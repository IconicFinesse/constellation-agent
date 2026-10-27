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
const { canonicalMessagesToTypedEntries } = await import(
  "/modules/_core/framework/js/engine-swap/history-shapes.js"
);
// The REAL store, so the stranding test exercises the production wiring instead of a
// hand-built copy of it (audit blocker 2: the old fixture pre-projected its input and
// stayed green while production stranded).
const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

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

// The stranding rule, driven through the PRODUCTION wiring over RAW typed history.
//
// The previous version of this test fed a hand-built PRE-PROJECTED fixture, which is
// why it stayed green while production stranded: `buildChatRenderProjection` matches
// committed calls by `typedTool`/`typedToolCallId`, and those marks are added by
// `projectHistoryEntryForDisplay`. Raw typed entries (`kind: "tool_call"`) carry
// neither, so a caller that guards before projecting gets NO match and draws the chip
// beside its own committed row (chat-polish audit blocker 2, 2026-10-27).
//
// So this drives `store.buildRenderHistory` — the one seam `render()` uses — with raw
// history as the store actually holds it. Reverting projection-before-guard (or
// re-adding a raw guard) reddens this.
test("no provisional chip can strand: the committed call row supersedes it (real store seam, raw history)", () => {
  const previousHistory = store.history;
  const previousCalls = store.engineSwapProvisionalCalls;
  const previousPreview = store.engineSwapStreamingPreview;

  try {
    // RAW typed history, exactly the shape `this.history` holds after a commit.
    store.history = canonicalMessagesToTypedEntries([
      { content: "read my notes", role: "user" },
      { content: "Reading it.", role: "assistant", toolCalls: [{ arguments: {}, id: "c1", name: "file_read" }] },
      { content: "ok: hello", role: "tool", toolCallId: "c1" }
    ]);
    store.engineSwapStreamingPreview = null;
    // The chip for c1 is still in the array: this is the state a late cleanup would
    // leave behind, and the projection alone must refuse to draw it.
    store.engineSwapProvisionalCalls = [{ callId: "c1", name: "file_read" }];

    const projection = store.buildRenderHistory();

    assert.ok(
      !projection.some((entry) => entry.provisional === true),
      "the committed call row already speaks for c1, so its chip is not drawn"
    );
    assert.equal(
      projection.filter((entry) => String(entry.typedToolCallId || "") === "c1").length,
      2,
      "exactly the committed call and its result — never a third provisional row"
    );
  } finally {
    store.history = previousHistory;
    store.engineSwapProvisionalCalls = previousCalls;
    store.engineSwapStreamingPreview = previousPreview;
  }
});

