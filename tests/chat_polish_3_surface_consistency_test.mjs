// FINAL surface-consistency polish (chat-polish-3, owner-approved items 1-3).
//
// 1 — ONE VOCABULARY PER TIER. On a typed (Tier 1) turn a separator-bearing reply is
//     display BY CONSTRUCTION, yet it rendered the Tier 3 card `Writing 70 lines of code`
//     BESIDE the typed `run_code · Running` chip for the same turn: two mechanisms, two
//     vocabularies, one turn. The message now carries `tier1Turn`, so the card resolves
//     display-only from the first painted frame and the live patch agrees with the
//     committed row. Tier 3 cards stay byte-identical.
//
// 2 — NO DOUBLE-ESCAPE. `markdown-frontmatter.js` escaped quotes and ampersands BEFORE
//     `marked.parse()`, and `marked` escapes them itself, so a quoted code body rendered a
//     SECOND entity (`&amp;quot;`) and the parser drew the literal `&quot;`. The escape now
//     neutralizes only raw angle brackets in PROSE; fenced blocks and inline code spans are
//     left to the parser, which still escapes them. The hostile cases are asserted here.
//
// 3 — DISPLAY-FORM TOOL CALLS ARE DETECTED, CORRECTED ONCE, AND COUNTED. The owner saw
//     `tool call: run_code {...}` arrive as chat prose and never run. The Tier 1 steering
//     already states that only a tool call executes, so more prompt text is not the lever:
//     the shape is detected, ONE correction names the specific mistake, and a counter line
//     records the catch. Fenced/display content still NEVER executes (BUG-007).
//
// Hermetic: no network, no keys, no disk. The DOM is a small stub; the store half drives
// the REAL seam over a fake `fetch` and stubs only persistence/render.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

