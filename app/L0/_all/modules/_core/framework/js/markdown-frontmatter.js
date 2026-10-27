import { marked } from "./marked.esm.js";
import * as yaml from "./yaml-lite.js";
// The fence classifier is REUSED, never copied: `execution-blocks.js` owns what counts
// as fenced code for every first-party surface (BUG-007 contract).
import { collectExecutionFenceRegions } from "./execution-blocks.js";

const SAFE_MARKDOWN_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const MARKDOWN_ROOT_CLASS = "markdown";
const MARKDOWN_TABLE_WRAP_CLASS = "markdown-table-wrap";
const LEGACY_MARKDOWN_TABLE_WRAP_CLASS = "message-markdown-table-wrap";

function normalizeMarkdownText(text = "") {
  return typeof text === "string" ? text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n") : "";
}

// Neutralize the ONLY thing the parser would otherwise pass through as markup: a raw
// `<`/`>` in prose. `marked` sanitizes nothing, so `<img onerror=...>` typed in a chat
// reply would become live HTML; escaping the angle brackets before parse is what keeps
// prose inert, and it is still applied.
function escapeProseAngleBrackets(text) {
  return String(text || "").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Escape prose WITHOUT creating a second entity (chat-polish-3 item 2).
//
// `marked` already escapes quotes, apostrophes and ampersands itself, in text AND in
// code: `"intent": "x"` renders as `&quot;intent&quot;: &quot;x&quot;` from RAW input.
// Escaping those characters BEFORE the parse therefore produced a SECOND entity
// (`&amp;quot;`), which the parser then rendered literally — the owner-visible
// `&quot;` in code bodies.
//
// Fenced regions are skipped entirely, for the same reason: the parser escapes fenced
// code itself, so an escape applied there is precisely the double-escape being removed.
// Skipping cannot widen the HTML surface — whatever sits in a fence is still escaped by
// the parser before it reaches `innerHTML` (the hostile-fence case is pinned by tests).
// Inline code spans, for the same reason fenced regions are skipped: the parser
// escapes a span's content itself, so escaping it first would double it
// (`<div>` in backticks rendered as `&amp;lt;div&amp;gt;`).
//
// A run of backticks with NO matching closing run on the same line is NOT treated as
// code here: `marked` would render those backticks literally and pass a raw `<` in
// between straight through, so that text must keep the angle-bracket escape.
const INLINE_BACKTICK_RUN_PATTERN = /`+/gu;

function collectInlineCodeRegions(text, from, to) {
  const regions = [];
  const slice = text.slice(from, to);
  const lineBreaks = [];

  for (let index = 0; index < slice.length; index += 1) {
    if (slice[index] === "\n") {
      lineBreaks.push(index);
    }
  }

  const lineEndAfter = (index) => {
    const nextBreak = lineBreaks.find((lineBreak) => lineBreak > index);
    return nextBreak === undefined ? slice.length : nextBreak;
  };

  INLINE_BACKTICK_RUN_PATTERN.lastIndex = 0;

  let match = INLINE_BACKTICK_RUN_PATTERN.exec(slice);

  while (match) {
    const opener = match[0];
    const openStart = match.index;
    const openEnd = openStart + opener.length;
    const lineEnd = lineEndAfter(openStart);
    let searchIndex = openEnd;
    let closed = null;

    while (searchIndex < lineEnd) {
      const closeIndex = slice.indexOf(opener, searchIndex);

      if (closeIndex === -1 || closeIndex >= lineEnd) {
        break;
      }

      // The closing run must be exactly as long as the opener; a longer run belongs
      // to a different span.
      const afterClose = slice[closeIndex + opener.length] || "";

      if (afterClose === "`") {
        searchIndex = closeIndex + opener.length;
        continue;
      }

      closed = { closeEnd: closeIndex + opener.length, closeStart: closeIndex, openEnd, openStart };
      break;
    }

    if (!closed) {
      INLINE_BACKTICK_RUN_PATTERN.lastIndex = openEnd;
      match = INLINE_BACKTICK_RUN_PATTERN.exec(slice);
      continue;
    }

    regions.push({ end: from + closed.closeEnd, start: from + closed.openStart });
    INLINE_BACKTICK_RUN_PATTERN.lastIndex = closed.closeEnd;
    match = INLINE_BACKTICK_RUN_PATTERN.exec(slice);
  }

  return regions;
}

// The byte ranges the parser escapes itself: fenced blocks and inline code spans.
// Everything OUTSIDE them is prose, which is where a raw angle bracket must be
// neutralized before the parse.
function collectParserEscapedRegions(text) {
  const fenced = collectExecutionFenceRegions(text);
  const regions = fenced.slice();
  let cursor = 0;

  fenced.forEach((region) => {
    if (region.start > cursor) {
      collectInlineCodeRegions(text, cursor, region.start).forEach((inlineRegion) => regions.push(inlineRegion));
    }

    cursor = Math.max(cursor, region.end);
  });

  if (cursor < text.length) {
    collectInlineCodeRegions(text, cursor, text.length).forEach((inlineRegion) => regions.push(inlineRegion));
  }

  return regions.sort((left, right) => left.start - right.start);
}

function escapeHtml(text) {
  const source = String(text || "");

  if (!source) {
    return source;
  }

  const escapedRegions = collectParserEscapedRegions(source);

  if (!escapedRegions.length) {
    return escapeProseAngleBrackets(source);
  }

  let escaped = "";
  let cursor = 0;

  escapedRegions.forEach((region) => {
    // Overlapping regions (an inline span that begins before a fence closes, which the
    // fence scan already swallowed) are clamped so nothing is ever escaped twice.
    const start = Math.max(cursor, region.start);
    const end = Math.max(start, region.end);

    if (start > cursor) {
      escaped += escapeProseAngleBrackets(source.slice(cursor, start));
    }

    escaped += source.slice(start, end);
    cursor = end;
  });

  if (cursor < source.length) {
    escaped += escapeProseAngleBrackets(source.slice(cursor));
  }

  return escaped;
}

