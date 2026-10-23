import { setPromptItem } from "/modules/_core/agent_prompt/prompt-items.js";
import { getStore } from "/modules/_core/framework/js/AlpineStore.js";
import {
  normalizeBrowserTransientCell,
  normalizeBrowserTransientId
} from "./open-browsers.js";

const LAST_INTERACTED_BROWSER_CONTENT_HEADING = "last interacted web browser";
const LAST_INTERACTED_BROWSER_CONTENT_KEY = "last-interacted-web-browser-content";
const LAST_INTERACTED_BROWSER_CONTENT_TIMEOUT_MS = 1800;
const LAST_INTERACTED_BROWSER_CONTENT_RETRY_COUNT = 3;
const LAST_INTERACTED_BROWSER_CONTENT_RETRY_DELAY_MS = 120;

function wait(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function buildBrowserStatusRow(browserSurface) {
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
}

async function buildLastInteractedBrowserContentTransientSection(webBrowsingStore = getStore("webBrowsing")) {
  const browserId = String(webBrowsingStore?.lastInteractedBrowserId || "").trim();
  const browserInstanceKey = webBrowsingStore?.lastInteractedBrowserInstanceKey ?? null;
  if (!browserId) {
    return null;
  }

  const browserSurface = typeof webBrowsingStore?.getBrowser === "function"
    ? webBrowsingStore.getBrowser(browserId)
    : typeof webBrowsingStore?.getWindow === "function"
      ? webBrowsingStore.getWindow(browserId)
      : null;
  if (!browserSurface) {
    return null;
  }

  if (browserInstanceKey != null && browserSurface.instanceKey !== browserInstanceKey) {
    return null;
  }

  let documentContent = "";
  for (let attempt = 0; attempt < LAST_INTERACTED_BROWSER_CONTENT_RETRY_COUNT; attempt += 1) {
    if (typeof webBrowsingStore?.syncNavigationState === "function") {
      await webBrowsingStore.syncNavigationState(browserId, {
        allowUnready: true,
        attempts: attempt === 0 ? 1 : 2
      });
    }

    const contentPayload = typeof webBrowsingStore?.requestBridgePayload === "function"
      ? await webBrowsingStore.requestBridgePayload(browserId, "content", null, {
          timeoutMs: LAST_INTERACTED_BROWSER_CONTENT_TIMEOUT_MS
        })
      : null;
    documentContent = typeof contentPayload?.document === "string"
      ? contentPayload.document.trim()
      : "";
    if (documentContent) {
      break;
    }

    if (attempt < (LAST_INTERACTED_BROWSER_CONTENT_RETRY_COUNT - 1)) {
      await wait(LAST_INTERACTED_BROWSER_CONTENT_RETRY_DELAY_MS);
    }
  }

  if (!documentContent) {
    return null;
  }

  const latestBrowserSurface = typeof webBrowsingStore?.getBrowser === "function"
    ? webBrowsingStore.getBrowser(browserId)
    : typeof webBrowsingStore?.getWindow === "function"
      ? webBrowsingStore.getWindow(browserId)
      : browserSurface;
  const row = buildBrowserStatusRow(latestBrowserSurface);
  if (!row) {
    return null;
  }

  return {
    heading: LAST_INTERACTED_BROWSER_CONTENT_HEADING,
    key: LAST_INTERACTED_BROWSER_CONTENT_KEY,
    order: 30,
    value: [
      "browser id|url|title",
      `${row.id}|${row.url}|${row.title}`,
      "",
      "page content↓",
      documentContent
    ].join("\n")
  };
}

export default async function injectLastInteractedBrowserContentTransientSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext) {
    return;
  }

  const contentTransientSection = await buildLastInteractedBrowserContentTransientSection();

  if (!contentTransientSection) {
    return;
  }

  promptContext.transientItems = setPromptItem(
    promptContext.transientItems,
    LAST_INTERACTED_BROWSER_CONTENT_KEY,
    contentTransientSection
  );
}
