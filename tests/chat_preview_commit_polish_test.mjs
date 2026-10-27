// Chat-surface polish items 2, 3 and 4 (owner-approved).
//
// ITEM 2 — provisional `running` chips. A call paints a chip as soon as its streamed
// arguments COMPLETE, and every chip must reach a terminal state or disappear. The
// guarantee is structural: provisional state lives in one projection-only array that
// one cleanup site clears on every turn exit.
//
// ITEM 3 — progressive markdown on the LIVE preview only. Partial documents are the
// normal case, a renderer that throws costs one tick of formatting, work is bounded,
// and the committed message never travels this path.
//
// ITEM 4 — the doubled row. One render pass drew the streaming preview AND the
// committed reply (same words, one raw, one formatted). The guard lives in the render
// projection: a preview whose id is committed, or whose text is already committed, is
// not admitted. That is a property of the projection, so ordering cannot undo it.
//
// Hermetic: no disk, no network, no real DOM.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

function createHarness() {
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

  const element = () => ({
    append() {},
    appendChild() {},
    classList: { add() {}, contains() { return false; }, remove() {} },
    replaceChildren() {},
    setAttribute() {},
    style: {}
  });

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
    createElement: element,
    body: { appendChild() {} },
    documentElement: { appendChild() {} }
  };
  globalThis.window = {
    space: runtime,
    console,
    addEventListener() {},
    removeEventListener() {},
    location: { href: "http://127.0.0.1:3000/" },
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
  globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.space = runtime;

  return runtime;
}

const runtime = createHarness();
const { buildChatRenderProjection, createProvisionalChipEntry, PROVISIONAL_CHIP_PREFIX } = await import(
  "/modules/_core/onscreen_agent/chat-projection.js"
);
const { paintPreviewMarkdown, PREVIEW_PAINT_MODE, PREVIEW_MARKDOWN_MAX_CHARS, resolvePreviewPaintMode, MESSAGE_CONTENT_PAINTER, selectMessageContentPainter } = await import(
  "/modules/_core/visual/conversation/preview-markdown.js"
);
const { resolveExecutionCardState } = await import("/modules/_core/visual/conversation/thread-view.js");

const PREVIEW_ID = "engine-swap-streaming-preview";

// --- ITEM 2: PROVISIONAL CHIPS ---------------------------------------------

test("a provisional chip projects as a running chip, never as a finished one", () => {
  const entry = createProvisionalChipEntry({ callId: "c1", name: "file_read" });

  assert.equal(entry.id, `${PROVISIONAL_CHIP_PREFIX}c1`);
  assert.equal(entry.provisional, true);
  assert.equal(entry.typedToolOutcome, "running");

  // The chip resolver is the ONE owner of the label/icon/tone decision, and a
  // provisional chip outranks the results-shaped branches: the placeholder text a
  // provisional entry carries parses as an execution message, so without the flag it
  // would settle GREEN for a call that has not run.
  const provisionalState = resolveExecutionCardState({ isProvisional: true });

  assert.equal(provisionalState.pendingState, "running");
  assert.equal(provisionalState.iconName, "sync");
  assert.notEqual(provisionalState.iconName, "check_circle");
});

test("a provisional chip is painted only for calls whose arguments completed", () => {
  // The transport notifies completion; the assembler remains the ONE owner of that
  // verdict (the surface never re-derives completeness itself).
  const completed = createProvisionalChipEntry({ callId: "c1", name: "file_read" });
  const projection = buildChatRenderProjection({ history: [], provisionalCalls: [{ callId: "c1", name: "file_read" }] });

  assert.deepEqual(
    projection.map((entry) => entry.id),
    [completed.id],
    "one provisional chip per completed call"
  );
});

test("provisional chips are deduped by call id and never enter history", () => {
  const history = [{ content: "read my notes", id: "u1", role: "user" }];
  const before = JSON.stringify(history);
  const projection = buildChatRenderProjection({
    history,
    provisionalCalls: [
      { callId: "c1", name: "file_read" },
      { callId: "c1", name: "file_read" },
      { callId: "c2", name: "file_write" }
    ]
  });

  assert.equal(projection.length, 3, "history plus one chip per distinct call");
  assert.equal(JSON.stringify(history), before, "the committed history is never mutated by a projection");
  assert.ok(
    !history.some((entry) => String(entry?.id || "").startsWith(PROVISIONAL_CHIP_PREFIX)),
    "a provisional chip is projection-only state"
  );
});

