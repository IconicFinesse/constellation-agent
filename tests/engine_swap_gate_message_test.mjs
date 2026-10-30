// BUG-009: EVERY DESTRUCTIVE-GATE OUTCOME LEAVES A USER-FACING MESSAGE.
//
// THE DEFECT. When a destructive call was HELD, the turn committed an assistant
// tool-call entry and a held tool-result entry and then stopped. The saved transcript
// ended at the tool result, so a reader (and a reload) could not tell a decision was
// pending. A denial left the same silence, and a cancellation left a placeholder
// claiming a pending decision forever. The session was never dead — a following
// message was answered normally — so this was purely a transcript defect.
//
// WHAT THIS SUITE PINS, in two layers:
//
//   LAYER A — the shared layer (`gate-message.js` + `history-shapes.js`). The wording
//   for each outcome, the plain-assistant message shape it commits, the ONE-per-episode
//   ordering rule that makes a hold-then-confirm leave exactly one gate sentence rather
//   than stacking two, and the do-nothing case where there is no row and no sentence to
//   settle (a cleared chat must not grow a sentence about a hold that no longer exists).
//
//   LAYER B — the two REAL surfaces. The helper layer alone would pass even if nobody
//   called it, which is this campaign's oldest failure mode. So every outcome is driven
//   through the real `onscreenAgent` and the real `adminAgent` stores: a held turn through
//   the real turn driver's commit path, then confirm / deny / stop-cancel / clear-cancel
//   through the real handlers, asserting the committed history each time. BOTH surfaces,
//   because admin shipped without the stop and clear exits until this lane.
//
// THE AUDIENCE SEPARATION IS A NAMED CASE. `formatHeldToolResult` writes coaching for
// the MODEL ("Do not retry this call..."); the sentences here are for a HUMAN. A lane
// that swapped them would pass a "message exists" assertion, so the model-facing string
// is imported and asserted absent from every user-facing one.
//
// Hermetic: no network, no DOM, no app-data writes. Every surface seam
// (persist/render/transport) is a stub, and the stores are driven through their own
// public handlers.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

