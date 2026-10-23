import { buildBrowserGuestRuntimeScriptPaths } from "./browser-guest-runtime.js";
import { logBrowser } from "./browser-logging.js";

const DEFAULT_WEBVIEW_PARTITION_PREFIX = "space-browser-";
const WEBVIEW_SHADOW_STYLE_ATTRIBUTE = "data-space-browser-webview-style";
const WEBVIEW_EMBEDDER_FRAME_SELECTOR = "iframe, embed, object, browserplugin";

const sourceTextCache = new Map();
const injectSourceCache = new Map();
const shadowObserverCache = new WeakMap();

function normalizeBrowserId(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    throw new Error("Desktop browser webview helpers require a non-empty browser id.");
  }

  return normalizedValue;
}

function getDesktopBrowserApi() {
  const browserApi = globalThis.spaceDesktop?.browser;
  return browserApi?.available ? browserApi : null;
}

function normalizeInjectPath(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    throw new Error("Desktop browser webview injection requires a non-empty script path.");
  }

  return normalizedValue;
}

export function isWebviewLike(value) {
  const tagName = String(value?.tagName || value?.nodeName || "").toUpperCase();
  return tagName === "WEBVIEW";
}

export function usesDesktopBrowserWebview() {
  return Boolean(getDesktopBrowserApi()?.webviewPreloadURL);
}

export function getDesktopBrowserWebviewPartition(browserId) {
  const browserApi = getDesktopBrowserApi();
  const prefix = String(browserApi?.webviewPartitionPrefix || DEFAULT_WEBVIEW_PARTITION_PREFIX).trim()
    || DEFAULT_WEBVIEW_PARTITION_PREFIX;

  return `${prefix}${normalizeBrowserId(browserId)}`;
}

function setImportantStyle(target, propertyName, value) {
  if (!(target instanceof Element) || !target.style) {
    return;
  }

  target.style.setProperty(propertyName, value, "important");
}

function applyEmbedderFrameStyles(target, options = {}) {
  if (!(target instanceof Element)) {
    return;
  }

  setImportantStyle(target, "display", "block");
  setImportantStyle(target, "width", "100%");
  setImportantStyle(target, "height", "100%");
  setImportantStyle(target, "min-width", "0");
  setImportantStyle(target, "min-height", "0");
  setImportantStyle(target, "max-width", "100%");
  setImportantStyle(target, "max-height", "100%");
  setImportantStyle(target, "overflow", "hidden");
  setImportantStyle(target, "pointer-events", "auto");
  setImportantStyle(target, "background-color", "#ffffff");

  if (options.absolute) {
    setImportantStyle(target, "position", "absolute");
    setImportantStyle(target, "inset", "0");
  }

  if (options.borderless) {
    setImportantStyle(target, "border", "0");
  }
}

function disableEmbedderSiblingPointerEvents(target) {
  if (!(target instanceof Element)) {
    return;
  }

  const tagName = String(target.tagName || "").toUpperCase();
  if (tagName === "STYLE" || tagName === "LINK" || tagName === "SCRIPT" || tagName === "TEMPLATE") {
    setImportantStyle(target, "pointer-events", "none");
    return;
  }

  setImportantStyle(target, "pointer-events", "none");
}

function collectEmbedderNodeChain(node, shadowRoot) {
  const chain = [];
  let current = node instanceof Element ? node : null;

  while (current instanceof Element) {
    chain.push(current);

    const parentNode = current.parentNode;
    if (parentNode === shadowRoot) {
      break;
    }

    current = parentNode instanceof Element ? parentNode : null;
  }

  return chain;
}

function ensureShadowLayout(webview) {
  const shadowRoot = webview.shadowRoot;
  if (!(shadowRoot instanceof ShadowRoot)) {
    return false;
  }

  shadowRoot.querySelectorAll(`[${WEBVIEW_SHADOW_STYLE_ATTRIBUTE}="true"]`).forEach((node) => {
    node.remove();
  });

  const activeNodes = new Set();
  const frameNodes = Array.from(shadowRoot.querySelectorAll(WEBVIEW_EMBEDDER_FRAME_SELECTOR))
    .filter((node) => node instanceof Element);

  frameNodes.forEach((frameNode) => {
    collectEmbedderNodeChain(frameNode, shadowRoot).forEach((node) => {
      activeNodes.add(node);
    });
  });

  activeNodes.forEach((node) => {
    const isRootLevelNode = node.parentNode === shadowRoot;
    const tagName = String(node.tagName || "").toUpperCase();
    const isFrameNode = tagName === "IFRAME" || tagName === "EMBED" || tagName === "OBJECT" || tagName === "BROWSERPLUGIN";

    applyEmbedderFrameStyles(node, {
      absolute: isRootLevelNode,
      borderless: isFrameNode
    });
  });

  Array.from(shadowRoot.children).forEach((child) => {
    if (activeNodes.has(child)) {
      return;
    }

    disableEmbedderSiblingPointerEvents(child);
  });

  return true;
}

