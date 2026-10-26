// Engine-swap P2 live hotfix: guaranteed exit for execution chips on Tier 1.
//
// THE DEFECT (owner-reported, staging VM, dispatch flag ON). On Tier 1 a model
// answered a file request with separator-bearing prose (`_____javascript` plus code)
// and NO typed tool call. The turn ended correctly, but the on-screen chip stayed at
// "Executing N lines of code" forever: the chip's running state was derived from
// `isConversationBusy`, that flag was not part of the row's render signature, and on
// Tier 1 no execution result can ever arrive to settle it. A state nothing can leave
// is the guaranteed-exit violation this suite pins.
//
// Four contracts:
//   1. a Tier 1 text-only separator turn renders a TERMINAL chip (display-only),
//      never `running`, even while the surface is still busy
//   2. Tier 3 keeps its existing states byte-identically (a real busy turn still
//      reads `running`; a settled turn with no override still reads settled)
//   3. the execute-section render signature CHANGES on busy -> settled, so the row
//      built mid-turn cannot be reused with a stale spinner
//   4. the store records exactly the separator-bearing assistant ids of a Tier 1
//      turn, cumulatively, using the SHARED fence-aware separator test
//
// Hermetic: no network, no keys, no disk. The store half reuses the documented
// global/window `space` wiring (the execution sandbox resolves `space` from the
// TARGET WINDOW, so both are wired) and stubs persistence/render seams.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const threadView = await import("/modules/_core/visual/conversation/thread-view.js");
const {
  EXECUTION_DISPLAY_ONLY_LABEL,
  EXECUTION_DISPLAY_ONLY_OUTPUT_TEXT,
  EXECUTION_DISPLAY_ONLY_STATE,
  createAgentThreadView,
  resolveExecutionCardState
} = threadView;

// --- 1. the resolver: a known-unexecuted message can never read `running` -----

test("a message known to be unexecuted never resolves to running, even while busy", () => {
  const busy = resolveExecutionCardState({ isConversationBusy: true });

  // The pre-existing busy reading is untouched for every other message.
  assert.equal(busy.pendingState, "running");

  // ...but the fact outranks the inference.
  const displayOnly = resolveExecutionCardState({ displayOnly: true, isConversationBusy: true });

  assert.equal(displayOnly.pendingState, EXECUTION_DISPLAY_ONLY_STATE);
  assert.notEqual(displayOnly.pendingState, "running");
  // Not the spinner: a spinning icon is the visual claim that work is in flight.
  assert.notEqual(displayOnly.iconName, "sync");
  assert.notEqual(displayOnly.tone, "is-running");
  // ...and it is terminal: it does not depend on the busy flag at all.
  assert.deepEqual(
    resolveExecutionCardState({ displayOnly: true, isConversationBusy: false }),
    displayOnly,
    "the terminal state must not change when the turn ends"
  );
});

// --- 2. Tier 3 states are unchanged -----------------------------------------

test("tier 3 chip states are byte-identical to before the fix", () => {
  // Streaming still writes code.
  assert.deepEqual(resolveExecutionCardState({ isStreaming: true }), {
    iconName: "edit_note",
    pendingState: "generating",
    tone: "is-writing"
  });

  // Busy with no results still runs (Tier 3 gets its results from execution).
  assert.deepEqual(resolveExecutionCardState({ isConversationBusy: true }), {
    iconName: "sync",
    pendingState: "running",
    tone: "is-running"
  });

  // Explicit rerun still runs.
  assert.deepEqual(resolveExecutionCardState({ isRerunning: true }), {
    iconName: "sync",
    pendingState: "running",
    tone: "is-running"
  });

  // Success and error keep their tones and carry no pending state.
  assert.deepEqual(resolveExecutionCardState({ hasResults: true }), {
    iconName: "check_circle",
    pendingState: "",
    tone: "is-success"
  });
  assert.deepEqual(resolveExecutionCardState({ hasError: true, hasResults: true }), {
    iconName: "error",
    pendingState: "",
    tone: "is-error"
  });

  // The settled no-result fallback is still the old fallback, NOT display-only.
  const settled = resolveExecutionCardState({});

  assert.equal(settled.pendingState, "");
  assert.equal(settled.tone, "is-pending");

  // A streaming turn outranks the display-only flag: live text is still arriving.
  assert.equal(
    resolveExecutionCardState({ displayOnly: true, isStreaming: true }).pendingState,
    "generating"
  );
});