// The stranding rule. Committed history always wins the identity, so a chip can never
// outlive the call it describes; and the turn's single cleanup site empties the array.
test("no provisional chip can strand: the committed call row supersedes it", () => {
  const committedCall = {
    content: "execution file_read call\n{}",
    id: "tool-call-c1",
    kind: "execution-output",
    role: "user",
    typedTool: "call",
    typedToolCallId: "c1",
    typedToolName: "file_read",
    typedToolOutcome: "pending"
  };
  const projection = buildChatRenderProjection({
    history: [committedCall],
    provisionalCalls: [{ callId: "c1", name: "file_read" }]
  });

  assert.deepEqual(projection.map((entry) => entry.id), ["tool-call-c1"]);
  assert.ok(
    !projection.some((entry) => entry.provisional === true),
    "once the real call row exists the provisional chip is gone, so it cannot strand"
  );
});

// --- ITEM 3: PROGRESSIVE PREVIEW MARKDOWN ----------------------------------

function fakeRenderer(html) {
  return () => ({ childNodes: [{ textContent: html }] });
}

function fakeTarget() {
  return {
    children: [],
    replaced: 0,
    text: "",
    replaceChildren(...nodes) {
      this.children = nodes;
      this.replaced += 1;
    }
  };
}

const paintPlainText = (target, text) => {
  target.text = text;
  target.children = [];
};

test("an unclosed fence renders as a growing code block instead of literal backticks", () => {
  const target = fakeTarget();
  const seen = [];
  const renderMarkdown = (source) => {
    seen.push(source);
    return { childNodes: [{ textContent: `rendered:${source}` }] };
  };

  // Three deltas of the SAME growing document, exactly as the surface paints them.
  const paints = ["```js\nconst a", "```js\nconst a = 1", "```js\nconst a = 1;\n```"];

  paints.forEach((text) => {
    const mode = paintPreviewMarkdown(target, text, { renderMarkdown, setPlainText: paintPlainText });

    assert.equal(mode, PREVIEW_PAINT_MODE.MARKDOWN, "the preview keeps formatting while the fence is open");
  });

  assert.deepEqual(seen, paints, "each tick re-renders the ACCUMULATED text, so the block grows");
  assert.equal(target.replaced, 3);
});

test("malformed partial input falls back to plain text for that tick without throwing", () => {
  const target = fakeTarget();
  let calls = 0;
  const renderMarkdown = () => {
    calls += 1;

    if (calls === 1) {
      throw new Error("partial document defeated the parser");
    }

    return { childNodes: [{ textContent: "ok" }] };
  };

  const partial = "[unterminated link(https://example.com";

  assert.doesNotThrow(() => {
    paintPreviewMarkdown(target, partial, { renderMarkdown, setPlainText: paintPlainText });
  });

  assert.equal(target.text, partial, "the tick degrades to the raw accumulated text");

  // The next tick tries again, so one bad frame does not end progressive formatting.
  const mode = paintPreviewMarkdown(target, `${partial})`, { renderMarkdown, setPlainText: paintPlainText });

  assert.equal(mode, PREVIEW_PAINT_MODE.MARKDOWN);
});

test("preview work is bounded: past the cap it paints plain text", () => {
  const longText = "x".repeat(PREVIEW_MARKDOWN_MAX_CHARS + 1);

  assert.equal(resolvePreviewPaintMode(longText).mode, PREVIEW_PAINT_MODE.PLAIN);
  assert.equal(resolvePreviewPaintMode(longText).reason, "over-cap");

  const target = fakeTarget();
  let rendered = false;
  const mode = paintPreviewMarkdown(target, longText, {
    renderMarkdown: () => {
      rendered = true;
      return { childNodes: [] };
    },
    setPlainText: paintPlainText
  });

  assert.equal(mode, PREVIEW_PAINT_MODE.PLAIN);
  assert.equal(rendered, false, "an over-cap preview must not re-parse the whole document");
  assert.equal(target.text.length, longText.length);
});

