// Focused engine-swap P2 coverage for the Tier 1 loop and session (plan §3.5, §6).
//
// What this locks down:
//   - the loop runs until a plain-text answer, dispatching exactly one call per
//     turn and returning structured tool results
//   - a turn with several tool calls is refused with policy coaching and nothing
//     executes (P3 replaces this with sequential dispatch)
//   - the iteration cap terminates, the stop request terminates, and a transport
//     failure terminates — no path spins
//   - repeat-error surfacing appears on the second identical failure
//   - a destructive call ends the loop HELD, with the model told held not failed,
//     and confirm executes exactly once
//   - the transport request is non-streamed and carries the assembled tool list
//     (the P2 boundary with P3)
//
// Hermetic: the completion call is a scripted fake. No network, no keys, no
// app-data writes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  TIER1_TURN_STATUS,
  buildTier1History,
  createTier1Session,
  extractToolCallsFromCompletion
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/tier1-session.js";
import {
  canonicalMessagesToTypedEntries,
  historyEntriesToCanonicalMessages
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/history-shapes.js";
import {
  TOOL_TURN_MAX_ITERATIONS,
  TOOL_TURN_STOP_REASON,
  buildRepeatErrorNote,
  formatParallelCallsPolicyHint,
  runToolTurn,
  trackToolErrorRepeat
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/tool-turn-loop.js";
import { createDestructiveGate } from "../app/L0/_all/modules/_core/framework/js/engine-swap/destructive-gate.js";

// The OpenAI-compatible adjacency contract: every `tool_call_id` an assistant
// message announces is answered by exactly one `tool` message, and no `tool`
// message answers a call that was never announced.
function assertValidToolCallAdjacency(messages) {
  const announced = [];
  const answered = [];

  (Array.isArray(messages) ? messages : []).forEach((message) => {
    if (message?.role === "assistant" && Array.isArray(message.toolCalls)) {
      message.toolCalls.forEach((call) => announced.push(call.id));
    }

    if (message?.role === "tool") {
      answered.push(message.toolCallId);
    }
  });

  announced.forEach((id) => {
    assert.equal(
      answered.filter((value) => value === id).length,
      1,
      `tool_call_id ${id} must be answered exactly once`
    );
  });

  answered.forEach((id) => {
    assert.ok(announced.includes(id), `tool result ${id} must answer an announced call`);
  });
}

function createFakeApi(outcomes = {}) {
  const calls = [];

  function record(name) {
    return async (...args) => {
      calls.push({ args, name });

      if (outcomes[name] instanceof Error) {
        throw outcomes[name];
      }

      return outcomes[name] === undefined ? { ok: true } : outcomes[name];
    };
  }

  return {
    calls,
    fileDelete: record("fileDelete"),
    fileList: record("fileList"),
    fileRead: record("fileRead"),
    fileWrite: record("fileWrite")
  };
}

// A scripted completion: each entry is either `{ text }` or `{ toolCalls }` and
// the sender walks the script in order, recording every request it was given.
function createScriptedSender(script) {
  const requests = [];
  let index = 0;

  async function sendCompletion({ request }) {
    requests.push(request);
    const step = script[Math.min(index, script.length - 1)];
    index += 1;

    if (step instanceof Error) {
      throw step;
    }

    const toolCalls = Array.isArray(step.toolCalls)
      ? step.toolCalls.map((call) => ({ function: { arguments: call.arguments, name: call.name }, id: call.id }))
      : [];

    return {
      choices: [
        {
          finish_reason: toolCalls.length ? "tool_calls" : "stop",
          message: { content: step.text || "", tool_calls: toolCalls }
        }
      ]
    };
  }

  return { requests, sendCompletion };
}

function createSession({ api = createFakeApi(), script = [{ text: "done" }], settings = {} } = {}) {
  const sender = createScriptedSender(script);
  const session = createTier1Session({
    api,
    apiEndpoint: settings.apiEndpoint || "https://api.openai.com/v1/chat/completions",
    history: [],
    model: settings.model || "gpt-x",
    providerKey: settings.providerKey || "openai",
    sendCompletion: sender.sendCompletion,
    systemPrompt: "You are a test agent.",
    userContent: "read my notes"
  });

  return { sender, session };
}

// --- completion parsing ----------------------------------------------------

test("a completion's tool calls are read with their raw argument strings", () => {
  const parsed = extractToolCallsFromCompletion({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "",
          tool_calls: [
            { function: { arguments: '{"path":"~/a.txt"}', name: "file_read" }, id: "call_1", type: "function" }
          ]
        }
      }
    ]
  });

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "file_read");
  assert.equal(parsed.toolCalls[0].id, "call_1");
  // The raw string survives so the pipeline — not the transport — decides validity.
  assert.equal(typeof parsed.toolCalls[0].arguments, "string");
  assert.equal(parsed.finishReason, "tool_calls");
});

