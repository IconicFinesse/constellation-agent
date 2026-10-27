// Focused engine-swap P2 coverage for the Tier 1 branch's PAINT ordering.
//
// The live bug this pins: on a Tier 1 session the user's own message did not appear
// until the assistant reply landed, and on the first message of a fresh chat the
// window stayed blank until then, at which point both messages appeared together.
//
// Cause: the Tier 1 branch of `runConversationLoop` rendered BEFORE the user's turn
// entered `this.history`, so `render()` drew the PREVIOUS turn. On a fresh chat the
// history was empty, `renderMessages` took its empty-state early return
// (thread-view.js:1629-1631) and painted nothing at all. The Tier 3 branch above it
// has always written history before rendering.
//
// These assertions are about ORDER, not about markup: the render seam is stubbed and
// records the exact `getRenderHistory()` projection the thread view would have
// consumed, so a render that happens before the history write is visible as a red
// test rather than as a plausible-looking unit test that never draws anything.
//
// Harness note (same trap the store-wiring suite documents): the execution sandbox
// resolves `space` from the TARGET WINDOW, so both `globalThis.space` and
// `window.space` are wired.
//
// Hermetic: transport, persistence and render are all stubbed. No disk, no DOM, no
// network. The Tier 1 tier is reached through the REAL flag + capability seam, so a
// change to that seam breaks this suite loudly instead of silently skipping it.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const DISPATCH_FLAG = "ENGINE_SWAP_DISPATCH";