// --- 3. the render signature covers the busy -> settled transition -----------

const SEPARATOR = "_____javascript";
const SEPARATOR_CONTENT = `Reading notes.txt now.\n${SEPARATOR}\nreturn await space.api.fileRead("~/notes.txt")`;

function makeView() {
  // Construction is config-only: no DOM is touched until a render call.
  return createAgentThreadView({});
}

function makeExecuteGroup({ displayOnly = false, id = "assistant-1", messageId = "assistant-1" } = {}) {
  const message = { content: SEPARATOR_CONTENT, id: messageId, role: "assistant" };

  return {
    sections: [
      {
        displayOnly,
        executeDisplay: { blocks: ["return await space.api.fileRead('~/notes.txt')"], narration: "Reading notes.txt now." },
        message,
        outputResults: null,
        type: "execute"
      }
    ],
    type: "assistant-sequence"
  };
}

test("a tier 3 execute row re-renders when the turn settles", () => {
  const view = makeView();
  const group = makeExecuteGroup();

  const busy = view.getGroupRenderSignature(group, { isConversationBusy: true });
  const settled = view.getGroupRenderSignature(group, { isConversationBusy: false });

  assert.notEqual(
    busy,
    settled,
    "without the resolved state in the signature the mid-turn row is reused and spins forever"
  );
  assert.ok(busy.includes("running"));
  assert.ok(!settled.includes("running"));
});

test("a tier 1 display-only row keeps one terminal signature across the turn end", () => {
  const view = makeView();
  const group = makeExecuteGroup({ displayOnly: true });

  const busy = view.getGroupRenderSignature(group, { isConversationBusy: true });
  const settled = view.getGroupRenderSignature(group, { isConversationBusy: false });

  assert.ok(busy.includes(EXECUTION_DISPLAY_ONLY_STATE));
  assert.ok(!busy.includes("running"));
  // Terminal: the end of the turn changes nothing, so the chip cannot flip back.
  assert.equal(busy, settled);
});

test("the display-only state carries an honest, non-running label and output line", () => {
  assert.equal(EXECUTION_DISPLAY_ONLY_LABEL, "Shown, not executed");
  assert.equal(EXECUTION_DISPLAY_ONLY_OUTPUT_TEXT, "Nothing was executed.");
  // The label must not claim execution, and must not claim a pending wait.
  assert.ok(!/execut/i.test(EXECUTION_DISPLAY_ONLY_LABEL.replace("not executed", "")));
  assert.ok(!/running|executing/i.test(EXECUTION_DISPLAY_ONLY_OUTPUT_TEXT));
});

// --- 4. the store records exactly the unexecuted separator ids ----------------

function createHarness() {
  const runtime = {
    api: {},
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
    proxy: {
      buildUrl(url) {
        return url;
      }
    }
  };

  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
    createElement() {
      return {
        classList: { add() {}, remove() {} },
        setAttribute() {},
        append() {},
        appendChild() {},
        style: {}
      };
    },
    body: { appendChild() {} },
    documentElement: { appendChild() {} }
  };
  globalThis.window = {
    space: runtime,
    console,
    addEventListener() {},
    removeEventListener() {},
    location: { href: "http://localhost/" },
    matchMedia() {
      return { addEventListener() {}, matches: false };
    },
    requestAnimationFrame(callback) {
      return setTimeout(callback, 0);
    },
    cancelAnimationFrame(id) {
      clearTimeout(id);
    },
    // The store's compact-bubble lifecycle schedules auto-hide through the WINDOW.
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.space = runtime;

  return runtime;
}

createHarness();

const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

test("only separator-bearing assistant text is recorded as shown-not-executed", (t) => {
  const previous = store.engineSwapDisplayOnlyMessageIds;

  t.after(() => {
    store.engineSwapDisplayOnlyMessageIds = previous;
  });

  const ids = store.collectEngineSwapDisplayOnlyIds([
    { content: SEPARATOR_CONTENT, id: "a-separator", role: "assistant" },
    { content: "just prose, nothing to run", id: "a-plain", role: "assistant" },
    // A separator inside a fence is DISPLAY text: it never starts an execution, so
    // it must not be reported as shown-not-executed either (the shared classifier).
    { content: "```js\n" + SEPARATOR + "\nrun()\n```", id: "a-fenced", role: "assistant" },
    // A tool result is a user-role entry; nothing here is a rendered assistant chip.
    { content: SEPARATOR_CONTENT, id: "r-1", role: "user", toolResult: { callId: "c1" }, kind: "tool_result" }
  ]);

  assert.deepEqual([...ids], ["a-separator"]);
});

