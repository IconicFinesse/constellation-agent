// P4b-1 — the typed chip's CONTENT (owner items 1 + 2).
//
// The owner read a `run_code` call on the new surface as "just a big wall of text", and
// the `result↓` arrow was missing. Both had one cause: the typed path wrote
// `String(argumentsText)` into a `<pre>` and `String(outputText)` into ONE undifferentiated
// `terminal-line`, so nothing was ever classified. This suite pins the replacement.
//
// EVERYTHING HERE RUNS THROUGH THE REAL PAINT PATH. The DOM is a stub with real selector
// matching, but the renderer, the projection, the classifier and the formatter are the
// product's own modules. A fixture that pre-formats its own expectations cannot see a
// wiring regression, which is this campaign's oldest failure mode.
//
// THE ONE-IMPLEMENTATION CLAIMS ARE PROVEN BY MUTATION, not by assertion. `p4b1Overrides`
// replaces the SHARED formatter at runtime; if a surface painted through a lookalike local
// copy, the mutation would not reach its output.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("./p4b1_format_loader.mjs", import.meta.url), import.meta.url);

// --- minimal selectable DOM (same technique the chat-polish suites use) --------------

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
    if (trimmed.includes(" ")) {
      // Combinators are not used by this suite's selectors; treat them as no match so a
      // typo is loud rather than silently broad.
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

const { P4B1_FORMAT_MODULE } = await import("./p4b1_format_loader.mjs");
const formatModule = await import(P4B1_FORMAT_MODULE);
const shared = await import("/modules/_core/framework/js/engine-swap/typed-result-format.js");
const shapes = await import("/modules/_core/framework/js/engine-swap/history-shapes.js");
const chip = await import("/modules/_core/framework/js/engine-swap/chat-projection.js");
const { createAgentThreadView } = await import("/modules/_core/visual/conversation/thread-view.js");
const execution = await import("/modules/_core/onscreen_agent/execution.js");

const WORKTREE = new URL("../", import.meta.url);

function readProductFile(relativePath) {
  return readFileSync(new URL(relativePath, WORKTREE), "utf8");
}

// Comment stripping, so a name mentioned in prose cannot satisfy an absence assertion.
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

// --- the transcribed abef323 classifier --------------------------------------------
//
// Transcribed from `abef323`:visual/conversation/thread-view.js:334-362 with only the
// module-level pattern inlined, because the move must be proven against the ORIGINAL body
// rather than against itself.
const ABEF323_PRINT_PATTERN = /^(log|info|warn|error|debug|dir|table|assert)(:\s*|↓)$/iu;

function abef323Modifier(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";

  if (!trimmed) {
    return "is-muted";
  }

  if (/^execution\s+/iu.test(trimmed)) {
    return "is-meta";
  }

  if (/^result(?::\s*|↓)$/iu.test(trimmed)) {
    return "is-result";
  }

  if (/^warn(?::\s*|↓)$/iu.test(trimmed)) {
    return "is-warn";
  }

  if (/^error(?::\s*|↓)$/iu.test(trimmed)) {
    return "is-error";
  }

  if (ABEF323_PRINT_PATTERN.test(trimmed)) {
    return "is-print";
  }

  return "";
}

// The adversarial LINE corpus: whitespace, the reserved prefixes with and without a colon,
// the arrow form, empty strings, unicode, CRLF, a whitespace-only line, a very long line, and
// near-misses that must NOT classify as a prefix.
const LINE_CORPUS = [
  "",
  "   ",
  "\t\t",
  "result↓",
  "  result↓  ",
  "result:",
  "result:  ",
  "RESULT↓",
  "Result:",
  "results:",
  "result 42",
  "warn↓",
  "warn:",
  "warning:",
  "error↓",
  "error:",
  "errors:",
  "execution success",
  "  execution  failed  ",
  "execution",
  "log↓",
  "log:",
  "info↓",
  "debug:",
  "dir↓",
  "table:",
  "assert↓",
  "logger↓",
  "plain text",
  "  padded plain text with trailing spaces   ",
  "héllo wörld ↓",
  "line with\r\ncarriage return",
  "x".repeat(4000),
  "42",
  "result↓ extra",
  "_result↓"
];

// --- typed history builders ---------------------------------------------------------

const RUN_CODE_PAYLOAD = {
  error: null,
  logs: [
    { level: "log", text: "first line of output" },
    { level: "warn", text: "a warning the script printed" }
  ],
  result: 42,
  resultText: "42",
  runId: 1,
  status: "success"
};

const RUN_CODE_ARGUMENTS = { language: "python", code: "print(1)\nprint(2)" };

function typedCallAndResult({ arguments: args = RUN_CODE_ARGUMENTS, name = "run_code", payload = RUN_CODE_PAYLOAD } = {}) {
  const messages = [
    { content: "", role: "assistant", toolCalls: [{ arguments: args, id: "call-1", name }] },
    { content: `ok: ${JSON.stringify(payload)}`, role: "tool", toolCallId: "call-1" }
  ];

  return shapes
    .canonicalMessagesToTypedEntries(messages)
    .map((entry) => shapes.projectHistoryEntryForDisplay(entry));
}

function provisionalChipFor({ arguments: args = RUN_CODE_ARGUMENTS, name = "run_code", payload = RUN_CODE_PAYLOAD } = {}) {
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

// The painted INPUT pane text (the arguments `<pre>`).
function paintedInputPane(thread) {
  const pane = thread.querySelector('[data-execution-pane="input"]');

  return pane ? pane.querySelector(".terminal-code")?.textContent || "" : "";
}

// The painted OUTPUT pane, as `{text, modifier}` in paint order. This is the sequence the
// parity and mutation claims are made about.
function paintedOutputLines(thread) {
  const pane = thread.querySelector('[data-execution-pane="output"]');

  if (!pane) {
    return [];
  }

  return pane
    .querySelectorAll(".terminal-line")
    .map((line) => ({
      modifier: line.className.replace(/^terminal-line\s*/u, "").trim(),
      text: line.textContent
    }));
}

function paintedOutputText(thread) {
  return paintedOutputLines(thread)
    .map((line) => line.text)
    .join("\n");
}

// ====================================================================================
// Condition 4 — the classifier MOVED, and it still behaves identically.
// ====================================================================================

test("the moved classifier matches a transcription of the abef323 body over the adversarial line corpus", () => {
  LINE_CORPUS.forEach((line) => {
    assert.equal(
      shared.getExecutionOutputLineModifier(line),
      abef323Modifier(line),
      `classifier must agree with abef323 for ${JSON.stringify(line)}`
    );
  });
});

test("the moved classifier can SEE a difference (the comparison is not vacuous)", () => {
  // A deliberate one-character mutation of the transcription must be detected, otherwise
  // the corpus proves nothing at all.
  const mutated = LINE_CORPUS.map((line) =>
    typeof line === "string" ? line.replace(/^result↓$/u, "result:") : line
  );
  const differs = LINE_CORPUS.some(
    (line, index) => shared.getExecutionOutputLineModifier(mutated[index]) !== abef323Modifier(mutated[index])
  );

  assert.equal(differs, false, "a faithful transcription agrees; the seed below must disagree");

  // Now prove the instrument: a transcription whose `result` rule accepts ONLY the arrow
  // (dropping the `result:` form) must disagree, or the comparison cannot see a narrowed
  // rule at all. This is the seeded mutation condition 4 asks for, and the first version of
  // this test was itself the bug: a "narrowed" rule that was behaviourally identical could
  // never fire, which is a measurement that cannot fail.
  const narrowed = (line) => {
    const trimmed = typeof line === "string" ? line.trim() : "";

    if (/^result(?::\s*|↓)$/iu.test(trimmed)) {
      return trimmed === "result↓" ? "is-result" : "";
    }

    return abef323Modifier(line);
  };

  assert.ok(
    LINE_CORPUS.some((line) => shared.getExecutionOutputLineModifier(line) !== narrowed(line)),
    "the differential must fire when the transcription's rules are narrowed"
  );
});

test("the classifier and its print pattern are ABSENT from the render layer (moved, not copied)", () => {
  const source = stripComments(readProductFile("app/L0/_all/modules/_core/visual/conversation/thread-view.js"));

  assert.equal(
    /function\s+getExecutionOutputLineModifier\s*\(/u.test(source),
    false,
    "the render layer must not declare its own classifier"
  );
  assert.equal(
    /const\s+EXECUTION_PRINT_LINE_PATTERN\s*=/u.test(source),
    false,
    "the render layer must not keep a second copy of the print pattern"
  );

  // …and the name it uses is the shared import, so the one call site still resolves.
  assert.ok(
    /getExecutionOutputLineModifier\s*,/u.test(source) || /\bgetExecutionOutputLineModifier\b/u.test(source),
    "the render layer must still reference the classifier it now imports"
  );
});

// ====================================================================================
// Item 2 — arguments formatting.
// ====================================================================================

test("arguments are pretty-printed, counted, and non-JSON is preserved verbatim", () => {
  const pretty = shared.formatTypedToolArguments({ argumentsText: JSON.stringify(RUN_CODE_ARGUMENTS) });

  assert.equal(pretty.text.includes('\n  "language": "python"'), true, "JSON must be re-serialized with indentation");
  assert.equal(pretty.lineCount, pretty.text.split("\n").length, "the count is of the FORMATTED text");
  assert.ok(pretty.lineCount > 1, "a formatted object is more than one line");
  assert.equal(pretty.raw, JSON.stringify(RUN_CODE_ARGUMENTS), "raw keeps the untouched original");

  const verbatim = shared.formatTypedToolArguments({ argumentsText: "not json at all" });

  assert.equal(verbatim.text, "not json at all", "a non-JSON payload must never be mangled");
  assert.equal(verbatim.raw, "not json at all");
  assert.equal(verbatim.lineCount, 1);
});

// ====================================================================================
// Item 1 — the result formatter.
// ====================================================================================

test("a run_code payload renders structurally: logs, then result↓, then error", () => {
  const entries = shared.formatTypedToolResult({ name: "run_code", payload: RUN_CODE_PAYLOAD });
  const lines = entries.map((entry) => entry.text);

  assert.deepEqual(lines, [
    "log↓",
    "first line of output",
    "warn↓",
    "a warning the script printed",
    "result↓",
    "42"
  ]);
  // The ARROW is the classifier's work, not a literal we typed into the renderer.
  assert.equal(entries.find((entry) => entry.text === "result↓").modifier, "is-result");
  assert.equal(entries.find((entry) => entry.text === "warn↓").modifier, "is-warn");

  const withError = shared.formatTypedToolResult({
    name: "run_code",
    payload: { ...RUN_CODE_PAYLOAD, error: { text: "NameError: x is not defined" }, result: undefined, resultText: "" }
  });
  const errorLine = withError.find((entry) => entry.text === "error↓");

  assert.ok(errorLine, "a run_code error must render its own block");
  assert.equal(errorLine.modifier, "is-error");
});

test("every other tool falls back to pretty-printed JSON under a result↓ line", () => {
  const entries = shared.formatTypedToolResult({ name: "file_read", payload: { content: "notes", path: "/a.txt" } });
  const lines = entries.map((entry) => entry.text);

  assert.equal(lines[0], "result↓");
  assert.equal(entries[0].modifier, "is-result");
  assert.ok(lines.join("\n").includes('"content": "notes"'), "the payload is pretty-printed, not dumped");
});

test("the formatter is TOTAL: it never throws and always classifies", () => {
  const cases = [
    { label: "payload null", options: { name: "run_code", payload: null, outputText: "committed text" } },
    { label: "payload undefined", options: { name: "run_code", payload: undefined, outputText: "committed text" } },
    { label: "non-object payload", options: { name: "run_code", payload: 42, outputText: "committed text" } },
    { label: "empty object", options: { name: "run_code", payload: {} } },
    { label: "only logs", options: { name: "run_code", payload: { logs: [{ level: "info", text: "hi" }] } } },
    { label: "only error", options: { name: "run_code", payload: { error: { text: "boom" }, logs: [] } } },
    { label: "resultText without result", options: { name: "run_code", payload: { resultText: "just text" } } },
    { label: "logged output and result", options: { name: "run_code", payload: { logs: [{ level: "log", text: "x" }], result: 1, resultText: "1" } } },
    { label: "error face", options: { name: "file_read", error: { coaching: "nope", message: "failed" } } },
    { label: "nothing at all", options: { name: "mystery" } },
    { label: "text only (pre-lane row)", options: { name: "mystery", outputText: "old committed text" } }
  ];

  cases.forEach(({ label, options }) => {
    const entries = shared.formatTypedToolResult(options);

    assert.ok(Array.isArray(entries), `${label}: must answer an array`);
    entries.forEach((entry) => {
      assert.equal(typeof entry.text, "string", `${label}: text must be a string`);
      assert.equal(typeof entry.modifier, "string", `${label}: modifier must be a string`);
    });
  });

  // A pre-lane row has no object at all: it must reach the classified text face rather than
  // a raw dump.
  const textFace = shared.formatTypedToolResult({ name: "mystery", outputText: "{ \"a\": 1 }" });

  assert.equal(textFace[0].text, "{ \"a\": 1 }");
});

test("a run_code payload that is ITSELF a JSON string is still rendered structurally", () => {
  const asString = JSON.stringify(RUN_CODE_PAYLOAD);
  const entries = shared.formatTypedToolResult({ name: "run_code", payload: asString });

  assert.equal(entries[0].text, "log↓", "the string must be parsed once, then rendered structurally");
  assert.equal(entries.find((entry) => entry.text === "result↓")?.modifier, "is-result");
});

// ====================================================================================
// Condition 1 — ONE derivation of the result text.
// ====================================================================================

test("projectToolResultText has no derivation of its own: it reads projectToolResultDetail", () => {
  const source = stripComments(
    readProductFile("app/L0/_all/modules/_core/framework/js/engine-swap/history-shapes.js")
  );
  const start = source.indexOf("export function projectToolResultText");
  const body = source.slice(start, source.indexOf("\n}", start) + 2);

  assert.ok(start !== -1, "the function must exist");
  assert.ok(body.includes("projectToolResultDetail("), "it must DELEGATE");
  assert.equal(
    body.includes("createToolResultMessage("),
    false,
    "it must not build its own message: that would be a second derivation"
  );
  assert.equal(
    body.includes("canonicalMessagesToTypedEntries("),
    false,
    "it must not read the history itself: that would be a second derivation"
  );

  // …and the delegation is what answers: the two agree over a corpus of shapes.
  const corpus = [
    { content: `ok: ${JSON.stringify(RUN_CODE_PAYLOAD)}`, isError: false },
    { content: "ok: \"plain string payload\"", isError: false },
    { content: "error (execution): boom", isError: true },
    { content: "ok: null", isError: false },
    { content: "", isError: false }
  ];

  corpus.forEach((input) => {
    assert.equal(shapes.projectToolResultText(input), shapes.projectToolResultDetail(input).text);
  });
});

// ====================================================================================
// Condition 2 — the new fields are DISPLAY-ONLY.
// ====================================================================================

test("the projection carries the payload object but serializes byte-identically", () => {
  const projected = typedCallAndResult().find((entry) => entry.typedTool === "result");

  assert.deepEqual(projected.typedToolResultPayload, RUN_CODE_PAYLOAD, "the object travels with the row");
  assert.equal(projected.typedToolResultError, null);

  // Serialization is the persistence/comparison face. It must not have moved.
  const serialized = JSON.stringify(projected);

  assert.equal(serialized.includes("typedToolResultPayload"), false, "never serialized");
  assert.equal(serialized.includes("typedToolResultError"), false, "never serialized");
  assert.deepEqual(Object.keys(projected).sort(), [
    "content",
    "id",
    "kind",
    "role",
    "typedTool",
    "typedToolCallId",
    "typedToolName",
    "typedToolOutcome"
  ]);

  // The chip carries the same pair, and it is equally invisible to serialization.
  const chipEntry = provisionalChipFor();

  assert.deepEqual(chipEntry.typedToolResultPayload, RUN_CODE_PAYLOAD);
  assert.equal(JSON.stringify(chipEntry).includes("typedToolResultPayload"), false);
});

// ====================================================================================
// Condition 6 — PARITY ON THE PAINTED PANE, not on the inputs.
// ====================================================================================

test("PARITY: the mid-turn chip's panes equal the committed row's panes, byte for byte", () => {
  const committed = renderThread(typedCallAndResult());
  const live = renderThread([provisionalChipFor()], { groupToolRuns: false, provisional: true });

  assert.equal(paintedInputPane(committed), paintedInputPane(live), "the ARGUMENTS pane must be identical");
  assert.deepEqual(paintedOutputLines(committed), paintedOutputLines(live), "the OUTPUT pane must be identical");
  assert.ok(paintedInputPane(committed).includes('\n  "language": "python"'), "and it must be the formatted form");
  assert.ok(
    paintedOutputLines(committed).some((line) => line.modifier === "is-result"),
    "the arrow must be painted, not just present in a string"
  );
});

// ====================================================================================
// Condition 5 — the Raw toggle is LOCAL DOM STATE and resets on repaint.
// ====================================================================================

test("the arguments pane offers a Raw toggle that swaps text locally and resets on repaint", () => {
  const thread = renderThread(typedCallAndResult());
  const pane = thread.querySelector('[data-execution-pane="input"]');
  const toggle = pane.querySelector('[data-typed-arguments-toggle="raw"]');

  assert.ok(toggle, "a Raw affordance must exist");
  assert.equal(toggle.dataset.messageAction, undefined, "it must not look like a store message action");
  assert.equal(toggle.dataset.terminalAction, undefined, "it must not look like a store terminal action");

  const prettyText = paintedInputPane(thread);

  toggle.dispatch("click");
  assert.equal(paintedInputPane(thread), JSON.stringify(RUN_CODE_ARGUMENTS), "Raw shows the untouched original");
  assert.notEqual(paintedInputPane(thread), prettyText);

  toggle.dispatch("click");
  assert.equal(paintedInputPane(thread), prettyText, "toggling back shows the pretty form");

  // THE RESET: a repaint builds a fresh row, so the toggle starts on the pretty form again.
  // Queried in two steps because the stub refuses descendant selectors on purpose: a wrong
  // selector must be loud rather than silently broad.
  const toggleOn = thread.querySelector('[data-execution-pane="input"]').querySelector('[data-typed-arguments-toggle="raw"]');
  toggleOn.dispatch("click");
  const repainted = renderThread(typedCallAndResult());

  assert.equal(paintedInputPane(repainted), prettyText, "a repaint must return to the pretty form");
  assert.equal(
    repainted.querySelector('[data-typed-arguments-toggle="raw"]').dataset.typedArgumentsShown,
    undefined,
    "the toggle's state is not persisted into the row"
  );
});

test("the Raw toggle's state is absent from the render signature (it is not store state)", () => {
  const [entry] = typedCallAndResult();
  const groups = view.buildMessageDisplayGroups(typedCallAndResult(), { groupToolRuns: true });
  const group = groups.find((item) => item?.typedTool) || groups[0];
  const before = view.getGroupRenderSignature(group, { toolRunOpenState: null });

  renderThread(typedCallAndResult()).querySelector('[data-typed-arguments-toggle="raw"]')?.dispatch("click");

  const after = view.getGroupRenderSignature(group, { toolRunOpenState: null });

  assert.equal(after, before, "toggling Raw must not change the render signature");
  assert.ok(entry);
});

// ====================================================================================
// Condition 7 — ONE IMPLEMENTATION, proven on both surfaces, plus two seeded failures.
// ====================================================================================

function resetOverrides() {
  formatModule.p4b1Overrides.formatTypedToolArguments = null;
  formatModule.p4b1Overrides.formatTypedToolResult = null;
}

// Both surfaces paint through `visual/conversation/thread-view.js` and the shared
// projection. This builds one view per surface CONFIG shape the two stores use, so the
// mutation is observed through each surface's own renderer instance.
const surfaceViews = [
  { label: "admin", view: createAgentThreadView({ execution, renderMarkdownWithMarked: true }) },
  {
    label: "onscreen",
    view: createAgentThreadView({ assistantAvatarPath: "", autoResizeMaxHeight: 120, execution, renderMarkdownWithMarked: true })
  }
];

surfaceViews.forEach(({ label, view: surfaceView }) => {
  function renderOnSurface(history) {
    const thread = new StubNode("div");

    surfaceView.renderMessages(thread, history, { groupToolRuns: true, scroller: null });

    return thread;
  }

  test(`ONE IMPLEMENTATION (${label}): mutating the shared formatter changes what this surface paints`, () => {
    const baseline = paintedOutputText(renderOnSurface(typedCallAndResult()));

    assert.ok(baseline.length > 0, "the baseline must paint something before the mutation means anything");

    formatModule.p4b1Overrides.formatTypedToolResult = () => [
      { modifier: "is-meta", text: "SHARED-FORMATTER-MUTATION" }
    ];

    const mutated = paintedOutputText(renderOnSurface(typedCallAndResult()));

    resetOverrides();

    assert.equal(
      mutated,
      "SHARED-FORMATTER-MUTATION",
      `${label} must paint through the SHARED formatter: a runtime change to it must reach its output`
    );
    assert.notEqual(mutated, baseline);
    assert.ok(formatModule.p4b1Calls.result > 0, "the shared formatter must actually be exercised");
  });

  test(`SEEDED FAILURE (${label}): arguments written raw again goes RED`, () => {
    formatModule.p4b1Overrides.formatTypedToolArguments = ({ argumentsText = "" } = {}) => ({
      lineCount: 0,
      raw: String(argumentsText),
      text: String(argumentsText)
    });

    const seeded = paintedInputPane(renderOnSurface(typedCallAndResult()));

    resetOverrides();

    assert.equal(
      seeded.includes('\n  "language": "python"'),
      false,
      "the seed must reproduce the old wall, or it proves nothing"
    );
    assert.ok(seeded.includes("\\n"), "the old wall shows escaped newlines");
  });

  test(`SEEDED FAILURE (${label}): the output pane bypassing the formatter goes RED`, () => {
    formatModule.p4b1Overrides.formatTypedToolResult = ({ outputText = "" } = {}) => [
      { modifier: "", text: String(outputText) }
    ];

    const seededLines = paintedOutputLines(renderOnSurface(typedCallAndResult()));

    resetOverrides();

    assert.equal(
      seededLines.some((line) => line.modifier === "is-result"),
      false,
      "bypassing the formatter loses the arrow, which is exactly the defect this lane fixes"
    );
    assert.equal(seededLines.length, 1, "and the pane collapses back to one blob");
  });
});

// ====================================================================================
// Condition 9 — the projection the payload field pair lands on is SHARED by both stores.
// ====================================================================================

test("both surfaces build their render history through projectHistoryEntryForDisplay", () => {
  const adminStore = readProductFile("app/L0/_all/modules/_core/admin/views/agent/store.js");
  const onscreenStore = readProductFile("app/L0/_all/modules/_core/onscreen_agent/store.js");

  [adminStore, onscreenStore].forEach((source) => {
    assert.ok(source.includes("projectHistoryEntryForDisplay("), "each store must project through the one seam");
  });
});

// ====================================================================================
// BUG-007 — display content never executes, and a display shape invents no chip.
// ====================================================================================

test("BUG-007: a fenced display reply paints no typed chip and dispatches nothing", () => {
  const calls = [];
  const thread = renderThread(
    [
      {
        content: "Here is the code:\n```javascript\nconsole.log(1);\n```\nThat is all.",
        id: "assistant-1",
        kind: "",
        role: "assistant",
        tier1Turn: true
      }
    ],
    { onDispatch: (name) => calls.push(name) }
  );

  assert.deepEqual(calls, [], "rendering display content must dispatch nothing");
  assert.equal(
    thread.querySelectorAll("[data-execution-card]").length,
    0,
    "a display-only reply must invent no execution chip"
  );
});

// ====================================================================================
// Condition 8 — the pre-existing dead reads are recorded, not deleted.
// ====================================================================================

test("PRE-EXISTING FINDING: typedTool.resultText has read sites and ZERO writers", () => {
  const renderSource = stripComments(
    readProductFile("app/L0/_all/modules/_core/visual/conversation/thread-view.js")
  );
  const writerSource = stripComments(
    readProductFile("app/L0/_all/modules/_core/framework/js/engine-swap/chat-projection.js")
  );

  assert.ok(renderSource.includes("typedTool.resultText"), "the read sites still exist (left alone by this lane)");

  const assignments = renderSource.match(/resultText\s*:/gu) || [];

  assert.equal(assignments.length, 0, "nothing ever WRITES a resultText field on a descriptor");
  assert.equal(writerSource.includes("typedToolResultText:"), false, "no producer in the projection either");
});
