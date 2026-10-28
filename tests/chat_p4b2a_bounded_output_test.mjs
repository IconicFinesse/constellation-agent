// P4b-2a — BOUNDED typed output.
//
// P4b-1 made the typed chip's content structured; it did not make it BOUNDED, so an expanded
// `run_code` chip was still a wall of text. This suite pins the bounds and, more importantly,
// pins their HONESTY: every cut names what it hid, the count comes from the real total, and
// the full content stays reachable through one control.
//
// EVERYTHING HERE RUNS THROUGH THE REAL PAINT PATH — the renderer, the projection, the
// classifier, the formatter and the shared bounding helper are the product's own modules. The
// "one implementation" claim is proven by MUTATION of the shared bounding module, not by an
// assertion that the surface calls it: a per-surface copy would pass such an assertion.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("./p4b2a_format_loader.mjs", import.meta.url), import.meta.url);

// --- minimal selectable DOM (same technique the chat-polish suites use) --------------

function camelCase(dataAttribute) {
  return String(dataAttribute || "")
    .replace(/^data-/iu, "")
    .replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

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

function matches(element, selector) {
  const trimmed = String(selector || "").trim();

  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith(".")) {
    if (trimmed.includes(" ")) {
      return false;
    }

    return element.classList.contains(trimmed.slice(1));
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
      },
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !this.classList.contains(name) : force === true;

        if (shouldAdd) {
          this.classList.add(name);
        } else {
          this.classList.remove(name);
        }

        return shouldAdd;
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
    this._text = String(value || "");
    this.children = [];
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

// --- the modules under test, loaded through the real product paths -------------------

const { P4B2A_FORMAT_MODULE } = await import("./p4b2a_format_loader.mjs");
const bounds = await import(P4B2A_FORMAT_MODULE);
const shared = await import("/modules/_core/framework/js/engine-swap/typed-result-format.js");
const shapes = await import("/modules/_core/framework/js/engine-swap/history-shapes.js");
const chip = await import("/modules/_core/framework/js/engine-swap/chat-projection.js");
const { createAgentThreadView } = await import("/modules/_core/visual/conversation/thread-view.js");
const execution = await import("/modules/_core/onscreen_agent/execution.js");

// Product source, for the assertions that are about WHERE a thing lives rather than what it
// paints. Comments are stripped so a name mentioned in prose cannot satisfy an absence check.
const WORKTREE = new URL("../", import.meta.url);

function readProductFile(relativePath) {
  return readFileSync(new URL(relativePath, WORKTREE), "utf8");
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");

      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

// The caps the product declares. Read from the product's own module so the test cannot
// disagree with the shipped number — but every COUNT asserted below is computed from the
// FIXTURE, never read back out of the formatter.
const MAX_LINES = bounds.EXECUTION_FORMAT_MAX_TRANSCRIPT_LINES;
const MAX_STRING = bounds.EXECUTION_FORMAT_MAX_STRING_LENGTH;
const MAX_ENTRIES = bounds.EXECUTION_FORMAT_MAX_COLLECTION_ENTRIES;

// Independent thousands separator, so the expected marker text is built here rather than
// asked of the product.
function withThousands(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

// --- fixtures -----------------------------------------------------------------------

const RUN_CODE_ARGUMENTS = { language: "python", code: "print(1)\nprint(2)" };

// 2,000 one-line log entries: the shape a chatty loop produces.
const BIG_LOG_COUNT = 2000;
const BIG_PAYLOAD = {
  error: null,
  logs: Array.from({ length: BIG_LOG_COUNT }, (_unused, index) => ({
    level: "log",
    text: `iteration ${index}`
  })),
  result: "done",
  resultText: "done",
  runId: 7,
  status: "success"
};

const LONG_LINE = "x".repeat(100 * 1024);
const LONG_LINE_PAYLOAD = {
  error: null,
  logs: [{ level: "log", text: LONG_LINE }],
  result: "ok",
  resultText: "ok"
};

const DEEP_VALUE = { a: { b: { c: { d: { e: { f: { g: { h: "deep" } } } } } } } };

const MANY_LINES = Array.from({ length: 10000 }, (_unused, index) => `line ${index}`).join("\n");

const BIG_ERROR_BODY = `Traceback (most recent call last):\n${"frame detail ".repeat(4200)}\nNameError: x is not defined`;

function typedCallAndResult({ arguments: args = RUN_CODE_ARGUMENTS, name = "run_code", payload = BIG_PAYLOAD } = {}) {
  const messages = [
    { content: "", role: "assistant", toolCalls: [{ arguments: args, id: "call-1", name }] },
    { content: `ok: ${JSON.stringify(payload)}`, role: "tool", toolCallId: "call-1" }
  ];

  return shapes
    .canonicalMessagesToTypedEntries(messages)
    .map((entry) => shapes.projectHistoryEntryForDisplay(entry));
}

function provisionalChipFor({ arguments: args = RUN_CODE_ARGUMENTS, name = "run_code", payload = BIG_PAYLOAD } = {}) {
  return chip.createProvisionalChipEntry({
    arguments: args,
    callId: "call-1",
    name,
    outcome: "success",
    resultContent: `ok: ${JSON.stringify(payload)}`
  });
}

const view = createAgentThreadView({ execution, renderMarkdownWithMarked: true });

function renderThread(history, options = {}) {
  const thread = new StubNode("div");

  view.renderMessages(thread, history, { groupToolRuns: true, scroller: null, ...options });

  return thread;
}

function paintedOutputLines(thread) {
  const pane = thread.querySelector('[data-execution-pane="output"]');

  if (!pane) {
    return [];
  }

  return pane.querySelectorAll(".terminal-line").map((line) => ({
    modifier: line.className.replace(/^terminal-line\s*/u, "").trim(),
    text: line.textContent
  }));
}

function paintedOutputText(thread) {
  return paintedOutputLines(thread)
    .map((line) => line.text)
    .join("\n");
}

function markerLines(thread) {
  return paintedOutputLines(thread).filter((line) => bounds.hasExecutionHiddenMarker(line.text));
}

// ====================================================================================
// 0. The caps have ONE home.
// ====================================================================================

test("the caps live in the ONE shared module, and the typed formatter declares none", () => {
  const sharedSource = stripComments(readProductFile("app/L0/_all/modules/_core/framework/js/execution-format.js"));
  const typedSource = stripComments(readProductFile("app/L0/_all/modules/_core/framework/js/engine-swap/typed-result-format.js"));

  ["EXECUTION_FORMAT_MAX_STRING_LENGTH", "EXECUTION_FORMAT_MAX_COLLECTION_ENTRIES", "EXECUTION_FORMAT_MAX_DEPTH", "EXECUTION_FORMAT_MAX_TRANSCRIPT_LINES"].forEach((name) => {
    assert.equal(sharedSource.includes(`export const ${name} =`), true, `${name} must be exported by the shared module`);
    assert.equal(typedSource.includes(`${name} =`), false, `${name} must not be re-declared by the typed formatter`);
  });

  assert.equal(MAX_ENTRIES, 8, "the console entry cap is admin's, unchanged");
  assert.equal(bounds.EXECUTION_FORMAT_MAX_DEPTH, 2, "the console depth cap is admin's, unchanged");
  assert.equal(MAX_STRING, 220, "the console string cap is admin's, unchanged");
  assert.ok(MAX_LINES > 0);

  // And no SECOND set of the same numbers inside the typed formatter.
  ["220", "= 8", "= 2"].forEach((literal) => {
    assert.equal(typedSource.includes(literal), false, `the typed formatter must not carry its own cap literal ${literal}`);
  });
});

// ====================================================================================
// 1. MARKER HONESTY — the count equals the real hidden count, computed here from the
//    fixture. This is the hard rule of the lane: never truncate silently.
// ====================================================================================

test("the transcript bound emits a marker whose count equals the real hidden line count", () => {
  // INDEPENDENT ARITHMETIC from the fixture: each log entry paints `label↓` plus its own
  // line (2 lines), then `result↓` plus the result text (2 lines). The cap admits MAX_LINES.
  const totalContentLines = BIG_LOG_COUNT * 2 + 2;
  const expectedHidden = totalContentLines - MAX_LINES;

  const entries = shared.formatTypedToolResult({ name: "run_code", payload: BIG_PAYLOAD });
  const marker = entries.find((entry) => bounds.isExecutionBoundMarkerText(entry.text));

  assert.ok(marker, "a bounded transcript must say that it is bounded");
  assert.equal(marker.text, `… ${withThousands(expectedHidden)} more lines`);
  assert.equal(marker.modifier, "is-muted", "a marker is transcript furniture, not program output");

  // The rendered content is exactly the admitted budget, plus the one marker line. Nothing
  // is lost silently and nothing is admitted twice.
  assert.equal(entries.length, MAX_LINES + 1);
});

test("the marker is HONEST at the edges: one line over the cap hides exactly one line", () => {
  // 21 log entries = 42 content lines, 2 over a 40-line budget.
  const payload = {
    logs: Array.from({ length: 21 }, (_unused, index) => ({ level: "log", text: `l${index}` })),
    result: undefined,
    resultText: ""
  };
  const entries = shared.formatTypedToolResult({ name: "run_code", payload });
  const marker = entries.find((entry) => bounds.isExecutionBoundMarkerText(entry.text));

  assert.ok(marker);
  assert.equal(marker.text, `… ${withThousands(42 - MAX_LINES)} more lines`);
  assert.equal(42 - MAX_LINES, 2);
});

test("a transcript that FITS is left completely alone: no marker, every line present", () => {
  const payload = {
    logs: Array.from({ length: 5 }, (_unused, index) => ({ level: "log", text: `l${index}` })),
    result: 1,
    resultText: "1"
  };
  const entries = shared.formatTypedToolResult({ name: "run_code", payload });

  assert.equal(entries.some((entry) => bounds.isExecutionBoundMarkerText(entry.text)), false);
  assert.equal(entries.length, 5 * 2 + 2, "the unbounded content is exactly what the payload holds");
});

// ====================================================================================
// 2. LINE-ORIENTED TEXT IS BOUNDED BY LINE COUNT ONLY.
//    Per-line character truncation would mangle the program output the owner opened the
//    pane to read, so it must not happen — the cap is admin's rule for CONSOLE VALUES.
// ====================================================================================

test("a 100 KB single line is kept WHOLE: the transcript rule never truncates characters", () => {
  const entries = shared.formatTypedToolResult({ name: "run_code", payload: LONG_LINE_PAYLOAD });
  const longLine = entries.find((entry) => entry.text === LONG_LINE);

  assert.ok(longLine, "the long line must be painted in full, not clamped mid-word");
  assert.equal(longLine.text.length, LONG_LINE.length);
  assert.equal(entries.some((entry) => bounds.isExecutionBoundMarkerText(entry.text)), false);
  assert.equal(entries.length, 4, "log↓ + the line + result↓ + the result text");
});

test("a 10,000-line resultText is bounded by LINES with the exact hidden count", () => {
  const payload = { error: null, logs: [], result: undefined, resultText: MANY_LINES };
  const entries = shared.formatTypedToolResult({ name: "run_code", payload });
  const marker = entries.find((entry) => bounds.isExecutionBoundMarkerText(entry.text));

  assert.ok(marker);
  // `result↓` + 10,000 lines = 10,001 entries; the result block is admitted head-first.
  assert.equal(marker.text, `… ${withThousands(10001 - MAX_LINES)} more lines`);
  assert.equal(entries.length, MAX_LINES + 1);
  // The lines that SURVIVE are unmodified whole lines.
  assert.equal(entries[1].text, "line 0");
  assert.equal(entries[MAX_LINES - 1].text, `line ${MAX_LINES - 2}`);
});

// ====================================================================================
// 3. STRUCTURED VALUES GET THE CONSOLE CAPS, each clamp naming what it hid.
// ====================================================================================

test("a structured result is clamped by the console caps and says so", () => {
  const payload = {
    error: null,
    logs: [],
    result: Object.fromEntries(Array.from({ length: 20 }, (_unused, index) => [`k${index}`, index])),
    resultText: ""
  };
  const entries = shared.formatTypedToolResult({ name: "run_code", payload });
  const body = entries.map((entry) => entry.text).join("\n");

  assert.ok(bounds.hasExecutionHiddenMarker(body), "a clamped structured value must carry its count");
  assert.ok(body.includes(`… ${20 - MAX_ENTRIES} more entries`), body.slice(0, 400));
});

test("depth 8 is bounded at the console depth, and the bound names the entry count", () => {
  const entries = shared.formatTypedToolResult({ name: "file_read", payload: DEEP_VALUE });
  const body = entries.map((entry) => entry.text).join("\n");

  assert.ok(body.includes("[Object"), "a depth-bound object names its type instead of vanishing");
  assert.ok(bounds.hasExecutionHiddenMarker(body), "and it names how many entries it hid");
});

test("a 220+ character string value is clamped with a character count, not a bare ellipsis", () => {
  const value = "y".repeat(MAX_STRING + 500);
  const entries = shared.formatTypedToolResult({ name: "file_read", payload: { content: value } });
  const body = entries.map((entry) => entry.text).join("\n");

  assert.ok(body.includes(`… 500 more characters`), body.slice(0, 400));
});

// ====================================================================================
// 4. ERRORS ARE NEVER TRUNCATED — not by lines, not by characters, not by depth.
// ====================================================================================

test("a 50 KB error body paints in FULL, with no marker", () => {
  assert.ok(BIG_ERROR_BODY.length > 50 * 1024, `the fixture must really clear 50 KB, got ${BIG_ERROR_BODY.length}`);

  const payload = { error: { text: BIG_ERROR_BODY }, logs: [], result: undefined, resultText: "" };
  const entries = shared.formatTypedToolResult({ name: "run_code", payload });
  const painted = entries.map((entry) => entry.text).join("\n");

  assert.equal(bounds.hasExecutionHiddenMarker(painted), false, "an error must never be marked hidden");
  assert.equal(painted.includes(BIG_ERROR_BODY), true, "every byte of the error must be painted");

  // The block is `error↓` plus the body's own lines — no line dropped, no line clamped.
  assert.equal(entries.length, 1 + BIG_ERROR_BODY.split("\n").length);
  assert.equal(entries[0].text, "error↓");
  assert.equal(entries[0].modifier, "is-error");
  BIG_ERROR_BODY.split("\n").forEach((line, index) => {
    assert.equal(entries[index + 1].text, line, "each error line is unchanged");
  });
});

test("an error body survives ALONGSIDE a bounded transcript, in its own place", () => {
  const payload = {
    error: { text: BIG_ERROR_BODY },
    logs: Array.from({ length: 500 }, (_unused, index) => ({ level: "log", text: `l${index}` })),
    result: undefined,
    resultText: ""
  };
  const entries = shared.formatTypedToolResult({ name: "run_code", payload });
  const markerIndex = entries.findIndex((entry) => bounds.isExecutionBoundMarkerText(entry.text));
  const errorIndex = entries.findIndex((entry) => entry.text === "Traceback (most recent call last):");

  assert.ok(markerIndex !== -1, "the logs are still bounded");
  assert.ok(errorIndex !== -1, "the error is still present");
  assert.equal(
    entries.map((entry) => entry.text).join("\n").includes(BIG_ERROR_BODY),
    true,
    "and it is present IN FULL, not cut by the surrounding bound"
  );
  assert.ok(errorIndex > markerIndex, "and it keeps its place AFTER the truncated logs");
});

test("the non-run_code error face is exempt too", () => {
  const entries = shared.formatTypedToolResult({ name: "file_read", error: { message: BIG_ERROR_BODY } });
  const painted = entries.map((entry) => entry.text).join("\n");

  assert.equal(painted.includes(BIG_ERROR_BODY), true, "the whole coaching/message body survives");
  assert.equal(entries.some((entry) => bounds.isExecutionBoundMarkerText(entry.text)), false);
});

// ====================================================================================
// 5. THE EXPANSION AFFORDANCE — collapsed → click → full → click → collapsed, proven on
//    BOTH surfaces by measuring the rendered length.
// ====================================================================================

const surfaceViews = [
  { label: "admin", view: createAgentThreadView({ execution, renderMarkdownWithMarked: true }) },
  {
    label: "onscreen",
    view: createAgentThreadView({
      assistantAvatarPath: "",
      autoResizeMaxHeight: 120,
      execution,
      renderMarkdownWithMarked: true
    })
  }
];

function renderOnSurface(surfaceView, history) {
  const thread = new StubNode("div");

  surfaceView.renderMessages(thread, history, { groupToolRuns: true, scroller: null });

  return thread;
}

surfaceViews.forEach(({ label, view: surfaceView }) => {
  test(`EXPAND (${label}): Show all renders the complete content, and collapses back`, () => {
    const thread = renderOnSurface(surfaceView, typedCallAndResult());
    const toggle = thread.querySelector('[data-typed-output-toggle="expand"]');

    assert.ok(toggle, "a bounded pane must offer a way to see everything");
    assert.equal(toggle.dataset.messageAction, undefined, "it must not look like a store message action");
    assert.equal(toggle.dataset.terminalAction, undefined, "it must not look like a store terminal action");

    const boundedLines = paintedOutputLines(thread);
    const boundedLength = boundedLines.map((line) => line.text).join("\n").length;

    assert.equal(markerLines(thread).length, 1, "the collapsed pane is bounded");

    toggle.dispatch("click");

    const expandedLines = paintedOutputLines(thread);
    const expandedLength = expandedLines.map((line) => line.text).join("\n").length;

    assert.ok(expandedLength > boundedLength, "the rendered text length must actually change");
    assert.equal(markerLines(thread).length, 0, "nothing is hidden once expanded");
    assert.equal(expandedLines.length, BIG_LOG_COUNT * 2 + 2, "every line of the payload is painted");
    assert.ok(
      expandedLines.some((line) => line.text === `iteration ${BIG_LOG_COUNT - 1}`),
      "the LAST line — the one the bound hid — must be reachable"
    );

    toggle.dispatch("click");

    assert.equal(paintedOutputLines(thread).length, boundedLines.length, "collapsing restores the bound");
    assert.equal(markerLines(thread).length, 1);

    // LOCAL DOM STATE ONLY: a repaint starts bounded again.
    const repainted = renderOnSurface(surfaceView, typedCallAndResult());

    assert.equal(
      repainted.querySelector('[data-typed-output-toggle="expand"]').dataset.typedOutputShown,
      undefined,
      "the toggle's state is not persisted into the row"
    );
    assert.equal(markerLines(repainted).length, 1, "a repaint returns to the bounded form");
  });
});

test("the expansion control also appears for a STRUCTURED clamp, and expands it", () => {
  const wide = Object.fromEntries(Array.from({ length: 30 }, (_unused, index) => [`k${index}`, `value ${index}`]));
  const thread = renderThread(typedCallAndResult({ name: "file_read", payload: wide }));
  const toggle = thread.querySelector('[data-typed-output-toggle="expand"]');

  assert.ok(toggle, "a clamped structured value must offer the same way out");

  const bounded = paintedOutputText(thread);

  assert.equal(bounded.includes('"k29": "value 29"'), false, "the tail entries are hidden");

  toggle.dispatch("click");

  const expanded = paintedOutputText(thread);

  assert.ok(expanded.length > bounded.length);
  assert.ok(expanded.includes('"k29": "value 29"'), "Show all reaches the clamped tail");
});

test("the expansion control is absent when nothing was hidden", () => {
  const small = { logs: [{ level: "log", text: "hi" }], result: 1, resultText: "1" };
  const thread = renderThread(typedCallAndResult({ payload: small }));

  assert.equal(thread.querySelector('[data-typed-output-toggle="expand"]'), null);
});

// ====================================================================================
// 6. PARITY — the mid-turn chip and the committed row still paint identically, now with
//    bounding in the path.
// ====================================================================================

test("PARITY under bounding: the mid-turn chip's panes equal the committed row's, byte for byte", () => {
  const committed = renderThread(typedCallAndResult());
  const live = renderThread([provisionalChipFor()], { groupToolRuns: false, provisional: true });

  assert.deepEqual(paintedOutputLines(committed), paintedOutputLines(live));
  assert.equal(paintedOutputText(committed), paintedOutputText(live));
  assert.equal(markerLines(committed).length, 1, "and the parity is OF the bounded form");
});

// ====================================================================================
// 7. ONE IMPLEMENTATION — mutate the SHARED bounding helper and watch BOTH surfaces move.
// ====================================================================================

function resetOverrides() {
  bounds.p4b2aOverrides.boundExecutionStructuredValue = null;
  bounds.p4b2aOverrides.boundExecutionTranscriptChunks = null;
  bounds.p4b2aOverrides.formatExecutionHiddenMarker = null;
}

surfaceViews.forEach(({ label, view: surfaceView }) => {
  test(`ONE IMPLEMENTATION (${label}): mutating the shared transcript bound changes this surface's paint`, () => {
    const baseline = paintedOutputText(renderOnSurface(surfaceView, typedCallAndResult()));

    assert.ok(baseline.length > 0, "the baseline must paint something before the mutation means anything");

    bounds.p4b2aOverrides.boundExecutionTranscriptChunks = (chunks) => ({
      chunks,
      cutIndex: -1,
      hiddenLineCount: 0,
      markerText: ""
    });

    const mutated = paintedOutputText(renderOnSurface(surfaceView, typedCallAndResult()));

    resetOverrides();

    assert.notEqual(mutated, baseline, `${label} must paint through the SHARED bound; a copy would not move`);
    assert.equal(
      mutated.includes(`iteration ${BIG_LOG_COUNT - 1}`),
      true,
      "the mutation removes the bound, so the hidden tail becomes visible"
    );
    assert.ok(bounds.p4b2aCalls.transcript > 0, "the shared bounder must actually be exercised");
  });

  test(`ONE IMPLEMENTATION (${label}): mutating the shared structured bound changes this surface's paint`, () => {
    const deepPayload = { nodes: DEEP_VALUE };
    const baseline = paintedOutputText(renderOnSurface(surfaceView, typedCallAndResult({ name: "file_read", payload: deepPayload })));

    bounds.p4b2aOverrides.boundExecutionStructuredValue = (value) => value;

    const mutated = paintedOutputText(renderOnSurface(surfaceView, typedCallAndResult({ name: "file_read", payload: deepPayload })));

    resetOverrides();

    assert.notEqual(mutated, baseline, `${label} must clamp structured values through the SHARED helper`);
    assert.ok(mutated.includes('"deep"'), "unclamped, the depth-8 value is reachable");
  });

  test(`SEEDED FAILURE (${label}): silencing the shared marker goes RED on honesty`, () => {
    bounds.p4b2aOverrides.boundExecutionTranscriptChunks = (chunks, options, real) => {
      const bounded = real.boundExecutionTranscriptChunks(chunks, options);

      return { ...bounded, markerText: "" };
    };

    const seeded = renderOnSurface(surfaceView, typedCallAndResult());

    resetOverrides();

    assert.equal(markerLines(seeded).length, 0, "a silent bound is exactly the defect this lane forbids");
    assert.equal(
      paintedOutputLines(seeded).length,
      MAX_LINES,
      "the content is cut but nothing says so — the seed must reproduce that, or it proves nothing"
    );
  });
});

// ====================================================================================
// 8. BUG-007 — bounded display content never executes.
// ====================================================================================

test("BUG-007: bounded display content dispatches nothing and invents no chip", () => {
  const calls = [];
  const thread = renderThread(
    [
      {
        content: `Here is a long reply:\n\`\`\`javascript\nconsole.log(1);\n\`\`\`\n${"filler ".repeat(500)}`,
        id: "assistant-1",
        kind: "",
        role: "assistant",
        tier1Turn: true
      }
    ],
    { onDispatch: (name) => calls.push(name) }
  );

  assert.deepEqual(calls, [], "rendering display content must dispatch nothing");
  assert.equal(thread.querySelectorAll("[data-execution-card]").length, 0);
});

// ====================================================================================
// 9. TOTALITY — the adversarial table. Every case must paint, none may throw.
// ====================================================================================

test("the bounded formatter is TOTAL over the adversarial table", () => {
  const circular = { name: "loop" };

  circular.self = circular;

  const cases = [
    { label: "2,000 log entries", options: { name: "run_code", payload: BIG_PAYLOAD } },
    { label: "100 KB line, no newline", options: { name: "run_code", payload: LONG_LINE_PAYLOAD } },
    { label: "depth-8 object", options: { name: "file_read", payload: DEEP_VALUE } },
    { label: "circular payload", options: { name: "file_read", payload: circular } },
    { label: "50 KB error", options: { name: "run_code", payload: { error: { text: BIG_ERROR_BODY }, logs: [] } } },
    { label: "empty logs + large result", options: { name: "run_code", payload: { logs: [], result: Array.from({ length: 100 }, (_u, i) => i), resultText: "" } } },
    { label: "10,000-line resultText", options: { name: "run_code", payload: { resultText: MANY_LINES, logs: [] } } },
    { label: "payload null", options: { name: "run_code", payload: null, outputText: "text" } },
    { label: "non-object payload", options: { name: "run_code", payload: 42, outputText: "text" } },
    { label: "nothing at all", options: { name: "mystery" } }
  ];

  cases.forEach(({ label, options }) => {
    const entries = shared.formatTypedToolResult(options);

    assert.ok(Array.isArray(entries), `${label}: must answer an array`);
    entries.forEach((entry) => {
      assert.equal(typeof entry.text, "string", `${label}: text must be a string`);
      assert.equal(typeof entry.modifier, "string", `${label}: modifier must be a string`);
    });
  });

  // Every case that hides something must SAY so. This is the blanket honesty sweep.
  const hidden = [
    { label: "log wall", entries: shared.formatTypedToolResult({ name: "run_code", payload: BIG_PAYLOAD }) },
    { label: "many lines", entries: shared.formatTypedToolResult({ name: "run_code", payload: { resultText: MANY_LINES, logs: [] } }) },
    { label: "deep object", entries: shared.formatTypedToolResult({ name: "file_read", payload: DEEP_VALUE }) }
  ];

  hidden.forEach(({ label, entries }) => {
    assert.equal(
      entries.some((entry) => bounds.hasExecutionHiddenMarker(entry.text)),
      true,
      `${label}: a bound with no marker is a silent truncation`
    );
  });
});

// ====================================================================================
// 10. A CIRCULAR PAYLOAD paints instead of throwing.
// ====================================================================================

test("a circular structured payload paints [Circular] rather than throwing", () => {
  const circular = { name: "loop" };

  circular.self = circular;

  const entries = shared.formatTypedToolResult({ name: "file_read", payload: circular });
  const body = entries.map((entry) => entry.text).join("\n");

  assert.ok(body.includes("loop"));
  assert.ok(body.includes("Circular") || body.includes("…"), body.slice(0, 300));
});