test("a tier 1 text-only separator turn records its chip as terminal", async (t) => {
  const previousState = {
    history: store.history,
    persistHistory: store.persistHistory,
    render: store.render,
    runTier1ConversationTurn: store.runTier1ConversationTurn,
    displayOnly: store.engineSwapDisplayOnlyMessageIds
  };

  store.persistHistory = async () => {};
  store.render = () => {};
  store.engineSwapDisplayOnlyMessageIds = new Set();
  store.runTier1ConversationTurn = async () => ({
    result: {
      answer: SEPARATOR_CONTENT,
      messages: [
        { content: "read my notes", role: "user" },
        { content: SEPARATOR_CONTENT, role: "assistant" }
      ],
      status: "answered"
    },
    session: {}
  });

  t.after(() => {
    store.history = previousState.history;
    store.persistHistory = previousState.persistHistory;
    store.render = previousState.render;
    store.runTier1ConversationTurn = previousState.runTier1ConversationTurn;
    store.engineSwapDisplayOnlyMessageIds = previousState.displayOnly;
  });

  const outcome = await store.runTier1TurnAndCommit(
    [{ content: "read my notes", id: "u1", role: "user" }],
    { messages: [{ content: "read my notes", id: "u1", role: "user" }] },
    { tier: "tier1" }
  );

  assert.equal(outcome, "complete");

  const recorded = [...store.engineSwapDisplayOnlyMessageIds];

  assert.equal(recorded.length, 1, "the separator answer must settle its chip");
  assert.ok(recorded[0].startsWith("assistant-"), "the recorded id is the assistant entry");

  // A later turn must not resurrect (or drop) the earlier terminal chip. The call
  // shape matters: the real loop always passes the WHOLE history plus the new user
  // message, so the re-derivation sees the earlier assistant entry again.
  const historyAfterFirstTurn = [...store.history];

  store.runTier1ConversationTurn = async () => ({
    result: { answer: "done", messages: [{ content: "thanks", role: "user" }, { content: "done", role: "assistant" }], status: "answered" },
    session: {}
  });

  await store.runTier1TurnAndCommit(
    [...historyAfterFirstTurn, { content: "thanks", id: "u2", role: "user" }],
    { messages: [...historyAfterFirstTurn, { content: "thanks", id: "u2", role: "user" }] },
    { tier: "tier1" }
  );

  assert.deepEqual(
    [...store.engineSwapDisplayOnlyMessageIds],
    recorded,
    "an earlier terminal chip must stay terminal while a later turn runs"
  );
});

// --- 5. audit round 1: the set must survive a RELOAD -------------------------
//
// Blocker 1: the set was memory-only, so after a refresh a never-executed message
// fell back to the label that claims `Executed N lines`. Deriving from the restored
// history removes the persistence question entirely.

test("restoring persisted history re-derives which messages were never executed", async (t) => {
  const previousHistory = store.history;
  const previousSet = store.engineSwapDisplayOnlyMessageIds;
  const previousOverrides = store.executionOutputOverrides;

  store.executionOutputOverrides = Object.create(null);

  t.after(() => {
    store.history = previousHistory;
    store.engineSwapDisplayOnlyMessageIds = previousSet;
    store.executionOutputOverrides = previousOverrides;
  });

  // Exactly what startup restores: a Tier 1 separator answer that never executed,
  // and a separator answer that DID execute (its framework follow-up carries the
  // results). Ids are the persisted ones, verbatim.
  await store.replaceHistory(
    [
      { content: "read my notes", id: "user-1", kind: "", role: "user" },
      { content: SEPARATOR_CONTENT, id: "assistant-1", kind: "", role: "assistant" },
      { content: "and delete the temp file", id: "user-2", kind: "", role: "user" },
      { content: SEPARATOR_CONTENT, id: "assistant-3", kind: "", role: "assistant" },
      { content: "execution ok", id: "user-4", kind: "execution-output", role: "user" }
    ],
    { refreshPrompt: false }
  );

  assert.deepEqual(
    [...store.engineSwapDisplayOnlyMessageIds],
    ["assistant-1"],
    "after restore only the message WITHOUT results is shown-not-executed"
  );
});

