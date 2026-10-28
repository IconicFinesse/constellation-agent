// P4b-3 — the POLISH lane: box weight, pane wording, `.is-print` colour.
//
// The owner compared the old and new surfaces and said the old box "looks better" and the
// old wording "reads more sensibly". Three things follow, and each is pinned here:
//
//   1. BOX WEIGHT may already be closed — since P4b-1 the typed path renders through the
//      SAME `createExecutionPane` the legacy path uses. This suite COMPARES the painted box
//      structure of both paths and reports which it is, instead of inventing styling to
//      look busy.
//   2. The arguments pane label is `Input` — the output pane already says `Output`, so
//      `Arguments`/`Output` was a mismatched noun pair with one jargon term.
//   3. `.is-print` gets a rule. `log↓`/`info↓`/`debug↓` are the STRUCTURAL labels that give
//      a payload its shape; they were inheriting default body colour and were the least
//      visible text in the pane while `result↓` was green and `warn↓` amber.
//
// Everything drives the REAL renderer, the REAL projection and the REAL formatters, over a
// selector-capable DOM stub — the same technique the P4b-1 and P4b-2b suites use. A fixture
// that pre-formats its own expectations cannot see a wiring regression.
//
// HONESTY NOTE ON ONE BRIEF PREMISE. The brief asserted `.is-print` is emitted only by the
// typed formatter so Tier 3 cannot be affected. That is NOT what the code does: the literal
// `"is-print"` is produced in exactly one place (`typed-result-format.js`), but the
// classifier that produces it is called by the LEGACY output painter too
// (`createTerminalOutputEntries` -> `getExecutionOutputLineModifier`). The rule therefore
// styles structural labels on whichever tier emits them. That is intentional — P4b-1 made
// one classifier for both surfaces — and the test below pins the single producer rather
// than the false claim.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

// --- minimal selectable DOM (same technique the P4b suites use) ---------------------

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

// Every execution seam the renderer could reach, so "nothing executed" is COUNTED rather
// than assumed (BUG-007).
const executionCalls = { count: 0 };

function countedSeam() {
  return (...args) => {
    executionCalls.count += 1;

    return args;
  };
}

