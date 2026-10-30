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
//   - the transport request STREAMS and carries the assembled tool list (P3)
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
  formatIncompleteArgumentsHint,
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

// P3 (plan §3.5): several calls in one turn are DISPATCHED, strictly sequentially,
// in the order the provider returned them. P2 refused them outright; that refusal
// is retired, and this test is what keeps it retired.
test("several calls in one turn dispatch sequentially in returned order", async () => {
  const api = createFakeApi({ fileRead: { content: "hello" } });
  const { sender, session } = createSession({
    api,
    script: [
      {
        toolCalls: [
          { arguments: '{"path":"~/a"}', id: "c1", name: "file_read" },
          { arguments: '{"path":"~/b"}', id: "c2", name: "file_read" },
          { arguments: '{"path":"~/c"}', id: "c3", name: "file_read" }
        ]
      },
      { text: "Read all three." }
    ]
  });
  const result = await session.run();

  assert.equal(result.status, TIER1_TURN_STATUS.ANSWERED);
  assert.equal(result.answer, "Read all three.");

  // Order is visible in the handler calls themselves, not inferred from a count.
  assert.deepEqual(
    api.calls.map((call) => call.args[0]),
    ["~/a", "~/b", "~/c"],
    "handlers run in the order the provider returned the calls"
  );

  // ONE assistant message announces all three, and all three results follow it in
  // one block — the wire shape the provider expects.
  const announcements = result.messages.filter(
    (message) => message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length
  );

  assert.equal(announcements.length, 1, "one assistant message announces the whole turn");
  assert.deepEqual(announcements[0].toolCalls.map((call) => call.id), ["c1", "c2", "c3"]);

  const secondMessages = sender.requests[1].body.messages;
  const toolIds = secondMessages.filter((message) => message.role === "tool").map((message) => message.tool_call_id);

  assert.deepEqual(toolIds, ["c1", "c2", "c3"], "results return together, in order, in one request");
  assert.equal(sender.requests.length, 2, "the two turns are: the calls, then the answer");
});

// A failure mid-batch must not abort the batch: the failing call gets its own
// structured error result, and the remaining calls still run.
test("a failing call mid-batch still answers every call and the later calls still run", async () => {
  // Only the MIDDLE path fails: a fixture that fails every read cannot show that
  // the batch continued past the failure.
  const calls = [];
  const api = {
    calls,
    fileRead: async (path) => {
      calls.push({ args: [path], name: "fileRead" });

      if (path === "~/b") {
        throw new Error("Path not found: ~/b");
      }

      return { content: `contents of ${path}`, path };
    }
  };
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
      { text: "Two of three worked." }
    ]
  });
  const result = await session.run();

  assert.equal(result.status, TIER1_TURN_STATUS.ANSWERED);
  assert.equal(api.calls.length, 3, "the third call still runs after the second failed");

  const toolMessages = result.messages.filter((message) => message.role === "tool");

  assert.equal(toolMessages.length, 3, "every announced call is answered exactly once");
  assert.equal(toolMessages[1].isError, true, "the middle result carries the failure");
  assert.match(toolMessages[1].content, /error \(api\)/u);
  assert.equal(toolMessages[2].isError, undefined, "the later call's result is clean");

  assertValidToolCallAdjacency(result.messages);
});

