// FINAL chat-surface polish (chat-polish-2, owner-approved items A-D).
//
// A — ONE ROW PER CALL. A call entry and its result entry are two ENTRIES describing one
//     CALL, so a body drawn per entry drew every call twice: the owner read "2 tool
//     calls · 2 succeeded" with four chips underneath. The row count and the header count
//     now come from the SAME per-call fold (`collectToolRunCalls`), so they cannot
//     disagree, and each row carries its OWN outcome.
//
// B — CONSISTENT GROUPING. The run is a contiguous TYPED stretch: a result landing between
//     two calls no longer splits the announcement, so the same batch groups the same way
//     whatever order its results arrived in. Narration still splits runs; a held/deferred
//     block still stays fully individual.
//
// C — LIVE PREVIEW PLACEMENT AND FORMATTING. Provisional chips interleave at the character
//     offset where they appeared instead of stacking above the prose, and narration inside
//     a streaming tool card is repainted through the same preview painter text turns use.
//
// D — HONEST LABELS. A typed chip says `file_read · Success`, not `Executed code of code`.
//     Tier 3 chips keep their wording byte-identical.
//
// Hermetic: no disk, no network. The DOM is a small stub with real selector matching so row
// structure can be asserted at the real render path rather than by re-deriving the rule.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

// --- minimal selectable DOM -------------------------------------------------