globalThis.document = stubDocument;
globalThis.Node = { TEXT_NODE: 3 };
globalThis.space = {
  api: new Proxy({}, { get: () => countedSeam() }),
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

// --- the real product modules, through their real paths -----------------------------

const shared = await import("/modules/_core/framework/js/engine-swap/typed-result-format.js");
const shapes = await import("/modules/_core/framework/js/engine-swap/history-shapes.js");
const chip = await import("/modules/_core/framework/js/engine-swap/chat-projection.js");
const turnProgress = await import("/modules/_core/visual/conversation/turn-progress.js");
const { createAgentThreadView } = await import("/modules/_core/visual/conversation/thread-view.js");
const execution = await import("/modules/_core/onscreen_agent/execution.js");

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

const THREAD_VIEW = "app/L0/_all/modules/_core/visual/conversation/thread-view.js";
const AGENT_THREAD_CSS = "app/L0/_all/modules/_core/visual/conversation/agent-thread.css";
const TYPED_FORMAT = "app/L0/_all/modules/_core/framework/js/engine-swap/typed-result-format.js";
const COLORS_CSS = "app/L0/_all/modules/_core/framework/css/colors.css";

// --- fixtures -----------------------------------------------------------------------

const RUN_CODE_ARGUMENTS = { language: "python", code: "print(1)\nprint(2)" };

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

const view = createAgentThreadView({ execution, renderMarkdownWithMarked: true });

function renderThread(history, options = {}) {
  const thread = new StubNode("div");

  view.renderMessages(thread, history, { groupToolRuns: true, scroller: null, ...options });

  return thread;
}

// The TYPED path: a committed call + result pair, projected for display.
function typedHistory() {
  const messages = [
    { content: "", role: "assistant", toolCalls: [{ arguments: RUN_CODE_ARGUMENTS, id: "call-1", name: "run_code" }] },
    { content: `ok: ${JSON.stringify(RUN_CODE_PAYLOAD)}`, role: "tool", toolCallId: "call-1" }
  ];

  return shapes
    .canonicalMessagesToTypedEntries(messages)
    .map((entry) => shapes.projectHistoryEntryForDisplay(entry));
}

// The LEGACY (Tier 3) path: one assistant message carrying the real execution separator.
function legacyHistory() {
  return [
    {
      content: `Running it now.\n\n${execution.EXECUTION_SEPARATOR}\n\nprint(1)\nprint(2)`,
      id: "legacy-1",
      role: "assistant"
    }
  ];
}

function inputPane(thread) {
  return thread.querySelector('[data-execution-pane="input"]');
}

function outputPane(thread) {
  return thread.querySelector('[data-execution-pane="output"]');
}

// The BOX, not the contents: the pane wrapper, its label element and its scroll body.
function boxShape(pane) {
  if (!pane) {
    return null;
  }

  const [label, body] = pane.children;

  return {
    bodyClassName: body ? body.className : null,
    className: pane.className,
    hasLabel: Boolean(label),
    labelClassName: label ? label.className : null,
    paneType: pane.dataset.executionPane ?? null
  };
}

// =====================================================================================
// Item 1 — BOX WEIGHT. Compared, not assumed.
// =====================================================================================

test("BOX PARITY: the typed and legacy panes paint the same box structure and classes", () => {
  const typed = renderThread(typedHistory());
  const legacy = renderThread(legacyHistory());

  const typedInput = boxShape(inputPane(typed));
  const legacyInput = boxShape(inputPane(legacy));
  const typedOutput = boxShape(outputPane(typed));
  const legacyOutput = boxShape(outputPane(legacy));

  assert.ok(typedInput, "the typed path must paint an input pane");
  assert.ok(legacyInput, "the legacy path must paint an input pane");
  assert.ok(typedOutput, "the typed path must paint an output pane");
  assert.ok(legacyOutput, "the legacy path must paint an output pane");

  // The pane WRAPPER is the thing the owner called "plainer": its class, its label element
  // and its scroll body (background, radius and padding all hang off `.execution-pane-scroll`).
  assert.equal(typedInput.className, legacyInput.className, "input pane wrapper class");
  assert.equal(typedInput.labelClassName, legacyInput.labelClassName, "input pane label class");
  assert.equal(typedInput.bodyClassName, legacyInput.bodyClassName, "input pane body class");
  assert.equal(typedOutput.className, legacyOutput.className, "output pane wrapper class");
  assert.equal(typedOutput.bodyClassName, legacyOutput.bodyClassName, "output pane body class");

  // The scroll body class is what carries the box treatment. Naming it makes a future
  // divergence loud instead of silent.
  assert.equal(typedInput.bodyClassName, "execution-pane-scroll");
  assert.equal(legacyInput.bodyClassName, "execution-pane-scroll");
});

// =====================================================================================
// Item 2 — the arguments pane label is `Input`, and only the label moved.
// =====================================================================================

test("the typed arguments pane is labelled `Input` with a line count from the shared formatter", () => {
  const thread = renderThread(typedHistory());
  const label = inputPane(thread).querySelector(".execution-pane-label").textContent;
  const formatted = shared.formatTypedToolArguments({ argumentsText: JSON.stringify(RUN_CODE_ARGUMENTS) });

  assert.equal(
    label,
    `Input • ${turnProgress.formatLineCount(formatted.lineCount)}`,
    "the label must be built from the SHARED line-count formatter, not a local copy"
  );
  assert.ok(
    label.startsWith("Input • "),
    `expected an 'Input • N lines' label, got "${label}"`
  );
});

test("the typed pane never reads `Arguments`, while its sibling still reads `Output`", () => {
  const thread = renderThread(typedHistory());
  const labels = thread
    .querySelectorAll(".execution-pane-label")
    .map((element) => element.textContent);

  assert.ok(
    !labels.some((label) => /\bArguments\b/u.test(label)),
    `no pane may read Arguments (got ${JSON.stringify(labels)})`
  );
  assert.ok(
    labels.includes("Output"),
    `the output pane label is untouched (got ${JSON.stringify(labels)})`
  );
  assert.ok(
    labels.some((label) => label.startsWith("Input")),
    "the arguments pane reads Input"
  );
});

test("the chip SUMMARY is unchanged: `run_code · Success`, not the retired code-line wording", () => {
  const thread = renderThread(typedHistory());
  const summary = thread.querySelector("[data-execution-summary-title]").textContent;

  assert.equal(summary, "run_code · Success", "the typed chip summary keeps its vocabulary");
});

test("`Executed N lines of code` stays retired tree-wide (comment-stripped source)", () => {
  const sources = [THREAD_VIEW, TYPED_FORMAT, "app/L0/_all/modules/_core/visual/conversation/turn-progress.js"]
    .map((file) => stripComments(readProductFile(file)))
    .join("\n");

  assert.equal(
    /Executed\s+\$?\{?[^\n]*\}?\s*lines?\s+of\s+code/u.test(sources),
    false,
    "the retired wording must not reappear"
  );
});

// =====================================================================================
// Item 3 — `.is-print` is painted, styled, and one producer.
// =====================================================================================

test("structural label lines are painted with the `is-print` modifier", () => {
  const thread = renderThread(typedHistory());
  const painted = outputPane(thread)
    .querySelectorAll(".terminal-line")
    .map((line) => ({ modifier: line.className, text: line.textContent }));

  const structural = painted.filter((line) => /(^|\s)is-print(\s|$)/u.test(line.modifier));

  assert.ok(
    structural.length > 0,
    `a run_code payload's log/info/debug headers must wear is-print (painted: ${JSON.stringify(painted.map((line) => line.text))})`
  );
  // The header lines the owner named are exactly these.
  assert.ok(
    structural.some((line) => /^log↓$/u.test(line.text)),
    "the `log↓` header is one of them"
  );
  // And a RESULT line must NOT wear it — the whole point is that statuses and structural
  // labels stay distinguishable.
  assert.ok(
    painted.some((line) => /(^|\s)is-result(\s|$)/u.test(line.modifier)),
    "result lines keep their own modifier"
  );
  assert.ok(
    !painted.some((line) => /result↓/u.test(line.text) && /(^|\s)is-print(\s|$)/u.test(line.modifier)),
    "a result line must never be classified as a structural label"
  );
});

// --- CSS colour resolution ---------------------------------------------------------------
//
// WHAT THIS REPLACES, AND WHY IT WAS A BLIND INSTRUMENT. The rule declares
// `var(--color-accent-primary-strong)` — an UNRESOLVED string — and the earlier version of this
// test compared that string against RESOLVED hex values. A `var()` expression never equals a
// hex, so every `notEqual` passed regardless of which token the rule named: seeding the success,
// warning, danger or muted colour into the rule still passed all of them. Only the two literal
// hex comparisons could ever fail. Under the owner's bar a measurement is evidence only if it
// could have failed, so the check is now resolved-versus-resolved, with the var() chain followed
// (`--agent-thread-muted-color` is itself `var(--color-text-secondary)`).

function readTokenMap() {
  return [COLORS_CSS, AGENT_THREAD_CSS].map(readProductFile).reduce((tokens, source) => {
    const declaration = /(--[a-z0-9-]+)\s*:\s*([^;]+);/giu;
    let match;

    while ((match = declaration.exec(stripComments(source))) !== null) {
      // First declaration of a name wins, as a single :root block would.
      if (!tokens.has(match[1])) {
        tokens.set(match[1], match[2].trim());
      }
    }

    return tokens;
  }, new Map());
}

function resolveColor(value, tokens, depth = 0) {
  const trimmed = String(value || "").trim();

  if (depth > 8) {
    throw new Error(`var() chain too deep at ${trimmed}`);
  }

  const variable = trimmed.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/iu);

  if (!variable) {
    return trimmed;
  }

  const [, name, fallback] = variable;
  const declared = tokens.get(name);

  if (declared === undefined) {
    if (fallback !== undefined) {
      return resolveColor(fallback, tokens, depth + 1);
    }

    throw new Error(`unresolved custom property ${name}`);
  }

  return resolveColor(declared, tokens, depth + 1);
}