test("a plain completion parses as text with no calls", () => {
  const parsed = extractToolCallsFromCompletion({ choices: [{ message: { content: "hello" } }] });

  assert.equal(parsed.text, "hello");
  assert.equal(parsed.toolCalls.length, 0);
});

// --- history assembly ------------------------------------------------------

test("tier 1 history puts the system prompt first and the user turn last", () => {
  const messages = buildTier1History({
    history: [{ content: "earlier turn", id: "u0", kind: "", role: "user" }],
    systemPrompt: "be useful",
    userContent: "now do this"
  });

  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, "be useful");
  assert.equal(messages[messages.length - 1].role, "user");
  assert.equal(messages[messages.length - 1].content, "now do this");
});

// --- loop behavior ---------------------------------------------------------

test("a plain-text answer ends the loop with no dispatch", async () => {
  const api = createFakeApi();
  const { session } = createSession({ api, script: [{ text: "Here is your answer." }] });
  const result = await session.run();

  assert.equal(result.status, TIER1_TURN_STATUS.ANSWERED);
  assert.equal(result.answer, "Here is your answer.");
  assert.equal(api.calls.length, 0);
  assert.equal(result.turns.length, 1);
});

test("one call dispatches, its result returns to the model, then the answer ends the loop", async () => {
  const api = createFakeApi({ fileRead: { content: "hello", path: "~/a.txt" } });
  const { sender, session } = createSession({
    api,
    script: [
      { toolCalls: [{ arguments: '{"path":"~/a.txt"}', id: "call_1", name: "file_read" }] },
      { text: "Your file says hello." }
    ]
  });
  const result = await session.run();

  assert.equal(result.status, TIER1_TURN_STATUS.ANSWERED);
  assert.equal(result.answer, "Your file says hello.");
  assert.equal(api.calls.length, 1);
  // Two requests went out: the call turn, then the turn carrying the tool result.
  assert.equal(sender.requests.length, 2);
  const secondMessages = sender.requests[1].body.messages;
  const toolMessage = secondMessages.find((message) => message.role === "tool");

  assert.ok(toolMessage, "the tool result must travel back as a tool message");
  assert.equal(toolMessage.tool_call_id, "call_1");
  assert.match(toolMessage.content, /content/u);
});

test("several calls in one turn are refused with policy coaching and none execute", async () => {
  const api = createFakeApi();
  const { session } = createSession({
    api,
    script: [
      {
        toolCalls: [
          { arguments: '{"path":"~/a"}', id: "c1", name: "file_read" },
          { arguments: '{"path":"~/b"}', id: "c2", name: "file_read" }
        ]
      },
      { text: "One at a time then." }
    ]
  });
  const result = await session.run();

  assert.equal(api.calls.length, 0, "no handler runs for a refused parallel turn");
  assert.equal(result.answer, "One at a time then.");

  // Variant (b): the refused calls never enter the message list, so no assistant
  // message carries a `tool_calls` array that could go unanswered.
  const assistantCalls = result.messages.filter(
    (message) => message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length
  );

  assert.deepEqual(assistantCalls, [], "a refused turn must not manufacture an assistant tool-call message");

  // The coaching still reaches the model, as a plain turn, with the count and the
  // retry instruction intact.
  const coaching = result.messages.find((message) => message.role === "user" && /policy:/u.test(message.content));

  assert.ok(coaching, "the model must still be coached");
  assert.match(coaching.content, /policy: 2 tool calls/u);
  assert.match(coaching.content, /exactly one call per turn/u);
  assert.match(coaching.content, /Retry with the first call alone/u);
});