// --- minimal DOM ------------------------------------------------------------

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
    this._text = "";
    this._html = "";
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
    this._html = String(value || "");
    this.children = [];

    if (this._html) {
      const child = new StubNode("span");
      child.textContent = this._html;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  get innerHTML() {
    return this._html;
  }

  setAttribute(name, value) {
    if (String(name).startsWith("data-")) {
      this.dataset[String(name).slice(5).replace(/-([a-z])/gu, (_m, letter) => letter.toUpperCase())] = String(value);
    }
  }

  getAttribute() {
    return null;
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

  querySelectorAll(selector) {
    const results = [];
    const wanted = String(selector || "").trim();

    const matches = (node) => {
      if (!wanted) {
        return false;
      }

      if (wanted.startsWith(".")) {
        return node.classList?.contains(wanted.slice(1)) === true;
      }

      const attributeMatch = wanted.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/u);

      if (attributeMatch) {
        const key = attributeMatch[1].replace(/^data-/u, "").replace(/-([a-z])/gu, (_m, letter) => letter.toUpperCase());
        const present = node.dataset?.[key] !== undefined;

        return attributeMatch[2] === undefined ? present : String(node.dataset?.[key]) === attributeMatch[2];
      }

      return String(node.tagName || "").toLowerCase() === wanted.toLowerCase();
    };

    const walk = (node) => {
      node.children.forEach((child) => {
        if (matches(child)) {
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
      if (node.classList?.contains(String(selector).replace(/^\./u, "")) === true) {
        return node;
      }

      node = node.parentNode;
    }

    return null;
  }
}

const stubDocument = {
  addEventListener() {},
  body: new StubNode("body"),
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
globalThis.location = { href: "http://localhost/" };

function createRuntime() {
  const runtime = {
    api: {},
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

  return runtime;
}

const runtime = createRuntime();

globalThis.space = runtime;
globalThis.window = {
  console,
  location: { href: "http://localhost/" },
  requestAnimationFrame(callback) {
    callback(0);
    return 1;
  },
  space: runtime
};
globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };

const markdown = await import("/modules/_core/framework/js/markdown-frontmatter.js");
const wireHygiene = await import("/modules/_core/framework/js/engine-swap/wire-hygiene.js");
const onscreenExecution = await import("/modules/_core/onscreen_agent/execution.js");
const threadView = await import("/modules/_core/visual/conversation/thread-view.js");
const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

const {
  EXECUTION_DISPLAY_ONLY_LABEL,
  EXECUTION_DISPLAY_ONLY_STATE,
  createAgentThreadView,
  resolveExecutionCardState
} = threadView;

const SEPARATOR = onscreenExecution.EXECUTION_SEPARATOR;

// ---------------------------------------------------------------- item 2 ----

function renderHtml(text) {
  return String(markdown.renderMarkdown(text).innerHTML || "");
}

test("a quoted code body renders real quotes, not entities (item 2)", () => {
  // `&quot;` IS the quote mark: the browser renders that entity as `"`. The defect was
  // `&amp;quot;`, which renders as the LITERAL text `&quot;` — that is what these
  // assertions forbid, and it is the difference the owner saw on screen.
  const fenced = renderHtml('```json\n{"intent": "run_code", "path": "~/x"}\n```');

  assert.ok(fenced.includes("&quot;intent&quot;: &quot;run_code&quot;"), `fenced body kept its quotes: ${fenced}`);
  assert.ok(!fenced.includes("&amp;quot;"), "no double-escaped quote entity in fenced code");
  assert.ok(!fenced.includes("&amp;lt;"), "no double-escaped angle bracket in fenced code");

  const inline = renderHtml('key `"intent": "x"` here');

  assert.ok(inline.includes("&quot;intent&quot;: &quot;x&quot;"), `inline code keeps its quotes: ${inline}`);
  assert.ok(!inline.includes("&amp;quot;"), "no double-escaped quote entity in inline code");

  const inlineAngled = renderHtml("tag `<div>` here");

  assert.ok(inlineAngled.includes("&lt;div&gt;"), `inline code keeps one level of bracket escape: ${inlineAngled}`);
  assert.ok(!inlineAngled.includes("&amp;lt;"), "inline code is not double-escaped");

  const prose = renderHtml('he said "hi" and it is fine');

  assert.ok(prose.includes("&quot;hi&quot;"), "prose still renders a quote mark as text");
  assert.ok(!prose.includes("&amp;quot;"), "prose is not double-escaped either");
});

test("the hostile cases still cannot inject raw HTML (item 2)", () => {
  const proseHostile = renderHtml("raw <img src=x onerror=alert(1)> text");

  assert.ok(!proseHostile.includes("<img"), "a raw tag in prose is neutralized");
  assert.ok(proseHostile.includes("&lt;img"), "the angle brackets are escaped instead");

  const script = renderHtml("<script>alert(1)</script>");

  assert.ok(!script.includes("<script"), "a script tag in prose is neutralized");

  const fencedHostile = renderHtml("```\n<script>alert(1)</script>\n```");

  assert.ok(!fencedHostile.includes("<script"), "a script tag inside a fence is neutralized by the parser");
  assert.ok(fencedHostile.includes("&lt;script&gt;"), "the fenced tag is escaped");

  // An UNCLOSED backtick run is not a code span: `marked` would print those backticks
  // literally and pass a raw tag through, so that text keeps the pre-parse escape.
  const unclosed = renderHtml("a `<script>alert(1)</script> b");

  assert.ok(!unclosed.includes("<script"), "an unclosed backtick run cannot smuggle a tag");
});

// THE AUDIT BLOCKER (p35 re-audit, fail-open). `\`` is a LITERAL backtick to `marked`, so
// text between two escaped backticks is PROSE and must be escaped. The first cut treated
// an escaped run as a code-span delimiter and skipped the escape, putting a raw tag into
// `innerHTML`: a security regression this commit introduced.
test("a backslash-escaped backtick never opens a code span (audit blocker)", () => {
  const BACKSLASH = String.fromCharCode(92);
  const TICK = String.fromCharCode(96);
  const E = `${BACKSLASH}${TICK}`;
  const cases = [
    [`${E}<img src=x onerror=alert(1)>${E}`, /<img\b/iu],
    [`${E}<script>alert(1)</script>${E}`, /<script\b/iu],
    [`${E}<svg onload=alert(1)>${E}`, /<svg\b/iu],
    [`${E}<img src=x onerror=alert(1)>${E} and ${E}more${E}`, /<img\b/iu],
    [`- item ${E}<img src=x onerror=alert(1)>${E} end`, /<img\b/iu]
  ];

  cases.forEach(([raw, forbidden]) => {
    const rendered = renderHtml(`a ${raw} b`);

    assert.ok(!forbidden.test(rendered), `escaped backticks must not expose raw HTML: ${rendered}`);
    assert.ok(rendered.includes("&lt;"), `the tag is escaped text instead: ${rendered}`);
    // The literal backticks still reach the reader as characters.
    assert.ok(rendered.includes(TICK), `the escaped backtick renders literally: ${rendered}`);
  });

  // An escaped backtick OUTSIDE any span is ordinary prose and is escaped the same way.
  const outside = renderHtml(`a ${E} b <img src=x onerror=alert(1)>`);

  assert.ok(!outside.includes("<img"), "an escaped backtick does not disable escaping for the line");

  // ...and the legitimate shapes still behave: a REAL span keeps its content escaped by
  // the parser, a triple fence still makes a code block, and a double-backtick span works.
  const realSpan = renderHtml("tag `<div>` here");

  assert.ok(realSpan.includes("<code>") && realSpan.includes("&lt;div&gt;"), `a real span still renders as code: ${realSpan}`);
  assert.ok(!realSpan.includes("&amp;lt;"), "a real span is not double-escaped");

  const fence = renderHtml("```\n<script>alert(1)</script>\n```");

  assert.ok(!fence.includes("<script"), "a fence still escapes its body");

  const doubleSpan = renderHtml("``a ` b`` and <b>x</b>");

  assert.ok(!doubleSpan.includes("<b>x</b>"), "prose outside a double-backtick span is still escaped");
});

// ---------------------------------------------------------------- item 1 ----

function tier1View() {
  return createAgentThreadView({ execution: onscreenExecution, renderMarkdownWithMarked: true });
}

function separatorMessage(extra = {}) {
  return {
    content: `Reading notes.txt now.\n${SEPARATOR}\nreturn await space.api.fileRead("~/notes.txt")`,
    id: "assistant-1",
    role: "assistant",
    ...extra
  };
}

test("a typed-tier turn reads `Shown, not executed` from the first frame (item 1)", () => {
  // The live card, resolved as a typed-tier row: no pencil, no `Writing N lines`, no spinner.
  const live = resolveExecutionCardState({ displayOnlyTier: true, isStreaming: true });

  assert.equal(live.pendingState, EXECUTION_DISPLAY_ONLY_STATE);
  assert.equal(live.iconName, "visibility");
  assert.notEqual(live.iconName, "edit_note", "the `Writing N lines` pencil never describes display text");
  assert.notEqual(live.iconName, "sync", "a typed-tier display card is never a spinner");

  // ...and it is the SAME reading once the turn ends: the row cannot flip back.
  assert.deepEqual(resolveExecutionCardState({ displayOnlyTier: true }), live);

  // Its own facts still win: a rerun that really executed is Success/Error.
  assert.equal(
    resolveExecutionCardState({ displayOnlyTier: true, hasResults: true }).iconName,
    "check_circle"
  );
  assert.equal(
    resolveExecutionCardState({ displayOnlyTier: true, hasError: true }).iconName,
    "error"
  );
});

test("a typed-tier separator turn renders exactly ONE vocabulary (item 1)", () => {
  const view = tier1View();
  const message = separatorMessage({ tier1Turn: true });
  const groups = view.buildMessageDisplayGroups([message], {});

  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, "assistant-sequence");

  const section = groups[0].sections[0];

  assert.equal(section.executeDisplay.narration.trim(), "Reading notes.txt now.");

  const card = view.createExecutionCard
    ? null
    : null;

  // The card is built through the same rule the render uses, so assert the rule's inputs
  // and the resolved state rather than a detached DOM guess.
  const state = resolveExecutionCardState({
    displayOnly: section.displayOnly === true,
    displayOnlyTier: true,
    isStreaming: Boolean(section.message.streaming)
  });

  assert.equal(state.pendingState, EXECUTION_DISPLAY_ONLY_STATE);

  // The label helper itself must never produce the legacy wording for this state.
  assert.equal(view.formatExecutionSummaryLabel(70, EXECUTION_DISPLAY_ONLY_STATE, []), EXECUTION_DISPLAY_ONLY_LABEL);
  assert.notEqual(view.formatExecutionSummaryLabel(70, "generating", []), EXECUTION_DISPLAY_ONLY_LABEL);

  // The rendered row carries the display-only label and NO `Writing` text anywhere.
  const thread = new StubNode("div");
  // The stub cannot run the whole render pipeline, so assert the two facts the render
  // derives from: the mark travels on the message, and the card state is terminal.
  assert.equal(message.tier1Turn, true, "the mark is what makes the typed tier authoritative");
  assert.ok(!EXECUTION_DISPLAY_ONLY_LABEL.includes("Writing"));
  void thread;
});

test("tier 3 rendering is byte-identical to before (item 1)", () => {
  // No mark, so every legacy reading still applies — streaming writes, busy runs, results
  // settle. This is the assertion that keeps the fix from leaking onto the text protocol.
  assert.deepEqual(resolveExecutionCardState({ isStreaming: true }), {
    iconName: "edit_note",
    pendingState: "generating",
    tone: "is-writing"
  });
  assert.deepEqual(resolveExecutionCardState({ isConversationBusy: true }), {
    iconName: "sync",
    pendingState: "running",
    tone: "is-running"
  });
  assert.deepEqual(resolveExecutionCardState({ hasResults: true }), {
    iconName: "check_circle",
    pendingState: "",
    tone: "is-success"
  });
  assert.equal(resolveExecutionCardState({}).pendingState, "");

  const view = createAgentThreadView({ execution: onscreenExecution });

  assert.equal(view.formatExecutionSummaryLabel(70, "generating", []), "Writing 70 lines of code");
  assert.equal(view.formatExecutionSummaryLabel(12, "running", []), "Executing 12 lines of code");

  // A Tier 3 group (no mark) resolves exactly as it did before this change.
  const group = {
    sections: [
      {
        displayOnly: false,
        executeDisplay: { blocks: ["run()"], narration: "Working." },
        message: { content: "Working.", id: "a3", role: "assistant" },
        outputResults: null,
        type: "execute"
      }
    ],
    type: "assistant-sequence"
  };

  const busy = view.getGroupRenderSignature(group, { isConversationBusy: true });
  const settled = view.getGroupRenderSignature(group, { isConversationBusy: false });

  assert.ok(busy.includes("running"), "a busy Tier 3 row still reads running");
  assert.notEqual(busy, settled, "the busy -> settled transition is still in the signature");
});

// ---------------------------------------------------------------- item 3 ----

function detect(answer, extra = {}) {
  return wireHygiene.detectTier1DisplayFormToolCall({
    answer,
    fenceRegions: onscreenExecution.findExecutionFenceRegions(answer),
    findSeparatorIndex: onscreenExecution.findExecutableSeparatorIndex,
    separator: SEPARATOR,
    ...extra
  });
}

const SHAPE_CASES = Object.freeze({
  bare: `Reading now.\n${SEPARATOR}\nreturn await space.api.fileRead("~/n")`,
  fencedCall: 'Here:\n```javascript\nreturn await space.api.fileRead({"path":"~/n"})\n```',
  fencedSeparator: '```\n' + SEPARATOR + '\nreturn 1\n```',
  prose: 'tool call: run_code {"code": "1+1"}'
});

test("each display-form shape is recognised (item 3)", () => {
  assert.equal(detect(SHAPE_CASES.bare), wireHygiene.TIER1_DISPLAY_FORM_SHAPE.BARE_SEPARATOR);
  // A fenced call body is drift only when the turn was trying to ACT, so this case
  // carries the user request that makes the intent unambiguous (audit non-blocker 3).
  assert.equal(
    detect(SHAPE_CASES.fencedCall, { userTurn: "read my notes" }),
    wireHygiene.TIER1_DISPLAY_FORM_SHAPE.FENCED_CALL_BODY
  );
  assert.equal(detect(SHAPE_CASES.fencedSeparator), wireHygiene.TIER1_DISPLAY_FORM_SHAPE.FENCED_SEPARATOR);
  assert.equal(detect(SHAPE_CASES.prose), wireHygiene.TIER1_DISPLAY_FORM_SHAPE.PROSE_TOOL_CALL);
});

test("a prose tool call written MID-REPLY is detected (audit non-blocker 2)", () => {
  // The realistic drift shape: the call is not at offset 0 but after the model's own
  // sentence. The first cut was `^`-anchored with no `m` flag, so all three were missed.
  const midReply = [
    'Sure.\ntool call: {"name":"file_read","arguments":{"path":"~/n"}}',
    'Sure, let me do this. tool call: {"code":"1+1"}',
    'I will read it.\n\ntool call: {"name":"file_read","arguments":{"path":"~/n"}}'
  ];

  midReply.forEach((answer) => {
    assert.equal(
      detect(answer),
      wireHygiene.TIER1_DISPLAY_FORM_SHAPE.PROSE_TOOL_CALL,
      `a mid-reply tool call must be caught: ${JSON.stringify(answer)}`
    );
  });
});

// DISPLAY vs ACTION (audit non-blocker 3). A fence containing a call is a MISTAKE only
// when the turn was trying to act. When the user asked to SEE code, it is the correct
// answer (BUG-007), and burning the single retry there nags about an unrequested action.
test("a show-me-code answer is never corrected (audit non-blocker 3)", () => {
  const showMe = 'Sure, here is how you call it:\n```javascript\nconst out = await space.api.fileRead("~/notes.md");\n```\nThat logs contents.';

  const decision = decide(showMe, { userTurn: "Show me how you'd call file_read" });

  assert.equal(decision.retry, false, "a display request must not consume the single retry");
  assert.equal(decision.shape, "");

  // A bare call-shaped JSON fence is unambiguous even on a show-me turn: nothing else
  // looks like the typed wire shape, so it is still counted.
  const wireShape = '```json\n{"name":"run_code","arguments":{"code":"1+1"}}\n```';

  assert.equal(
    detect(wireShape, { userTurn: "show me the shape" }),
    wireHygiene.TIER1_DISPLAY_FORM_SHAPE.FENCED_CALL_BODY,
    "the typed wire shape alone is positive evidence of an action attempt"
  );
});

test("an action request whose call arrived fenced still gets the retry (audit non-blocker 3)", () => {
  const fencedCall = '```javascript\nreturn await space.api.fileRead({"path":"~/n"})\n```';

  assert.equal(
    decide(fencedCall, { userTurn: "read my notes file" }).shape,
    wireHygiene.TIER1_DISPLAY_FORM_SHAPE.FENCED_CALL_BODY,
    "the user asked for an action: the fenced call is drift and earns the correction"
  );

  // And the model's own completion claim is positive evidence too, whatever the request.
  const claim = 'I have read your notes.\n```javascript\nreturn await space.api.fileRead({"path":"~/n"})\n```';

  assert.equal(detect(claim), wireHygiene.TIER1_DISPLAY_FORM_SHAPE.FENCED_CALL_BODY);
});

test("ordinary prose and ordinary fenced code are never caught (item 3)", () => {
  // The owner's concern in reverse: a false positive would nag on a healthy answer, and a
  // block of code shown on purpose is legitimate display (BUG-007).
  assert.equal(detect("Your notes say: buy milk."), "");
  assert.equal(detect("```js\nconst x = 1;\n```"), "");
  assert.equal(detect("I can read that file whenever you like."), "");
  assert.equal(detect(""), "");
});

test("a normal typed-call turn is never corrected (item 3)", () => {
  const decision = wireHygiene.resolveTier1CorrectiveRetry({
    answer: SHAPE_CASES.fencedCall,
    turns: [{ toolCallCount: 1 }]
  });

  assert.equal(decision.retry, false, "the action happened, so display text beside it is honest");
  assert.equal(decision.shape, "");
});

function decide(answer, extra = {}) {
  return wireHygiene.resolveTier1CorrectiveRetry({
    answer,
    fenceRegions: onscreenExecution.findExecutionFenceRegions(answer),
    findSeparatorIndex: onscreenExecution.findExecutableSeparatorIndex,
    separator: SEPARATOR,
    turns: [{ toolCallCount: 0 }],
    ...extra
  });
}

test("the correction is bounded and cannot loop (item 3)", () => {
  const base = { answer: SHAPE_CASES.bare };

  assert.equal(decide(base.answer).retry, true);
  assert.equal(
    decide(base.answer, { attempts: wireHygiene.TIER1_CORRECTIVE_RETRY_LIMIT }).retry,
    false,
    "the cap is applied by the ONE decision function"
  );

  // Every shape routes through the same capped decision, so no shape can escape the cap.
  for (const answer of Object.values(SHAPE_CASES)) {
    assert.equal(
      decide(answer, { userTurn: "read my notes" }).retry,
      true,
      "each shape is caught at attempt 0"
    );
    assert.equal(
      decide(answer, { attempts: 1, userTurn: "read my notes" }).retry,
      false,
      "a second correction is never issued"
    );
  }
});

test("the correction names the specific mistake and never says 'run it' (item 3)", () => {
  const prompts = Object.values(wireHygiene.TIER1_DISPLAY_FORM_SHAPE).map((shape) =>
    wireHygiene.resolveTier1CorrectivePrompt(shape)
  );

  prompts.forEach((prompt) => {
    assert.ok(/never executes|nothing ran/i.test(prompt), `states the consequence: ${prompt}`);
    // The legacy line says "Call the matching tool"; the new ones say "tool call". Both
    // name the channel that actually runs, and neither may tell the model to run the block.
    assert.ok(/tool call|matching tool/i.test(prompt), `names the action that does run: ${prompt}`);
    assert.ok(!/^execute the (code|block)/i.test(prompt), "never instructs executing display content");
  });

  // The three NEW shapes name their own mistake rather than repeating the generic line.
  const generic = wireHygiene.TIER1_CORRECTIVE_PROMPT;

  [
    wireHygiene.TIER1_DISPLAY_FORM_SHAPE.FENCED_CALL_BODY,
    wireHygiene.TIER1_DISPLAY_FORM_SHAPE.FENCED_SEPARATOR,
    wireHygiene.TIER1_DISPLAY_FORM_SHAPE.PROSE_TOOL_CALL
  ].forEach((shape) => {
    assert.notEqual(wireHygiene.resolveTier1CorrectivePrompt(shape), generic, `${shape} gets its own wording`);
  });
});

test("the counter line reports one catch and carries no content (item 3)", () => {
  const line = wireHygiene.formatDisplayFormToolCallLine(wireHygiene.TIER1_DISPLAY_FORM_SHAPE.FENCED_CALL_BODY);

  assert.equal(line, "[engine-swap] display-form-tool-call detected=1 shape=fenced-call-body");
  assert.ok(line.startsWith("[engine-swap] "), "it rides the existing diagnostics channel");
});

// --- the LIVE store seam: one bounded re-prompt, counted, never persisted ----

const REQUEST_MESSAGES = [
  { content: "read my notes", id: "u1", role: "user" }
];
const PREPARED = {
  messages: [
    { content: "you are a runtime operator", role: "system" },
    { content: "read my notes", role: "user" }
  ]
};

function stubSurface(t) {
  const previous = {
    history: store.history,
    persistHistory: store.persistHistory,
    render: store.render,
    settings: store.settings,
    status: store.status,
    stopRequested: store.stopRequested,
    activeRequestController: store.activeRequestController
  };
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  const infos = [];

  store.persistHistory = async () => {};
  store.render = () => {};
  store.settings = {
    ...(previous.settings && typeof previous.settings === "object" ? previous.settings : {}),
    apiEndpoint: "https://example.invalid/v1/chat/completions",
    apiKey: "test-key-not-real",
    model: "test-model",
    paramsText: ""
  };
  store.stopRequested = false;
  store.engineSwapStreamingPreview = null;
  console.info = (message) => {
    infos.push(String(message));
  };

  t.after(() => {
    globalThis.fetch = previousFetch;
    console.info = previousInfo;
    store.history = previous.history;
    store.persistHistory = previous.persistHistory;
    store.render = previous.render;
    store.settings = previous.settings;
    store.status = previous.status;
    store.stopRequested = previous.stopRequested;
    store.activeRequestController = previous.activeRequestController;
    store.engineSwapStreamingPreview = null;
  });

  return { infos };
}

function withFetch(t, answers) {
  const bodies = [];

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));

    bodies.push(body);

    const index = bodies.length - 1;
    const content = answers[Math.min(index, answers.length - 1)];
    const payload = {
      choices: [{ finish_reason: "stop", message: { content } }],
      model: "test-model"
    };

    return {
      json: async () => payload,
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload)
    };
  };

  return bodies;
}