function declaredRuleColor(cssText, selectorFragment) {
  // `[^{]*` because the muted rule shares its block with `.is-meta`.
  const block = cssText.match(new RegExp(`\\.terminal-line\\.${selectorFragment}[^{]*\\{([^}]*)\\}`, "u"));

  return block ? (block[1].match(/color:\s*([^;]+);/u)?.[1]?.trim() ?? null) : null;
}

// Colours the structural-label rule must NOT resolve to. The sibling modifier rules are read
// from the stylesheet itself, so the file's own literals are covered without hardcoding them.
const FORBIDDEN_COLOURS = [
  { label: "status success", value: "var(--color-status-success)" },
  { label: "status warning", value: "var(--color-status-warning)" },
  { label: "status danger", value: "var(--color-status-danger)" },
  { label: "muted body text", value: "var(--agent-thread-muted-color)" }
];

const SIBLING_MODIFIERS = ["is-warn", "is-error", "is-result", "is-muted"];

// Returns the COLLISIONS found rather than asserting internally, so a seeded mutation can call
// it directly and be observed going non-empty.
function colourCollisions(cssText) {
  const tokens = readTokenMap();
  const declared = declaredRuleColor(cssText, "is-print");

  if (!declared) {
    return ["no .terminal-line.is-print colour"];
  }

  const resolved = resolveColor(declared, tokens);
  const collisions = [];

  FORBIDDEN_COLOURS.forEach(({ label, value }) => {
    if (resolved === resolveColor(value, tokens)) {
      collisions.push(`equals ${label} (${resolved})`);
    }
  });

  SIBLING_MODIFIERS.forEach((sibling) => {
    const siblingColour = declaredRuleColor(cssText, sibling);

    if (siblingColour && resolveColor(siblingColour, tokens) === resolved) {
      collisions.push(`equals .${sibling} (${resolved})`);
    }
  });

  return collisions;
}