// The persisted-history half of the same defect: whatever a refused turn leaves
// behind must REPLAY into a valid canonical sequence. Before variant (b) the tail
// mapped to three typed `tool_call` entries (one per refused call) that replayed
// as three assistant messages with zero or trailing results — invalid adjacency
// that poisoned every later turn in the chat.
test("a refused parallel turn persists a history that replays validly", async () => {
  const api = createFakeApi();
  const { session } = createSession({
    api,
    script: [
      {
        toolCalls: [
          { arguments: '{"path":"~/a"}', id: "c1", name: "file_read" },
          { arguments: '{"path":"~/b"}', id: "c2", name: "file_read" },
          { arguments: '{"path":"~/c"}', id: "c3", name: "file_read" }
        ]
      },
      { text: "One at a time then." }
    ]
  });
  const result = await session.run();
  const baseline = 2; // system prompt + the scripted user turn
  const tailEntries = canonicalMessagesToTypedEntries(result.messages, { fromIndex: baseline });

  // No typed call entry may be written for a refused call.
  assert.equal(
    tailEntries.some((entry) => entry.kind === "tool_call"),
    false,
    "a refused call must never be persisted as a tool_call entry"
  );

  // And the replay is a valid OpenAI-shaped sequence.
  const replayed = historyEntriesToCanonicalMessages(tailEntries);

  assertValidToolCallAdjacency(replayed);
});

// Stop responsiveness (P2 audit non-blocker 3): the loop consults the surface's
// stop flag between iterations, so a stop after the first iteration exits without
// executing anything further and reports a legible stopped state.
test("a stop requested after the first iteration exits without executing further calls", async () => {
  const api = createFakeApi();
  let stop = false;
  const sender = createScriptedSender([
    { toolCalls: [{ arguments: '{"path":"~/a"}', id: "c1", name: "file_read" }] },
    { toolCalls: [{ arguments: '{"path":"~/b"}', id: "c2", name: "file_read" }] },
    { toolCalls: [{ arguments: '{"path":"~/c"}', id: "c3", name: "file_read" }] }
  ]);
  const session = createTier1Session({
    api,
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    history: [],
    model: "gpt-x",
    providerKey: "openai",
    sendCompletion: async (context) => {
      const payload = await sender.sendCompletion(context);

      // The user presses Stop while the first turn is being handled.
      stop = true;
      return payload;
    },
    systemPrompt: "You are a test agent.",
    userContent: "read my files"
  });
  const result = await session.run({ isStopRequested: () => stop });

  assert.equal(result.status, TIER1_TURN_STATUS.STOPPED, "a stop is its own ended state, not an answer");
  assert.equal(api.calls.length, 1, "the first call may execute; the stop lands before the second");
  assert.equal(sender.requests.length, 1, "no further request may be sent after the stop");
  assert.equal(result.answer, "", "a stopped turn carries no answer");
});

// A transport cut by an abort is a stop, not a fault; a real failure with no stop
// request still surfaces as an error.
test("an aborted transport is reported as stopped, not as a transport error", async () => {
  let stop = false;
  const session = createTier1Session({
    api: createFakeApi(),
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    history: [],
    model: "gpt-x",
    providerKey: "openai",
    sendCompletion: async () => {
      stop = true;
      throw new Error("The operation was aborted.");
    },
    systemPrompt: "You are a test agent.",
    userContent: "read my notes"
  });
  const stopped = await session.run({ isStopRequested: () => stop });

  assert.equal(stopped.status, TIER1_TURN_STATUS.STOPPED);

  const failing = createTier1Session({
    api: createFakeApi(),
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    history: [],
    model: "gpt-x",
    providerKey: "openai",
    sendCompletion: async () => {
      throw new Error("provider exploded");
    },
    systemPrompt: "You are a test agent.",
    userContent: "read my notes"
  });
  const errored = await failing.run();

  assert.equal(errored.status, TIER1_TURN_STATUS.ERROR, "a failure with no stop request is still an error");
});