function joinClassNames(...classNames) {
  const normalizedClassNames = classNames.flatMap((className) =>
    typeof className === "string" ? className.trim().split(/\s+/u).filter(Boolean) : []
  );

  return [...new Set(normalizedClassNames)].join(" ");
}

function isSafeMarkdownUrl(value) {
  const normalizedValue = typeof value === "string" ? value.trim() : "";

  if (!normalizedValue) {
    return false;
  }

  if (normalizedValue.startsWith("#") || normalizedValue.startsWith("/") || normalizedValue.startsWith("./") || normalizedValue.startsWith("../")) {
    return true;
  }

  try {
    const parsed = new URL(normalizedValue, globalThis.location?.href || "http://localhost/");
    return SAFE_MARKDOWN_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function hasVisibleMarkdownHeaderText(cell) {
  return typeof cell?.textContent === "string" && cell.textContent.trim().length > 0;
}

function finalizeMarkdownLinks(container) {
  container.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href");

    if (!isSafeMarkdownUrl(href)) {
      link.replaceWith(document.createTextNode(link.textContent || href || ""));
      return;
    }

    link.target = "_blank";
    link.rel = "noreferrer";
  });

  container.querySelectorAll("img[src]").forEach((image) => {
    const source = image.getAttribute("src");

    if (!isSafeMarkdownUrl(source)) {
      image.remove();
      return;
    }

    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
  });
}

function finalizeMarkdownTables(container) {
  container.querySelectorAll("table").forEach((table) => {
    const header = table.querySelector("thead");
    const headerCells = Array.from(header?.querySelectorAll("th") || []);

    if (header && headerCells.length && headerCells.every((cell) => !hasVisibleMarkdownHeaderText(cell))) {
      header.remove();
    }

    if (
      table.parentElement?.classList.contains(MARKDOWN_TABLE_WRAP_CLASS) ||
      table.parentElement?.classList.contains(LEGACY_MARKDOWN_TABLE_WRAP_CLASS)
    ) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = joinClassNames(MARKDOWN_TABLE_WRAP_CLASS, LEGACY_MARKDOWN_TABLE_WRAP_CLASS);
    table.replaceWith(wrapper);
    wrapper.append(table);
  });
}

function renderMarkdownFallback(root, sourceText) {
  if (!sourceText) {
    return;
  }

  const pre = document.createElement("pre");
  pre.textContent = sourceText;
  root.replaceChildren(pre);
}

function getRenderableTarget(targetElement) {
  return targetElement &&
    typeof targetElement.replaceChildren === "function" &&
    typeof targetElement.appendChild === "function"
    ? targetElement
    : null;
}

export function renderMarkdown(text = "", targetElement = null, options = {}) {
  const rootTagName =
    typeof options.tagName === "string" && options.tagName.trim() ? options.tagName.trim().toLowerCase() : "div";
  const root = document.createElement(rootTagName);
  const sourceText = text === undefined || text === null ? "" : String(text);
  const customClassName = typeof options.className === "string" ? options.className : "";

  root.className = joinClassNames(MARKDOWN_ROOT_CLASS, customClassName);

  try {
    const renderedHtml = marked.parse(escapeHtml(sourceText), {
      async: false,
      breaks: true,
      gfm: true
    });

    if (renderedHtml && typeof renderedHtml.then === "function") {
      renderMarkdownFallback(root, sourceText);
    } else {
      root.innerHTML = String(renderedHtml || "");
      finalizeMarkdownLinks(root);
      finalizeMarkdownTables(root);
    }
  } catch {
    renderMarkdownFallback(root, sourceText);
  }

  const target = getRenderableTarget(targetElement);

  if (target) {
    target.replaceChildren(root);
  }

  return root;
}

function hasFrontmatterFence(text) {
  return text.startsWith("---\n") || text === "---";
}

function findClosingFence(text) {
  let searchIndex = 4;

  while (searchIndex <= text.length) {
    const fenceIndex = text.indexOf("\n---", searchIndex);

    if (fenceIndex === -1) {
      return -1;
    }

    const nextIndex = fenceIndex + "\n---".length;
    const nextChar = text[nextIndex] || "";

    if (!nextChar || nextChar === "\n") {
      return fenceIndex + 1;
    }

    searchIndex = nextIndex;
  }

  return -1;
}

export function parseMarkdownDocument(text = "") {
  const content = normalizeMarkdownText(text);

  if (!hasFrontmatterFence(content)) {
    return {
      body: content,
      content,
      frontmatter: {},
      frontmatterText: "",
      hasFrontmatter: false
    };
  }

  const closingFenceIndex = findClosingFence(content);

  if (closingFenceIndex === -1) {
    return {
      body: content,
      content,
      frontmatter: {},
      frontmatterText: "",
      hasFrontmatter: false
    };
  }

  const frontmatterText = content.slice(4, closingFenceIndex).trim();
  const bodyStartIndex = closingFenceIndex + 4;
  const body =
    content[bodyStartIndex] === "\n"
      ? content.slice(bodyStartIndex + 1)
      : content.slice(bodyStartIndex);

  return {
    body,
    content,
    frontmatter: yaml.parseSimpleYaml(frontmatterText),
    frontmatterText,
    hasFrontmatter: true
  };
}