function matchesCompound(element, selector) {
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

function camelCase(dataAttribute) {
  return String(dataAttribute || "")
    .replace(/^data-/iu, "")
    .replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

function matches(element, selector) {
  const trimmed = String(selector || "").trim();

  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith(".")) {
    return element.classList.contains(trimmed.slice(1));
  }

  if (trimmed.startsWith("[")) {
    return matchesCompound(element, trimmed);
  }

  return matchesCompound(element, trimmed);
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
    this.type = "";
    this.title = "";
    this.src = "";
    this.alt = "";
    this.disabled = false;
    this.open = false;
    this._text = "";
    this._listeners = new Map();
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
    if (this.children.length) {
      return this.children.map((child) => child.textContent).join("");
    }

    return this._text;
  }

  set textContent(value) {
    this._text = String(value === undefined || value === null ? "" : value);
    this.children = [];
  }

  set innerHTML(value) {
    // `renderMarkdown` writes markup here. The stub keeps ONE child so the preview painter
    // sees a non-empty render result (its "renderer produced nothing" fallback is a
    // different, separately asserted case) and so the chosen MODE stays observable.
    this._text = String(value || "");
    this.children = [];

    if (this._text) {
      const child = new StubNode("span");
      child.textContent = this._text;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  get innerHTML() {
    return this._text;
  }

  setAttribute(name, value) {
    if (String(name).startsWith("data-")) {
      this.dataset[camelCase(name)] = String(value);
    }
  }

  getAttribute(name) {
    return this.dataset[camelCase(name)] ?? null;
  }

  addEventListener(type, handler) {
    this._listeners.set(type, handler);
  }

  dispatch(type) {
    this._listeners.get(type)?.({ target: this, type });
  }

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

  querySelectorAll(selector) {
    const results = [];

    const walk = (node) => {
      node.children.forEach((child) => {
        if (matches(child, selector)) {
          results.push(child);
        }

        walk(child);
      });
    };

    walk(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let node = this;

    while (node) {
      if (matches(node, selector)) {
        return node;
      }

      node = node.parentNode;
    }

    return null;
  }
}

const stubDocument = {
  addEventListener() {},
  createElement(tagName) {
    return new StubNode(tagName);
  },
  createTextNode(value) {
    const node = new StubNode("#text");
    node.nodeType = 3;
    node.textContent = value;
    return node;
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  }
};

globalThis.document = stubDocument;
globalThis.Node = { TEXT_NODE: 3 };

// The framework modules this suite loads (`execution.js` -> `skills.js`) register themselves
// through `space.extend` at import time, exactly as they do in the app shell. A minimal
// runtime stub keeps that contract without dragging the real shell into a hermetic test.
globalThis.space = {
  api: {},
  config: { get: (_name, fallback = undefined) => fallback },
  extend: (_meta, value) => value,
  fw: { createStore: (_name, model) => model },
  proxy: { buildUrl: (url) => url }
};

globalThis.window = globalThis.window || {
  location: { href: "http://localhost/" },
  requestAnimationFrame(callback) {
    callback(0);
    return 1;
  }
};
globalThis.window.space = globalThis.space;

const { createAgentThreadView } = await import("/modules/_core/visual/conversation/thread-view.js");
// The REAL execution module: the execute branch (and therefore the tool-turn narration) is
// only reached when the surface is given one, exactly as the onscreen agent's view config
// does in production. Without it a separator-bearing message is plain text and the
// narration contract would be untested.
const execution = await import("/modules/_core/onscreen_agent/execution.js");
const { canonicalMessagesToTypedEntries, projectHistoryEntryForDisplay } = await import(
  "/modules/_core/framework/js/engine-swap/history-shapes.js"
);
const {
  collectToolRun,
  collectToolRunCalls,
  formatToolRunLabel,
  summarizeToolRun
} = await import("/modules/_core/visual/conversation/tool-run.js");
const { buildChatRenderProjection, PREVIEW_SEGMENT_SUFFIX, PROVISIONAL_CHIP_PREFIX } = await import(
  "/modules/_core/onscreen_agent/chat-projection.js"
);
const { selectMessageContentPainter, paintPreviewMarkdown, MESSAGE_CONTENT_PAINTER, PREVIEW_PAINT_MODE } =
  await import("/modules/_core/visual/conversation/preview-markdown.js");

const view = createAgentThreadView({ execution, renderMarkdownWithMarked: true });

const PREVIEW_ID = "engine-swap-streaming-preview";

function project(entries) {
  return entries.map((entry) => projectHistoryEntryForDisplay(entry));
}

function typed(messages) {
  return project(canonicalMessagesToTypedEntries(messages));
}

function renderThread(history, options = {}) {
  const thread = new StubNode("div");
  view.renderMessages(thread, history, { groupToolRuns: true, scroller: null, ...options });
  return thread;
}

function rowsOf(toolRunCard) {
  const body = toolRunCard.querySelector("[data-tool-run-body]");
  return body ? body.children.filter((child) => child.dataset.toolRunRowCallId !== undefined) : [];
}

function findToolRunCards(thread) {
  return thread.querySelectorAll("[data-tool-run-card]");
}

function summaryTitleOf(row) {
  return row.querySelector("[data-execution-summary-title]")?.textContent || "";
}

// --- ITEM A -----------------------------------------------------------------

const twoCallBatch = () =>
  typed([
    {
      content: "Two reads.",
      role: "assistant",
      toolCalls: [
        { arguments: { path: "a" }, id: "c1", name: "file_read" },
        { arguments: { path: "b" }, id: "c2", name: "file_read" }
      ]
    },
    { content: JSON.stringify({ ok: 1 }), role: "tool", toolCallId: "c1" },
    { content: JSON.stringify({ ok: 2 }), role: "tool", toolCallId: "c2" }
  ]);

test("A: the expanded body draws exactly as many rows as the header counts", () => {
  const entries = twoCallBatch();
  const run = collectToolRun(entries, 1);
  const summary = summarizeToolRun(run.entries);

  assert.equal(summary.total, 2, "two CALLS, not four entries");
  assert.equal(summary.succeeded, 2);
  assert.equal(formatToolRunLabel(summary), "2 tool calls · 2 succeeded");

  const thread = renderThread(entries);
  const [card] = findToolRunCards(thread);

  assert.ok(card, "the batch is grouped");
  assert.equal(
    card.querySelector("[data-tool-run-label]").textContent,
    "2 tool calls · 2 succeeded",
    "the header states the call count"
  );
  assert.deepEqual(
    rowsOf(card).map((row) => row.dataset.toolRunRowCallId),
    ["c1", "c2"],
    "ONE row per call — the owner-visible 2-vs-4 mismatch is a parity failure"
  );
});

test("A: each row carries its OWN outcome, so a failure is not masked by a sibling", () => {
  const entries = project(
    canonicalMessagesToTypedEntries([
      {
        content: "One good read, one bad.",
        role: "assistant",
        toolCalls: [
          { arguments: {}, id: "ok1", name: "file_read" },
          { arguments: {}, id: "bad1", name: "file_write" }
        ]
      },
      { content: JSON.stringify({ ok: true }), role: "tool", toolCallId: "ok1" },
      { content: "error (io): denied", role: "tool", toolCallId: "bad1" }
    ])
  );
  const run = collectToolRun(entries, 1);
  const summary = summarizeToolRun(run.entries);

  assert.deepEqual(
    summary.calls.map((call) => [call.callId, call.outcome]),
    [
      ["ok1", "success"],
      ["bad1", "error"]
    ],
    "outcomes are per call"
  );

  const thread = renderThread(entries);
  const [card] = findToolRunCards(thread);
  const rows = rowsOf(card);
  const failedRow = rows.find((row) => row.dataset.toolRunRowCallId === "bad1");
  const okRow = rows.find((row) => row.dataset.toolRunRowCallId === "ok1");

  assert.match(summaryTitleOf(failedRow), /file_write · Error$/u);
  assert.match(summaryTitleOf(okRow), /file_read · Success$/u);
  assert.equal(
    failedRow.querySelector("[data-execution-status]")?.className,
    "execution-status is-error",
    "the failing row shows the failure"
  );
});

test("A: a standalone call+result pair still draws its two ordered rows", () => {
  // Report-only contract the lane brief asked to check: a pair that is NOT grouped still
  // renders a call row and a result row, in stored order, exactly as before.
  const entries = typed([
    { content: "Just one.", role: "assistant", toolCalls: [{ arguments: {}, id: "s1", name: "file_read" }] },
    { content: JSON.stringify({ ok: 1 }), role: "tool", toolCallId: "s1" }
  ]);
  const thread = renderThread(entries);

  assert.equal(findToolRunCards(thread).length, 0, "a single call is not grouped");
  assert.deepEqual(
    thread.querySelectorAll("[data-execution-message-id]").map((card) => card.dataset.executionMessageId),
    ["tool-call-s1", "tool-result-s1"],
    "the pair keeps one row per ENTRY — unchanged behaviour, not a regression"
  );
});

// --- ITEM B -----------------------------------------------------------------

test("B: an interleaved run groups as ONE run and splits at narration", () => {
  const ordered = twoCallBatch();
  const callA = ordered.find((entry) => entry.typedToolCallId === "c1" && entry.typedTool === "call");
  const callB = ordered.find((entry) => entry.typedToolCallId === "c2" && entry.typedTool === "call");
  const resultA = ordered.find((entry) => entry.typedToolCallId === "c1" && entry.typedTool === "result");
  const resultB = ordered.find((entry) => entry.typedToolCallId === "c2" && entry.typedTool === "result");
  const narration = ordered[0];
  const interleaved = [narration, callA, resultA, callB, resultB];

  const interleavedRun = collectToolRun(interleaved, 1);
  assert.equal(interleavedRun.endIndex, 4, "a result between two calls does not end the run");
  assert.equal(summarizeToolRun(interleavedRun.entries).total, 2);

  // Narration still splits: prose is a different kind of row and is never inferred across.
  const split = [narration, callA, resultA, { content: "then", id: "n2", role: "assistant" }, callB, resultB];
  assert.equal(collectToolRun(split, 1).endIndex, 2, "narration ends the run");
});

test("B: a held/deferred block stays fully individual", () => {
  const entries = project(
    canonicalMessagesToTypedEntries([
      {
        content: "Delete two things.",
        role: "assistant",
        toolCalls: [
          { arguments: {}, id: "h1", name: "file_delete" },
          { arguments: {}, id: "h2", name: "file_delete" }
        ]
      },
      { content: "held: confirm deletion", role: "tool", toolCallId: "h1" },
      { content: "deferred: sibling held", role: "tool", toolCallId: "h2" }
    ])
  );
  const thread = renderThread(entries);

  assert.equal(findToolRunCards(thread).length, 0, "a consent episode is never summarized away");
});

// --- ITEM C -----------------------------------------------------------------

test("C: provisional chips interleave chronologically instead of stacking on top", () => {
  const history = [
    { content: "read it", id: "u1", kind: "", role: "user" }
  ];
  const previewText = "I will read the file, then write it.";
  const preview = { content: previewText, id: PREVIEW_ID, role: "assistant", streaming: true };
  // Offsets are the preview length AT THE MOMENT each call's arguments completed, so they
  // are derived from the text rather than invented: chip p1 lands after the first clause,
  // chip p2 after the second.
  const firstOffset = previewText.indexOf(" then") + " the file,".length;
  const secondOffset = previewText.indexOf(" it.");
  const projection = buildChatRenderProjection({
    history,
    preview,
    provisionalCalls: [
      { atChars: firstOffset, callId: "p1", name: "file_read" },
      { atChars: secondOffset, callId: "p2", name: "file_write" }
    ]
  });
  const tail = projection.slice(1);
  const shape = tail.map((entry) => (entry.provisional === true ? `chip:${entry.typedToolCallId}` : "text"));

  assert.deepEqual(shape, ["text", "chip:p1", "text", "chip:p2", "text"]);
  assert.equal(
    tail[0].content,
    previewText.slice(0, firstOffset),
    "the first chip sits exactly where the prose had reached when it appeared"
  );
  assert.equal(
    tail.filter((entry) => entry.provisional !== true).map((entry) => entry.content).join(""),
    previewText,
    "no preview text is dropped or duplicated by the split"
  );
  assert.notEqual(
    tail[0].id,
    tail[tail.length - 1].id,
    "frozen segments are distinct rows; only the tail keeps the patchable preview id"
  );
  assert.equal(tail[tail.length - 1].id, PREVIEW_ID, "the tail is the row the live patch updates");
  assert.match(tail[0].id, new RegExp(`${PREVIEW_SEGMENT_SUFFIX}0$`, "u"));
  assert.ok(
    projection.findIndex((entry) => entry.provisional === true) > 1,
    "a chip appears AFTER committed history and prose, never stacked on top of it"
  );
});

test("C: a chip with no offset still renders, and no chips keeps the old single row", () => {
  const preview = { content: "Words.", id: PREVIEW_ID, role: "assistant", streaming: true };

  const plain = buildChatRenderProjection({ history: [], preview });
  assert.equal(plain.length, 1, "no boundary, no split — byte-identical to before item C");
  assert.equal(plain[0], preview, "the SAME preview object is pushed, unwrapped");

  const withCall = buildChatRenderProjection({
    history: [],
    preview,
    provisionalCalls: [{ callId: "x1", name: "file_read" }]
  });
  assert.equal(withCall.length, 2, "an unmeasured chip is drawn at the cursor, never dropped");
  assert.equal(withCall[0].typedToolCallId, "x1");
});

test("C: the commit-race guard still refuses a preview the turn already committed", () => {
  const committed = "All done.";
  const history = [
    { content: "go", id: "u1", kind: "", role: "user" },
    { content: committed, id: "a1", kind: "", role: "assistant" }
  ];
  const projection = buildChatRenderProjection({
    history,
    preview: { content: committed, id: PREVIEW_ID, role: "assistant", streaming: true },
    provisionalCalls: [{ atChars: 3, callId: "p1", name: "file_read" }]
  });

  assert.deepEqual(
    projection.map((entry) => entry.id),
    ["u1", "a1",
      `${PROVISIONAL_CHIP_PREFIX}p1`],
    "the guard is applied to the WHOLE preview before splitting, so the chip still paints and the duplicate row does not"
  );
});

test("C: the painter decision is the shared one, and the preview takes it", () => {
  assert.equal(selectMessageContentPainter({ streaming: true }), MESSAGE_CONTENT_PAINTER.PREVIEW);
  assert.equal(selectMessageContentPainter({ streaming: false }), MESSAGE_CONTENT_PAINTER.COMMITTED);

  // An unclosed fence GROWS as a code block rather than sitting there as literal backticks.
  const painted = [];
  const renderer = (source) => {
    painted.push(source);
    const node = new StubNode("div");
    node.innerHTML = `<pre><code>${source}</code></pre>`;
    return node;
  };
  const target = new StubNode("p");
  const setPlainText = (element, value) => {
    element.textContent = value;
  };

  const first = paintPreviewMarkdown(target, "Narration.\n\n```js\nconst a = 1;", { renderMarkdown: renderer, setPlainText });
  const grown = paintPreviewMarkdown(target, "Narration.\n\n```js\nconst a = 1;\nconst b = 2;\n```", {
    renderMarkdown: renderer,
    setPlainText
  });

  assert.equal(first, PREVIEW_PAINT_MODE.MARKDOWN);
  assert.equal(grown, PREVIEW_PAINT_MODE.MARKDOWN);
  assert.equal(painted.length, 2, "each tick re-renders the ACCUMULATED text");
  assert.ok(painted[1].includes("const b = 2;"), "the fence grew");
});

test("C: a streaming tool card repaints its narration through the preview painter", () => {
  // The owner-visible shape: prose above a tool card froze at the first fragment. The
  // narration is now repainted on every tick and wears the preview painter's mark, while a
  // tick with unchanged text touches nothing.
  //
  // The separator is the REAL one the surface classifies with, so this goes through the
  // same execute branch a live tool turn takes; without it the message would be plain text
  // and the contract would be untested.
  const thread = new StubNode("div");
  const message = {
    content: "Reading now, then **bold** text.",
    id: "assistant-live-1",
    kind: "",
    role: "assistant",
    streaming: true
  };
  const withSeparator = (text) => `${text}\n${execution.EXECUTION_SEPARATOR}\nfileRead({ path: "a" })`;

  view.renderMessages(thread, [{ ...message, content: withSeparator(message.content) }], {
    groupToolRuns: true,
    scroller: null
  });

  const row = thread.querySelector("[data-streaming-message-id]");
  assert.ok(row, "a streaming execute row is mounted");

  const narration = row.querySelector("[data-execution-narration]");
  assert.ok(narration, "the narration block exists");
  assert.ok(
    narration.classList.contains("message-markdown"),
    "narration takes the SAME markdown painter as text turns"
  );

  const before = narration.textContent;
  view.updateStreamingAssistantMessage(
    thread,
    { ...message, content: withSeparator(message.content) },
    { scroller: null }
  );

  assert.equal(
    row.querySelector("[data-execution-narration]").textContent,
    before,
    "an unchanged tick does not repaint"
  );

  const grown = "Reading now, then **bold** text that keeps arriving.";
  view.updateStreamingAssistantMessage(thread, { ...message, content: withSeparator(grown) }, { scroller: null });

  assert.notEqual(
    row.querySelector("[data-execution-narration]").textContent,
    before,
    "narration follows the stream instead of freezing at its first fragment"
  );
});

// --- ITEM D -----------------------------------------------------------------

test("D: typed chips state what they are, in the existing vocabulary", () => {
  assert.equal(view.formatTypedToolLabel("file_read", "success"), "file_read · Success");
  assert.equal(view.formatTypedToolLabel("run_code", "error"), "run_code · Error");
  assert.equal(view.formatTypedToolLabel("run_code", "pending"), "run_code · Running");
  assert.equal(view.formatTypedToolLabel("", "success"), "tool · Success", "a nameless chip still reads honestly");

  assert.doesNotMatch(
    view.formatTypedToolLabel("run_code", "success"),
    /Executed|of code/u,
    "Tier 3 code-line vocabulary must not leak onto typed chips"
  );
});

test("D: Tier 3 chip labels are byte-identical", () => {
  assert.equal(view.formatExecutionSummaryLabel(3, "generating", []), "Writing 3 lines of code");
  assert.equal(view.formatExecutionSummaryLabel(3, "running", []), "Executing 3 lines of code");
  assert.equal(
    view.formatExecutionSummaryLabel(0, "", [{ outputLines: [], status: "log" }]),
    "Executed code of code - Success",
    "the pre-existing wording is untouched, including its degenerate zero-line form"
  );
  assert.equal(view.formatExecutionSummaryLabel(0, "display-only", []), "Shown, not executed");
});

test("D: a typed chip's rendered label comes from the tool, not from its projected prose", () => {
  const entries = typed([
    { content: "One.", role: "assistant", toolCalls: [{ arguments: {}, id: "d1", name: "file_read" }] },
    { content: JSON.stringify({ ok: 1 }), role: "tool", toolCallId: "d1" }
  ]);
  const thread = renderThread(entries);
  const callRow = thread
    .querySelectorAll("[data-execution-message-id]")
    .find((card) => card.dataset.executionMessageId === "tool-call-d1");
  const resultRow = thread
    .querySelectorAll("[data-execution-message-id]")
    .find((card) => card.dataset.executionMessageId === "tool-result-d1");

  assert.equal(summaryTitleOf(callRow), "file_read · Running");
  assert.equal(summaryTitleOf(resultRow), "file_read · Success");
});
