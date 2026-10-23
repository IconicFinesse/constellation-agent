import { setPromptItem } from "/modules/_core/agent_prompt/prompt-items.js";
import { getStore } from "/modules/_core/framework/js/AlpineStore.js";

const OPEN_BROWSERS_TRANSIENT_HEADING = "currently open web browsers";
const OPEN_BROWSERS_TRANSIENT_KEY = "currently-open-web-browsers";

export function normalizeBrowserTransientId(value) {
  const match = String(value || "").trim().match(/^browser-(\d+)$/u);
  if (match) {
    const parsed = Number.parseInt(match[1], 10);
    return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : "";
  }

  return String(value || "").trim();
}

export function normalizeBrowserTransientCell(value) {
  return String(value ?? "")
    .replace(/\|/gu, "/")
    .replace(/\s+/gu, " ")
    .trim();
}

function compareBrowsers(left, right) {
  const leftId = Number.parseInt(left.id, 10);
  const rightId = Number.parseInt(right.id, 10);

  if (Number.isInteger(leftId) && Number.isInteger(rightId)) {
    return leftId - rightId;
  }

  return left.id.localeCompare(right.id);
}

export function getOpenBrowserTransientRows(webBrowsingStore = getStore("webBrowsing")) {
  const browsers = typeof webBrowsingStore?.getBrowserList === "function"
    ? webBrowsingStore.getBrowserList()
    : Array.isArray(webBrowsingStore?.windows)
      ? webBrowsingStore.windows
      : [];

  return browsers
    .map((browserSurface) => {
      const id = normalizeBrowserTransientId(browserSurface?.id);
      const url = normalizeBrowserTransientCell(
        browserSurface?.currentUrl
        || browserSurface?.frameSrc
        || browserSurface?.addressValue
        || ""
      );
      const title = normalizeBrowserTransientCell(browserSurface?.title || "");

      if (!id) {
        return null;
      }

      return {
        id,
        title,
        url
      };
    })
    .filter(Boolean)
    .sort(compareBrowsers);
}

export function buildOpenBrowsersTransientSection(webBrowsingStore = getStore("webBrowsing")) {
  const rows = getOpenBrowserTransientRows(webBrowsingStore);

  if (!rows.length) {
    return null;
  }

  return {
    heading: OPEN_BROWSERS_TRANSIENT_HEADING,
    key: OPEN_BROWSERS_TRANSIENT_KEY,
    order: 20,
    value: [
      "browser id|url|title",
      ...rows.map((row) => `${row.id}|${row.url}|${row.title}`)
    ].join("\n")
  };
}

export default async function injectOpenBrowsersTransientSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext) {
    return;
  }

  const openBrowsersTransientSection = buildOpenBrowsersTransientSection();

  if (!openBrowsersTransientSection) {
    return;
  }

  promptContext.transientItems = setPromptItem(
    promptContext.transientItems,
    OPEN_BROWSERS_TRANSIENT_KEY,
    openBrowsersTransientSection
  );
}