// WCAG 2.x relative luminance and contrast, computed here so the numbers quoted in the report
// are checkable rather than copied.
function linearChannel(channel) {
  const scaled = channel / 255;

  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const value = Number.parseInt(String(hex).replace("#", ""), 16);

  return (
    0.2126 * linearChannel((value >> 16) & 255) +
    0.7152 * linearChannel((value >> 8) & 255) +
    0.0722 * linearChannel(value & 255)
  );
}

function contrastRatio(a, b) {
  const first = luminance(a);
  const second = luminance(b);

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("a CSS rule exists for `.is-print` and its RESOLVED colour collides with no status or muted colour", () => {
  const css = readProductFile(AGENT_THREAD_CSS);

  assert.ok(
    /\.terminal-line\.is-print\s*\{/u.test(css),
    "`.terminal-line.is-print` must have a rule alongside the other is-* rules"
  );

  const collisions = colourCollisions(css);

  assert.deepEqual(
    collisions,
    [],
    `is-print must not resolve to a status or muted colour; collisions: ${collisions.join("; ")}`
  );
});

test("PROOF THE INSTRUMENT CAN FAIL: every forbidden colour seeded into the rule is caught", () => {
  const css = readProductFile(AGENT_THREAD_CSS);
  const seeds = [
    { label: "status success token", color: "var(--color-status-success)" },
    { label: "status warning token", color: "var(--color-status-warning)" },
    { label: "status danger token", color: "var(--color-status-danger)" },
    { label: "muted body-text token", color: "var(--agent-thread-muted-color)" },
    { label: "muted value via chained token", color: "var(--color-text-secondary)" },
    { label: "warn literal", color: "#ffd586" },
    { label: "error literal", color: "#ffb0a9" }
  ];
  const caught = [];

  const seed = (color) =>
    css.replace(
      /(\.terminal-line\.is-print\s*\{[^}]*color:\s*)([^;]+)(;)/u,
      (_match, head, _original, tail) => `${head}${color}${tail}`
    );

  seeds.forEach(({ label, color }) => {
    const seeded = seed(color);

    assert.notEqual(seeded, css, `${label}: the seed must actually rewrite the rule`);

    if (colourCollisions(seeded).length > 0) {
      caught.push(label);
    }
  });

  assert.deepEqual(
    caught,
    seeds.map((entry) => entry.label),
    `every seeded status/muted colour must be caught (caught ${caught.length} of ${seeds.length})`
  );

  // INERT CONTROL: a different, non-status colour must NOT be reported, so a matcher that fired
  // on everything could not pass this test.
  const inert = seed("var(--color-accent-primary)");

  assert.notEqual(inert, css, "the inert control must actually rewrite the rule");
  assert.deepEqual(colourCollisions(inert), [], "a distinct accent colour must not be flagged");
});

test("the structural-label colour is legible and is NOT brighter than body text (measured)", () => {
  const css = readProductFile(AGENT_THREAD_CSS);
  const tokens = readTokenMap();
  const label = resolveColor(declaredRuleColor(css, "is-print"), tokens);
  const muted = resolveColor("var(--agent-thread-muted-color)", tokens);
  const body = resolveColor("var(--color-text-primary)", tokens);
  const pane = resolveColor(tokens.get("--agent-thread-execution-pane-bg") || "#09131f", tokens);

  // AA for normal text is 4.5:1; the tint clears it comfortably.
  assert.ok(
    contrastRatio(label, pane) >= 4.5,
    `is-print must stay legible, got ${contrastRatio(label, pane).toFixed(2)}:1`
  );

  // THE CORRECTED FACT, pinned so it cannot be misstated again. The accent is DARKER than both
  // body text and muted text, so this rule does not brighten these headers and they are not the
  // most prominent text in the pane — it identity-tints them, the way `result↓` and `warn↓` are
  // tinted. The claim in the earlier report and in the CSS comment was backwards.
  assert.ok(
    luminance(label) < luminance(muted),
    `is-print (L=${luminance(label).toFixed(4)}) must be darker than muted (L=${luminance(muted).toFixed(4)})`
  );
  assert.ok(
    luminance(label) < luminance(body),
    `is-print (L=${luminance(label).toFixed(4)}) must be darker than body text (L=${luminance(body).toFixed(4)})`
  );
  assert.ok(
    contrastRatio(label, pane) < contrastRatio(body, pane),
    "and its contrast must be LOWER than the inherited body colour, which is what the report now says"
  );
});

test("`is-print` has ONE producer: the shared typed formatter, not a per-surface copy", () => {
  const threadSource = stripComments(readProductFile(THREAD_VIEW));
  const typedSource = stripComments(readProductFile(TYPED_FORMAT));

  // The classifier is the single producer of the modifier STRING.
  assert.equal(
    /["']is-print["']/u.test(typedSource),
    true,
    "the shared formatter must be the one that names the modifier"
  );
  assert.equal(
    /["']is-print["']/u.test(threadSource),
    false,
    "the renderer must not declare its own is-print modifier"
  );

  // The classifier FUNCTION is shared: the renderer imports it rather than re-deriving it.
  assert.ok(
    /getExecutionOutputLineModifier/u.test(threadSource),
    "the renderer reaches the classification through the shared import"
  );
  assert.equal(
    /function\s+getExecutionOutputLineModifier\s*\(/u.test(threadSource),
    false,
    "and must not define a second classifier"
  );
});

// =====================================================================================
// BUG-007 — display content never executes.
// =====================================================================================

test("BUG-007: painting every display shape dispatches nothing", () => {
  executionCalls.count = 0;

  renderThread(typedHistory());
  renderThread(legacyHistory());
  renderThread([chip.createProvisionalChipEntry({
    arguments: RUN_CODE_ARGUMENTS,
    callId: "call-1",
    name: "run_code",
    outcome: "success",
    resultContent: `ok: ${JSON.stringify(RUN_CODE_PAYLOAD)}`
  })], { groupToolRuns: false, provisional: true });

  assert.equal(executionCalls.count, 0, "rendering must reach no execution seam at all");
});