// The persisted-history half: a parallel turn must REPLAY into a valid canonical
// sequence. P2 refused parallel turns partly because one entry per call replayed as
// several assistant messages; the fix is one announcement plus ordered results, so
// the replay is exactly the shape the wire wants.
test("a parallel turn persists a history that replays validly", async () => {
  const api = createFakeApi({ fileRead: { content: "hello" } });
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
      { text: "Done." }
    ]
  });
  const result = await session.run();
  const baseline = 2; // system prompt + the scripted user turn
  const tailEntries = canonicalMessagesToTypedEntries(result.messages, { fromIndex: baseline });

  assert.equal(
    tailEntries.filter((entry) => entry.kind === "tool_call").length,
    3,
    "each call is persisted as its own typed entry"
  );
  assert.equal(
    tailEntries.filter((entry) => entry.kind === "tool_result").length,
    3,
    "each call is answered exactly once"
  );

  const replayed = historyEntriesToCanonicalMessages(tailEntries);

  assertValidToolCallAdjacency(replayed);
  // The replay groups the three calls back into ONE assistant message: the reader
  // is what makes per-entry persistence compatible with the wire contract.
  assert.equal(
    replayed.filter((message) => message.role === "assistant" && Array.isArray(message.toolCalls)).length,
    3,
    "the reader rebuilds one assistant message per call entry (its documented shape)"
  );
  assert.equal(replayed.filter((message) => message.role === "tool").length, 3);
});

// A call whose argument fragments never completed is NEVER dispatched, and it
// never enters the message list: an announced id with no valid arguments cannot be
// answered honestly.
test("a call with incomplete streamed arguments is refused with coaching and never dispatches", async () => {
  const api = createFakeApi();

  // The scripted sender rebuilds payloads from `call.arguments`, so it cannot
  // express the assembler's `argumentsComplete` verdict. Drive that verdict through
  // a direct sender, which is exactly the shape the streaming transport returns.
  let sends = 0;
  const direct = createTier1Session({
    api,
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    history: [],
    model: "gpt-x",
    providerKey: "openai",
    sendCompletion: async () => {
      sends += 1;

      if (sends > 1) {
        return { text: "Let me resend that.", toolCalls: [] };
      }

      return {
        text: "reading",
        toolCalls: [
          {
            arguments: JSON.stringify({ path: "~/" }),
            argumentsComplete: false,
            id: "c1",
            name: "file_read"
          }
        ]
      };
    },
    systemPrompt: "You are a test agent.",
    userContent: "read my notes"
  });
  const result = await direct.run();

  assert.equal(api.calls.length, 0, "an incomplete call never reaches a handler");
  assert.equal(result.answer, "Let me resend that.");

  const announced = result.messages.filter(
    (message) => message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length
  );

  assert.deepEqual(announced, [], "an incomplete call is not announced either");

  const coaching = result.messages.find((message) => message.role === "user" && /incomplete arguments/u.test(message.content));

  assert.ok(coaching, "the model is coached rather than silently ignored");
  assert.match(coaching.content, /Nothing was executed/u);
});

// A destructive call in the MIDDLE of a parallel turn: it is held, so it never
// executes, and the calls after it must still be answered (as deferred) rather than
// left unannounced-but-unanswered. This is the shape that would poison every later
// turn if the loop simply broke out of the batch.
test("a held call mid-batch still answers every sibling exactly once", async () => {
  const api = createFakeApi({ fileRead: { content: "hello" } });
  const { session } = createSession({
    api,
    script: [
      {
        toolCalls: [
          { arguments: '{"path":"~/a"}', id: "c1", name: "file_read" },
          { arguments: '{"path":"~/doomed.txt"}', id: "c2", name: "file_delete" },
          { arguments: '{"path":"~/b"}', id: "c3", name: "file_read" }
        ]
      }
    ]
  });
  const result = await session.run();

  assert.equal(result.status, TIER1_TURN_STATUS.HELD);
  assert.equal(result.hold?.tool, "file_delete");
  // Only the read BEFORE the hold executed; the delete is held and the read after it
  // is deferred, never executed.
  assert.deepEqual(api.calls.map((call) => call.name), ["fileRead"], "nothing after the hold runs");

  const toolMessages = result.messages.filter((message) => message.role === "tool");

  assert.equal(toolMessages.length, 3, "every announced call is answered");
  assert.deepEqual(toolMessages.map((message) => message.toolCallId), ["c1", "c2", "c3"]);
  assert.match(toolMessages[1].content, /^held:/u, "the destructive call says held, not failed");
  assert.match(toolMessages[2].content, /^deferred:/u, "the later call is deferred, not silently dropped");

  assertValidToolCallAdjacency(result.messages);

  // The siblings' results persist and replay validly too: a hold must not leave a
  // dangling id in stored history.
  const tailEntries = canonicalMessagesToTypedEntries(result.messages, { fromIndex: 2 });

  assertValidToolCallAdjacency(historyEntriesToCanonicalMessages(tailEntries));
  assert.equal(
    tailEntries.filter((entry) => entry.kind === "tool_result").length,
    3,
    "three results persisted for three announced calls"
  );
});

