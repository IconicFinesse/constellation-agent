// P7-2 — THE FALLBACK NOTICE.
//
// Since v1.5.0 BETA the typed tool loop is the DEFAULT engine, so a session whose
// config does not resolve the `tools` capability falls back to the legacy text
// protocol. Before this lane that fallback was one console line, which is
// invisible in a live chat — exactly how the previous default hid itself. The
// store now writes a once-per-config notice into the conversation.
//
// THE CLAIM THIS SUITE EARNS: that notice actually fires.
//
// Nothing else in the tree proves it. Every existing node suite resolves
// ENGINE_SWAP_DISPATCH as ABSENT (a Map-backed config with no entry returns the
// fallback `false`), so the notice branch has never executed under test before
// this file. A green suite that never ran the new code is the failure this
// campaign has been burned by more than once.
//
// HOW THE TOAST IS OBSERVED. `visual/chrome/toast.js` looks its runtime up on
// `globalThis[TOAST_RUNTIME_KEY]` ("__spaceToastRuntime"). This suite installs
// that key with a recording container, so the REAL `showToast` runs its own
// record-building path with its own `document.createElement` calls and appends
// its own element to that container. Every assertion below reads what that
// element actually says — message text, tone class and ARIA role — which a mock
// of our own module could never prove.
//
// Hermetic: no disk, no network, no real timers.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

// --- minimal DOM ------------------------------------------------------------

// Just enough node for `toast.js` to build a real record: element creation,
// class lists, attributes, text and append. `onAppend` is the injection point
// case 6 uses to make the REAL `showToast` throw from inside its own body.
class StubNode {
  constructor(tagName = "div", options = {}) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.className = options.className || "";
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
    this.onAppend = null;
    this._attributes = {};
    this._text = "";
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/u).filter(Boolean));
        names.forEach((name) => current.add(name));
        this.className = Array.from(current).join(" ");
      },
      contains: (name) => this.className.split(/\s+/u).filter(Boolean).includes(name),
      remove: (...names) => {
        const remove = new Set(names);
        this.className = this.className
          .split(/\s+/u)
          .filter((name) => name && !remove.has(name))
          .join(" ");
      }
    };
  }

  get childNodes() {
    return this.children;
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text;
  }

  set textContent(value) {
    this._text = String(value === undefined || value === null ? "" : value);
    this.children = [];
  }

  setAttribute(name, value) {
    this._attributes[name] = String(value);
  }

  getAttribute(name) {
    return this._attributes[name] ?? null;
  }

  addEventListener() {}

  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }

  appendChild(node) {
    if (this.onAppend) {
      // Deliberately BEFORE the node is attached: a notice that blew up halfway
      // must not leave a half-built toast that reads as a delivered notice.
      this.onAppend(node);
    }

    if (node) {
      node.parentNode = this;
      this.children.push(node);
    }

    return node;
  }

  remove() {
    const parent = this.parentNode;

    if (parent) {
      parent.children = parent.children.filter((child) => child !== this);
      this.parentNode = null;
    }
  }
}

globalThis.Node = { TEXT_NODE: 3 };

globalThis.document = {
  addEventListener() {},
  body: new StubNode("body"),
  createElement: (tagName) => new StubNode(tagName),
  createTextNode(value) {
    const node = new StubNode("#text");
    node.nodeType = 3;
    node.textContent = value;
    return node;
  },
  documentElement: null,
  getElementById() {
    return null;
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  }
};

// Real timers would hold the process open for the toast's 8s dismiss delay, so
// timeouts are recorded and never scheduled. Nothing this suite asserts depends
// on a timer firing.
const pendingTimers = new Map();
let nextTimerId = 1;

globalThis.window = {
  addEventListener() {},
  cancelAnimationFrame() {},
  clearTimeout(id) {
    pendingTimers.delete(id);
  },
  console,
  location: { href: "http://localhost/" },
  matchMedia: () => ({ addEventListener() {}, matches: false }),
  removeEventListener() {},
  requestAnimationFrame(callback) {
    callback(0);
    return 1;
  },
  setTimeout(callback, delay) {
    const id = nextTimerId;
    nextTimerId += 1;
    pendingTimers.set(id, { callback, delay });
    return id;
  }
};

// THE RECORDING TOAST STACK. `toast.js` finds this under its own runtime key and
// uses it instead of building a container, so the product's real function runs
// unchanged and its output lands somewhere this suite can read.
const toastContainer = new StubNode("div", { className: "space-toast-stack" });
globalThis.__spaceToastRuntime = { container: toastContainer };

// --- the product's own runtime object ---------------------------------------