test("the parallel policy hint names the count and the retry shape", () => {
  const hint = formatParallelCallsPolicyHint(3);

  assert.match(hint, /^policy: 3 tool calls/u);
  assert.match(hint, /Retry with the first call alone/u);
});

test("a malformed complete-args call becomes a validation coaching error and never executes", async () => {
  const api = createFakeApi();
  const { session } = createSession({
    api,
    script: [
      { toolCalls: [{ arguments: '{"path":', id: "c1", name: "file_read" }] },
      { text: "Let me retry." }
    ]
  });
  const result = await session.run();

  assert.equal(api.calls.length, 0);
  const failed = result.messages.find((message) => message.role === "tool");
  assert.match(failed.content, /error \(validation\)/u);
  assert.match(failed.content, /not valid JSON/u);
});

test("the iteration cap terminates a model that never answers", async () => {
  const api = createFakeApi();
  // Every turn asks to read again; the loop must stop at the cap, not spin.
  const { sender, session } = createSession({
    api,
    script: [{ toolCalls: [{ arguments: '{"path":"~/a"}', id: "c1", name: "file_read" }] }]
  });
  const result = await session.run();

  assert.equal(result.status, TIER1_TURN_STATUS.ITERATION_CAP);
  assert.equal(sender.requests.length, TOOL_TURN_MAX_ITERATIONS);
});

test("a stop request ends the loop at the next boundary", async () => {
  const api = createFakeApi();
  const { session } = createSession({ api, script: [{ text: "never sent" }] });
  const result = await session.run({ isStopRequested: () => true });

  assert.equal(result.status, TIER1_TURN_STATUS.STOPPED);
  assert.equal(api.calls.length, 0);
});

test("a transport failure ends the loop as an error, never a hang", async () => {
  const api = createFakeApi();
  const { session } = createSession({ api, script: [new Error("Chat request failed with status 500")] });
  const result = await session.run();

  assert.equal(result.status, TIER1_TURN_STATUS.ERROR);
  assert.match(result.error, /status 500/u);
});

// --- repeat-error surfacing ------------------------------------------------

test("every coaching error appears as a failed tool message in the transcript", async () => {
  const api = createFakeApi({ fileRead: new Error("Path not found: ~/missing") });
  const { session } = createSession({
    api,
    script: [
      { toolCalls: [{ arguments: '{"path":"~/missing"}', id: "c1", name: "file_read" }] },
      { text: "That file does not exist." }
    ]
  });
  const result = await session.run();
  const failed = result.messages.find((message) => message.role === "tool");

  assert.ok(failed);
  assert.match(failed.content, /error \(api\)/u);
  assert.match(failed.content, /not found|writable scope/iu);
});

test("the second identical failure carries the repeat note", async () => {
  const api = createFakeApi({ fileRead: new Error("Path not found: ~/missing") });
  const { session } = createSession({
    api,
    script: [
      { toolCalls: [{ arguments: '{"path":"~/missing"}', id: "c1", name: "file_read" }] },
      { toolCalls: [{ arguments: '{"path":"~/missing"}', id: "c2", name: "file_read" }] },
      { text: "Giving up." }
    ]
  });
  const result = await session.run();
  const toolMessages = result.messages.filter((message) => message.role === "tool");

  assert.equal(toolMessages.length, 2);
  assert.match(toolMessages[1].content, /this exact tool error has now occurred 2 times in a row/u);
});

test("repeat tracking resets on a clean turn and on a changed error", () => {
  const first = trackToolErrorRepeat(["boom"], "", 0);
  const second = trackToolErrorRepeat(["boom"], first.signature, first.count);
  const changed = trackToolErrorRepeat(["other"], second.signature, second.count);
  const clean = trackToolErrorRepeat([], changed.signature, changed.count);

  assert.equal(first.count, 1);
  assert.equal(second.count, 2);
  assert.equal(changed.count, 1);
  assert.equal(clean.count, 0);
  assert.equal(buildRepeatErrorNote(1), "");
  assert.match(buildRepeatErrorNote(2), /occurred 2 times/u);
});