function ensureShadowObserver(webview) {
  if (!isWebviewLike(webview)) {
    return false;
  }

  const shadowRoot = webview.shadowRoot;
  if (!(shadowRoot instanceof ShadowRoot)) {
    return false;
  }

  const cachedObserver = shadowObserverCache.get(webview);
  if (cachedObserver?.shadowRoot === shadowRoot) {
    return true;
  }

  cachedObserver?.observer?.disconnect?.();

  const observer = new MutationObserver(() => {
    ensureShadowLayout(webview);
  });

  observer.observe(shadowRoot, {
    childList: true,
    subtree: true
  });

  shadowObserverCache.set(webview, {
    observer,
    shadowRoot
  });

  return true;
}

export function stabilizeWebviewEmbedder(webview) {
  if (!isWebviewLike(webview)) {
    return false;
  }

  setImportantStyle(webview, "display", "block");
  setImportantStyle(webview, "width", "100%");
  setImportantStyle(webview, "height", "100%");
  setImportantStyle(webview, "min-width", "0");
  setImportantStyle(webview, "min-height", "0");
  setImportantStyle(webview, "overflow", "hidden");
  setImportantStyle(webview, "pointer-events", "auto");
  setImportantStyle(webview, "background-color", "#ffffff");

  if (!webview.hasAttribute("tabindex")) {
    webview.tabIndex = -1;
  }

  ensureShadowObserver(webview);
  return ensureShadowLayout(webview);
}

export function releaseWebviewEmbedder(webview) {
  if (!isWebviewLike(webview)) {
    return;
  }

  const cachedObserver = shadowObserverCache.get(webview);
  cachedObserver?.observer?.disconnect?.();
  shadowObserverCache.delete(webview);
}

export function focusWebview(webview) {
  if (!isWebviewLike(webview)) {
    return false;
  }

  try {
    webview.focus?.();
    return true;
  } catch {
    return false;
  }
}

function callWebviewMethod(webview, methodName, fallback = null) {
  try {
    if (!isWebviewLike(webview)) {
      return fallback;
    }

    const method = webview?.[methodName];
    if (typeof method !== "function") {
      return fallback;
    }

    return method.call(webview);
  } catch {
    return fallback;
  }
}

async function fetchSourceText(scriptPath) {
  const normalizedScriptPath = normalizeInjectPath(scriptPath);
  if (sourceTextCache.has(normalizedScriptPath)) {
    return sourceTextCache.get(normalizedScriptPath);
  }

  const loadPromise = (async () => {
    const response = await globalThis.fetch(normalizedScriptPath, {
      credentials: "same-origin"
    });
    if (!response.ok) {
      throw new Error(`Desktop browser webview injection could not load ${normalizedScriptPath} (${response.status}).`);
    }

    return response.text();
  })();

  sourceTextCache.set(normalizedScriptPath, loadPromise);

  try {
    return await loadPromise;
  } catch (error) {
    sourceTextCache.delete(normalizedScriptPath);
    throw error;
  }
}

async function fetchInjectSource(injectPath) {
  const normalizedInjectPath = normalizeInjectPath(injectPath);
  if (injectSourceCache.has(normalizedInjectPath)) {
    return injectSourceCache.get(normalizedInjectPath);
  }

  const loadPromise = (async () => {
    const runtimeContext = await buildBrowserGuestRuntimeScriptPaths({
      injectPath: normalizedInjectPath,
      postBootstrapScriptPaths: [],
      preBootstrapScriptPaths: []
    });
    const preBootstrapScriptPaths = Array.isArray(runtimeContext?.preBootstrapScriptPaths)
      ? runtimeContext.preBootstrapScriptPaths
      : [];
    const postBootstrapScriptPaths = Array.isArray(runtimeContext?.postBootstrapScriptPaths)
      ? runtimeContext.postBootstrapScriptPaths
      : [];
    const sources = await Promise.all([
      ...preBootstrapScriptPaths.map((scriptPath) => fetchSourceText(scriptPath)),
      fetchSourceText(normalizedInjectPath),
      ...postBootstrapScriptPaths.map((scriptPath) => fetchSourceText(scriptPath))
    ]);

    return sources
      .map((source) => String(source || "").trim())
      .filter(Boolean)
      .join("\n;\n");
  })();

  injectSourceCache.set(normalizedInjectPath, loadPromise);

  try {
    return await loadPromise;
  } catch (error) {
    injectSourceCache.delete(normalizedInjectPath);
    throw error;
  }
}

