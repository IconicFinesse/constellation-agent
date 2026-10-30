// BUG-008: A TURN THAT SAYS IT IS ONLY SHOWING CODE MUST NOT ALSO RUN IT.
//
// THE DEFECT (measured across two beta passes, 12 display turns): 7 were fully
// clean; 2 write-side turns actually created the file the model had just told the
// user it would not create; 3 delete-side turns dispatched a real delete (all caught
// by the destructive gate). Control: asked afterwards to really create a file, it
// complied 6/6 — so this was never blanket refusal, it was one turn asserting two
// contradictory things at once.
//
// THE SHAPE THAT PICKED THE FIX, entry by entry across ALL FIVE non-clean turns:
//   1. an assistant TEXT entry carrying BOTH the display claim AND the fenced code;
//   2. the dispatch as a SEPARATE, LATER tool_call entry;
//   3. a tool_result.
// No single message both claimed "not executed" and carried the dispatch. Hence a
// LOOP-LEVEL refusal — not a dispatch-time dry-run, not a per-tool opt-out, not a
// schema flag.
//
// THIS SUITE PINS BOTH DIRECTIONS, because a guard that refuses legitimate turns is
// worse than the defect it fixes:
//   A. each observed failure shape is REFUSED and NO handler runs (a spy proves zero
//      execution), the refusal names its reason in model-facing coaching, and every
//      announced `tool_call_id` is still answered exactly once (an unanswered id
//      breaks every later turn);
//   B. NINE legitimate turns dispatch normally and are NOT refused — including the
//      exact shapes a careless predicate would eat ("here's the code I ran", "I will
//      now write the file", "creating it now", a bare fenced block with no claim, and
//      the word "executed" inside an ordinary past-tense report);
//   C. a turn with no tool calls is untouched (it is already just display);
//   D. a held destructive call STILL HOLDS — the guard must not steal the consent
//      path — and a refusal must stay distinguishable from a hold (status, gate
//      state, and the absence of any hold record).
//
// Hermetic: scripted completions, a fake api, no network, no DOM, no app-data writes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  TIER1_TURN_STATUS,
  createTier1Session
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/tier1-session.js";
import { TOOL_TURN_STOP_REASON } from "../app/L0/_all/modules/_core/framework/js/engine-swap/tool-turn-loop.js";
import {
  ACTION_INTENT_PHRASES,
  DISPLAY_CLAIM_PHRASES,
  createDisplayRefusalError,
  findDisplayClaim,
  hasDisplayOnlyClaim,
  stripFencedText
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/display-claim.js";
import { DESTRUCTIVE_GATE_STATUS } from "../app/L0/_all/modules/_core/framework/js/engine-swap/destructive-gate.js";
import {
  TURN_LOG_OUTCOME,
  TURN_LOG_STEP_TYPE,
  turnLogStepFromEvent
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/turn-log.js";

// The OpenAI-compatible adjacency contract: every `tool_call_id` an assistant message
// announces is answered by exactly ONE tool message, and no tool message answers a
// call that was never announced. An unanswered id poisons every later turn.
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

// The spy. Every handler records its invocation, so "nothing executed" is a measured
// fact rather than an inference from the return value.
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

function createSession({ api = createFakeApi(), script, settings = {} } = {}) {
  const sender = createScriptedSender(script);
  const session = createTier1Session({
    api,
    apiEndpoint: settings.apiEndpoint || "https://api.openai.com/v1/chat/completions",
    history: [],
    model: settings.model || "gpt-x",
    providerKey: settings.providerKey || "openai",
    sendCompletion: sender.sendCompletion,
    systemPrompt: "You are a test agent.",
    userContent: "show me the code for creating a file"
  });

  return { sender, session };
}

const FENCED_WRITE = [
  "```javascript",
  'space.api.fileWrite({ content: "hello", path: "~/forbidden.txt" })',
  "```"
].join("\n");

const FENCED_DELETE = [
  "```javascript",
  'space.api.fileDelete("~/forbidden.txt")',
  "```"
].join("\n");

const WRITE_CALL = { arguments: '{"content":"hello","path":"~/forbidden.txt"}', id: "c1", name: "file_write" };
const READ_CALL = { arguments: '{"path":"~/notes.txt"}', id: "c1", name: "file_read" };
const DELETE_CALL = { arguments: '{"path":"~/forbidden.txt"}', id: "c1", name: "file_delete" };

// --- 0. the predicate itself ------------------------------------------------

test("the claim phrase list and the action-intent veto are explicit and non-empty", () => {
  assert.ok(DISPLAY_CLAIM_PHRASES.length >= 20, "the observed phrases plus close variants");
  assert.ok(ACTION_INTENT_PHRASES.length >= 8, "the veto list is real, not a placeholder");

  // The list is the contract: every phrase must actually arm the guard on its own.
  DISPLAY_CLAIM_PHRASES.forEach((phrase) => {
    assert.equal(findDisplayClaim(`Some preamble. ${phrase}.`), phrase, `${phrase} must arm the guard`);
  });

  // And no veto phrase may arm it, which is what keeps the two lists disjoint in effect.
  ACTION_INTENT_PHRASES.forEach((phrase) => {
    assert.equal(findDisplayClaim(`Here is the code. ${phrase}`), "", `${phrase} must disarm the guard`);
  });
});

test("only the prose is scanned: a claim inside a fenced block does not count", () => {
  const fenced = [
    "Here is the code:",
    "```javascript",
    'const note = "not executed";',
    "```"
  ].join("\n");

  assert.equal(findDisplayClaim(fenced), "", "code being shown is not a claim about what ran");
  assert.equal(stripFencedText(fenced).includes("not executed"), false);
  // The control: the same words OUTSIDE the fence do arm it.
  assert.equal(findDisplayClaim(`${fenced}\nNothing was executed.`), "nothing was executed");
});

test("the predicate is total: no text, empty text, and non-strings never throw", () => {
  [undefined, null, "", "   ", 0, 42, {}, []].forEach((value) => {
    assert.equal(hasDisplayOnlyClaim(value), false);
  });
});

test("an unterminated fence is display to the end, so it cannot smuggle a claim", () => {
  const unterminated = ["Here is the code:", "```javascript", 'space.api.fileWrite({ path: "~/x" })'].join("\n");

  assert.equal(findDisplayClaim(unterminated), "");
});

// --- A. the five observed failure shapes -------------------------------------

// The five non-clean turns, reconstructed as the shape the beta lab verified: the
// claim and the fenced code in the turn's TEXT, the real call beside it.
const OBSERVED_FAILURE_SHAPES = [
  {
    claim: "not executed",
    label: "write-side: 'not executed' beside a real file_write",
    text: `Here is the code. It is not executed:\n\n${FENCED_WRITE}`,
    toolCall: WRITE_CALL,
    toolName: "fileWrite"
  },
  {
    claim: "nothing was created",
    label: "write-side: 'nothing was created' beside a real file_write",
    text: `Nothing was created. Here is what it would look like:\n\n${FENCED_WRITE}`,
    toolCall: WRITE_CALL,
    toolName: "fileWrite"
  },
  {
    claim: "not executed",
    label: "delete-side: 'not executed' beside a real file_delete",
    text: `Shown only, not executed:\n\n${FENCED_DELETE}`,
    toolCall: DELETE_CALL,
    toolName: "fileDelete"
  },
  {
    claim: "for display",
    label: "delete-side: 'for display' beside a real file_delete",
    text: `For display purposes only, nothing was deleted:\n\n${FENCED_DELETE}`,
    toolCall: DELETE_CALL,
    toolName: "fileDelete"
  },
  {
    claim: "shown for reference",
    label: "write-side: 'shown for reference' beside a real file_write",
    text: `Shown for reference. Nothing has been created yet:\n\n${FENCED_WRITE}`,
    toolCall: WRITE_CALL,
    toolName: "fileWrite"
  }
];

OBSERVED_FAILURE_SHAPES.forEach((shape) => {
  test(`REFUSED — ${shape.label}`, async () => {
    const api = createFakeApi();
    const { session } = createSession({ api, script: [{ toolCalls: [shape.toolCall], text: shape.text }] });
    const result = await session.run();

    // 1. NOTHING ran. The spy is the proof, not the status word.
    assert.equal(api.calls.length, 0, "no handler may be invoked in a display-only turn");

    // 2. The turn ends on its own reason, never as `error` (nothing failed) and never
    //    as `held` (nothing is waiting for consent).
    assert.equal(result.status, TIER1_TURN_STATUS.DISPLAY_REFUSED);
    assert.equal(result.hold, null, "a refusal is not a hold");
    assert.equal(session.gate.status, DESTRUCTIVE_GATE_STATUS.IDLE, "the gate stays idle");

    // 3. The announced id is ANSWERED exactly once, with a real policy error.
    const toolMessages = result.messages.filter((message) => message.role === "tool");

    assert.equal(toolMessages.length, 1);
    assert.equal(toolMessages[0].toolCallId, shape.toolCall.id);
    assert.equal(toolMessages[0].isError, true, "a refusal is an error result, not a success");
    assert.match(toolMessages[0].content, /^error \(policy\):/u);
    assertValidToolCallAdjacency(result.messages);

    // 4. The user-facing answer is what they were actually shown.
    assert.equal(result.answer, shape.text);
  });
});

// --- B. the refusal's coaching names the reason -------------------------------

test("the refusal tells the model WHY, in the taxonomy's policy class", async () => {
  const api = createFakeApi();
  const { session } = createSession({
    api,
    script: [{ toolCalls: [WRITE_CALL], text: `Not executed:\n\n${FENCED_WRITE}` }]
  });
  const result = await session.run();
  const content = result.messages.find((message) => message.role === "tool").content;

  // The reason is named, not merely asserted.
  assert.match(content, /error \(policy\):/u);
  assert.match(content, /told the user that file_write would not run/u);
  assert.match(content, /so it was not run/u);
  // The model is told what to do instead, and what NOT to do.
  assert.match(content, /must ask for it explicitly in a new message/u);
  assert.match(content, /never claim it happened/u);
  // And display stays legitimate: the guard must not teach refusal of display.
  assert.match(content, /Showing code without running it is a legitimate answer/u);
});

test("the refusal error is a real policy error from the closed taxonomy", () => {
  const error = createDisplayRefusalError({ callId: "c9", count: 2, tool: "file_delete" });

  assert.equal(error.class, "policy");
  assert.equal(error.tool, "file_delete");
  assert.match(error.message, /2 calls refused in this turn/u);
  assert.ok(error.hint.length > 0, "a prose-only error is a defect");
});

test("a refusal reports its own stop reason, and the log vocabulary mirrors it", () => {
  assert.equal(TOOL_TURN_STOP_REASON.DISPLAY_REFUSED, "display-refused");
  // The engine turn log mirrors the loop's vocabulary; a drift here would log a word
  // the loop never produces (or 400 the endpoint that whitelists outcomes).
  assert.deepEqual({ ...TURN_LOG_OUTCOME }, { ...TOOL_TURN_STOP_REASON });
  assert.equal(TURN_LOG_STEP_TYPE.DISPLAY_CLAIM_REFUSED, "display-claim-refused");
});

test("the refusal records a content-free step: a COUNT, never the claim text", () => {
  const step = turnLogStepFromEvent({
    call: { id: "c1", name: "file_write" },
    claim: "not executed",
    refusedCount: 3,
    type: TURN_LOG_STEP_TYPE.DISPLAY_CLAIM_REFUSED
  });

  assert.deepEqual(Object.keys(step).sort(), ["refusedCount", "type"]);
  assert.equal(step.refusedCount, 3);
  assert.equal(JSON.stringify(step).includes("not executed"), false, "message text never enters the log");
});

// --- C. several calls in one refused turn ------------------------------------

test("every call of a refused batch is answered exactly once and none executes", async () => {
  const api = createFakeApi();
  const { session } = createSession({
    api,
    script: [
      {
        text: `Nothing was created:\n\n${FENCED_WRITE}`,
        toolCalls: [
          { arguments: '{"path":"~/a"}', id: "c1", name: "file_read" },
          { arguments: '{"content":"x","path":"~/b"}', id: "c2", name: "file_write" },
          { arguments: '{"path":"~/c"}', id: "c3", name: "file_delete" }
        ]
      }
    ]
  });
  const result = await session.run();

  assert.equal(api.calls.length, 0, "not even the read runs");

  const toolMessages = result.messages.filter((message) => message.role === "tool");

  assert.deepEqual(toolMessages.map((message) => message.toolCallId), ["c1", "c2", "c3"]);
  toolMessages.forEach((message) => {
    assert.equal(message.isError, true);
    assert.match(message.content, /^error \(policy\):/u);
  });
  assertValidToolCallAdjacency(result.messages);
  assert.equal(result.refused.length, 3);
  assert.equal(result.displayClaim, "nothing was created");
});

// --- D. the negatives: legitimate turns must dispatch -------------------------

// Each entry is a turn a careless predicate would eat. The assertion is the API spy:
// the handler ran, so the turn was NOT refused.
const LEGITIMATE_TURNS = [
  {
    label: "'here is the code I ran' — past tense, already done",
    text: "Here is the code I ran:",
    toolCall: WRITE_CALL,
    toolName: "fileWrite"
  },
  {
    label: "'I will now write the file'",
    text: `I will now write the file. Here is the code:\n\n${FENCED_WRITE}`,
    toolCall: WRITE_CALL,
    toolName: "fileWrite"
  },
  {
    label: "'Creating it now'",
    text: "Creating it now.",
    toolCall: WRITE_CALL,
    toolName: "fileWrite"
  },
  {
    label: "a fenced code block with no claim at all",
    text: FENCED_WRITE,
    toolCall: WRITE_CALL,
    toolName: "fileWrite"
  },
  {
    label: "'executed' inside an ordinary past-tense report",
    text: "The script was executed successfully and returned 42.",
    toolCall: READ_CALL,
    toolName: "fileRead"
  },
  {
    label: "'here is the code' with a plain read",
    text: "Here is the code:",
    toolCall: READ_CALL,
    toolName: "fileRead"
  },
  {
    label: "'let me create that file'",
    text: "Let me create that file for you. Here's the code:",
    toolCall: WRITE_CALL,
    toolName: "fileWrite"
  },
  {
    label: "\"I'm writing the file now\"",
    text: "I'm writing the file now.",
    toolCall: WRITE_CALL,
    toolName: "fileWrite"
  },
  {
    label: "a claim that ALSO says it is acting right now (the veto)",
    text: "The draft was not executed. I will now write the real file.",
    toolCall: WRITE_CALL,
    toolName: "fileWrite"
  }
];

LEGITIMATE_TURNS.forEach((entry) => {
  test(`NOT REFUSED — ${entry.label}`, async () => {
    const api = createFakeApi();
    const { session } = createSession({
      api,
      script: [{ text: entry.text, toolCalls: [entry.toolCall] }, { text: "done" }]
    });
    const result = await session.run();

    assert.equal(result.status, TIER1_TURN_STATUS.ANSWERED, "a legitimate turn still answers");
    assert.deepEqual(api.calls.map((call) => call.name), [entry.toolName], "the handler really ran");
    assert.equal(findDisplayClaim(entry.text), "", "and the predicate agrees it is not a claim");
  });
});

// --- E. a turn with no tool calls is untouched --------------------------------

test("a display-only answer with NO tool calls is unaffected — it never reaches the guard", async () => {
  const api = createFakeApi();
  const text = `Here is the code, shown but not executed:\n\n${FENCED_WRITE}`;
  const { session } = createSession({ api, script: [{ text }] });
  const result = await session.run();

  // The plain-text early return handles it: the guard is never consulted, so the turn
  // keeps its ordinary shape (ANSWERED, one assistant message, no refusal records).
  assert.equal(result.status, TIER1_TURN_STATUS.ANSWERED);
  assert.equal(result.answer, text);
  assert.deepEqual(result.refused, [], "no call was refused because no call was announced");
  assert.equal(result.displayClaim, "", "and no claim was recorded");
  assert.equal(api.calls.length, 0);
  assert.equal(result.messages.filter((message) => message.role === "tool").length, 0);
  // Proving the premise: the same text WOULD arm the guard if calls were present.
  assert.ok(hasDisplayOnlyClaim(text));
});

// --- F. the hold path is not stolen ------------------------------------------

test("a held destructive call STILL HOLDS: the guard does not steal the consent path", async () => {
  const api = createFakeApi();
  // No display claim anywhere: the delete must be HELD, exactly as before BUG-008.
  const { session } = createSession({ api, script: [{ toolCalls: [DELETE_CALL], text: "Deleting it now." }] });
  const result = await session.run();

  assert.equal(result.status, TIER1_TURN_STATUS.HELD);
  assert.ok(result.hold, "the hold record survives");
  assert.equal(result.hold.tool, "file_delete");
  assert.equal(session.gate.status, DESTRUCTIVE_GATE_STATUS.HELD);
  assert.equal(api.calls.length, 0, "nothing executes while held; the consent question is still the gate's");

  const heldMessage = result.messages.find((message) => message.role === "tool");

  assert.match(heldMessage.content, /^held:/u, "held, not refused");

  // And the confirm path still executes it exactly once afterwards.
  const executed = await session.confirmHeld();

  assert.equal(executed.status, "ok");
  assert.equal(api.calls.length, 1);
});

test("a refusal and a hold are distinguishable by status, gate state and hold record", async () => {
  const refusalApi = createFakeApi();
  const refusal = await createSession({
    api: refusalApi,
    script: [{ toolCalls: [DELETE_CALL], text: "Nothing was deleted:" }]
  }).session.run();

  const holdApi = createFakeApi();
  const hold = await createSession({
    api: holdApi,
    script: [{ toolCalls: [DELETE_CALL], text: "I'm deleting it now." }]
  }).session.run();

  // Three independent separations, so no single vocabulary change can merge them.
  assert.equal(refusal.status, TIER1_TURN_STATUS.DISPLAY_REFUSED);
  assert.equal(hold.status, TIER1_TURN_STATUS.HELD);
  assert.equal(refusal.hold, null);
  assert.ok(hold.hold);
  assert.notEqual(refusal.status, hold.status);

  // A hold paints a consent affordance; a refusal has nothing to confirm.
  assert.match(hold.messages.find((message) => message.role === "tool").content, /^held:/u);
  assert.match(refusal.messages.find((message) => message.role === "tool").content, /^error \(policy\):/u);
});

// --- G. the refusal is honest about repetition -------------------------------

test("a model that repeats the same claim is told once, not looped", async () => {
  const api = createFakeApi();
  const { sender, session } = createSession({
    api,
    script: [{ toolCalls: [WRITE_CALL], text: "Not executed:" }]
  });
  const result = await session.run();

  // ONE model call: the turn ends at the refusal instead of asking the model again
  // for a call that would be refused identically. A retry loop here would burn the
  // iteration cap on a decision already made.
  assert.equal(sender.requests.length, 1);
  assert.equal(result.status, TIER1_TURN_STATUS.DISPLAY_REFUSED);
  assert.equal(result.turns.length, 1);
});