const runtime = {
  api: {},
  config: {
    get(name, fallback = undefined) {
      return runtime.configValues.has(name) ? runtime.configValues.get(name) : fallback;
    }
  },
  configValues: new Map(),
  extend: (_meta, value) => value,
  fw: { createStore: (_name, model) => model },
  proxy: { buildUrl: (url) => url }
};

Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: null } });

globalThis.space = runtime;
globalThis.window.space = runtime;
globalThis.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
globalThis.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };

const { resolveOnscreenTier1Plan } = await import("/modules/_core/onscreen_agent/engine-swap-dispatch.js");
const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

// --- fixtures ---------------------------------------------------------------

const NEURALWATT_ENDPOINT = "https://api.neuralwatt.com/v1/chat/completions";

// The provider-truth table carries an explicit `tools: false` rule for this
// model, so it is the realistic "deployed daily-driver that the beta is not
// testing" case. Resolution is PROBED below rather than assumed.
const FALLBACK_CONFIG = Object.freeze({ apiEndpoint: NEURALWATT_ENDPOINT, model: "qwen-3.8-27b" });

// A different fallback with a DIFFERENT diagnostics string at the SAME tier: an
// unrecognized provider. This is what makes case 4 prove the notice key is more
// than the tier.
const FALLBACK_CONFIG_B = Object.freeze({ apiEndpoint: "https://api.example.invalid/v1", model: "mystery-model-9000" });

// Resolves the tools capability, so the typed tool loop is the engine.
const TIER1_CONFIG = Object.freeze({ apiEndpoint: NEURALWATT_ENDPOINT, model: "deepseek-v4.1-flash" });

const USER_TURN = (id = "u1") => ({ attachments: [], content: "read my notes", id, role: "user" });

const NOTICE_PATTERN = /legacy engine/iu;

function useDispatch(dispatchOn) {
  // Written EXACTLY the way the product reads it. An absent entry would resolve
  // to the reader's fallback, which is now `false` at the params layer — but the
  // point of being explicit here is that a case can never silently inherit the
  // other column.
  runtime.configValues.set("ENGINE_SWAP_DISPATCH", dispatchOn === true);
}

function useConfig(config) {
  store.settings = { apiKey: "k", provider: "", ...config };
}

function stubStoreSurface(t) {
  const previous = {
    chatRuntime: store.chatRuntime,
    displayMode: store.displayMode,
    engineSwapFallbackNoticeShownFor: store.engineSwapFallbackNoticeShownFor,
    executeAssistantBlocks: store.executeAssistantBlocks,
    focusInput: store.focusInput,
    getConfiguredMaxTokens: store.getConfiguredMaxTokens,
    history: store.history,
    isSending: store.isSending,
    persistHistory: store.persistHistory,
    preparePromptRequest: store.preparePromptRequest,
    queuedSubmissions: store.queuedSubmissions,
    refs: store.refs,
    refreshPromptInputFromHistory: store.refreshPromptInputFromHistory,
    render: store.render,
    reportError: store.reportError,
    runTier1ConversationTurn: store.runTier1ConversationTurn,
    settings: store.settings,
    status: store.status,
    stopRequested: store.stopRequested,
    streamAssistantResponse: store.streamAssistantResponse
  };

  store.displayMode = "full";
  store.refs = { ...(store.refs || {}), scroller: null, thread: new StubNode("div") };
  store.persistHistory = async () => {};
  store.refreshPromptInputFromHistory = async () => null;
  store.getConfiguredMaxTokens = () => 1_000_000;
  store.focusInput = () => {};
  store.render = () => {};
  store.executeAssistantBlocks = async () => [];
  store.queuedSubmissions = [];
  store.chatRuntime = { attachments: { rememberMessageAttachments() {}, setActiveMessage() {} } };
  store.reportError = (context, error) => {
    store.status = `Error ${context}: ${error?.message || error}`;
  };
  // The notice keys off resolved config, so it persists across turns by design.
  // Reset per case so each case proves its own firings.
  store.engineSwapFallbackNoticeShownFor = "";

  t.after(() => {
    Object.assign(store, previous);
  });
}

function resetToastStack() {
  toastContainer.children = [];
  toastContainer.onAppend = null;
  pendingTimers.clear();
}

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

// One REAL conversation-loop turn on the legacy text protocol. The transport is
// canned, nothing above it is.
function stubLegacyTransport() {
  store.streamAssistantResponse = async (_requestMessages, assistantMessage) => {
    assistantMessage.content = "legacy answer";
    return { hasContent: true, responseMeta: null, stopped: false };
  };
}