export function collectWebviewNavigationState(webview) {
  if (!isWebviewLike(webview)) {
    return null;
  }

  return {
    canGoBack: Boolean(callWebviewMethod(webview, "canGoBack", false)),
    canGoForward: Boolean(callWebviewMethod(webview, "canGoForward", false)),
    loading: Boolean(callWebviewMethod(webview, "isLoading", false)),
    title: String(callWebviewMethod(webview, "getTitle", "") || ""),
    // Electron throws for several getters before the guest is fully ready.
    // Fall back to the embedder src so toolbar state can stay stable.
    url: String(callWebviewMethod(webview, "getURL", "") || webview.src || "")
  };
}

export function loadWebviewUrl(webview, url) {
  if (!isWebviewLike(webview)) {
    return false;
  }

  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) {
    return false;
  }

  try {
    if (typeof webview.getWebContentsId === "function") {
      webview.getWebContentsId();
      const result = webview.loadURL?.(normalizedUrl);
      result?.catch?.(() => {});
      return true;
    }
  } catch {
    // Fall back to the embedder src until Electron finishes wiring the guest.
  }

  try {
    webview.setAttribute("src", normalizedUrl);
    return true;
  } catch {
    return false;
  }
}

export function navigateWebviewHistory(webview, direction) {
  if (!isWebviewLike(webview)) {
    return false;
  }

  if (direction === "back") {
    if (!Boolean(callWebviewMethod(webview, "canGoBack", false))) {
      return false;
    }

    try {
      webview.goBack?.();
      return true;
    } catch {
      return false;
    }
  }

  if (direction === "forward") {
    if (!Boolean(callWebviewMethod(webview, "canGoForward", false))) {
      return false;
    }

    try {
      webview.goForward?.();
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export function reloadWebview(webview) {
  if (!isWebviewLike(webview)) {
    return false;
  }

  try {
    webview.reload?.();
    return true;
  } catch {
    const fallbackUrl = String(webview.getAttribute?.("src") || webview.src || "").trim();
    if (!fallbackUrl) {
      return false;
    }

    try {
      webview.setAttribute("src", fallbackUrl);
      return true;
    } catch {
      return false;
    }
  }
}

export async function injectBrowserWebviewRuntime(webview, options = {}) {
  if (!isWebviewLike(webview)) {
    throw new Error("Desktop browser webview injection requires a <webview> element.");
  }

  const browserId = normalizeBrowserId(options.browserId);
  const injectPath = normalizeInjectPath(options.injectPath);
  const scriptSource = await fetchInjectSource(injectPath);
  const scriptUrl = new URL(injectPath, globalThis.location?.href || "http://localhost/").href;
  const sourceUrl = String(scriptUrl || injectPath || "space-desktop-browser-webview-injected-script")
    .replace(/[\r\n]+/gu, " ");
  const bootstrap = {
    browserId,
    iframeId: browserId,
    scriptPath: injectPath,
    scriptUrl
  };
  const source = `(() => {\n  const bootstrap = ${JSON.stringify(bootstrap)};\n  globalThis.__spaceBrowserInjectBootstrap__ = bootstrap;\n  globalThis.__spaceBrowserFrameInjectBootstrap__ = bootstrap;\n  try {\n${scriptSource}\n  } finally {\n    delete globalThis.__spaceBrowserInjectBootstrap__;\n    delete globalThis.__spaceBrowserFrameInjectBootstrap__;\n  }\n})();\n//# sourceURL=${sourceUrl}`;

  await webview.executeJavaScript(source, true);
  logBrowser("debug", `[space-browser] Injected browser runtime into ${browserId}.`, {
    browserId,
    injectPath,
    scriptUrl
  });
}