// Audit-2 note N2: the repeat count must ESCALATE, and the escalation now covers
// the coaching paths too (P2 computed the count but only surfaced the note on the
// dispatch-error branch, so a model repeating the same mistake saw byte-identical
// coaching every iteration).
test("repeating the same refusal escalates with the repeat note", async () => {
  const api = createFakeApi();
  let calls = 0;
  const session = createTier1Session({
    api,
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    history: [],
    model: "gpt-x",
    providerKey: "openai",
    sendCompletion: async () => {
      calls += 1;

      if (calls > 3) {
        return { text: "Fine, answering.", toolCalls: [] };
      }

      return {
        text: "reading",
        toolCalls: [
          {
            arguments: JSON.stringify({ path: "~/" }),
            argumentsComplete: false,
            id: `c${calls}`,
            name: "file_read"
          }
        ]
      };
    },
    systemPrompt: "You are a test agent.",
    userContent: "read my notes"
  });
  const result = await session.run();
  const coachings = result.messages.filter((message) => message.role === "user" && /incomplete arguments/u.test(message.content));

  assert.equal(coachings.length, 3);
  assert.equal(
    /has now occurred/u.test(coachings[0].content),
    false,
    "the first refusal carries no repeat note"
  );
  assert.match(coachings[1].content, /now occurred 2 times in a row/u);
  assert.match(coachings[2].content, /now occurred 3 times in a row/u);
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

test("the incomplete-arguments hint names the count and the retry shape", () => {
  const hint = formatIncompleteArgumentsHint(2);

  assert.match(hint, /^policy: 2 tool calls/u);
  assert.match(hint, /incomplete arguments/u);
  assert.match(hint, /Nothing was executed/u);
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

// --- transport shape (the P3 contract) ------------------------------------

// P2 pinned `stream: false` here because the reader dropped `tool_calls`. P3
// replaced that boundary: a tool turn STREAMS and the surface assembles fragments
// per call index, so this assertion now pins the opposite — the retired boundary
// cannot quietly return.
test("a tool turn streams and carries the visible tool list", async () => {
  const { sender, session } = createSession({ script: [{ text: "hi" }] });

  await session.run();

  const request = sender.requests[0];

  assert.equal(request.body.stream, true, "P3 assembles streamed tool calls");
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
  // STILL EXHAUSTIVE, deliberately. Both later entries are EXTENSIONS, not loosening:
  //
  // - `display-refused` is a SIXTH exit (BUG-008). A turn whose own text claimed
  //   display-only ends there, and reporting it as `error` would say something failed
  //   when nothing did, while reporting it as `held` would paint a consent bar for a
  //   refusal.
  // - `stalled` is a SEVENTH exit (BUG-013's no-progress watchdog). A turn that stopped
  //   making progress ends there. Reporting it as `stopped` would blame the user for a
  //   stall they did not cause, and `error` would hide the one fact that matters: the
  //   turn was abandoned for silence, not because anything reported a fault.
  //
  // The mirror in `turn-log.js` and the server's OUTCOMES whitelist carry the same
  // words, and the display-guard and stall-watchdog suites each assert their mirror
  // against this list.
  assert.deepEqual(Object.values(TOOL_TURN_STOP_REASON).sort(), [
    "answered",
    "display-refused",
    "error",
    "held",
    "iteration-cap",
    "stalled",
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