function prepareLegacyTurn(userTurn = USER_TURN()) {
  store.stopRequested = false;
  store.history = [];
  store.preparePromptRequest = async () => preparedRequestFor(userTurn);
  stubLegacyTransport();
  return userTurn;
}

function prepareTier1Turn(userTurn = USER_TURN()) {
  store.stopRequested = false;
  store.history = [];
  store.preparePromptRequest = async () => preparedRequestFor(userTurn);
  store.runTier1ConversationTurn = async () => cannedTier1Turn(userTurn);
  return userTurn;
}

function toastNodes() {
  return toastContainer.children.filter((node) => node.classList.contains("space-toast"));
}

function messageTextOf(toastNode) {
  const found = [];
  const walk = (node) => {
    if (node.classList && node.classList.contains("space-toast-message")) {
      found.push(node.textContent);
    }
    (node.children || []).forEach(walk);
  };
  walk(toastNode);
  return found.join("\n");
}

function noticeToasts() {
  return toastNodes().filter((node) => NOTICE_PATTERN.test(messageTextOf(node)));
}

// --- 0. the fixture configs really resolve the tiers the cases claim ---------

// This runs FIRST and against the product's own resolver. Without it, a case
// named "it does not fire for a real Tier-1 config" could pass because the
// config never resolved Tier 1 at all — the assertion would be about nothing.
test("the fixture configs resolve the tiers and dispatch states the cases assume", async () => {
  useDispatch(true);

  const fallback = await resolveOnscreenTier1Plan({ settings: FALLBACK_CONFIG });
  assert.equal(fallback.dispatchEnabled, true, "dispatch must be ON for a fallback to exist");
  assert.equal(fallback.tier, "tier3", "qwen-3.8-27b must resolve Tier 3 (tools: false)");
  assert.match(fallback.diagnostics, /tools=off/u, "the diagnostics line must say why");

  const fallbackB = await resolveOnscreenTier1Plan({ settings: FALLBACK_CONFIG_B });
  assert.equal(fallbackB.tier, "tier3", "the second fallback config must also resolve Tier 3");
  assert.notEqual(
    fallbackB.diagnostics,
    fallback.diagnostics,
    "case 4 needs two fallbacks that differ at the SAME tier, so their diagnostics must differ"
  );

  const tier1 = await resolveOnscreenTier1Plan({ settings: TIER1_CONFIG });
  assert.equal(tier1.tier, "tier1", "deepseek-v4.1-flash must resolve Tier 1 (tools: true)");
  assert.match(tier1.diagnostics, /tools=on/u, "the diagnostics line must say why");

  useDispatch(false);
  const off = await resolveOnscreenTier1Plan({ settings: FALLBACK_CONFIG });
  assert.equal(off.dispatchEnabled, false, "an explicit false must win over everything");
  assert.equal(off.tier, "none", "dispatch OFF is not a tier: it is no swap at all");
});

// --- 1. a notice fires for a fallback ---------------------------------------

test("a fallback config gets a visible notice naming the legacy engine", async (t) => {
  stubStoreSurface(t);
  resetToastStack();
  useDispatch(true);
  useConfig(FALLBACK_CONFIG);
  const userTurn = prepareLegacyTurn();

  await store.runSubmissionSeries(userTurn);

  const notices = noticeToasts();

  assert.equal(notices.length, 1, "a session that fell back must say so exactly once");
  assert.match(
    messageTextOf(notices[0]),
    /not tool-capable/iu,
    "the notice must say WHY the chat is on the legacy engine"
  );
  assert.ok(
    notices[0].classList.contains("is-info"),
    "the notice is a notice, not a failure: the real showToast applied the info tone"
  );
  assert.equal(
    notices[0].getAttribute("role"),
    "status",
    "the real showToast gives a non-error toast a polite live-region role"
  );
  assert.equal(
    toastNodes().length,
    1,
    "no other toast fired during this turn, so the single notice is the whole story"
  );

  // The fallback still answered: fail loudly AND stay usable.
  assert.equal(store.status, "Ready.", "a fallback turn must still complete normally");
  assert.ok(
    store.history.some((message) => message.content === "legacy answer"),
    "the legacy engine's reply reached history"
  );

  // The dedupe key is DECLARED state on the store model, not an undeclared write.
  assert.ok(
    Object.prototype.hasOwnProperty.call(store, "engineSwapFallbackNoticeShownFor"),
    "the notice key must be declared store state"
  );
  assert.notEqual(store.engineSwapFallbackNoticeShownFor, "", "the notice recorded what it was shown for");
});