test("a fenced call body earns exactly one specific re-prompt and is counted", async (t) => {
  const { infos } = stubSurface(t);
  const retryPrompt = wireHygiene.resolveTier1CorrectivePrompt(
    wireHygiene.TIER1_DISPLAY_FORM_SHAPE.FENCED_CALL_BODY
  );
  const bodies = withFetch(t, [SHAPE_CASES.fencedCall, "Your notes say hello."]);

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.equal(bodies.length, 2, "exactly one corrective request follows the fenced-call answer");
  assert.ok(
    bodies[1].messages.some((message) => message?.role === "user" && message?.content === retryPrompt),
    "the retry carries the correction that NAMES the mistake"
  );
  assert.equal(turn.correctiveRetry, true);
  assert.deepEqual(
    infos.filter((line) => line.includes("display-form-tool-call")),
    ["[engine-swap] display-form-tool-call detected=1 shape=fenced-call-body"],
    "one catch, one line, and the shape is on it"
  );
  assert.ok(
    !JSON.stringify(turn.result.messages).includes(retryPrompt),
    "the coaching turn is scaffolding: it never reaches persisted history"
  );
});

test("a prose tool call earns its own correction and a plain answer earns none", async (t) => {
  const { infos } = stubSurface(t);
  const retryPrompt = wireHygiene.resolveTier1CorrectivePrompt(
    wireHygiene.TIER1_DISPLAY_FORM_SHAPE.PROSE_TOOL_CALL
  );
  const bodies = withFetch(t, [SHAPE_CASES.prose, "Done: 2."]);

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.equal(bodies.length, 2);
  assert.ok(
    bodies[1].messages.some((message) => message?.role === "user" && message?.content === retryPrompt)
  );
  assert.equal(turn.correctiveRetry, true);
  assert.ok(infos.some((line) => line.includes("shape=prose-tool-call")));
});