function createHarness() {
  const runtime = {
    api: {},
    // Default OFF; each test flips this through the same reader the product uses.
    configValues: new Map(),
    config: {
      get(name, fallback = undefined) {
        return runtime.configValues.has(name) ? runtime.configValues.get(name) : fallback;
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
      callback(0);
      return 1;
    },
    // The compact-mode bubble path (store.js:2912) schedules a hide timer. It is
    // stubbed out below by switching to full mode, but a stray call must not throw
    // in a suite that is about paint ORDER.
    setTimeout,
    clearTimeout
  };
  globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.space = runtime;

  return runtime;
}

const runtime = createHarness();
const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

// Everything the loop touches outside the branch decision under test. `render`
// records the projection the thread view would receive; that recording IS the
// evidence, because a render that draws nothing cannot be told apart from a render
// that was never called by reading state afterwards.
function stubSurface(t) {
  const previous = {
    displayMode: store.displayMode,
    executeAssistantBlocks: store.executeAssistantBlocks,
    history: store.history,
    persistHistory: store.persistHistory,
    preparePromptRequest: store.preparePromptRequest,
    queuedSubmissions: store.queuedSubmissions,
    refreshPromptInputFromHistory: store.refreshPromptInputFromHistory,
    render: store.render,
    runTier1ConversationTurn: store.runTier1ConversationTurn,
    settings: store.settings,
    status: store.status,
    stopRequested: store.stopRequested,
    streamAssistantResponse: store.streamAssistantResponse
  };

  const paints = [];

  // Full mode: this suite is about paint ORDER, and the compact-mode opinion
  // bubble (`showCompactAssistantReplyBubble`) is a different surface that would
  // drag DOM and timers into the harness without testing anything here.
  store.displayMode = "full";
  store.persistHistory = async () => {};
  // The prompt runtime loads real prompt files over `fetch`; prompt CONTENT is not
  // what this suite measures, only the order of the history write and the render.
  store.refreshPromptInputFromHistory = async () => null;
  store.render = () => {
    // THIS is what `renderMessages` would have been handed.
    paints.push({
      historyIds: (Array.isArray(store.history) ? store.history : []).map((entry) => String(entry?.id || "")),
      renderedContents: store
        .getRenderHistory()
        .map((entry) => String(entry?.content || ""))
    });
  };
  store.chatRuntime = {
    attachments: {
      rememberMessageAttachments() {},
      setActiveMessage() {}
    }
  };
  store.queuedSubmissions = [];

  const restore = () => {
    store.displayMode = previous.displayMode;
    store.executeAssistantBlocks = previous.executeAssistantBlocks;
    store.history = previous.history;
    store.persistHistory = previous.persistHistory;
    store.preparePromptRequest = previous.preparePromptRequest;
    store.queuedSubmissions = previous.queuedSubmissions;
    store.refreshPromptInputFromHistory = previous.refreshPromptInputFromHistory;
    store.render = previous.render;
    store.runTier1ConversationTurn = previous.runTier1ConversationTurn;
    store.settings = previous.settings;
    store.status = previous.status;
    store.stopRequested = previous.stopRequested;
    store.streamAssistantResponse = previous.streamAssistantResponse;
  };

  t.after(restore);

  return { paints, restore };
}

const USER_TURN = Object.freeze({ attachments: [], content: "read my notes", id: "u1", role: "user" });

function preparedRequestFor(userTurn) {
  return {
    messages: [
      { content: "You are a test agent.", role: "system" },
      { content: userTurn.content, role: "user" }
    ],
    promptInput: {
      requestMessages: [
        { content: "You are a test agent.", role: "system" },
        { content: userTurn.content, role: "user" }
      ],
      systemPrompt: "You are a test agent."
    }
  };
}

// A canned Tier 1 turn whose message list is shaped like the real one: the WIRE
// messages followed by the assistant reply. The commit slices at the wire length,
// so a shorter list here would silently commit nothing and the determinism check
// below would pass for the wrong reason.
function cannedTier1Turn(userTurn) {
  const wireMessages = [
    { content: "You are a test agent.", role: "system" },
    { content: userTurn.content, role: "user" }
  ];

  return {
    result: {
      answer: "Your notes say hello.",
      messages: [...wireMessages, { content: "Your notes say hello.", role: "assistant" }],
      status: "answered",
      turns: []
    },
    session: null,
    wireMessageCount: wireMessages.length
  };
}

function setupTier1(t, { paints, restore }) {
  runtime.configValues.set(DISPATCH_FLAG, true);

  t.after(() => {
    runtime.configValues.delete(DISPATCH_FLAG);
    restore();
  });

  store.settings = {
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: "test-key",
    maxTokens: undefined,
    model: "gpt-x",
    provider: ""
  };
  store.stopRequested = false;
  store.status = "";
  store.preparePromptRequest = async () => preparedRequestFor(USER_TURN);
  store.runTier1ConversationTurn = async () => cannedTier1Turn(USER_TURN);

  return paints;
}

test("Tier 1 paints the user's own turn BEFORE the request, on a fresh chat", async (t) => {
  const surface = stubSurface(t);
  setupTier1(t, surface);

  // Fresh chat: nothing has ever been rendered.
  store.history = [];

  const outcome = await store.runConversationLoop(USER_TURN);

  assert.equal(outcome, "complete", "the canned turn must complete normally");
  assert.ok(surface.paints.length >= 1, "at least one render must happen during the turn");

  const firstPaint = surface.paints[0];

  assert.ok(
    firstPaint.historyIds.includes("u1"),
    `the user's turn must be in history at the FIRST render (saw ${JSON.stringify(firstPaint.historyIds)})`
  );
  // The empty-state early return in thread-view.js:1629-1631 is taken when the
  // projection is empty, and then NOTHING is drawn. A non-empty projection is what
  // makes the first paint visible at all.
  assert.ok(
    firstPaint.renderedContents.length > 0,
    "the first render must hand a NON-EMPTY projection to the thread view, or the window stays blank"
  );
  assert.ok(
    firstPaint.renderedContents.some((content) => content.includes("read my notes")),
    `the first paint must draw the user's text (saw ${JSON.stringify(firstPaint.renderedContents)})`
  );
});

test("Tier 1 keeps the user's turn in history when the transport fails", async (t) => {
  const surface = stubSurface(t);
  setupTier1(t, surface);

  // `runConversationLoop` only wraps request PREPARATION; a thrown turn propagates
  // to `runSubmissionSeries`, which owns the submission-level catch. Drive the real
  // entry point so the assertion is about the product's failure contract rather
  // than about a test-only call shape.
  const previousFocusInput = store.focusInput;
  const previousReportError = store.reportError;

  t.after(() => {
    store.focusInput = previousFocusInput;
    store.reportError = previousReportError;
  });

  store.focusInput = () => {};
  // `reportError` raises a toast, which is DOM. Record the status text instead: the
  // assertion is that the fault is REPORTED, not how it is painted.
  store.reportError = (context, error) => {
    store.status = `Error ${context}: ${error?.message || error}`;

    return store.status;
  };
  store.history = [];
  store.runTier1ConversationTurn = async () => {
    throw new Error("transport exploded");
  };

  // The series reports the fault and re-renders; it must not swallow the user's
  // turn on the way out.
  await store.runSubmissionSeries(USER_TURN);

  assert.match(store.status, /transport exploded/u, "the failure must be reported, never silent");
  assert.ok(
    store.history.some((entry) => entry?.id === "u1"),
    "a failed turn must not erase what the user actually said"
  );
});

test("Tier 1 commit still rewrites history as the request plus the reply", async (t) => {
  const surface = stubSurface(t);
  setupTier1(t, surface);

  store.history = [];

  await store.runConversationLoop(USER_TURN);

  const ids = store.history.map((entry) => String(entry?.id || ""));

  assert.equal(ids[0], "u1", "the committed history starts with the user's turn");
  assert.equal(store.history.length, 2, "request plus exactly one assistant reply");
  assert.equal(store.history[1].role, "assistant");
  assert.match(store.history[1].content, /Your notes say hello/u);
});

test("display-only derivation after a Tier 1 turn matches a fresh derivation (reload determinism)", async (t) => {
  const surface = stubSurface(t);
  setupTier1(t, surface);

  store.history = [];

  await store.runConversationLoop(USER_TURN);

  // What the RELOAD path computes from the persisted history...
  const derivedOnRestore = store.collectEngineSwapDisplayOnlyIds(store.history, store.executionOutputOverrides);
  // ...must equal what the live session is holding.
  const live = store.engineSwapDisplayOnlyMessageIds;

  assert.deepEqual(
    [...live].sort(),
    [...derivedOnRestore].sort(),
    "the live display-only set must be reproducible from persisted history alone"
  );
});

test("the text path (dispatch off) still writes history before rendering", async (t) => {
  const surface = stubSurface(t);

  t.after(() => {
    runtime.configValues.delete(DISPATCH_FLAG);
  });

  // Dispatch OFF: the loop keeps the unchanged Tier 3 branch.
  runtime.configValues.set(DISPATCH_FLAG, false);

  store.settings = {
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: "test-key",
    maxTokens: undefined,
    model: "gpt-x",
    provider: ""
  };
  store.stopRequested = false;
  store.status = "";
  store.history = [];
  store.preparePromptRequest = async () => preparedRequestFor(USER_TURN);
  store.streamAssistantResponse = async (_requestMessages, assistantMessage) => {
    assistantMessage.content = "streamed answer";
    return { hasContent: true, responseMeta: null, stopped: false };
  };
  store.executeAssistantBlocks = async () => [];

  const outcome = await store.runConversationLoop(USER_TURN);

  assert.equal(outcome, "complete");

  const firstPaint = surface.paints[0];

  assert.ok(firstPaint.historyIds.includes("u1"), "Tier 3 must keep painting the user's turn first");
  assert.ok(firstPaint.renderedContents.length > 0, "Tier 3's first paint must stay non-empty");
});
