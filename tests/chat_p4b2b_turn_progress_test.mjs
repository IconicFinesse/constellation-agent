// P4b-2b — the TURN-LEVEL progress affordance.
//
// The per-call chip spinner already answered "is THIS call running". Nothing answered
// "is the agent working right now", so a turn showed the user's own row and then dead air
// until the first token arrived, and a turn that opened with a tool call showed chips with
// no turn-level context.
//
// THE HONESTY BAR FOR THIS LANE IS ONE SENTENCE: an indicator that outlives its turn is a
// lie. So the exit matrix below drives the REAL store and asserts, per exit, that the
// indicator was up during the turn and is gone after it — including the paint path that
// draws NOTHING (a fresh chat whose only content is the empty state), which is exactly the
// path this lane's own first draft stranded the indicator on.
//
// Hermetic: no disk, no network. The DOM is a selector-capable stub, so the affordance is
// asserted at the real render path rather than by re-deriving its rule.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("./p4b2b_turn_progress_loader.mjs", import.meta.url), import.meta.url);

// --- minimal selectable DOM -------------------------------------------------

function camelCase(dataAttribute) {
  return String(dataAttribute || "")
    .replace(/^data-/iu, "")
    .replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

function matchesCompound(element, selector) {
  if (selector.startsWith(".")) {
    return element.classList.contains(selector.slice(1));
  }

  const attributeMatch = selector.match(/^([a-z0-9]*)((?:\[[^\]]+\])*)$/iu);

  if (!attributeMatch) {
    return false;
  }

  const [, tagName, attributePart] = attributeMatch;

  if (tagName && element.tagName.toLowerCase() !== tagName.toLowerCase()) {
    return false;
  }

  const attributeSelectors = attributePart.match(/\[[^\]]+\]/gu) || [];

  return attributeSelectors.every((attributeSelector) => {
    const body = attributeSelector.slice(1, -1);
    const equalsIndex = body.indexOf("=");

    if (equalsIndex === -1) {
      return element.dataset[camelCase(body)] !== undefined;
    }

    const name = camelCase(body.slice(0, equalsIndex));
    const value = body.slice(equalsIndex + 1).replace(/^["']|["']$/gu, "");

    return String(element.dataset[name]) === value;
  });
}

class StubNode {
  constructor(tagName = "div") {
    this.tagName = String(tagName || "div").toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
    this.disabled = false;
    this.open = false;
    this.type = "";
    this.title = "";
    this.src = "";
    this.alt = "";
    this._text = "";
    this._attributes = {};
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

  set innerHTML(value) {
    this._text = String(value || "");
    this.children = [];
  }

  get innerHTML() {
    return this._text;
  }

  setAttribute(name, value) {
    this._attributes[name] = String(value);

    if (String(name).startsWith("data-")) {
      this.dataset[camelCase(name)] = String(value);
    }
  }

  getAttribute(name) {
    return this._attributes[name] ?? null;
  }

  addEventListener() {}

  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }

  appendChild(node) {
    if (node) {
      node.parentNode = this;
      this.children.push(node);
    }

    return node;
  }

  prepend(node) {
    if (node) {
      node.parentNode = this;
      this.children.unshift(node);
    }
  }

  insertBefore(node, reference) {
    const index = this.children.indexOf(reference);
    node.parentNode = this;

    if (index === -1) {
      this.children.push(node);
    } else {
      this.children.splice(index, 0, node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    nodes.forEach((node) => this.appendChild(node));
  }

  remove() {
    const parent = this.parentNode;

    if (parent) {
      parent.children = parent.children.filter((child) => child !== this);
      this.parentNode = null;
    }
  }

  replaceWith(node) {
    const parent = this.parentNode;

    if (!parent) {
      return;
    }

    const index = parent.children.indexOf(this);
    node.parentNode = parent;
    parent.children.splice(index, 1, node);
    this.parentNode = null;
  }

  walk(selector, results) {
    this.children.forEach((child) => {
      if (matchesCompound(child, selector)) {
        results.push(child);
      }

      child.walk(selector, results);
    });
  }

  querySelectorAll(selector) {
    const results = [];
    this.walk(selector, results);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let node = this;

    while (node) {
      if (matchesCompound(node, selector)) {
        return node;
      }

      node = node.parentNode;
    }

    return null;
  }
}

globalThis.document = {
  addEventListener() {},
  body: { appendChild() {} },
  createElement(tagName) {
    return new StubNode(tagName);
  },
  createTextNode(value) {
    const node = new StubNode("#text");
    node.nodeType = 3;
    node.textContent = value;
    return node;
  },
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
globalThis.Node = { TEXT_NODE: 3 };

const runtime = {
  api: {},
  // The REAL reader shape: a value the suite sets WINS, otherwise the shipped default.
  // An earlier draft of this harness ignored `configValues`, so `useTier1(true)` did
  // nothing, the Tier 1 branch was never reached and two exit cases passed without ever
  // running the code they claimed to test. That is the fixture-masked-wiring trap this
  // campaign has hit before; the flag is now read exactly the way the product reads it.
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
  cancelAnimationFrame() {},
  setTimeout,
  clearTimeout
};
globalThis.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
globalThis.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };

const { createAgentThreadView } = await import("/modules/_core/visual/conversation/thread-view.js");
const { buildChatRenderProjection, resolvePreviewTailContent } = await import(
  "/modules/_core/framework/js/engine-swap/chat-projection.js"
);
const onscreenExecution = await import("/modules/_core/onscreen_agent/execution.js");
const adminExecution = await import("/modules/_core/admin/views/agent/execution.js");
const turnProgress = await import("/modules/_core/visual/conversation/turn-progress.js");
const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

// The two REAL view configs, copied shape-for-shape from the product's own view modules
// (onscreen_agent/view.js and admin/views/agent/view.js). If a surface's config stops
// painting through the shared renderer, its half of the both-surfaces case goes red.
const onscreenView = createAgentThreadView({
  assistantMarkdownClassName: "onscreen-agent-response-markdown",
  execution: onscreenExecution,
  groupConsecutiveAvatars: true,
  renderMarkdownWithMarked: true
});
const adminView = createAgentThreadView({
  execution: adminExecution,
  renderMarkdownWithMarked: true
});

const SURFACES = [
  { name: "onscreen", view: onscreenView },
  { name: "admin", view: adminView }
];

function renderThread(view, history, options = {}) {
  const thread = new StubNode("div");
  view.renderMessages(thread, history, { groupToolRuns: true, scroller: null, ...options });
  return thread;
}

function indicatorOf(thread) {
  return thread.querySelector("[data-turn-progress]");
}

function indicatorLabel(thread) {
  return thread.querySelector("[data-turn-progress-label]")?.textContent ?? null;
}

const LIVE_ASSISTANT = (content) => ({
  content,
  id: "assistant-live",
  role: "assistant",
  streaming: true
});
const USER_TURN = { attachments: [], content: "read my notes", id: "u1", role: "user" };

// --- 1. THE DEAD-AIR CASE ---------------------------------------------------

test("dead air: a fresh chat with a turn in flight shows the indicator and says Thinking", () => {
  for (const surface of SURFACES) {
    const thread = renderThread(surface.view, [USER_TURN], { isConversationBusy: true });
    const indicator = indicatorOf(thread);

    assert.ok(indicator, `${surface.name}: the indicator must exist while a turn is in flight`);
    assert.equal(
      indicatorLabel(thread),
      turnProgress.TURN_PROGRESS_THINKING,
      `${surface.name}: before the first token the honest phase is 'Thinking...'`
    );
  }
});

// --- 2. MID-STREAM PHASE ----------------------------------------------------

test("mid-stream: the label follows the shared phase vocabulary as content arrives", () => {
  for (const surface of SURFACES) {
    const prose = renderThread(surface.view, [USER_TURN, LIVE_ASSISTANT("Some text so far")], {
      isConversationBusy: true
    });

    assert.equal(
      indicatorLabel(prose),
      turnProgress.TURN_PROGRESS_WRITING_RESPONSE,
      `${surface.name}: streamed prose is 'Writing response...'`
    );

    // A fenced call body means the turn is writing code, and the EXISTING vocabulary says
    // so with a line count — no new phrasing invented here.
    const fenced = renderThread(
      surface.view,
      [USER_TURN, LIVE_ASSISTANT("Let me write that.\n\n_____javascript\nconst a = 1;\nconst b = 2;")],
      { isConversationBusy: true }
    );

    assert.equal(
      indicatorLabel(fenced),
      "Writing 2 lines of code...",
      `${surface.name}: a fenced body reuses the existing line-counted phase wording`
    );
  }
});

// --- 3. AFTER COMMIT --------------------------------------------------------

test("after commit: the indicator is gone once the turn is no longer in flight", () => {
  for (const surface of SURFACES) {
    const committed = { attachments: [], content: "Your notes say hello.", id: "assistant-1", role: "assistant" };
    const thread = renderThread(surface.view, [USER_TURN, committed], { isConversationBusy: false });

    assert.equal(
      indicatorOf(thread),
      null,
      `${surface.name}: a settled turn must leave no indicator behind`
    );
  }
});

// --- 3b. THE CLEAR DOES NOT TRUST THE INFERENCE -----------------------------

test("the clear fires even when nothing on screen agrees with the busy inference", () => {
  // The campaign trap: a clear path that depends on `isConversationBusy` can strand the
  // indicator when that inference disagrees with what is painted. This case forces the
  // disagreement — busy first, then a settle paint over a thread with NO rows, NO
  // streaming entry and no `is-empty` class — and requires the indicator to be gone.
  for (const surface of SURFACES) {
    const thread = new StubNode("div");
    surface.view.renderMessages(thread, [USER_TURN], { isConversationBusy: true, scroller: null });
    assert.ok(indicatorOf(thread), `${surface.name}: busy paint shows the indicator`);

    // Empty history, and the thread is not flagged empty: the renderer takes neither the
    // early return nor the empty-state branch that a normal chat would.
    surface.view.renderMessages(thread, [], { isConversationBusy: false, scroller: null });

    assert.equal(
      indicatorOf(thread),
      null,
      `${surface.name}: the clear must not depend on rows or a streaming entry existing`
    );
  }
});

// --- 4. ONE IMPLEMENTATION, TWO SURFACES ------------------------------------

test("one implementation: mutating the shared classifier changes BOTH surfaces' paint", () => {
  const before = SURFACES.map((surface) => {
    const thread = renderThread(surface.view, [USER_TURN], { isConversationBusy: true });
    return indicatorLabel(thread);
  });

  assert.deepEqual(
    before,
    [turnProgress.TURN_PROGRESS_THINKING, turnProgress.TURN_PROGRESS_THINKING],
    "control: both surfaces agree before the mutation"
  );

  // The transform lives behind the shared module's own export, so it can only change a
  // paint that actually reads that module. A surface-local phrase table would ignore it.
  turnProgress.p4b2bLabelTransforms.push((label) => `MUTATED ${label}`);

  try {
    const after = SURFACES.map((surface) => {
      const thread = renderThread(surface.view, [USER_TURN], { isConversationBusy: true });
      return indicatorLabel(thread);
    });

    assert.deepEqual(
      after,
      [`MUTATED ${turnProgress.TURN_PROGRESS_THINKING}`, `MUTATED ${turnProgress.TURN_PROGRESS_THINKING}`],
      "both surfaces must paint through the ONE shared classifier"
    );
  } finally {
    turnProgress.p4b2bLabelTransforms.length = 0;
  }
});

// --- 4b. THE PER-DELTA PATH -------------------------------------------------

test("per-delta: the in-place streaming patch re-syncs the phase label", () => {
  // Production does NOT re-render the whole thread on every token: `scheduleStreamingMessageRender`
  // calls `updateStreamingAssistantMessage`, which patches one row. If the label were only
  // synced on a full render, the indicator would keep saying `Thinking...` through an entire
  // streamed answer. This case forces the real patch path.
  for (const surface of SURFACES) {
    const thread = new StubNode("div");
    const live = LIVE_ASSISTANT("");
    surface.view.renderMessages(thread, [USER_TURN, live], {
      isConversationBusy: true,
      groupToolRuns: true,
      scroller: null
    });

    assert.equal(
      indicatorLabel(thread),
      turnProgress.TURN_PROGRESS_THINKING,
      `${surface.name}: starts at the pre-token phase`
    );

    const patched = surface.view.updateStreamingAssistantMessage(
      thread,
      { ...live, content: "Now writing the answer." },
      { scroller: null }
    );

    assert.equal(patched, true, `${surface.name}: the row patch must actually apply`);
    assert.equal(
      indicatorLabel(thread),
      turnProgress.TURN_PROGRESS_WRITING_RESPONSE,
      `${surface.name}: the phase label must follow the delta, not wait for a full re-render`
    );
  }
});

// --- 4c. AUDIT FOLLOW-UP 1: ONE LABEL DERIVATION (no flicker) ---------------

test("audit-1: full render and delta patch agree on the phase, through a chip split", () => {
  // THE AUDITOR'S REPRODUCTION, FROZEN. Painting one turn in PRODUCTION ORDER used to
  // alternate, because the full render read the FIRST streaming entry (a frozen prose
  // segment once a chip split the preview) while the patch painted the TAIL:
  //
  //   sequence: ["Writing response...", "Writing 2 lines of code...",
  //              "Writing response...", "Writing 2 lines of code..."]   AGREE? false
  //
  // Both painters now derive the label from the projection's TAIL slice, so every step
  // must agree. The frozen prose + chip + code-body shape below is what produced the flip;
  // if a future change reintroduces a second derivation, this goes red on the SEQUENCE.
  const preview = {
    content: "Let me write that.\n\n_____javascript\nconst a = 1;\nconst b = 2;",
    id: "engine-swap-streaming-preview",
    role: "assistant",
    streaming: true
  };
  const provisionalCalls = [
    { arguments: "{\"code\":\"x\"}", atChars: 18, callId: "c1", name: "run_code" }
  ];
  const options = { groupToolRuns: true, isConversationBusy: true, scroller: null };

  for (const surface of SURFACES) {
    const thread = new StubNode("div");

    const fullRender = () => {
      // The REAL projection decides the split and the tail; the renderer only paints it.
      const history = buildChatRenderProjection({
        history: [USER_TURN],
        preview,
        provisionalCalls
      });
      surface.view.renderMessages(thread, history, options);
      return indicatorLabel(thread);
    };

    const deltaPatch = () => {
      const previewTailContent = resolvePreviewTailContent({
        history: [USER_TURN],
        preview,
        provisionalCalls
      });
      surface.view.updateStreamingAssistantMessage(thread, preview, {
        previewTailContent,
        scroller: null
      });
      return indicatorLabel(thread);
    };

    const sequence = [fullRender(), deltaPatch(), fullRender(), deltaPatch()];

    assert.equal(
      new Set(sequence).size,
      1,
      `${surface.name}: the label must be IDENTICAL after every paint step, or it flickers on every chip repaint (saw ${JSON.stringify(sequence)})`
    );
    // And it is the honest phase for what the tail holds, not a stale prose reading.
    assert.equal(
      sequence[0],
      "Writing 2 lines of code...",
      `${surface.name}: the tail carries the code body, so that is the phase`
    );
  }
});

// --- 4d. AUDIT FOLLOW-UP 2: ONE LINE-COUNT FORMATTER -----------------------

test("audit-2: formatLineCount is declared exactly once tree-wide", () => {
  const files = [
    "../app/L0/_all/modules/_core/visual/conversation/turn-progress.js",
    "../app/L0/_all/modules/_core/visual/conversation/thread-view.js",
    "../app/L0/_all/modules/_core/onscreen_agent/store.js",
    "../app/L0/_all/modules/_core/admin/views/agent/store.js"
  ];
  const definitions = [];

  for (const relativePath of files) {
    const source = stripComments(readFileSync(new URL(relativePath, import.meta.url), "utf8"));

    if (/function\s+formatLineCount\s*\(/u.test(source)) {
      definitions.push(relativePath);
    }
  }

  assert.deepEqual(
    definitions.map((path) => path.split("/").pop()),
    ["turn-progress.js"],
    `exactly ONE definition, in the shared module (saw ${JSON.stringify(definitions)})`
  );

  // The behavioural half: the shared formatter is the one with the thousands separator,
  // which is the visible change this lane disclosed. Pinned so nobody "fixes" it back to
  // an unformatted lookalike.
  // LOCALE-INDEPENDENT ON PURPOSE. The property that matters is that the shared formatter
  // GROUPS digits; which separator a particular LANG chooses is not this lane's contract, and
  // pinning "1,000" would make the suite fail on a CI box with a different locale for a
  // reason unrelated to unification. An unformatted lookalike ("1000 lines") still fails.
  const grouped = turnProgress.formatLineCount(1000);

  assert.notEqual(
    grouped,
    "1000 lines",
    "the shared formatter must GROUP digits — the deleted local lookalike did not"
  );
  assert.match(grouped, /^1\D?000 lines$/u, `grouped count (saw ${JSON.stringify(grouped)})`);
  assert.equal(turnProgress.formatLineCount(1), "1 line");

  // And the consumer really uses it: the pane label of a large block is formatted.
  for (const surface of SURFACES) {
    const bigBody = Array.from({ length: 1200 }, (_unused, index) => `const v${index} = ${index};`).join(
      "\n"
    );
    const thread = renderThread(
      surface.view,
      [USER_TURN, LIVE_ASSISTANT(`Here:\n\n_____javascript\n${bigBody}`)],
      { isConversationBusy: true }
    );

    const painted = indicatorLabel(thread);

    assert.equal(
      painted,
      `Writing ${turnProgress.formatLineCount(1200)} of code...`,
      `${surface.name}: the live phase label uses the SHARED formatter`
    );
    assert.notEqual(
      painted,
      "Writing 1200 lines of code...",
      `${surface.name}: the consumer must not paint an unformatted count`
    );
  }
});

// --- 5. ACCESSIBILITY -------------------------------------------------------

test("the indicator is a polite live region and never takes focus", () => {
  for (const surface of SURFACES) {
    const thread = renderThread(surface.view, [USER_TURN], { isConversationBusy: true });
    const indicator = indicatorOf(thread);

    assert.equal(indicator.getAttribute("role"), "status", `${surface.name}: announced as a status`);
    assert.equal(indicator.getAttribute("aria-live"), "polite", `${surface.name}: polite, never assertive`);
    assert.equal(indicator.getAttribute("aria-atomic"), "true", `${surface.name}: one atomic announcement`);
    assert.equal(indicator.getAttribute("tabindex"), null, `${surface.name}: not focusable`);
    assert.equal(
      indicator.querySelector(".turn-progress-spinner")?.getAttribute("aria-hidden"),
      "true",
      `${surface.name}: the spinner is decorative; the words carry the meaning`
    );
  }
});

// --- 6. THE DEAD MARKER IS GONE --------------------------------------------

test("the dead is-streaming marker and its three additions are gone", () => {
  const threadViewSource = readFileSync(
    new URL("../app/L0/_all/modules/_core/visual/conversation/thread-view.js", import.meta.url),
    "utf8"
  );

  // Three additions and zero CSS rules was the whole finding: a marker with no reader.
  assert.equal(
    (threadViewSource.match(/classList\.add\("is-streaming"\)/gu) || []).length,
    0,
    "no site may add the class that painted nothing"
  );
  assert.match(
    threadViewSource,
    /data-turn-progress/iu,
    "a live turn is signalled by a real element instead"
  );
});

// --- 7. NO SECOND VOCABULARY ---------------------------------------------- 

// COMMENTS ARE PROSE, NOT DECLARATIONS. The rule this case enforces is 'the phrase is
// declared once', so the scan runs on comment-stripped source: a comment that names the
// phrase to explain WHY it moved is documentation, and failing on it would push the next
// author to delete the explanation instead of keeping the rule.
function stripComments(source) {
  return String(source || "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/u, "$1"))
    .join("\n");
}

test("the progress phrases are declared once, in the shared module", () => {
  const storeSources = [
    "../app/L0/_all/modules/_core/onscreen_agent/store.js",
    "../app/L0/_all/modules/_core/admin/views/agent/store.js"
  ].map((path) => ({
    path,
    source: stripComments(readFileSync(new URL(path, import.meta.url), "utf8"))
  }));

  // SELF-CHECK, so this case cannot pass by scanning nothing: the same scanner must still
  // see a declaration when one exists.
  assert.ok(
    stripComments('const a = "Thinking...";').includes('"Thinking..."'),
    "the scanner must still see a real declaration, or its silence means nothing"
  );
  assert.ok(
    !stripComments('// it used to say "Thinking..."').includes('"Thinking..."'),
    "a comment naming the phrase is prose, not a declaration"
  );

  for (const { path, source } of storeSources) {
    for (const phrase of ["Thinking...", "Writing response...", "Preparing code..."]) {
      assert.ok(
        !source.includes(`"${phrase}"`) && !source.includes(`\`${phrase}\``),
        `${path} must not declare the phrase ${JSON.stringify(phrase)} — it is shared`
      );
    }
    assert.match(
      source,
      /visual\/conversation\/turn-progress\.js/u,
      `${path} must consume the shared classifier`
    );
  }

  // The legacy phrasing P3.5 spent three audit rounds retiring stays retired.
  const threadViewSource = readFileSync(
    new URL("../app/L0/_all/modules/_core/visual/conversation/thread-view.js", import.meta.url),
    "utf8"
  );

  assert.ok(
    !/Executed \$\{[^}]*\} lines of code/u.test(threadViewSource),
    "the legacy 'Executed N lines of code' vocabulary must not return on this path"
  );
});

// --- 8. THE EXIT MATRIX (REAL STORE) --------------------------------------- 

function stubStoreSurface(t) {
  const previous = {
    displayMode: store.displayMode,
    executeAssistantBlocks: store.executeAssistantBlocks,
    focusInput: store.focusInput,
    getConfiguredMaxTokens: store.getConfiguredMaxTokens,
    history: store.history,
    isSending: store.isSending,
    persistHistory: store.persistHistory,
    preparePromptRequest: store.preparePromptRequest,
    queuedSubmissions: store.queuedSubmissions,
    refreshPromptInputFromHistory: store.refreshPromptInputFromHistory,
    render: store.render,
    reportError: store.reportError,
    runTier1ConversationTurn: store.runTier1ConversationTurn,
    settings: store.settings,
    status: store.status,
    stopRequested: store.stopRequested,
    streamAssistantResponse: store.streamAssistantResponse
  };
  const thread = new StubNode("div");
  const duringTurn = [];

  store.displayMode = "full";
  store.refs = { ...(store.refs || {}), scroller: null, thread };
  store.persistHistory = async () => {};
  store.refreshPromptInputFromHistory = async () => null;
  store.getConfiguredMaxTokens = () => 1_000_000;
  store.focusInput = () => {};
  store.reportError = (context, error) => {
    store.status = `Error ${context}: ${error?.message || error}`;
  };
  store.executeAssistantBlocks = async () => [];
  store.queuedSubmissions = [];
  store.settings = { apiEndpoint: "https://api.openai.com/v1/chat/completions", apiKey: "k", model: "m", provider: "" };
  store.chatRuntime = { attachments: { rememberMessageAttachments() {}, setActiveMessage() {} } };
  // PAINT THROUGH THE REAL RENDERER, but into the stub thread: the affordance's presence
  // is decided by the real `renderMessages` over the real `buildRenderHistory`, which is
  // where the defect this lane must not ship actually lives.
  store.render = function renderIntoStub(options = {}) {
    if (!this.isFullMode) {
      return;
    }

    onscreenView.renderMessages(thread, this.buildRenderHistory(), {
      displayOnlyMessageIds: this.engineSwapDisplayOnlyMessageIds,
      groupToolRuns: true,
      isConversationBusy: this.isSending,
      outputOverrides: this.executionOutputOverrides,
      preserveScroll: options.preserveScroll === true,
      queuedMessages: this.getQueuedPreviewMessages(),
      rerunningMessageId: this.rerunningMessageId,
      scroller: null,
      toolRunOpenState: this.toolRunOpenState
    });
  };

  t.after(() => {
    Object.assign(store, previous);
  });

  return { duringTurn, thread };
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

// EXPLICIT IN BOTH DIRECTIONS, deliberately. The ON preload supplies a flag the suite did
// NOT set, so expressing "Tier 3" as an ABSENT entry silently ran those cases on Tier 1
// under the ON column — their transport stubs were never reached and the assertions were
// vacuous in exactly the way this campaign has been bitten by before. An explicit `false`
// is the only shape the preload respects (verified: absent→true, explicit false→false).
function useTier1(dispatchOn) {
  runtime.configValues.set("ENGINE_SWAP_DISPATCH", dispatchOn === true);
}

test("exit SUCCESS: the indicator is up during the turn and gone after it commits", async (t) => {
  const surface = stubStoreSurface(t);
  useTier1(true);
  store.stopRequested = false;
  store.history = [];
  store.preparePromptRequest = async () => preparedRequestFor(USER_TURN);
  store.runTier1ConversationTurn = async () => {
    store.render();
    surface.duringTurn.push(indicatorLabel(surface.thread));
    return cannedTier1Turn(USER_TURN);
  };

  await store.runSubmissionSeries(USER_TURN);

  assert.deepEqual(
    surface.duringTurn,
    [turnProgress.TURN_PROGRESS_THINKING],
    "mid-turn the indicator must be up and say the honest phase"
  );
  assert.equal(indicatorOf(surface.thread), null, "a committed turn must leave no indicator");
  assert.equal(store.isSending, false, "the surface really did leave its sending state");
});

test("exit ERROR: a thrown turn still clears the indicator", async (t) => {
  const surface = stubStoreSurface(t);
  useTier1(true);
  store.stopRequested = false;
  store.history = [];
  store.preparePromptRequest = async () => preparedRequestFor(USER_TURN);
  store.runTier1ConversationTurn = async () => {
    store.render();
    surface.duringTurn.push(indicatorLabel(surface.thread));
    throw new Error("transport exploded");
  };

  await store.runSubmissionSeries(USER_TURN);

  assert.deepEqual(surface.duringTurn, [turnProgress.TURN_PROGRESS_THINKING], "up during the turn");
  assert.equal(indicatorOf(surface.thread), null, "an errored turn must leave no indicator — it is not still working");
  assert.match(store.status, /transport exploded/u, "the failure is reported, not swallowed");
});

test("exit ABORT: an aborted request clears the indicator", async (t) => {
  const surface = stubStoreSurface(t);
  useTier1(false);
  store.stopRequested = false;
  store.history = [];
  store.preparePromptRequest = async () => preparedRequestFor(USER_TURN);
  store.streamAssistantResponse = async () => {
    store.render();
    surface.duringTurn.push(indicatorLabel(surface.thread));
    store.stopRequested = true;
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    throw abort;
  };

  await store.runSubmissionSeries(USER_TURN);

  assert.deepEqual(surface.duringTurn, [turnProgress.TURN_PROGRESS_THINKING], "up during the turn");
  assert.equal(indicatorOf(surface.thread), null, "an aborted turn must leave no indicator");
});

test("exit USER STOP: a stopped turn clears the indicator", async (t) => {
  const surface = stubStoreSurface(t);
  useTier1(false);
  store.stopRequested = false;
  store.history = [];
  store.preparePromptRequest = async () => preparedRequestFor(USER_TURN);
  store.streamAssistantResponse = async () => {
    store.render();
    surface.duringTurn.push(indicatorLabel(surface.thread));
    store.stopRequested = true;
    return { hasContent: false, responseMeta: null, stopped: true };
  };

  await store.runSubmissionSeries(USER_TURN);

  // PRESENT, not merely absent-after. An exit case that only asserts the indicator is gone
  // passes on any tree that never painted one — the failure this whole matrix exists to
  // catch would be invisible. `duringTurn` is the mid-turn paint the stub transport forced.
  assert.deepEqual(
    surface.duringTurn,
    [turnProgress.TURN_PROGRESS_THINKING],
    "the indicator must be up while the turn is in flight"
  );
  assert.equal(indicatorOf(surface.thread), null, "a stopped turn must leave no indicator");
  assert.equal(store.status, "Stopped.", "the stop is reported honestly");
});

test("exit STRANDING TRAP: the clear fires on the paint that draws NOTHING", async (t) => {
  const surface = stubStoreSurface(t);
  useTier1(true);
  store.stopRequested = false;
  // A FRESH chat. The paint that ends the turn takes the empty-state early return in
  // `renderMessages`, which draws no rows at all — the exact path this lane's first draft
  // skipped, leaving the indicator up after the turn died.
  store.history = [];
  store.preparePromptRequest = async () => preparedRequestFor(USER_TURN);
  store.runTier1ConversationTurn = async () => {
    // Capture the mid-turn paint FIRST: an exit case that only asserts absence afterwards
    // passes on any tree that never painted the indicator at all, which is how this case
    // was green on the pristine base before it was strengthened.
    store.render();
    surface.duringTurn.push(indicatorLabel(surface.thread));
    return cannedTier1Turn(USER_TURN);
  };

  const previousReplaceHistory = store.replaceHistory;
  t.after(() => {
    store.replaceHistory = previousReplaceHistory;
  });
  // Keep the history empty through the commit so the thread paints only the empty state.
  store.replaceHistory = async () => {
    store.history = [];
  };

  await store.runSubmissionSeries(USER_TURN);

  assert.deepEqual(
    surface.duringTurn,
    [turnProgress.TURN_PROGRESS_THINKING],
    "the indicator must have been up mid-turn, or the clear below proves nothing"
  );
  assert.equal(
    indicatorOf(surface.thread),
    null,
    "the clear must not depend on rows existing — an empty transcript still ends its turn"
  );
});

// --- 9. NO NEW PERSISTENCE --------------------------------------------------

test("the affordance adds no persisted state and does not touch serialization", async (t) => {
  stubStoreSurface(t);
  useTier1(true);
  store.stopRequested = false;
  store.history = [
    { ...USER_TURN },
    { attachments: [], content: "Your notes say hello.", id: "assistant-1", role: "assistant" }
  ];

  const serialized = JSON.stringify(store.serializeHistoryMessages(store.history));

  // Paint with a turn in flight — the state in which the indicator exists.
  store.isSending = true;
  store.render();
  store.isSending = false;

  assert.equal(
    JSON.stringify(store.serializeHistoryMessages(store.history)),
    serialized,
    "an indicator that is on screen must not change one byte of what is stored"
  );
  assert.equal(
    store.history.some((entry) => "turnProgress" in entry || "indicator" in entry),
    false,
    "no indicator field may enter history"
  );
});

// --- 10. BUG-007 ------------------------------------------------------------

test("BUG-007: the indicator never executes anything (dispatch count 0)", () => {
  let dispatchCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    dispatchCount += 1;
    throw new Error("the indicator must never reach the network");
  };

  try {
    for (const surface of SURFACES) {
      // Every phase a display turn can pass through, including a full fenced call body.
      const shapes = [
        "",
        "Some prose.",
        "_____javascript\nconst a = 1;",
        "```javascript\n_____javascript\nspace.api.fileDelete({ path: 'x' })\n```"
      ];

      for (const shape of shapes) {
        const thread = renderThread(
          surface.view,
          [USER_TURN, LIVE_ASSISTANT(shape)],
          { isConversationBusy: true }
        );

        assert.ok(indicatorOf(thread), `${surface.name}: the affordance painted`);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(dispatchCount, 0, "a display affordance must dispatch nothing, ever");
});