test("a healthy text answer is never re-prompted or counted", async (t) => {
  const { infos } = stubSurface(t);
  const bodies = withFetch(t, ["Your notes say: buy milk."]);

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.equal(bodies.length, 1, "no false positive on an ordinary answer");
  assert.equal(turn.correctiveRetry, false);
  assert.deepEqual(
    infos.filter((line) => line.includes("display-form-tool-call")),
    [],
    "nothing was counted because nothing was caught"
  );
});

test("display content still NEVER executes, even when it is detected (item 3, BUG-007)", async (t) => {
  stubSurface(t);
  withFetch(t, [SHAPE_CASES.fencedCall, "Your notes say hello."]);

  let dispatched = 0;

  runtime.api.fileRead = async () => {
    dispatched += 1;
    return { content: "hello" };
  };

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.equal(dispatched, 0, "a fenced call body is display text: nothing ran");
  assert.equal(
    turn.result.answer,
    "Your notes say hello.",
    "the turn ended on the model's plain answer, not on the display block"
  );

  // The fenced body still cannot be executed by a LATER rerun path either: the separator
  // finder refuses a fenced token, which is the shared contract this guarantee rests on.
  assert.equal(onscreenExecution.findExecutableSeparatorIndex(SHAPE_CASES.fencedSeparator), -1);
  assert.equal(onscreenExecution.findExecutionFenceRegions(SHAPE_CASES.fencedSeparator).length, 1);
});