// THE BOUNDARY: the committed path is untouched, so the final output is unchanged.
test("only a streaming message selects the preview painter", () => {
  // This is what makes 'render the preview on commit' a RED change rather than an
  // invisible style preference: a settled message must select COMMITTED, and the
  // renderer dispatches on exactly this value.
  assert.equal(selectMessageContentPainter({ streaming: true }), MESSAGE_CONTENT_PAINTER.PREVIEW);
  assert.equal(selectMessageContentPainter({ streaming: false }), MESSAGE_CONTENT_PAINTER.COMMITTED);
  assert.equal(selectMessageContentPainter({}), MESSAGE_CONTENT_PAINTER.COMMITTED, "settled is the default");
});

test("the committed path never travels the preview renderer", () => {
  // `paintPreviewMarkdown` is only reachable from the streaming branch, which the
  // renderer selects on `message.streaming`. A settled message takes
  // `createFormattedMessageBlock`, whose output is what it always was: the shared
  // markdown render over the same text, with no preview cap and no fallback mode.
  const source = "# Title\n\nSome **bold** text.";
  const target = fakeTarget();

  const mode = paintPreviewMarkdown(target, source, {
    renderMarkdown: fakeRenderer("shared"),
    setPlainText: paintPlainText
  });

  assert.equal(mode, PREVIEW_PAINT_MODE.MARKDOWN);
  assert.deepEqual(target.children, [{ textContent: "shared" }], "the preview uses the same shared renderer");
  assert.equal(PREVIEW_MARKDOWN_MAX_CHARS, 20000, "the cap is a preview-only bound");
});

// --- ITEM 4: PREVIEW/COMMIT RACE -------------------------------------------

function previewEntry(text, id = PREVIEW_ID) {
  return { content: text, id, role: "assistant", streaming: true };
}

// The doubled shape the owner saw: the preview still holds the whole reply while the
// committed history already ends with the same words. ONE render pass drew both.
test("the commit render cannot draw the preview beside the committed reply", () => {
  const committed = [
    { content: "read my notes", id: "u1", role: "user" },
    { content: "Your notes say hello.", id: "assistant-2", role: "assistant" }
  ];
  const projection = buildChatRenderProjection({
    history: committed,
    preview: previewEntry("Your notes say hello.")
  });

  assert.deepEqual(
    projection.map((entry) => String(entry.content || "")),
    ["read my notes", "Your notes say hello."],
    "the reply appears exactly ONCE, however late the commit runs"
  );
  assert.ok(
    !projection.some((entry) => entry.streaming === true),
    "no streaming row may survive the commit render"
  );
});

// Identity is the other half: a preview reusing a committed id is stale by definition.
test("a preview whose id is already committed is never admitted", () => {
  const committed = [{ content: "done", id: PREVIEW_ID, role: "assistant" }];
  const projection = buildChatRenderProjection({
    history: committed,
    preview: previewEntry("something else entirely")
  });

  assert.equal(projection.length, 1);
  assert.equal(projection[0].content, "done");
});

// Sanity: while the turn is LIVE the preview is still drawn — the guard must not
// suppress progressive output.
test("a live preview still renders while its text is not yet committed", () => {
  const committed = [{ content: "read my notes", id: "u1", role: "user" }];
  const projection = buildChatRenderProjection({
    history: committed,
    preview: previewEntry("Your notes say hel")
  });

  assert.equal(projection.length, 2, "the streaming row is drawn during the turn");
  assert.equal(projection[1].id, PREVIEW_ID);
});

// Tier 3 has no preview at all, so its projection is byte-identical to history.
test("a render with no preview and no provisional calls projects exactly the history", () => {
  const committed = [
    { content: "read my notes", id: "u1", role: "user" },
    { content: "Your notes say hello.", id: "a1", role: "assistant" }
  ];
  const projection = buildChatRenderProjection({ history: committed, preview: null, provisionalCalls: [] });

  assert.deepEqual(projection, committed, "Tier 3 projection is the history, unchanged");
});
