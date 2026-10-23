import { marked } from "./marked.esm.js";
import * as yaml from "./yaml-lite.js";

const SAFE_MARKDOWN_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const MARKDOWN_ROOT_CLASS = "markdown";
const MARKDOWN_TABLE_WRAP_CLASS = "markdown-table-wrap";
const LEGACY_MARKDOWN_TABLE_WRAP_CLASS = "message-markdown-table-wrap";

function normalizeMarkdownText(text = "") {
  return typeof text === "string" ? text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n") : "";
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