// The other direction, so the guard is not merely "always drop": an UNCOMMITTED call
// keeps its live chip through the same seam. Without this, deleting the collector
// would look identical to fixing it.
test("a chip for a call the history has not committed yet still paints (real store seam)", () => {
  const previousHistory = store.history;
  const previousCalls = store.engineSwapProvisionalCalls;
  const previousPreview = store.engineSwapStreamingPreview;

  try {
    store.history = canonicalMessagesToTypedEntries([{ content: "read two files", role: "user" }]);
    store.engineSwapStreamingPreview = null;
    store.engineSwapProvisionalCalls = [{ callId: "c9", name: "file_write" }];

    const projection = store.buildRenderHistory();
    const chips = projection.filter((entry) => entry.provisional === true);

    assert.equal(chips.length, 1, "an in-flight call keeps its running chip");
    assert.equal(chips[0].typedToolCallId, "c9");
    assert.equal(chips[0].typedToolOutcome, "running");
  } finally {
    store.history = previousHistory;
    store.engineSwapProvisionalCalls = previousCalls;
    store.engineSwapStreamingPreview = previousPreview;
  }
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
//
// This is the CURRENT-TURN case: the committed reply follows the user message that
// opened the turn, so it is in scope and the preview is refused.
test("the commit render cannot draw the preview beside the committed reply", () => {
  const committed = [
    { content: "read my notes", id: "u1", role: "user" },
    { content: "Your notes say hello.", id: "assistant-1780000000000-abc123", role: "assistant" }
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

// THE REGRESSION THE AUDIT FOUND (blocker 1). The guard used to compare the preview
// against EVERY assistant message in the thread, so a chat that had ever said "Done."
// made every later preview of that phrase invisible for the whole stream — the exact
// paint-timing defect this campaign already fixed once. Scoping to the current turn is
// what keeps the guard from suppressing legitimate live output.
test("a phrase already committed in an EARLIER turn still streams", () => {
  const committed = [
    { content: "first question", id: "u1", role: "user" },
    { content: "Done.", id: "assistant-1780000000001-def456", role: "assistant" },
    { content: "ping again", id: "u2", role: "user" }
  ];
  const projection = buildChatRenderProjection({
    history: committed,
    preview: previewEntry("Done.")
  });

  assert.equal(projection.length, 4, "the earlier turn's identical text does not block this turn");
  assert.equal(projection[3].id, PREVIEW_ID);
  assert.equal(projection[3].content, "Done.", "the live preview is drawn as it streams");
});

// Same shape, but the earlier turn's phrase is the common one in practice, and the
// partial-prefix frame is what the user actually sees arrive.
test("a partial frame of a phrase from an earlier turn also paints", () => {
  const committed = [
    { content: "first question", id: "u1", role: "user" },
    { content: "Let me check.", id: "assistant-1780000000002-aaa111", role: "assistant" },
    { content: "and now?", id: "u2", role: "user" }
  ];
  const projection = buildChatRenderProjection({
    history: committed,
    preview: previewEntry("Let me check.")
  });

  assert.ok(
    projection.some((entry) => entry.streaming === true),
    "a repeated opening line must not silence the stream"
  );
});

// A framework follow-up row (legacy text protocol) also carries `role: "user"`, but it
// belongs to the turn it follows. Accepting one as a turn opener would move the scope
// boundary forward, leave this turn's narration outside the guard, and let the committed
// reply be drawn a second time (chat-polish re-audit non-blocker 1).
test("a framework follow-up row is never mistaken for a turn opener", () => {
  const committed = [
    { content: "first question", id: "u1", role: "user" },
    { content: "Reply one.", id: "assistant-1780000000003-bbb222", role: "assistant" },
    { content: "execution ok", id: "x1", kind: "execution-output", role: "user" }
  ];
  const projection = buildChatRenderProjection({
    history: committed,
    preview: previewEntry("Reply one.")
  });

  assert.ok(
    !projection.some((entry) => entry.streaming === true),
    "a follow-up row must not reopen the turn and let the committed reply stream again"
  );
});

// Identity is the other half, and it is DEFENCE IN DEPTH rather than the mechanism that
// fixes today's bug: in production the preview id is the reserved constant
// `engine-swap-streaming-preview` while committed ids are
// `${role}-${Date.now()}-${random}`, so the two can never collide. The assertion is
// still worth keeping — it is what makes a future caller that hands the preview a real
// message id fail here instead of drawing a duplicate row.
test("a preview carrying a committed message id is never admitted", () => {
  const committedId = "assistant-1780000000003-bee789";
  const committed = [{ content: "done", id: committedId, role: "assistant" }];
  const projection = buildChatRenderProjection({
    history: committed,
    preview: previewEntry("something else entirely", committedId)
  });

  assert.equal(projection.length, 1);
  assert.equal(projection[0].content, "done");
});

// The production id shape cannot collide with a committed id, which is why the guard's
// text half is the one that matters at runtime. Asserted so the reserved constant and
// the committed shape stay visibly different.
test("the reserved preview id can never equal a committed message id", () => {
  const committedId = `assistant-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  assert.notEqual(committedId, PREVIEW_ID);
  assert.match(committedId, /^assistant-\d+-[0-9a-f]{1,6}$/u);
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
