// Progressive markdown for the LIVE streaming preview only (chat-surface polish,
// item 3).
//
// The preview used to paint plain text and format at commit, so a streaming answer
// looked like raw markdown until it finished. This module is the whole policy for the
// preview half, kept pure and injectable so the policy is assertable without a browser:
//
//   - the ACCUMULATED preview text is re-rendered through the normal markdown renderer
//     on each paint tick, so an unclosed fence renders as a code block that keeps
//     growing instead of as literal backticks;
//   - partial syntax is expected, not exceptional: an unterminated emphasis or link
//     simply degrades to text because the renderer sees the raw accumulated string;
//   - a renderer that throws for a tick falls back to PLAIN TEXT for that tick and
//     never breaks the paint — a streaming surface must not die on a partial document;
//   - work is bounded: past `PREVIEW_MARKDOWN_MAX_CHARS` the preview paints as plain
//     text, because re-parsing an enormous partial document every frame is exactly the
//     unbounded cost this must not have.
//
// The COMMITTED message never comes through here: it renders through
// `createFormattedMessageBlock` exactly as before, which is what keeps the final output
// byte-identical to today.

export const PREVIEW_MARKDOWN_MAX_CHARS = 20000;

export const PREVIEW_PAINT_MODE = Object.freeze({
  MARKDOWN: "markdown",
  PLAIN: "plain"
});

// WHICH painter a message uses. This is the whole committed/preview boundary, in one
// place, and it is deliberately not a place to be clever: a streaming message is a
// preview, a settled message is committed. The committed painter is the pre-existing
// formatted-markdown block, untouched, which is what keeps the final output
// byte-identical to today.
export const MESSAGE_CONTENT_PAINTER = Object.freeze({
  COMMITTED: "committed",
  PREVIEW: "preview"
});

export function selectMessageContentPainter({ streaming = false } = {}) {
  return streaming === true ? MESSAGE_CONTENT_PAINTER.PREVIEW : MESSAGE_CONTENT_PAINTER.COMMITTED;
}

// The decision, separated from the painting so it can be asserted directly.
export function resolvePreviewPaintMode(text) {
  const source = String(text === undefined || text === null ? "" : text);

  if (!source.trim()) {
    return { mode: PREVIEW_PAINT_MODE.PLAIN, reason: "empty", source };
  }

  if (source.length > PREVIEW_MARKDOWN_MAX_CHARS) {
    return { mode: PREVIEW_PAINT_MODE.PLAIN, reason: "over-cap", source };
  }

  return { mode: PREVIEW_PAINT_MODE.MARKDOWN, reason: "", source };
}

// Paint the accumulated preview into `target`.
//
// `renderMarkdown(source, null, options)` is the shared renderer, injected so this
// module stays a leaf: it returns a root element whose child nodes are moved into the
// target. `setPlainText(target, text)` is the caller's plain-text painter (the same one
// the committed path uses for non-markdown messages).
//
// Returns the mode actually painted, which is what a caller/test can observe.
export function paintPreviewMarkdown(target, text, { renderMarkdown, setPlainText, className = "" } = {}) {
  const decision = resolvePreviewPaintMode(text);

  if (!target) {
    return decision.mode;
  }

  if (decision.mode === PREVIEW_PAINT_MODE.PLAIN) {
    setPlainText?.(target, decision.source);
    return PREVIEW_PAINT_MODE.PLAIN;
  }

  try {
    const rendered = renderMarkdown?.(decision.source, null, { className });
    const nodes = Array.from(rendered?.childNodes || []);

    if (!nodes.length) {
      setPlainText?.(target, decision.source);
      return PREVIEW_PAINT_MODE.PLAIN;
    }

    target.replaceChildren(...nodes);
    return PREVIEW_PAINT_MODE.MARKDOWN;
  } catch {
    // A partial document the renderer cannot handle costs ONE tick of formatting; the
    // next delta tries again. Throwing here would kill the streaming surface.
    setPlainText?.(target, decision.source);
    return PREVIEW_PAINT_MODE.PLAIN;
  }
}