// --- destructive hold through the loop ------------------------------------

test("a destructive call ends the loop held, and the model is told held not failed", async () => {
  const api = createFakeApi();
  const { session } = createSession({
    api,
    script: [{ toolCalls: [{ arguments: '{"path":"~/a.txt"}', id: "c1", name: "file_delete" }] }]
  });
  const result = await session.run();

  assert.equal(result.status, TIER1_TURN_STATUS.HELD);
  assert.ok(result.hold);
  assert.equal(result.hold.tool, "file_delete");
  assert.equal(api.calls.length, 0, "nothing executes while held");

  const heldMessage = result.messages.find((message) => message.role === "tool");
  assert.match(heldMessage.content, /^held:/u);
  assert.match(heldMessage.content, /Do not retry this call/u);
});

test("confirming a held call executes exactly once through the session", async () => {
  const api = createFakeApi();
  const { session } = createSession({
    api,
    script: [{ toolCalls: [{ arguments: '{"path":"~/a.txt"}', id: "c1", name: "file_delete" }] }]
  });

  await session.run();
  const executed = await session.confirmHeld();

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].name, "fileDelete");
  assert.deepEqual(api.calls[0].args, ["~/a.txt"]);
  assert.equal(executed.status, "ok");
  assert.equal(await session.confirmHeld(), null, "a second confirm settles nothing");
  assert.equal(api.calls.length, 1);
});

test("denying a held call executes nothing and leaves the gate idle", async () => {
  const api = createFakeApi();
  const { session } = createSession({
    api,
    script: [{ toolCalls: [{ arguments: '{"path":"~/a.txt"}', id: "c1", name: "file_delete" }] }]
  });

  await session.run();
  const settled = session.denyHeld();

  assert.equal(settled.status, "denied");
  assert.equal(api.calls.length, 0);
  assert.equal(session.gate.isHeld, false);
});

test("session end cancels a hold without executing", async () => {
  const api = createFakeApi();
  const { session } = createSession({
    api,
    script: [{ toolCalls: [{ arguments: '{"path":"~/a.txt"}', id: "c1", name: "file_delete" }] }]
  });

  await session.run();
  const cancelled = session.cancelHeld();

  assert.equal(cancelled.status, "cancelled");
  assert.equal(api.calls.length, 0);
});

// --- transport shape (the P2/P3 boundary) ---------------------------------

test("a tool turn asks for a non-streamed completion carrying the visible tool list", async () => {
  const { sender, session } = createSession({ script: [{ text: "hi" }] });

  await session.run();

  const request = sender.requests[0];

  assert.equal(request.body.stream, false, "P2 consumes complete tool calls only");
  assert.ok(Array.isArray(request.body.tools));
  assert.deepEqual(
    request.body.tools.map((tool) => tool.function.name),
    session.assembled.names
  );
  // Deterministic order: alphabetical, identical to the assembled list.
  assert.deepEqual(session.assembled.names, [...session.assembled.names].sort());
});

test("the visible tool list is identical across sessions of the same config", () => {
  const first = createSession().session;
  const second = createSession().session;

  assert.deepEqual(first.assembled.names, second.assembled.names);
  assert.equal(first.assembled.hash, second.assembled.hash);
});

// --- pure loop contract ----------------------------------------------------

test("runToolTurn refuses to start without a sender or a pipeline", async () => {
  await assert.rejects(() => runToolTurn({}), /sendTurn/u);
  await assert.rejects(() => runToolTurn({ sendTurn: async () => ({}) }), /dispatch pipeline/u);
});

test("a stop reason enum covers every exit", () => {
  assert.deepEqual(Object.values(TOOL_TURN_STOP_REASON).sort(), [
    "answered",
    "error",
    "held",
    "iteration-cap",
    "stopped"
  ]);
});

test("the gate used by a session is a real destructive gate", () => {
  const { session } = createSession();

  assert.equal(session.gate.isHeld, false);
  assert.equal(typeof session.gate.confirm, "function");
  // And a standalone gate behaves the same, proving no custom object is needed.
  const standalone = createDestructiveGate();

  assert.equal(standalone.status, "idle");
});