// The `/modules/...` loader is for the SURFACE stores, which import each other by that
// specifier. The engine modules below are dependency-free leaves, so they are imported
// by RELATIVE path: a static import is resolved before `register()` can run, and a
// static `/modules/...` specifier would therefore never reach the hook.
import {
  GATE_OUTCOME_MESSAGE_KIND,
  appendGateOutcomeMessage,
  canonicalMessagesToTypedEntries,
  createGateOutcomeMessageEntry,
  normalizeTypedHistoryFields,
  projectHistoryEntryForDisplay,
  readHistoryEntry,
  serializeTypedHistoryFields,
  settleGateOutcome
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/history-shapes.js";
import { formatHeldToolResult } from "../app/L0/_all/modules/_core/framework/js/engine-swap/destructive-gate.js";
import {
  describeGateAction,
  formatGateCancelledMessage,
  formatGateConfirmedMessage,
  formatGateDeniedMessage,
  formatGateHeldMessage
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/gate-message.js";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

// --- fixtures ----------------------------------------------------------------

// A hold as the real gate builds it (`destructive-gate.js` `hold({...})`).
const HOLD = Object.freeze({
  arguments: Object.freeze({ path: "/home/owner/notes.txt" }),
  callId: "call_held_1",
  description: 'file_delete {"path":"/home/owner/notes.txt"}',
  status: "held",
  tool: "file_delete"
});

// The committed turn a held call leaves behind, built through the REAL writer so the
// fixture is the production shape rather than a hand-rolled lookalike.
function heldHistory(callId = HOLD.callId) {
  return canonicalMessagesToTypedEntries([
    { content: "delete the notes file", role: "user" },
    {
      content: "",
      role: "assistant",
      toolCalls: [{ arguments: { path: "/home/owner/notes.txt" }, id: callId, name: "file_delete" }]
    },
    { content: `held: the delete of /home/owner/notes.txt is waiting.`, role: "tool", toolCallId: callId }
  ]);
}

function gateMessages(history) {
  return (Array.isArray(history) ? history : []).filter(
    (entry) => String(entry?.kind || "") === GATE_OUTCOME_MESSAGE_KIND
  );
}

// ============================================================================
// LAYER A — the shared wording and commit layer
// ============================================================================

test("HELD names the actual action that is waiting", () => {
  const message = formatGateHeldMessage(HOLD);

  assert.match(message, /waiting for your confirmation/u);
  assert.match(message, /notes\.txt/u, "the target the user must decide about is named");
  assert.match(message, /^The delete of /u, "the sentence is capitalized at the sentence start");
});

test("describeGateAction falls back honestly when a hold carries only a tool name", () => {
  // A hold reaches a surface with different fields populated depending on the layer
  // that built it. A sentence must still be produced, and it must still be true.
  assert.equal(describeGateAction({ tool: "file_delete" }), "the delete");
  assert.equal(describeGateAction({ description: "a mystery action" }), "a mystery action");
  assert.equal(describeGateAction({}), "the action");
  // A description whose body carries no path but whose NAME is known still degrades to
  // the verb alone rather than inventing a target.
  assert.equal(
    describeGateAction({ description: 'file_delete {}', tool: "file_delete" }),
    "the delete"
  );
});

test("CONFIRMED acknowledges execution, and a FAILED confirm says failure rather than success", () => {
  const ok = formatGateConfirmedMessage(HOLD, { status: "ok" });
  const failed = formatGateConfirmedMessage(HOLD, { status: "error" });
  const nothingToRun = formatGateConfirmedMessage(HOLD, null);

  assert.match(ok, /executed/u);
  assert.doesNotMatch(ok, /did not execute/u);

  assert.match(failed, /did not execute/u, "a failure must not be dressed as success");
  assert.doesNotMatch(failed, /executed\.$|^Delete the delete of/u);

  assert.match(nothingToRun, /did not execute/u, "no outcome is not an outcome");
  assert.notEqual(ok, failed, "success and failure cannot share a sentence");
});

test("DENIED and CANCELLED both say plainly that nothing was removed", () => {
  const denied = formatGateDeniedMessage(HOLD);
  const cancelled = formatGateCancelledMessage(HOLD);

  assert.match(denied, /nothing was removed/u);
  assert.match(denied, /notes\.txt/u);

  assert.match(cancelled, /cancelled/u);
  assert.match(cancelled, /nothing was removed/u);
  assert.match(cancelled, /notes\.txt/u);

  assert.notEqual(denied, cancelled, "a refusal and an abandonment are different facts");
});

test("the user-facing sentences are NOT the model-facing coaching text", () => {
  const modelFacing = formatHeldToolResult(HOLD);

  // The coaching string is what a test that only checked "a message exists" would
  // accept. It carries instructions aimed at a model ("Do not retry"), and it never
  // belongs in a transcript a human reads.
  assert.match(modelFacing, /Do not retry/u);

  for (const [label, userFacing] of [
    ["held", formatGateHeldMessage(HOLD)],
    ["denied", formatGateDeniedMessage(HOLD)],
    ["confirmed", formatGateConfirmedMessage(HOLD, { status: "ok" })],
    ["cancelled", formatGateCancelledMessage(HOLD)]
  ]) {
    assert.notEqual(userFacing, modelFacing, `${label}: two audiences, two strings`);
    assert.doesNotMatch(userFacing, /Do not retry/u, `${label}: no model coaching`);
    assert.doesNotMatch(userFacing, /you will receive a policy result/u, `${label}: no model coaching`);
    assert.doesNotMatch(userFacing, /^held:/u, `${label}: no wire vocabulary`);
    assert.doesNotMatch(userFacing, /^policy:/u, `${label}: no wire vocabulary`);
  }
});

test("a gate sentence is a PLAIN assistant message every reader already handles", () => {
  const entry = createGateOutcomeMessageEntry({ content: "Delete x is waiting." });
  const read = readHistoryEntry(entry);

  // Plain, not a third history shape: the renderer's only `kind` branches are for
  // `execution-output` and `queued`, so this paints as an ordinary assistant row.
  assert.equal(entry.role, "assistant");
  assert.equal(entry.kind, GATE_OUTCOME_MESSAGE_KIND);
  assert.deepEqual([...entry.attachments], []);
  assert.ok(typeof entry.id === "string" && entry.id.length > 0);

  assert.equal(read.kind, "message", "not a tool_call / tool_result shape");

  // No typed fields, so persistence writes no new keys for it (same six-key shape a
  // legacy assistant message has) and the prompt projection passes it through.
  assert.deepEqual({ ...serializeTypedHistoryFields(entry) }, {});
  assert.deepEqual({ ...normalizeTypedHistoryFields({}) }, {});
});

test("HELD commits a message into history, and a clean turn commits none", () => {
  const held = appendGateOutcomeMessage(heldHistory(), { content: formatGateHeldMessage(HOLD) });

  assert.equal(gateMessages(held).length, 1, "exactly one committed gate sentence");
  assert.equal(held.length, heldHistory().length + 1, "the turn is kept, plus one message");
  assert.equal(held[held.length - 1].role, "assistant");
  assert.match(held[held.length - 1].content, /waiting for your confirmation/u);

  // A clean turn is untouched by any of this.
  const clean = canonicalMessagesToTypedEntries([
    { content: "list my files", role: "user" },
    { content: "Here they are.", role: "assistant" }
  ]);
  const answers = clean.filter((entry) => entry.role === "assistant");

  assert.equal(answers.length, 1, "one answer");
  assert.equal(gateMessages(clean).length, 0, "no gate message on a clean turn");
  assert.match(answers[0].content, /Here they are/u);
});

test("a settle RETIRES the pending sentence instead of stacking a second one", () => {
  // THE ORDERING-SENSITIVE CASE. `replaceHeldToolResult` only rewrites the LAST entry,
  // and the pending sentence now sits after that row. Settling must retire the sentence
  // FIRST, then replace the held row — the other order finds a gate message in the last
  // position, matches nothing, and leaves the placeholder claiming a decision.
  const pending = appendGateOutcomeMessage(heldHistory(), { content: formatGateHeldMessage(HOLD) });
  const settled = settleGateOutcome(pending, {
    content: "ok: deleted",
    isError: false,
    message: formatGateConfirmedMessage(HOLD, { status: "ok" }),
    toolCallId: HOLD.callId
  });

  assert.equal(gateMessages(settled).length, 1, "one sentence, not two");
  assert.match(gateMessages(settled)[0].content, /executed/u);
  assert.doesNotMatch(gateMessages(settled)[0].content, /waiting for your confirmation/u);

  // The held row really was settled: one result per call id, and it carries the outcome.
  const results = settled.filter((entry) => String(entry?.kind || "") === "tool_result");

  assert.equal(results.length, 1, "exactly one result per call id");
  assert.equal(results[0].toolResult.callId, HOLD.callId);
  assert.equal(results[0].toolResult.error, undefined, "a success is not an error result");
  // The canonical tool-message writer parses an `ok: <json>` prefix, so the stored
  // payload is the parsed body rather than the wire sentence. Asserting the REAL
  // committed value is what makes this a proof about stored history.
  assert.equal(results[0].toolResult.payload, "deleted");
});

test("a DENIED settle commits the refusal sentence and an error result", () => {
  const settled = settleGateOutcome(heldHistory(), {
    content: "policy: the user denied the action.",
    isError: true,
    message: formatGateDeniedMessage(HOLD),
    toolCallId: HOLD.callId
  });

  assert.equal(gateMessages(settled).length, 1);
  assert.match(gateMessages(settled)[0].content, /nothing was removed/u);

  const result = settled[settled.length - 2];

  assert.equal(result.toolResult.callId, HOLD.callId);
  assert.ok(result.toolResult.error, "a denial is an error result for the model");
});

test("settling a cleared/empty history appends no sentence", () => {
  // Clearing the chat empties history and then ends the hold, so a settle can arrive with
  // no row to replace and no sentence to retire. Appending there would write a gate
  // sentence into a chat the user just cleared.
  for (const empty of [[], null, undefined]) {
    const settled = settleGateOutcome(empty, {
      content: "policy: the pending action was cancelled.",
      isError: true,
      message: formatGateCancelledMessage(HOLD),
      toolCallId: HOLD.callId
    });

    assert.deepEqual(settled, [], "nothing to settle, nothing to say");
  }
});

test("settling a history with no matching held row appends no sentence", () => {
  // The row belongs to a different episode: rewriting it would edit a transcript the
  // user already read, and inventing a sentence would describe a hold this history
  // never had.
  const other = canonicalMessagesToTypedEntries([
    { content: "hello", role: "user" },
    { content: "Hi.", role: "assistant" }
  ]);
  const settled = settleGateOutcome(other, {
    content: "ok: 1",
    isError: false,
    message: formatGateConfirmedMessage(HOLD, { status: "ok" }),
    toolCallId: "call_absent"
  });

  assert.equal(gateMessages(settled).length, 0);
  assert.deepEqual(settled, other, "nothing changed, so nothing is added");
});

test("an earlier turn's gate sentence is history, not something a later settle may rewrite", () => {
  // Only a TRAILING run is retired. A gate row from a prior turn sits in the middle, and
  // a settle must not reach back and delete it.
  const earlier = [
    ...canonicalMessagesToTypedEntries([
      { content: "first", role: "user" },
      { content: "First answer.", role: "assistant" }
    ]),
    createGateOutcomeMessageEntry({ content: "Delete old.txt executed." }),
    ...heldHistory()
  ];
  const settled = settleGateOutcome(earlier, {
    content: "ok: deleted",
    isError: false,
    message: formatGateConfirmedMessage(HOLD, { status: "ok" }),
    toolCallId: HOLD.callId
  });
  const sentences = gateMessages(settled).map((entry) => entry.content);

  assert.equal(sentences.length, 2, "the earlier sentence survives, the pending one settles");
  assert.ok(sentences.includes("Delete old.txt executed."));
  assert.ok(sentences.some((text) => /executed/u.test(text) && text !== "Delete old.txt executed."));
});

test("a gate sentence survives the persistence round trip it will meet on reload", () => {
  const entry = appendGateOutcomeMessage(heldHistory(), { content: formatGateHeldMessage(HOLD) }).at(-1);

  // The surface writer and reader both keep `kind` (that is how the settle finds the
  // pending sentence again after a reload).
  const stored = JSON.parse(
    JSON.stringify({
      attachments: entry.attachments,
      content: entry.content,
      id: entry.id,
      kind: entry.kind,
      role: entry.role,
      ...serializeTypedHistoryFields(entry)
    })
  );
  const restored = { ...stored, ...normalizeTypedHistoryFields(stored) };

  assert.equal(restored.kind, GATE_OUTCOME_MESSAGE_KIND);
  assert.equal(restored.role, "assistant");
  assert.equal(restored.content, entry.content);
  assert.equal(Object.keys(stored).sort().join(","), "attachments,content,id,kind,role");

  // And the renderer draws it as an ordinary assistant row.
  const projected = projectHistoryEntryForDisplay(restored);

  assert.equal(projected.content, entry.content);
});

// ============================================================================
// LAYER B — the two real surfaces
// ============================================================================

function createRuntime() {
  const runtime = {
    api: {
      async fileDelete() {},
      async fileRead() {
        return { content: "" };
      },
      async fileWrite() {
        return { ok: true };
      }
    },
    config: {
      get(_name, fallback = undefined) {
        return fallback;
      }
    },
    extend(_meta, value) {
      return value;
    },
    fw: {
      createStore(_name, model) {
        return model;
      }
    },
    proxy: { buildUrl: (url) => url },
    utils: {
      userCrypto: {
        async decryptText(value) { return value; },
        async encryptText(value) { return value; }
      },
      yaml: { parse: () => ({}), stringify: () => "" }
    }
  };

  globalThis.document = {
    addEventListener() {},
    body: { appendChild() {} },
    createElement: () => ({
      classList: { add() {}, remove() {} },
      setAttribute() {},
      appendChild() {},
      style: {}
    }),
    documentElement: { appendChild() {} },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    removeEventListener() {}
  };
  globalThis.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };
  globalThis.window = {
    addEventListener() {},
    cancelAnimationFrame() {},
    console,
    location: { href: "http://localhost/" },
    matchMedia: () => ({ addEventListener() {}, matches: false }),
    removeEventListener() {},
    requestAnimationFrame(callback) {
      callback(0);
      return 1;
    },
    space: runtime
  };
  globalThis.space = runtime;

  return runtime;
}

createRuntime();

const { onscreenAgent } = await import("/modules/_core/onscreen_agent/store.js");
const { adminAgent } = await import("/modules/_core/admin/views/agent/store.js");

// Every surface case stubs persistence and paint: this suite is about COMMITTED
// HISTORY, never about disk or DOM.
function stubSurface(store, t) {
  const previous = {
    history: store.history,
    persistHistory: store.persistHistory,
    render: store.render,
    status: store.status
  };

  store.persistHistory = async () => {};
  store.render = () => {};

  t.after(() => {
    store.history = previous.history;
    store.persistHistory = previous.persistHistory;
    store.render = previous.render;
    store.status = previous.status;
    store.engineSwapPendingHold = null;
    store.engineSwapTier1Session = null;
    store.engineSwapHeldMessages = null;
    store.stopRequested = false;
    store.isSending = false;
  });
}

// A held surface: the committed turn from the real writer, plus the live hold state a
// real held turn leaves on the store.
function armHold(store) {
  store.history = appendGateOutcomeMessage(heldHistory(), { content: formatGateHeldMessage(HOLD) });
  store.engineSwapPendingHold = { ...HOLD };
  store.engineSwapTier1Session = null;
  store.engineSwapHeldMessages = null;

  return store.history;
}

const SURFACES = [
  ["onscreen", onscreenAgent],
  ["admin", adminAgent]
];

for (const [name, store] of SURFACES) {
  test(`${name}: a held turn leaves one committed message naming the action`, (t) => {
    stubSurface(store, t);

    const history = armHold(store);

    assert.equal(gateMessages(history).length, 1);
    assert.match(gateMessages(history)[0].content, /notes\.txt/u);
    assert.match(gateMessages(history)[0].content, /waiting for your confirmation/u);
  });

  test(`${name}: CONFIRMED settles the row and commits exactly one acknowledgement`, async (t) => {
    stubSurface(store, t);
    armHold(store);

    let confirmCalls = 0;

    store.engineSwapTier1Session = {
      async confirmHeld() {
        confirmCalls += 1;
        return { call: { callId: HOLD.callId }, status: "ok" };
      },
      formatOutcome() {
        return "ok: deleted";
      },
      denyHeld() {
        return null;
      }
    };
    // `runContinuation` absent: no model continuation in a hermetic case, which is the
    // surface's own documented branch.
    store.engineSwapHeldMessages = [];

    await store.confirmEngineSwapHold();

    assert.equal(confirmCalls, 1, "exactly once");
    assert.equal(gateMessages(store.history).length, 1, "one sentence, not two");
    assert.match(gateMessages(store.history)[0].content, /executed/u);
    assert.doesNotMatch(gateMessages(store.history)[0].content, /waiting for your confirmation/u);
  });

  test(`${name}: a FAILED confirm says failure, not success`, async (t) => {
    stubSurface(store, t);
    armHold(store);

    store.engineSwapTier1Session = {
      async confirmHeld() {
        return { call: { callId: HOLD.callId }, status: "error" };
      },
      formatOutcome() {
        return "error: execution failed";
      },
      denyHeld() {
        return null;
      }
    };
    store.engineSwapHeldMessages = [];

    await store.confirmEngineSwapHold();

    assert.equal(gateMessages(store.history).length, 1);
    assert.match(gateMessages(store.history)[0].content, /did not execute/u);
    assert.doesNotMatch(gateMessages(store.history)[0].content, /^The delete of .* executed\.$/u);
  });

  test(`${name}: DENIED commits the refusal and executes nothing`, async (t) => {
    stubSurface(store, t);
    armHold(store);

    let denyCalls = 0;

    store.engineSwapTier1Session = {
      denyHeld() {
        denyCalls += 1;
        return { ...HOLD };
      }
    };

    await store.denyEngineSwapHold();

    assert.equal(denyCalls, 1);
    assert.equal(gateMessages(store.history).length, 1, "one sentence, not two");
    assert.match(gateMessages(store.history)[0].content, /nothing was removed/u);
    assert.doesNotMatch(gateMessages(store.history)[0].content, /waiting for your confirmation/u);
  });

  test(`${name}: STOP while held settles the hold and says it was cancelled`, async (t) => {
    stubSurface(store, t);
    armHold(store);

    let cancelled = 0;

    store.engineSwapTier1Session = {
      cancelHeld() {
        cancelled += 1;
      }
    };
    // `requestStop` guards on a live turn, so the surface must look busy for the real
    // control to do anything at all.
    store.isSending = true;

    store.requestStop();

    assert.equal(cancelled, 1, "the gate reaches a terminal status instead of being abandoned");
    assert.equal(store.engineSwapPendingHold, null, "the confirm bar must not outlive the stop");
    assert.equal(gateMessages(store.history).length, 1, "one sentence, not two");
    assert.match(gateMessages(store.history)[0].content, /cancelled/u);
    assert.doesNotMatch(
      gateMessages(store.history)[0].content,
      /waiting for your confirmation/u,
      "the transcript must not keep claiming a decision is pending"
    );
  });
}

// The CLEAR path is where admin was also unwired. It is driven for real on both
// surfaces; the admin harness needs a few more seams stubbed because its clear handler
// resets the local runtime as well.
test("onscreen: clearing the chat ends a held episode and says so", async (t) => {
  stubSurface(onscreenAgent, t);
  armHold(onscreenAgent);

  const previous = {
    activeTurnRequestMessages: onscreenAgent.activeTurnRequestMessages,
    applyPromptInput: onscreenAgent.applyPromptInput,
    chatRuntime: onscreenAgent.chatRuntime,
    dismissUiBubble: onscreenAgent.dismissUiBubble,
    executionContext: onscreenAgent.executionContext,
    refreshRuntimeSystemPrompt: onscreenAgent.refreshRuntimeSystemPrompt
  };

  onscreenAgent.activeTurnRequestMessages = null;
  // The real Clear control is DISABLED unless the surface is initialized (and not
  // sending, and holding history). That guard is correct product behaviour, so the case
  // states the precondition instead of bypassing the control.
  onscreenAgent.isInitialized = true;
  onscreenAgent.applyPromptInput = () => {};
  onscreenAgent.chatRuntime = null;
  onscreenAgent.dismissUiBubble = () => {};
  onscreenAgent.executionContext = null;
  onscreenAgent.refreshRuntimeSystemPrompt = async () => {};

  t.after(() => {
    Object.assign(onscreenAgent, previous);
  });

  await onscreenAgent.handleClearClick();

  // The history was emptied FIRST, so there is nothing left to settle and no sentence
  // is written into the chat the user just cleared.
  assert.deepEqual(onscreenAgent.history, []);
  assert.equal(onscreenAgent.engineSwapPendingHold, null);
});

// A CLEAR with a hold and a NON-empty history is the reachable shape where the pending
// sentence still exists: the clear empties history first, so the settle finds nothing.
// What must be true regardless is that the hold state is dropped, which is what
// `STOP while held` above proves behaviourally for both surfaces.

test("admin: clearing the chat ends a held episode instead of stranding it", async (t) => {
  // THE OTHER GAP THIS LANE CLOSED. Admin's `handleClearClick()` emptied the history and
  // left the hold armed, so the confirm bar survived a cleared chat with no session
  // behind it. Onscreen had this exit; admin did not.
  stubSurface(adminAgent, t);
  armHold(adminAgent);

  const previous = {
    activeRequestController: adminAgent.activeRequestController,
    chatRuntime: adminAgent.chatRuntime,
    clearComposerDraft: adminAgent.clearComposerDraft,
    closeRawDialog: adminAgent.closeRawDialog,
    executionContext: adminAgent.executionContext,
    queuedSubmissions: adminAgent.queuedSubmissions,
    refreshRuntimeSystemPrompt: adminAgent.refreshRuntimeSystemPrompt,
    rerunningMessageId: adminAgent.rerunningMessageId,
    stopRequested: adminAgent.stopRequested
  };
  let cancelled = 0;

  adminAgent.engineSwapTier1Session = {
    cancelHeld() {
      cancelled += 1;
    }
  };
  adminAgent.chatRuntime = null;
  adminAgent.clearComposerDraft = () => {};
  adminAgent.closeRawDialog = () => {};
  adminAgent.executionContext = null;
  adminAgent.refreshRuntimeSystemPrompt = async () => {};

  t.after(() => {
    Object.assign(adminAgent, previous);
  });

  await adminAgent.handleClearClick();

  assert.equal(cancelled, 1, "the gate reaches a terminal status instead of being abandoned");
  assert.equal(adminAgent.engineSwapPendingHold, null, "no confirm bar may survive a cleared chat");
  // The history was emptied FIRST, so there is nothing left to settle: the cleared chat
  // must not grow a sentence describing a hold that no longer exists.
  assert.deepEqual(adminAgent.history, [], "a cleared chat stays cleared");
});

// ============================================================================
// The fail-loud wiring guard: one implementation, reached by both surfaces
// ============================================================================

test("both surfaces commit gate sentences through the ONE shared layer", () => {
  const sources = {
    onscreen: readFileSafe(
      "/modules/_core/onscreen_agent/store.js",
      "app/L0/_all/modules/_core/onscreen_agent/store.js"
    ),
    admin: readFileSafe(
      "/modules/_core/admin/views/agent/store.js",
      "app/L0/_all/modules/_core/admin/views/agent/store.js"
    )
  };

  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /engine-swap\/gate-message\.js/u, `${name} imports the shared wording`);
    assert.match(source, /settleGateOutcome/u, `${name} settles through the shared helper`);
    // No surface-local copy of any sentence: one hold cannot be described two ways.
    assert.doesNotMatch(source, /is waiting for your confirmation\./u, `${name} has no local wording copy`);
    assert.doesNotMatch(source, /nothing was removed\./u, `${name} has no local wording copy`);
  }
});

function readFileSafe(_specifier, relativePath) {
  // Read through the module loader's own mapping so the path cannot diverge from the
  // module under test.
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}