// --- 2. it does NOT fire for a real Tier-1 config ---------------------------

test("a tools-capable config gets no fallback notice", async (t) => {
  stubStoreSurface(t);
  resetToastStack();
  useDispatch(true);
  useConfig(TIER1_CONFIG);
  const userTurn = prepareTier1Turn();

  await store.runSubmissionSeries(userTurn);

  // PRESENT, not merely absent-after: the turn really ran the Tier 1 path, so
  // "no notice" is a fact about a turn that happened rather than about a turn
  // that never started.
  assert.ok(
    store.history.some((message) => message.content === "Your notes say hello."),
    "the Tier 1 answer committed, so the tier1 branch is the one that ran"
  );
  assert.equal(noticeToasts().length, 0, "the engine the beta tests must not be told it is the fallback");
  assert.equal(store.engineSwapFallbackNoticeShownFor, "", "nothing was recorded as a fallback");
});

// --- 3. once per config, not once per turn ----------------------------------

test("the notice fires once per config, not once per turn", async (t) => {
  stubStoreSurface(t);
  resetToastStack();
  useDispatch(true);
  useConfig(FALLBACK_CONFIG);

  prepareLegacyTurn(USER_TURN("u1"));
  await store.runSubmissionSeries(USER_TURN("u1"));
  prepareLegacyTurn(USER_TURN("u2"));
  await store.runSubmissionSeries(USER_TURN("u2"));

  assert.equal(
    noticeToasts().length,
    1,
    "repeating a notice every message is noise the owner learns to ignore"
  );
  assert.ok(
    store.history.some((message) => message.content === "legacy answer"),
    "both turns really ran on the legacy path"
  );
});

// --- 4. a different config re-notifies -------------------------------------

test("a different fallback config re-notifies even at the same tier", async (t) => {
  stubStoreSurface(t);
  resetToastStack();
  useDispatch(true);

  useConfig(FALLBACK_CONFIG);
  prepareLegacyTurn(USER_TURN("u1"));
  await store.runSubmissionSeries(USER_TURN("u1"));
  const afterFirst = store.engineSwapFallbackNoticeShownFor;

  // Same resolved TIER, different resolved diagnostics. If the key were just the
  // tier, this switch would be silent and the user would never learn that the
  // new model is also not being tested.
  useConfig(FALLBACK_CONFIG_B);
  prepareLegacyTurn(USER_TURN("u2"));
  await store.runSubmissionSeries(USER_TURN("u2"));

  assert.equal(noticeToasts().length, 2, "a change of config earns a fresh notice");
  assert.notEqual(
    store.engineSwapFallbackNoticeShownFor,
    afterFirst,
    "the dedupe key follows the resolved config, not the turn count"
  );
});

// --- 5. dispatch OFF is not a fallback --------------------------------------

test("dispatch OFF is an explicit choice, not a fallback, and stays silent", async (t) => {
  stubStoreSurface(t);
  resetToastStack();
  useDispatch(false);
  useConfig(FALLBACK_CONFIG);
  const userTurn = prepareLegacyTurn();

  await store.runSubmissionSeries(userTurn);

  assert.ok(
    store.history.some((message) => message.content === "legacy answer"),
    "the turn ran on the legacy protocol because that was requested"
  );
  assert.equal(
    noticeToasts().length,
    0,
    "telling someone their explicit choice is a fallback would be a lie"
  );
  assert.equal(store.engineSwapFallbackNoticeShownFor, "", "nothing was recorded as a fallback");
});

// --- 6. a notice can never break a turn -------------------------------------

test("a throwing toast cannot break the turn", async (t) => {
  stubStoreSurface(t);
  resetToastStack();
  useDispatch(true);
  useConfig(FALLBACK_CONFIG);
  const userTurn = prepareLegacyTurn();

  // The REAL showToast throws from inside its own body, at the moment it would
  // attach the record. This is the strongest available injection: the notice
  // path is genuinely reached, and only the store's try/catch can save the turn.
  let appendAttempts = 0;
  toastContainer.onAppend = () => {
    appendAttempts += 1;
    throw new Error("the toast stack exploded");
  };

  await store.runSubmissionSeries(userTurn);

  t.after(() => {
    toastContainer.onAppend = null;
  });

  assert.equal(appendAttempts, 1, "the notice really was attempted, so the catch is what ran");
  assert.equal(toastNodes().length, 0, "the failed notice left nothing behind");
  assert.equal(store.status, "Ready.", "no error propagated out of the notice");
  assert.ok(
    store.history.some((message) => message.content === "legacy answer"),
    "the chat still answered"
  );
});