// --- 6. audit round 1: a rerun settles the card out of display-only ----------

test("a rerun that produces real results ends the display-only claim", async (t) => {
  const previousState = {
    chatRuntime: store.chatRuntime,
    executionOutputOverrides: store.executionOutputOverrides,
    executeAssistantBlocks: store.executeAssistantBlocks,
    history: store.history,
    isSending: store.isSending,
    render: store.render,
    rerunningMessageId: store.rerunningMessageId,
    status: store.status
  };
  const messageId = "assistant-1";
  const ranResults = [{ outputLines: ["result\u2193", "notes"], status: "success" }];

  store.history = [
    { content: "read my notes", id: "user-1", kind: "", role: "user" },
    { content: SEPARATOR_CONTENT, id: messageId, kind: "", role: "assistant" }
  ];
  store.executionOutputOverrides = Object.create(null);
  store.engineSwapDisplayOnlyMessageIds = new Set([messageId]);
  store.chatRuntime = { attachments: { setActiveMessage() {} } };
  store.render = () => {};
  store.isSending = false;
  store.executeAssistantBlocks = async () => ranResults;

  t.after(() => {
    store.chatRuntime = previousState.chatRuntime;
    store.executionOutputOverrides = previousState.executionOutputOverrides;
    store.executeAssistantBlocks = previousState.executeAssistantBlocks;
    store.history = previousState.history;
    store.isSending = previousState.isSending;
    store.render = previousState.render;
    store.rerunningMessageId = previousState.rerunningMessageId;
    store.status = previousState.status;
  });

  const button = {
    blur() {},
    dataset: { terminalAction: "rerun", terminalMessageId: messageId }
  };
  const event = {
    target: {
      closest(selector) {
        return selector === "[data-terminal-action]" ? button : null;
      }
    }
  };

  store.refs.thread = { contains: () => true };

  await store.handleThreadClick(event);

  // The code really ran, so the override now holds its output...
  assert.equal(store.executionOutputOverrides[messageId].length, ranResults.length);
  // ...and the message is no longer eligible to be called unexecuted.
  assert.equal(
    store.engineSwapDisplayOnlyMessageIds.has(messageId),
    false,
    "an executed message must stop claiming it was only shown"
  );

  // Label, icon and output pane all describe the execution now: the resolver and
  // the render signature agree that this card is executed, not display-only.
  const settled = resolveExecutionCardState({ displayOnly: true, hasResults: true });

  assert.notEqual(settled.pendingState, EXECUTION_DISPLAY_ONLY_STATE);
  assert.equal(settled.tone, "is-success");

  // With the rerun's results present and the id no longer in the set, the render
  // signature carries the executed state, not the display-only one.
  const rerunGroup = makeExecuteGroup();

  rerunGroup.sections[0].outputResults = ranResults;

  const signature = createAgentThreadView({}).getGroupRenderSignature(rerunGroup, {
    isConversationBusy: false
  });

  assert.ok(!signature.includes(EXECUTION_DISPLAY_ONLY_STATE));
  assert.ok(signature.includes("is-success") || signature.includes("check_circle") || !signature.includes("running"));
});

// --- 7. audit round 1: "no results" is a real eligibility condition ----------

test("a separator message WITH results is never recorded as shown-not-executed", (t) => {
  const previous = store.engineSwapDisplayOnlyMessageIds;

  t.after(() => {
    store.engineSwapDisplayOnlyMessageIds = previous;
  });

  const withOverride = store.collectEngineSwapDisplayOnlyIds(
    [{ content: SEPARATOR_CONTENT, id: "assistant-1", role: "assistant" }],
    { "assistant-1": [{ outputLines: ["ran"], status: "success" }] }
  );

  assert.equal(withOverride.size, 0, "results override means it executed");

  const withFollowUp = store.collectEngineSwapDisplayOnlyIds([
    { content: SEPARATOR_CONTENT, id: "assistant-1", role: "assistant" },
    { content: "execution ok", id: "user-2", kind: "execution-output", role: "user" }
  ]);

  assert.equal(withFollowUp.size, 0, "a framework results turn means it executed");

  // The control: the same message with no results anywhere IS display-only.
  const withoutResults = store.collectEngineSwapDisplayOnlyIds([
    { content: SEPARATOR_CONTENT, id: "assistant-1", role: "assistant" }
  ]);

  assert.deepEqual([...withoutResults], ["assistant-1"]);
});
