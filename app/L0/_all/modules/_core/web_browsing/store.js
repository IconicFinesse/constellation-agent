import {
  getBrowserFrameBridge,
  send as sendBrowserFrameMessage
} from "./browser-frame-bridge.js";
import { defineBrowserElement } from "./browser-element.js";
import {
  AGENT_FUNCTION_REQUIREMENT,
  guardAgentFunction
} from "./agent-function-availability.js";
import {
  browserConsoleEventLevelToLogLevel,
  logBrowser,
  setBrowserLogLevel
} from "./browser-logging.js";
import {
  collectWebviewNavigationState,
  focusWebview,
  getDesktopBrowserWebviewPartition,
  injectBrowserWebviewRuntime,
  isWebviewLike,
  loadWebviewUrl,
  navigateWebviewHistory,
  releaseWebviewEmbedder,
  reloadWebview,
  stabilizeWebviewEmbedder,
  usesDesktopBrowserWebview
} from "./browser-webview.js";
import {
  bindDesktopBrowserHostEvents,
  BROWSER_INJECT_PATH,
  focusBrowserSurface,
  goBackBrowserSurface,
  goForwardBrowserSurface,
  navigateBrowserSurface,
  registerBrowserSurface as registerDesktopBrowserSurface,
  reloadBrowserSurface,
  syncAllBrowserSurfaces,
  syncBrowserSurface as syncDesktopBrowserSurface,
  unregisterBrowserSurface as unregisterDesktopBrowserSurface,
  usesNativeDesktopBrowser
} from "./browser-surface.js";

const STORE_NAME = "webBrowsing";
const BROWSER_WINDOW_ID_PREFIX = "browser-";
const DEFAULT_FRAME_SRC = "/modules/_core/web_browsing/browser-frame.html";
const FRAME_REQUEST_TIMEOUT_MS = 450;
const FRAME_SYNC_ATTEMPTS = 5;
const FRAME_SYNC_DELAY_MS = 120;
const FRAME_NAVIGATION_WAIT_MS = 2500;
const FRAME_NAVIGATION_READY_TIMEOUT_MS = 8000;
const FRAME_NAVIGATION_QUIET_MS = 250;
const WINDOW_CASCADE_X_STEP = 28;
const WINDOW_CASCADE_Y_STEP = 24;
const WINDOW_MARGIN = 16;
const WINDOW_DRAG_TOP_MARGIN = 0;
const WINDOW_MIN_WIDTH = 360;
const WINDOW_MIN_HEIGHT = 260;
const WINDOW_EMERGENCY_MIN_WIDTH = 240;
const WINDOW_EMERGENCY_MIN_HEIGHT = 180;
const WINDOW_MINIMIZED_HEIGHT = 46;
const WINDOW_MINIMIZED_WIDTH_EM = 12;
const WINDOW_TOP_RESERVE_EM = 4.5;
const DEFAULT_HEIGHT_RATIO = 0.8;
const DEFAULT_MAX_HEIGHT_EM = 100;
const PERSISTED_BROWSER_WINDOWS_STORAGE_KEY = "space.web_browsing.windows.v1";
const PERSISTED_BROWSER_WINDOWS_WRITE_DELAY_MS = 80;
const ROUTER_STAGE_APPROX_MAX_WIDTH_REM = 84;
const AGENT_BROWSER_INTERACTION_MESSAGE_TYPES = new Set([
  "click",
  "evaluate",
  "history_back",
  "history_forward",
  "location_navigate",
  "location_reload",
  "scroll",
  "submit",
  "type",
  "type_submit"
]);

let nextWindowZIndex = 2147481200;
let nextBrowserWindowInstanceKey = 1;
const browserSurfaceElements = new Map();
const browserElementIds = new WeakMap();

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getNextBrowserWindowInstanceKey() {
  const currentKey = nextBrowserWindowInstanceKey;
  nextBrowserWindowInstanceKey += 1;
  return currentKey;
}

function roundPx(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function wait(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, roundPx(ms)));
  });
}

function resolveMinimum(maxValue, preferredValue, emergencyFloor) {
  if (maxValue <= 0) {
    return emergencyFloor;
  }

  if (maxValue <= emergencyFloor) {
    return Math.round(maxValue);
  }

  return Math.min(preferredValue, Math.round(maxValue));
}

function readRootFontSize() {
  const root = globalThis.document?.documentElement;

  if (!(root instanceof HTMLElement)) {
    return 16;
  }

  const resolvedValue = Number.parseFloat(globalThis.getComputedStyle(root).fontSize);
  return Number.isFinite(resolvedValue) && resolvedValue > 0 ? resolvedValue : 16;
}

function getMinimizedWidthPx() {
  return Math.round(readRootFontSize() * WINDOW_MINIMIZED_WIDTH_EM);
}

function getTopReservePx() {
  return Math.round(readRootFontSize() * WINDOW_TOP_RESERVE_EM);
}

function getDefaultMaxHeightPx() {
  return Math.round(readRootFontSize() * DEFAULT_MAX_HEIGHT_EM);
}

function getViewportSize() {
  return {
    width: Math.max(roundPx(globalThis.window?.innerWidth, 0), WINDOW_EMERGENCY_MIN_WIDTH),
    height: Math.max(
      roundPx(globalThis.window?.innerHeight, 0),
      WINDOW_MINIMIZED_HEIGHT + getTopReservePx() + WINDOW_MARGIN
    )
  };
}

function getAvailableWindowArea() {
  const viewport = getViewportSize();

  return {
    height: Math.max(WINDOW_MINIMIZED_HEIGHT, viewport.height - WINDOW_DRAG_TOP_MARGIN - WINDOW_MARGIN),
    left: WINDOW_MARGIN,
    top: WINDOW_DRAG_TOP_MARGIN,
    width: Math.max(WINDOW_EMERGENCY_MIN_WIDTH, viewport.width - (WINDOW_MARGIN * 2))
  };
}

function getSpawnWindowArea() {
  const viewport = getViewportSize();
  const top = WINDOW_MARGIN + getTopReservePx();

  return {
    height: Math.max(WINDOW_MINIMIZED_HEIGHT, viewport.height - top - WINDOW_MARGIN),
    left: WINDOW_MARGIN,
    top,
    width: Math.max(WINDOW_EMERGENCY_MIN_WIDTH, viewport.width - (WINDOW_MARGIN * 2))
  };
}

function getApproximateRouterStageMetrics(area = getAvailableWindowArea()) {
  const maxStageWidth = Math.round(readRootFontSize() * ROUTER_STAGE_APPROX_MAX_WIDTH_REM);
  const width = clamp(
    Math.min(area.width, maxStageWidth),
    WINDOW_EMERGENCY_MIN_WIDTH,
    Math.max(WINDOW_EMERGENCY_MIN_WIDTH, area.width)
  );

  return {
    left: area.left + Math.max(0, Math.round((area.width - width) / 2)),
    width
  };
}

function getExpandedSizeBounds(area = getAvailableWindowArea()) {
  const minWidth = resolveMinimum(area.width, WINDOW_MIN_WIDTH, WINDOW_EMERGENCY_MIN_WIDTH);
  const minHeight = resolveMinimum(area.height, WINDOW_MIN_HEIGHT, WINDOW_EMERGENCY_MIN_HEIGHT);

  return {
    maxHeight: Math.max(minHeight, Math.round(area.height)),
    maxWidth: Math.max(minWidth, Math.round(area.width)),
    minHeight,
    minWidth
  };
}

function getDefaultExpandedSize(spawnArea = getSpawnWindowArea(), clampArea = getAvailableWindowArea()) {
  const bounds = getExpandedSizeBounds(clampArea);
  const routerStage = getApproximateRouterStageMetrics(clampArea);
  const viewport = getViewportSize();
  const preferredHeight = Math.min(
    Math.round(viewport.height * DEFAULT_HEIGHT_RATIO),
    getDefaultMaxHeightPx()
  );

  return {
    height: clamp(preferredHeight, bounds.minHeight, bounds.maxHeight),
    width: clamp(Math.round(routerStage.width), bounds.minWidth, bounds.maxWidth)
  };
}

function getDefaultPosition(size, spawnArea = getSpawnWindowArea(), clampArea = getAvailableWindowArea(), cascadeIndex = 0) {
  const maxX = clampArea.left + Math.max(0, clampArea.width - size.width);
  const maxY = clampArea.top + Math.max(0, clampArea.height - size.height);
  const offsetX = Math.min(
    Math.max(0, cascadeIndex) * WINDOW_CASCADE_X_STEP,
    Math.max(0, clampArea.width - size.width)
  );
  const offsetY = Math.min(
    Math.max(0, cascadeIndex) * WINDOW_CASCADE_Y_STEP,
    Math.max(0, clampArea.height - size.height)
  );
  const routerStage = getApproximateRouterStageMetrics(clampArea);

  return {
    x: clamp(routerStage.left + offsetX, clampArea.left, maxX),
    y: clamp(spawnArea.top + offsetY, clampArea.top, maxY)
  };
}

function clampPosition(position, size, area = getAvailableWindowArea()) {
  const width = Math.max(0, roundPx(size?.width));
  const height = Math.max(0, roundPx(size?.height));
  const maxX = area.left + Math.max(0, area.width - width);
  const maxY = area.top + Math.max(0, area.height - height);

  return {
    x: clamp(roundPx(position?.x, area.left), area.left, maxX),
    y: clamp(roundPx(position?.y, area.top), area.top, maxY)
  };
}

function getRightAnchoredPosition(position, previousSize, nextSize, area = getAvailableWindowArea()) {
  return clampPosition({
    x: roundPx(position?.x, area.left) + Math.max(0, roundPx(previousSize?.width)) - Math.max(0, roundPx(nextSize?.width)),
    y: roundPx(position?.y, area.top)
  }, nextSize, area);
}

function getNextZIndex() {
  nextWindowZIndex += 1;
  return nextWindowZIndex;
}

function getBrowserWindowStorage() {
  try {
    const storage = globalThis.localStorage;
    return storage
      && typeof storage.getItem === "function"
      && typeof storage.setItem === "function"
      && typeof storage.removeItem === "function"
      ? storage
      : null;
  } catch {
    return null;
  }
}

function parsePersistedBrowserWindows(rawValue) {
  if (!rawValue) {
    return [];
  }

  try {
    const parsedValue = JSON.parse(String(rawValue));
    return Array.isArray(parsedValue) ? parsedValue : [];
  } catch {
    return [];
  }
}

function buildPersistedBrowserWindowSnapshot(browserWindow) {
  if (!browserWindow || typeof browserWindow !== "object") {
    return null;
  }

  const url = resolveBrowserLocation(
    browserWindow.currentUrl
      || browserWindow.frameSrc
      || browserWindow.addressValue
      || resolveDefaultFrameSrc()
  );
  if (!url) {
    return null;
  }

  return {
    id: String(browserWindow.id || "").trim(),
    instanceKey: Math.max(1, roundPx(browserWindow.instanceKey, 1)),
    isMinimized: browserWindow.isMinimized === true,
    position: {
      x: roundPx(browserWindow.position?.x),
      y: roundPx(browserWindow.position?.y)
    },
    size: {
      height: roundPx(browserWindow.size?.height),
      width: roundPx(browserWindow.size?.width)
    },
    url,
    zIndex: Math.max(1, roundPx(browserWindow.zIndex, 1))
  };
}

function syncBrowserWindowCounters(windows = []) {
  const maxInstanceKey = windows.reduce((currentMax, browserWindow) => {
    const nextValue = Math.max(0, roundPx(browserWindow?.instanceKey));
    return Math.max(currentMax, nextValue);
  }, 0);
  const maxZIndex = windows.reduce((currentMax, browserWindow) => {
    const nextValue = Math.max(0, roundPx(browserWindow?.zIndex));
    return Math.max(currentMax, nextValue);
  }, 0);

  nextBrowserWindowInstanceKey = Math.max(nextBrowserWindowInstanceKey, maxInstanceKey + 1);
  nextWindowZIndex = Math.max(nextWindowZIndex, maxZIndex);
}

function releasePointerCapture(interaction) {
  try {
    interaction?.captureTarget?.releasePointerCapture?.(interaction.pointerId);
  } catch {
    // Ignore release failures from stale or detached capture targets.
  }
}

function getBrowserBaseUrl() {
  return String(globalThis.window?.location?.href || globalThis.location?.href || "http://localhost/");
}

function getBrowserOriginUrl() {
  try {
    return new URL(getBrowserBaseUrl()).origin;
  } catch {
    return "http://localhost";
  }
}

function resolveDefaultFrameSrc() {
  return new URL(DEFAULT_FRAME_SRC, `${getBrowserOriginUrl()}/`).href;
}

function resolveBrowserLocation(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return "";
  }

  try {
    return new URL(normalizedValue, getBrowserBaseUrl()).href;
  } catch {
    return normalizedValue;
  }
}

function looksLikeLocalBrowserHost(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return false;
  }

  const host = normalizedValue.split(/[/?#]/u, 1)[0] || "";
  return /^(?:localhost|\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$/iu.test(host);
}

function looksLikeTypedBrowserHost(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue || /\s/u.test(normalizedValue)) {
    return false;
  }

  const host = normalizedValue.split(/[/?#]/u, 1)[0] || "";
  return /^(?:localhost|\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d-]{2,63})(?::\d+)?$/iu.test(host);
}

function getRuntime() {
  const runtime = globalThis.space;

  if (!runtime || typeof runtime !== "object") {
    throw new Error("Space runtime is not available.");
  }

  return runtime;
}

function shouldRememberAgentBrowserInteraction(type) {
  return AGENT_BROWSER_INTERACTION_MESSAGE_TYPES.has(String(type || "").trim());
}

function normalizeAgentBrowserId(value) {
  if (typeof Element !== "undefined" && value instanceof Element) {
    return String(value.dataset?.browserId || value.getAttribute?.("data-browser-id") || "").trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const ordinal = Math.trunc(value);
    return ordinal > 0 ? `${BROWSER_WINDOW_ID_PREFIX}${ordinal}` : "";
  }

  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return "";
  }

  if (/^\d+$/u.test(normalizedValue)) {
    const ordinal = Number.parseInt(normalizedValue, 10);
    return Number.isInteger(ordinal) && ordinal > 0
      ? `${BROWSER_WINDOW_ID_PREFIX}${ordinal}`
      : "";
  }

  const ordinal = extractBrowserWindowOrdinal(normalizedValue);
  return ordinal ? `${BROWSER_WINDOW_ID_PREFIX}${ordinal}` : normalizedValue;
}

function mergeBrowserSurfaceEntries(currentSurfaces = [], nextSurfaces = []) {
  const surfaceById = new Map();

  [...(Array.isArray(currentSurfaces) ? currentSurfaces : []), ...(Array.isArray(nextSurfaces) ? nextSurfaces : [])]
    .filter((browserSurface) => browserSurface?.id)
    .forEach((browserSurface) => {
      surfaceById.set(browserSurface.id, browserSurface);
    });

  return [...surfaceById.values()];
}

function toAgentBrowserId(value) {
  const ordinal = extractBrowserWindowOrdinal(value);
  return ordinal ?? String(value || "").trim();
}

function buildRuntimeBrowserWindowSnapshot(browserWindow) {
  if (!browserWindow || typeof browserWindow !== "object") {
    return null;
  }

  return {
    ...browserWindow,
    id: toAgentBrowserId(browserWindow.id),
    position: browserWindow.position && typeof browserWindow.position === "object"
      ? { ...browserWindow.position }
      : browserWindow.position,
    size: browserWindow.size && typeof browserWindow.size === "object"
      ? { ...browserWindow.size }
      : browserWindow.size
  };
}

function getFrontmostBrowserWindow(windows) {
  if (!Array.isArray(windows) || !windows.length) {
    return null;
  }

  return windows.reduce((frontmostWindow, browserWindow) => {
    if (!frontmostWindow) {
      return browserWindow;
    }

    return Number(browserWindow?.zIndex || 0) >= Number(frontmostWindow?.zIndex || 0)
      ? browserWindow
      : frontmostWindow;
  }, null);
}

function normalizeCreateWindowOptions(value) {
  if (typeof value === "string") {
    const url = String(value).trim();
    return url ? { url } : {};
  }

  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

async function settleRuntimeBrowserWindowState(store, id, options = {}) {
  const normalizedId = normalizeAgentBrowserId(id);
  const browserWindow = normalizedId ? store.getBrowser(normalizedId) : null;
  if (!browserWindow) {
    return null;
  }

  if (options.waitForNavigation && typeof store.waitForNavigationObservation === "function") {
    const navigationObserved = await store.waitForNavigationObservation(normalizedId, {
      timeoutMs: options.navigationWaitMs
    });

    if (navigationObserved && typeof store.waitForGuestUsableOrSettled === "function") {
      const settledState = await store.waitForGuestUsableOrSettled(normalizedId, {
        quietMs: options.navigationQuietMs,
        syncAttempts: options.attempts,
        timeoutMs: options.navigationReadyTimeoutMs
      });
      return settledState ?? buildRuntimeBrowserWindowSnapshot(store.getBrowser(normalizedId));
    }
  }

  const settleDelayMs = Math.max(0, Number(options.settleDelayMs) || 0);
  if (settleDelayMs > 0) {
    await wait(settleDelayMs);
  }

  if (typeof store.syncNavigationState === "function") {
    await store.syncNavigationState(normalizedId, {
      allowUnready: options.allowUnready !== false,
      attempts: Math.max(1, Number(options.attempts) || (FRAME_SYNC_ATTEMPTS + 2))
    });
  }

  return buildRuntimeBrowserWindowSnapshot(store.getBrowser(normalizedId));
}

async function performRuntimeBrowserRead(store, id, type, payload = null, options = {}) {
  const normalizedId = normalizeAgentBrowserId(id);
  const browserWindow = normalizedId ? store.getBrowser(normalizedId) : null;
  if (!browserWindow) {
    throw new Error(`Browser window "${String(id || "").trim()}" was not found.`);
  }

  if (typeof store.rememberBrowserInteraction === "function") {
    store.rememberBrowserInteraction(normalizedId, type);
  }

  await settleRuntimeBrowserWindowState(store, normalizedId, {
    attempts: options.syncAttempts,
    allowUnready: true,
    settleDelayMs: options.settleDelayMs
  });
  return sendBrowserFrameMessage(normalizedId, type, payload, options);
}

async function performRuntimeBrowserAction(store, id, actionType, perform, options = {}) {
  const normalizedId = normalizeAgentBrowserId(id);
  const browserWindow = normalizedId ? store.getBrowser(normalizedId) : null;
  if (!browserWindow) {
    throw new Error(`Browser window "${String(id || "").trim()}" was not found.`);
  }

  if (actionType && typeof store.rememberBrowserInteraction === "function") {
    store.rememberBrowserInteraction(normalizedId, actionType);
  }

  const beforeState = buildRuntimeBrowserWindowSnapshot(store.getBrowser(normalizedId));
  const action = await perform(normalizedId);
  const state = await settleRuntimeBrowserWindowState(store, normalizedId, {
    attempts: options.syncAttempts,
    allowUnready: true,
    navigationQuietMs: options.navigationQuietMs,
    navigationReadyTimeoutMs: options.navigationReadyTimeoutMs,
    navigationWaitMs: options.navigationWaitMs,
    settleDelayMs: options.settleDelayMs ?? FRAME_SYNC_DELAY_MS,
    waitForNavigation: options.waitForNavigation === true
  });

  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return state;
  }

  const status = {
    ...(action.status && typeof action.status === "object" ? action.status : {})
  };
  status.urlChanged = beforeState.currentUrl !== state.currentUrl;
  status.titleChanged = beforeState.title !== state.title;
  status.historyChanged = beforeState.canGoBack !== state.canGoBack
    || beforeState.canGoForward !== state.canGoForward;
  status.navigated = status.urlChanged || beforeState.frameSrc !== state.frameSrc;
  status.reacted = Object.entries(status).some(([key, value]) => key !== "reacted" && key !== "noObservedEffect" && value === true);
  status.noObservedEffect = !status.reacted;

  return {
    action: {
      ...action,
      status
    },
    state
  };
}

function ensureBrowserRuntimeNamespace(store) {
  const runtime = getRuntime();
  const previousNamespace = runtime.browser && typeof runtime.browser === "object" ? runtime.browser : {};
  const {
    current: _previousCurrent,
    get: _previousGet,
    sync: _previousSync,
    ...preservedNamespace
  } = previousNamespace;
  const requireWindowId = (id) => {
    const normalizedId = normalizeAgentBrowserId(id);
    if (!normalizedId || !store.getBrowser(normalizedId)) {
      throw new Error(`Browser window "${String(id || "").trim()}" was not found.`);
    }
    return normalizedId;
  };
  const openWindow = async (options = {}) => {
    const id = store.createWindow(normalizeCreateWindowOptions(options));
    store.rememberBrowserInteraction(id, "open");
    return settleRuntimeBrowserWindowState(store, id, {
      allowUnready: true,
      attempts: FRAME_SYNC_ATTEMPTS + 2,
      settleDelayMs: FRAME_SYNC_DELAY_MS
    });
  };
  const namespace = {
    ...preservedNamespace,
    back: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id) => {
      return performRuntimeBrowserAction(store, id, "history_back", (normalizedId) => {
        return store.goBack(normalizedId);
      }, {
        navigationQuietMs: FRAME_NAVIGATION_QUIET_MS,
        navigationReadyTimeoutMs: FRAME_NAVIGATION_READY_TIMEOUT_MS,
        navigationWaitMs: FRAME_NAVIGATION_WAIT_MS,
        waitForNavigation: true
      });
    }),
    click: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, referenceId) => {
      return performRuntimeBrowserAction(store, id, "click", async (normalizedId) => {
        await settleRuntimeBrowserWindowState(store, normalizedId, {
          attempts: 2,
          allowUnready: true
        });
        return await sendBrowserFrameMessage(normalizedId, "click", referenceId);
      });
    }),
    close: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id) => {
      const normalizedId = normalizeAgentBrowserId(id);

      if (!normalizedId) {
        return;
      }

      store.closeBrowser(normalizedId);
    }),
    closeAll: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, () => {
      const ids = store.getBrowserList().map((browserWindow) => browserWindow.id);

      ids.forEach((id) => {
        store.closeBrowser(id);
      });

      return ids.length;
    }),
    count: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, () => {
      return store.getBrowserList().length;
    }),
    content: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, payload = null, options = {}) => {
      return performRuntimeBrowserRead(store, id, "content", payload, options);
    }),
    create: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (options = {}) => {
      return openWindow(options);
    }),
    detail: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, referenceId, options = {}) => {
      return performRuntimeBrowserRead(store, id, "detail", referenceId, options);
    }),
    dom: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, payload = null, options = {}) => {
      return performRuntimeBrowserRead(store, id, "dom", payload, options);
    }),
    evaluate: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, scriptOrPayload = "", options = {}) => {
      const payload = typeof scriptOrPayload === "string"
        ? { script: scriptOrPayload }
        : scriptOrPayload;
      return performRuntimeBrowserRead(store, id, "evaluate", payload, options);
    }),
    focus: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, options = {}) => {
      const normalizedId = requireWindowId(id);
      store.rememberBrowserInteraction(normalizedId, "focus");
      store.focusBrowser(normalizedId, options);
      return settleRuntimeBrowserWindowState(store, normalizedId, {
        allowUnready: true,
        attempts: 1
      });
    }),
    forward: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id) => {
      return performRuntimeBrowserAction(store, id, "history_forward", (normalizedId) => {
        return store.goForward(normalizedId);
      }, {
        navigationQuietMs: FRAME_NAVIGATION_QUIET_MS,
        navigationReadyTimeoutMs: FRAME_NAVIGATION_READY_TIMEOUT_MS,
        navigationWaitMs: FRAME_NAVIGATION_WAIT_MS,
        waitForNavigation: true
      });
    }),
    has: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id) => {
      return Boolean(store.getBrowser(normalizeAgentBrowserId(id)));
    }),
    ids: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, () => {
      return store.getBrowserList().map((browserWindow) => toAgentBrowserId(browserWindow.id));
    }),
    list: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, () => {
      return store.getBrowserList().map((browserWindow) => buildRuntimeBrowserWindowSnapshot(browserWindow));
    }),
    navigate: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, url) => {
      return performRuntimeBrowserAction(store, id, "location_navigate", (normalizedId) => {
        store.updateAddressValue(normalizedId, String(url ?? ""));
        return store.navigateToAddress(normalizedId);
      }, {
        navigationQuietMs: FRAME_NAVIGATION_QUIET_MS,
        navigationReadyTimeoutMs: FRAME_NAVIGATION_READY_TIMEOUT_MS,
        navigationWaitMs: FRAME_NAVIGATION_WAIT_MS,
        waitForNavigation: true
      });
    }),
    open: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (options = {}) => {
      return openWindow(options);
    }),
    setLogLevel(level) {
      return setBrowserLogLevel(level);
    },
    reload: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id) => {
      return performRuntimeBrowserAction(store, id, "location_reload", (normalizedId) => {
        return store.reloadFrame(normalizedId);
      }, {
        navigationQuietMs: FRAME_NAVIGATION_QUIET_MS,
        navigationReadyTimeoutMs: FRAME_NAVIGATION_READY_TIMEOUT_MS,
        navigationWaitMs: FRAME_NAVIGATION_WAIT_MS,
        waitForNavigation: true
      });
    }),
    scroll: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, referenceId) => {
      return performRuntimeBrowserAction(store, id, "scroll", async (normalizedId) => {
        await settleRuntimeBrowserWindowState(store, normalizedId, {
          attempts: 2,
          allowUnready: true
        });
        return await sendBrowserFrameMessage(normalizedId, "scroll", referenceId);
      });
    }),
    send: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, type, payload = null, options = {}) => {
      const normalizedId = requireWindowId(id);
      if (shouldRememberAgentBrowserInteraction(type)) {
        store.rememberBrowserInteraction(normalizedId, type);
      }
      return sendBrowserFrameMessage(normalizedId, type, payload, options);
    }),
    state: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id) => {
      const normalizedId = requireWindowId(id);
      store.rememberBrowserInteraction(normalizedId, "state");
      return settleRuntimeBrowserWindowState(store, normalizedId, {
        allowUnready: true,
        attempts: FRAME_SYNC_ATTEMPTS + 2
      });
    }),
    submit: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, referenceId) => {
      return performRuntimeBrowserAction(store, id, "submit", async (normalizedId) => {
        await settleRuntimeBrowserWindowState(store, normalizedId, {
          attempts: 2,
          allowUnready: true
        });
        return await sendBrowserFrameMessage(normalizedId, "submit", referenceId);
      });
    }),
    type: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, referenceId, value = "") => {
      return performRuntimeBrowserAction(store, id, "type", async (normalizedId) => {
        await settleRuntimeBrowserWindowState(store, normalizedId, {
          attempts: 2,
          allowUnready: true
        });
        return await sendBrowserFrameMessage(normalizedId, "type", {
          referenceId,
          value
        });
      });
    }),
    typeSubmit: guardAgentFunction(AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY, (id, referenceId, value = "") => {
      return performRuntimeBrowserAction(store, id, "type_submit", async (normalizedId) => {
        await settleRuntimeBrowserWindowState(store, normalizedId, {
          attempts: 2,
          allowUnready: true
        });
        return await sendBrowserFrameMessage(normalizedId, "type_submit", {
          referenceId,
          value
        });
      });
    })
  };

  runtime.browser = namespace;
  return namespace;
}

function normalizeTypedBrowserLocation(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return "";
  }

  if (/^[a-z][a-z\d+\-.]*:\/\//iu.test(normalizedValue) || /^(about|blob|data|file|mailto|tel):/iu.test(normalizedValue)) {
    return resolveBrowserLocation(normalizedValue);
  }

  if (/^[/?#.]/u.test(normalizedValue)) {
    return resolveBrowserLocation(normalizedValue);
  }

  if (looksLikeTypedBrowserHost(normalizedValue)) {
    const protocol = looksLikeLocalBrowserHost(normalizedValue) ? "http://" : "https://";
    return resolveBrowserLocation(`${protocol}${normalizedValue}`);
  }

  return resolveBrowserLocation(`https://${normalizedValue}`);
}

function extractBrowserWindowOrdinal(id) {
  const match = String(id || "").trim().match(/^browser-(\d+)$/u);
  const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isBrowserWindowIdInUse(id, windows, root = globalThis.document) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) {
    return false;
  }

  if (windows.some((browserWindow) => browserWindow?.id === normalizedId)) {
    return true;
  }

  if (root?.getElementById?.(normalizedId)) {
    return true;
  }

  return Boolean(root?.getElementsByName?.(normalizedId)?.length);
}

function getNextBrowserWindowId(windows, root = globalThis.document) {
  const usedOrdinals = new Set(
    windows
      .map((browserWindow) => extractBrowserWindowOrdinal(browserWindow?.id))
      .filter((ordinal) => ordinal != null)
  );

  let nextOrdinal = 1;
  while (usedOrdinals.has(nextOrdinal) || isBrowserWindowIdInUse(`${BROWSER_WINDOW_ID_PREFIX}${nextOrdinal}`, windows, root)) {
    nextOrdinal += 1;
  }

  return `${BROWSER_WINDOW_ID_PREFIX}${nextOrdinal}`;
}

function readNavigationCapability(navigation, key) {
  return typeof navigation?.[key] === "boolean" ? navigation[key] : null;
}

function collectIframeFallbackState(iframe) {
  if (!iframe) {
    return null;
  }

  let canGoBack = false;
  let canGoForward = false;
  let loading = false;
  let title = "";
  let url = "";

  try {
    url = String(iframe.contentWindow?.location?.href || "");
    title = String(iframe.contentDocument?.title || "");
    loading = String(iframe.contentDocument?.readyState || "").toLowerCase() !== "complete";

    const navigation = iframe.contentWindow?.navigation;
    const navigationCanGoBack = readNavigationCapability(navigation, "canGoBack");
    const navigationCanGoForward = readNavigationCapability(navigation, "canGoForward");

    canGoBack = navigationCanGoBack == null
      ? Number(iframe.contentWindow?.history?.length || 0) > 1
      : navigationCanGoBack;
    canGoForward = navigationCanGoForward == null ? false : navigationCanGoForward;
  } catch {
    // Cross-origin iframes fall back to their exposed src attribute only.
  }

  const fallbackUrl = resolveBrowserLocation(iframe.src || iframe.getAttribute?.("src") || "");
  if (!url || (url === "about:blank" && fallbackUrl && fallbackUrl !== "about:blank")) {
    url = fallbackUrl;
  }

  return {
    canGoBack,
    canGoForward,
    loading,
    title,
    url
  };
}

function readImmediateBrowserNavigationState(store, id) {
  const webview = typeof store.getWebview === "function"
    ? store.getWebview(id)
    : null;
  if (webview) {
    return collectWebviewNavigationState(webview);
  }

  const iframe = typeof store.getIframe === "function"
    ? store.getIframe(id)
    : null;
  if (iframe) {
    return collectIframeFallbackState(iframe);
  }

  return null;
}

function createBrowserSurfaceState(id, options = {}) {
  const initialUrl = String(options.url || "").trim();
  const frameSrc = initialUrl
    ? normalizeTypedBrowserLocation(initialUrl)
    : resolveBrowserLocation(resolveDefaultFrameSrc());

  return {
    addressValue: frameSrc,
    bridgeHandlersReady: false,
    bridgeStateReady: false,
    bridgeTransportReady: false,
    canGoBack: false,
    canGoForward: false,
    currentUrl: frameSrc,
    frameSrc,
    id,
    instanceKey: getNextBrowserWindowInstanceKey(),
    isWindow: false,
    kind: String(options.kind || "surface").trim() || "surface",
    loading: false,
    title: ""
  };
}

function createBrowserWindowState(id, cascadeIndex = 0, options = {}) {
  const clampArea = getAvailableWindowArea();
  const spawnArea = getSpawnWindowArea();
  const size = getDefaultExpandedSize(spawnArea, clampArea);

  return {
    ...createBrowserSurfaceState(id, {
      ...options,
      kind: "window"
    }),
    isWindow: true,
    isMinimized: false,
    loading: false,
    position: getDefaultPosition(size, spawnArea, clampArea, cascadeIndex),
    size: { ...size },
    zIndex: getNextZIndex()
  };
}

const model = {
  browserSurfaces: [],
  frameConnections: Object.create(null),
  interaction: null,
  lastInteractedBrowserId: "",
  lastInteractedBrowserInstanceKey: null,
  offDesktopBrowserHostEvents: null,
  observedNavigationVersions: Object.create(null),
  pendingNavigations: Object.create(null),
  persistedWindowsWriteTimeoutId: null,
  syncTokens: Object.create(null),
  windows: [],

  mount() {
    ensureBrowserRuntimeNamespace(this);
    this.restorePersistedWindows();

    if (!this.offDesktopBrowserHostEvents) {
      this.offDesktopBrowserHostEvents = bindDesktopBrowserHostEvents({
        onFocus: (id) => {
          if (id) {
            this.rememberBrowserInteraction(id, "focus");
            this.focusBrowser(id, {
              fromBrowserSurface: true
            });
          }
        },
        onOpenWindow: (event) => {
          const url = String(event?.url || "").trim();
          this.createWindow(url ? { url } : {});
        }
      });
    }

    this.fitWindowsToViewport({
      persist: false
    });
  },

  unmount() {
    this.stopPointer();
    this.persistWindowsNow();

    if (typeof this.offDesktopBrowserHostEvents === "function") {
      this.offDesktopBrowserHostEvents();
    }

    this.offDesktopBrowserHostEvents = null;
  },

  fitWindowsToViewport(options = {}) {
    this.windows.forEach((browserWindow) => {
      this.ensureWindowGeometry(browserWindow);
    });

    if (this.usesNativeDesktopSurface && options.syncSurfaces !== false) {
      syncAllBrowserSurfaces();
    }

    if (options.persist !== false) {
      this.schedulePersistedWindowsWrite(options.persistDelayMs);
    }
  },

  schedulePersistedWindowsWrite(delayMs = PERSISTED_BROWSER_WINDOWS_WRITE_DELAY_MS) {
    if (this.persistedWindowsWriteTimeoutId != null) {
      globalThis.clearTimeout?.(this.persistedWindowsWriteTimeoutId);
      this.persistedWindowsWriteTimeoutId = null;
    }

    const normalizedDelayMs = Math.max(0, Number(delayMs) || 0);
    if (normalizedDelayMs === 0) {
      this.persistWindowsNow();
      return;
    }

    this.persistedWindowsWriteTimeoutId = globalThis.setTimeout(() => {
      this.persistedWindowsWriteTimeoutId = null;
      this.persistWindowsNow();
    }, normalizedDelayMs);
  },

  persistWindowsNow() {
    if (this.persistedWindowsWriteTimeoutId != null) {
      globalThis.clearTimeout?.(this.persistedWindowsWriteTimeoutId);
      this.persistedWindowsWriteTimeoutId = null;
    }

    const storage = getBrowserWindowStorage();
    if (!storage) {
      return false;
    }

    const snapshots = this.windows
      .map((browserWindow) => buildPersistedBrowserWindowSnapshot(browserWindow))
      .filter(Boolean);

    try {
      if (!snapshots.length) {
        storage.removeItem(PERSISTED_BROWSER_WINDOWS_STORAGE_KEY);
        return true;
      }

      storage.setItem(PERSISTED_BROWSER_WINDOWS_STORAGE_KEY, JSON.stringify(snapshots));
      return true;
    } catch {
      return false;
    }
  },

  restorePersistedWindows() {
    if (this.windows.length > 0) {
      return false;
    }

    const storage = getBrowserWindowStorage();
    if (!storage) {
      return false;
    }

    const persistedWindows = parsePersistedBrowserWindows(
      storage.getItem(PERSISTED_BROWSER_WINDOWS_STORAGE_KEY)
    );
    if (!persistedWindows.length) {
      return false;
    }

    const restoredIds = new Set();
    const restoredWindows = [];

    persistedWindows.forEach((entry, index) => {
      const storedId = String(entry?.id || "").trim();
      const browserId = storedId && !restoredIds.has(storedId)
        ? storedId
        : getNextBrowserWindowId([...this.getBrowserList(), ...restoredWindows], globalThis.document);
      restoredIds.add(browserId);

      const restoredUrl = normalizeTypedBrowserLocation(entry?.url)
        || resolveBrowserLocation(resolveDefaultFrameSrc());
      const browserWindow = createBrowserWindowState(browserId, index, {
        url: restoredUrl
      });

      browserWindow.isMinimized = entry?.isMinimized === true;
      browserWindow.instanceKey = Math.max(1, roundPx(entry?.instanceKey, browserWindow.instanceKey));
      browserWindow.position = {
        x: roundPx(entry?.position?.x, browserWindow.position.x),
        y: roundPx(entry?.position?.y, browserWindow.position.y)
      };
      browserWindow.size = {
        height: roundPx(entry?.size?.height, browserWindow.size.height),
        width: roundPx(entry?.size?.width, browserWindow.size.width)
      };
      browserWindow.zIndex = Math.max(1, roundPx(entry?.zIndex, browserWindow.zIndex));

      restoredWindows.push(browserWindow);
    });

    if (!restoredWindows.length) {
      storage.removeItem(PERSISTED_BROWSER_WINDOWS_STORAGE_KEY);
      return false;
    }

    this.windows = restoredWindows;
    this.browserSurfaces = mergeBrowserSurfaceEntries(this.browserSurfaces, restoredWindows);
    syncBrowserWindowCounters(restoredWindows);
    this.fitWindowsToViewport({
      persistDelayMs: 0,
      syncSurfaces: false
    });
    return true;
  },

  get hasOpenWindows() {
    return this.windows.length > 0;
  },

  get hasOpenBrowsers() {
    return this.getBrowserList().length > 0;
  },

  get usesNativeDesktopSurface() {
    return usesNativeDesktopBrowser();
  },

  get usesDesktopWebviewSurface() {
    return usesDesktopBrowserWebview();
  },

  getWindow(id) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return null;
    }

    return this.windows.find((browserWindow) => browserWindow.id === normalizedId) || null;
  },

  getBrowserList() {
    const surfaces = Array.isArray(this.browserSurfaces) ? this.browserSurfaces : [];
    return surfaces.length ? surfaces : this.windows;
  },

  getBrowser(id) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return null;
    }

    return this.getBrowserList().find((browserWindow) => browserWindow.id === normalizedId)
      || this.getWindow(normalizedId);
  },

  getIframe(id) {
    const connection = this.frameConnections[String(id || "").trim()];
    if (connection?.iframe) {
      return connection.iframe;
    }

    const element = globalThis.document?.getElementById?.(String(id || "").trim());
    return String(element?.tagName || "").toUpperCase() === "IFRAME" ? element : null;
  },

  getWebview(id) {
    const connection = this.frameConnections[String(id || "").trim()];
    if (connection?.webview) {
      return connection.webview;
    }

    const element = globalThis.document?.getElementById?.(String(id || "").trim());
    return isWebviewLike(element) ? element : null;
  },

  getObservedNavigationVersion(id) {
    return Number(this.observedNavigationVersions[String(id || "").trim()] || 0);
  },

  markNavigationObserved(id) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return 0;
    }

    const nextVersion = this.getObservedNavigationVersion(normalizedId) + 1;
    this.observedNavigationVersions[normalizedId] = nextVersion;
    delete this.pendingNavigations[normalizedId];
    return nextVersion;
  },

  startPendingNavigation(id) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return;
    }

    this.pendingNavigations[normalizedId] = {
      observedVersion: this.getObservedNavigationVersion(normalizedId)
    };
  },

  clearPendingNavigation(id) {
    delete this.pendingNavigations[String(id || "").trim()];
  },

  hasUnobservedPendingNavigation(id) {
    const normalizedId = String(id || "").trim();
    const pendingNavigation = this.pendingNavigations[normalizedId];
    if (!pendingNavigation) {
      return false;
    }

    return this.getObservedNavigationVersion(normalizedId) === Number(pendingNavigation.observedVersion || 0);
  },

  collectImmediateNavigationState(id) {
    return readImmediateBrowserNavigationState(this, id);
  },

  webviewPartition(id) {
    return getDesktopBrowserWebviewPartition(id);
  },

  allocateBrowserSurfaceId(preferredId = "") {
    const normalizedPreferredId = String(preferredId || "").trim();
    const preferredElement = normalizedPreferredId ? browserSurfaceElements.get(normalizedPreferredId) : null;

    if (
      normalizedPreferredId &&
      !this.getBrowser(normalizedPreferredId) &&
      !preferredElement &&
      !isBrowserWindowIdInUse(normalizedPreferredId, this.getBrowserList(), globalThis.document)
    ) {
      return normalizedPreferredId;
    }

    return getNextBrowserWindowId(this.getBrowserList(), globalThis.document);
  },

  registerBrowserElement(element, options = {}) {
    if (!element) {
      return null;
    }

    const previousId = browserElementIds.get(element) || "";
    const requestedId = String(element.dataset?.browserId || element.getAttribute?.("data-browser-id") || previousId || "").trim();
    const existingElement = requestedId ? browserSurfaceElements.get(requestedId) : null;
    const shouldReuseRequestedId = requestedId
      && (!existingElement || existingElement === element || !existingElement.isConnected);
    const id = shouldReuseRequestedId ? requestedId : this.allocateBrowserSurfaceId(requestedId);
    const sourceUrl = String(options.src ?? element.getAttribute?.("src") ?? "").trim();
    let browserSurface = this.getBrowser(id);

    if (!browserSurface) {
      browserSurface = createBrowserSurfaceState(id, {
        kind: "element",
        url: sourceUrl
      });
      this.browserSurfaces = mergeBrowserSurfaceEntries(this.browserSurfaces, [browserSurface]);
      syncBrowserWindowCounters(this.getBrowserList());
    } else if (!this.getBrowserList().some((entry) => entry.id === browserSurface.id)) {
      this.browserSurfaces = mergeBrowserSurfaceEntries(this.browserSurfaces, [browserSurface]);
    }

    if (previousId && previousId !== id && browserSurfaceElements.get(previousId) === element) {
      browserSurfaceElements.delete(previousId);
      if (!this.getWindow(previousId)) {
        this.removeBrowserSurface(previousId);
      }
    }

    if (sourceUrl && (!browserSurface.currentUrl || browserSurface.currentUrl === resolveBrowserLocation(resolveDefaultFrameSrc()))) {
      const normalizedSourceUrl = normalizeTypedBrowserLocation(sourceUrl);
      if (normalizedSourceUrl) {
        browserSurface.addressValue = normalizedSourceUrl;
        browserSurface.currentUrl = normalizedSourceUrl;
        browserSurface.frameSrc = normalizedSourceUrl;
      }
    }

    browserElementIds.set(element, id);
    browserSurfaceElements.set(id, element);
    if (element.dataset?.browserId !== id) {
      element.dataset.browserId = id;
    }
    return browserSurface;
  },

  unregisterBrowserElement(element) {
    if (!element) {
      return false;
    }

    const id = browserElementIds.get(element) || String(element.dataset?.browserId || element.getAttribute?.("data-browser-id") || "").trim();
    if (!id) {
      return false;
    }

    if (browserSurfaceElements.get(id) === element) {
      browserSurfaceElements.delete(id);
    }

    browserElementIds.delete(element);

    if (this.getWindow(id)) {
      this.unregisterBrowserSurface(id, element);
      this.unregisterWebview(id);
      this.unregisterIframe(id);
      return true;
    }

    this.removeBrowserSurface(id);
    return true;
  },

  updateBrowserElementSource(element, src) {
    const id = browserElementIds.get(element) || String(element?.dataset?.browserId || element?.getAttribute?.("data-browser-id") || "").trim();
    const browserSurface = id ? this.getBrowser(id) : this.registerBrowserElement(element, { src });
    const normalizedUrl = normalizeTypedBrowserLocation(src);

    if (!browserSurface || !normalizedUrl) {
      return false;
    }

    if (browserSurface.currentUrl === normalizedUrl && browserSurface.frameSrc === normalizedUrl) {
      return true;
    }

    browserSurface.addressValue = normalizedUrl;
    void this.navigateToAddress(browserSurface.id);
    return true;
  },

  notifyBrowserElementState(id) {
    const normalizedId = String(id || "").trim();
    const browserSurface = this.getBrowser(normalizedId);
    const element = browserSurfaceElements.get(normalizedId);
    element?.updateBrowserState?.(browserSurface);
  },

  rememberBrowserInteraction(id, type = "") {
    const normalizedId = String(id || "").trim();
    const browserWindow = normalizedId ? this.getBrowser(normalizedId) : null;
    if (!browserWindow) {
      return;
    }

    this.lastInteractedBrowserId = normalizedId;
    this.lastInteractedBrowserInstanceKey = browserWindow.instanceKey ?? null;
  },

  nextSyncToken(id) {
    const normalizedId = String(id || "").trim();
    const nextToken = (Number(this.syncTokens[normalizedId]) || 0) + 1;
    this.syncTokens[normalizedId] = nextToken;
    return nextToken;
  },

  createWindow(options = {}) {
    const id = getNextBrowserWindowId(this.getBrowserList());
    const browserWindow = createBrowserWindowState(id, this.windows.length, options);

    this.windows = [...this.windows, browserWindow];
    this.browserSurfaces = mergeBrowserSurfaceEntries(this.browserSurfaces, [browserWindow]);
    this.focusWindow(id, {
      persist: false
    });
    this.persistWindowsNow();

    return id;
  },

  openFromMenu() {
    return this.createWindow();
  },

  focusWindow(id, options = {}) {
    const browserWindow = this.getWindow(id);
    if (!browserWindow) {
      return;
    }

    browserWindow.zIndex = getNextZIndex();

    if (this.usesNativeDesktopSurface && !options.fromBrowserSurface && options.focusSurface !== false) {
      focusBrowserSurface(browserWindow.id);
    }

    if (this.usesNativeDesktopSurface) {
      syncDesktopBrowserSurface(browserWindow.id);
    }

    if (options.persist !== false) {
      this.schedulePersistedWindowsWrite();
    }
  },

  focusBrowser(id, options = {}) {
    const normalizedId = String(id || "").trim();
    const browserWindow = this.getWindow(normalizedId);
    if (browserWindow) {
      this.focusWindow(normalizedId, options);
      return;
    }

    const webview = this.getWebview(normalizedId);
    if (webview) {
      focusWebview(webview);
      return;
    }

    if (this.usesNativeDesktopSurface && options.focusSurface !== false) {
      focusBrowserSurface(normalizedId);
    }
  },

  handleWindowPointerDown(id, event) {
    const target = event?.target;
    const shouldKeepChromeFocus = target instanceof Element
      && Boolean(target.closest(".web-browsing-window-toolbar, .space-browser-toolbar"));

    this.focusWindow(id, {
      focusSurface: !shouldKeepChromeFocus
    });
  },

  ensureWindowGeometry(browserWindow) {
    if (!browserWindow) {
      return;
    }

    const area = getAvailableWindowArea();
    const bounds = getExpandedSizeBounds(area);

    browserWindow.size = {
      height: clamp(roundPx(browserWindow.size?.height, bounds.maxHeight), bounds.minHeight, bounds.maxHeight),
      width: clamp(roundPx(browserWindow.size?.width, bounds.maxWidth), bounds.minWidth, bounds.maxWidth)
    };
    browserWindow.position = clampPosition(browserWindow.position, this.getPanelSize(browserWindow), area);
  },

  getPanelSize(browserWindow) {
    if (!browserWindow) {
      return {
        height: WINDOW_MINIMIZED_HEIGHT,
        width: getMinimizedWidthPx()
      };
    }

    const area = getAvailableWindowArea();
    const bounds = getExpandedSizeBounds(area);
    const expandedSize = {
      height: clamp(roundPx(browserWindow.size?.height, bounds.maxHeight), bounds.minHeight, bounds.maxHeight),
      width: clamp(roundPx(browserWindow.size?.width, bounds.maxWidth), bounds.minWidth, bounds.maxWidth)
    };

    if (browserWindow.isMinimized) {
      return {
        height: Math.min(WINDOW_MINIMIZED_HEIGHT, area.height),
        width: clamp(getMinimizedWidthPx(), Math.min(bounds.minWidth, bounds.maxWidth), bounds.maxWidth)
      };
    }

    return expandedSize;
  },

  removeBrowserSurface(id) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return false;
    }

    this.unregisterBrowserSurface(normalizedId);
    this.unregisterWebview(normalizedId);
    this.unregisterIframe(normalizedId);
    delete this.observedNavigationVersions[normalizedId];
    delete this.pendingNavigations[normalizedId];
    delete this.syncTokens[normalizedId];
    browserSurfaceElements.delete(normalizedId);
    this.browserSurfaces = this.getBrowserList().filter((entry) => entry.id !== normalizedId);

    if (this.lastInteractedBrowserId === normalizedId) {
      this.lastInteractedBrowserId = "";
      this.lastInteractedBrowserInstanceKey = null;
    }

    return true;
  },

  closeBrowser(id) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return false;
    }

    if (this.getWindow(normalizedId)) {
      this.closeWindow(normalizedId);
      return true;
    }

    const element = browserSurfaceElements.get(normalizedId);
    this.removeBrowserSurface(normalizedId);
    element?.remove?.();
    return true;
  },

  closeWindow(id) {
    const browserWindow = this.getWindow(id);
    if (!browserWindow) {
      return;
    }

    if (this.interaction?.windowId === browserWindow.id) {
      this.stopPointer();
    }

    this.removeBrowserSurface(browserWindow.id);
    this.windows = this.windows.filter((entry) => entry.id !== browserWindow.id);
    this.persistWindowsNow();
  },

  toggleMinimized(id) {
    const browserWindow = this.getWindow(id);
    if (!browserWindow) {
      return;
    }

    this.stopPointer();
    this.focusWindow(id);

    const area = getAvailableWindowArea();
    const previousSize = this.getPanelSize(browserWindow);

    browserWindow.isMinimized = !browserWindow.isMinimized;
    this.ensureWindowGeometry(browserWindow);

    const nextSize = this.getPanelSize(browserWindow);
    browserWindow.position = getRightAnchoredPosition(browserWindow.position, previousSize, nextSize, area);
    if (this.usesNativeDesktopSurface) {
      syncDesktopBrowserSurface(browserWindow.id);
    }
    this.persistWindowsNow();
  },

  handleViewportResize() {
    this.fitWindowsToViewport({
      persistDelayMs: 0
    });
  },

  startDrag(id, event) {
    const browserWindow = this.getWindow(id);
    if (!browserWindow || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.focusWindow(id);

    const interaction = {
      captureTarget: event.currentTarget,
      originPosition: { ...browserWindow.position },
      panelSize: this.getPanelSize(browserWindow),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      type: "drag",
      windowId: browserWindow.id
    };

    interaction.captureTarget?.setPointerCapture?.(event.pointerId);
    this.interaction = interaction;
  },

  startResize(id, event) {
    const browserWindow = this.getWindow(id);
    if (!browserWindow || browserWindow.isMinimized || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.focusWindow(id);

    const bounds = getExpandedSizeBounds();
    const interaction = {
      captureTarget: event.currentTarget,
      originSize: {
        height: clamp(roundPx(browserWindow.size?.height, bounds.maxHeight), bounds.minHeight, bounds.maxHeight),
        width: clamp(roundPx(browserWindow.size?.width, bounds.maxWidth), bounds.minWidth, bounds.maxWidth)
      },
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      type: "resize",
      windowId: browserWindow.id
    };

    interaction.captureTarget?.setPointerCapture?.(event.pointerId);
    this.interaction = interaction;
  },

  handlePointerMove(event) {
    const interaction = this.interaction;

    if (!interaction || event.pointerId !== interaction.pointerId) {
      return;
    }

    const browserWindow = this.getWindow(interaction.windowId);
    if (!browserWindow) {
      this.stopPointer(event);
      return;
    }

    event.preventDefault();

    if (interaction.type === "drag") {
      browserWindow.position = clampPosition({
        x: interaction.originPosition.x + (event.clientX - interaction.startX),
        y: interaction.originPosition.y + (event.clientY - interaction.startY)
      }, interaction.panelSize);
      if (this.usesNativeDesktopSurface) {
        syncDesktopBrowserSurface(browserWindow.id);
      }
      this.schedulePersistedWindowsWrite();
      return;
    }

    const bounds = getExpandedSizeBounds();
    browserWindow.size = {
      height: Math.round(clamp(interaction.originSize.height + (event.clientY - interaction.startY), bounds.minHeight, bounds.maxHeight)),
      width: Math.round(clamp(interaction.originSize.width + (event.clientX - interaction.startX), bounds.minWidth, bounds.maxWidth))
    };
    browserWindow.position = clampPosition(browserWindow.position, this.getPanelSize(browserWindow));
    if (this.usesNativeDesktopSurface) {
      syncDesktopBrowserSurface(browserWindow.id);
    }
    this.schedulePersistedWindowsWrite();
  },

  stopPointer(event) {
    const interaction = this.interaction;

    if (!interaction) {
      return;
    }

    if (event && interaction.pointerId !== event.pointerId) {
      return;
    }

    const browserWindow = this.getWindow(interaction.windowId);

    releasePointerCapture(interaction);
    this.interaction = null;

    if (browserWindow) {
      this.ensureWindowGeometry(browserWindow);
      if (this.usesNativeDesktopSurface) {
        syncDesktopBrowserSurface(browserWindow.id);
      }
      this.persistWindowsNow();
    }
  },

  panelStyle(id) {
    const browserWindow = this.getWindow(id);
    if (!browserWindow) {
      return {};
    }

    const panelSize = this.getPanelSize(browserWindow);

    return {
      height: `${panelSize.height}px`,
      left: `${browserWindow.position.x}px`,
      top: `${browserWindow.position.y}px`,
      width: `${panelSize.width}px`,
      zIndex: String(browserWindow.zIndex)
    };
  },

  registerIframe(id, iframe) {
    const browserSurface = this.getBrowser(id);
    if (!browserSurface || !iframe) {
      return;
    }

    this.unregisterIframe(id);

    let bridge = null;
    let offNavigationState = null;
    let offOpenWindow = null;

    try {
      bridge = getBrowserFrameBridge(id);
      offNavigationState = bridge.on("navigation_state", (message) => {
        this.applyNavigationState(id, message.payload, { fromBridge: true });
      });
      offOpenWindow = bridge.on("open_window", (message) => {
        const url = String(message?.payload?.url || "").trim();
        this.createWindow(url ? { url } : {});
      });
    } catch {
      // The host bridge remains optional outside packaged desktop runs.
    }

    const handleIframeFocus = () => {
      this.rememberBrowserInteraction(id, "focus");
      this.focusBrowser(id, {
        fromBrowserSurface: true
      });
    };
    const iframeInteractionListeners = [
      ["pointerdown", handleIframeFocus],
      ["mousedown", handleIframeFocus],
      ["focus", handleIframeFocus]
    ];

    iframeInteractionListeners.forEach(([eventName, handler]) => {
      iframe.addEventListener?.(eventName, handler);
    });

    this.frameConnections[browserSurface.id] = {
      bridge,
      iframe,
      offNavigationState,
      offOpenWindow,
      offIframeEvents() {
        iframeInteractionListeners.forEach(([eventName, handler]) => {
          iframe.removeEventListener?.(eventName, handler);
        });
      },
      webview: null
    };

    this.applyNavigationState(id, collectIframeFallbackState(iframe));
    void this.syncNavigationState(id);
  },

  registerBrowserSurface(id, element) {
    const browserSurface = this.getBrowser(id);
    if (!browserSurface || !element || !this.usesNativeDesktopSurface) {
      return;
    }

    this.unregisterIframe(id);

    let bridge = null;
    let offNavigationState = null;
    let offOpenWindow = null;

    try {
      bridge = getBrowserFrameBridge(id);
      offNavigationState = bridge.on("navigation_state", (message) => {
        this.applyNavigationState(id, message.payload, { fromBridge: true });
      });
      offOpenWindow = bridge.on("open_window", (message) => {
        const url = String(message?.payload?.url || "").trim();
        this.createWindow(url ? { url } : {});
      });
    } catch {
      // The host bridge remains optional while the native view is still initializing.
    }

    this.frameConnections[browserSurface.id] = {
      bridge,
      iframe: null,
      offNavigationState,
      offOpenWindow,
      webview: null
    };

    registerDesktopBrowserSurface(browserSurface.id, element, {
      injectPath: BROWSER_INJECT_PATH,
      url: browserSurface.currentUrl || browserSurface.frameSrc
    });

    void this.syncNavigationState(id, { attempts: FRAME_SYNC_ATTEMPTS + 3 });
  },

  registerWebview(id, webview, initialUrl = "") {
    const browserSurface = this.getBrowser(id);
    if (!browserSurface || !isWebviewLike(webview)) {
      return;
    }

    const stabilizeEmbedder = () => {
      stabilizeWebviewEmbedder(webview);
      globalThis.requestAnimationFrame?.(() => {
        stabilizeWebviewEmbedder(webview);
      });
    };

    stabilizeEmbedder();

    this.unregisterIframe(id);
    this.unregisterWebview(id);

    const normalizedInitialUrl = resolveBrowserLocation(
      initialUrl || browserSurface.currentUrl || browserSurface.frameSrc || DEFAULT_FRAME_SRC
    );
    const runtimeState = {
      attached: false,
      injected: false
    };

    if (normalizedInitialUrl) {
      browserSurface.addressValue = normalizedInitialUrl;
      browserSurface.currentUrl = normalizedInitialUrl;
      browserSurface.frameSrc = normalizedInitialUrl;
    }

    let bridge = null;
    let offNavigationState = null;
    let offOpenWindow = null;
    let offPreloadReady = null;
    let offPreloadReceived = null;
    let offBridgeReady = null;
    let offCoreHandlersReady = null;

    try {
      bridge = getBrowserFrameBridge(id);
      offNavigationState = bridge.on("navigation_state", (message) => {
        this.applyNavigationState(id, message.payload, { fromBridge: true });
      });
      offOpenWindow = bridge.on("open_window", (message) => {
        const url = String(message?.payload?.url || "").trim();
        this.createWindow(url ? { url } : {});
      });
      offPreloadReady = bridge.on("__preload_ready__", (message) => {
        browserSurface.bridgeTransportReady = true;
        logBrowser("debug", `[space-browser] Guest preload ready for ${browserSurface.id}.`, message.payload);
      });
      offPreloadReceived = bridge.on("__preload_received__", (message) => {
        browserSurface.bridgeTransportReady = true;
        logBrowser("debug", `[space-browser] Guest preload received host envelope for ${browserSurface.id}.`, message.payload);
      });
      offBridgeReady = bridge.on("__bridge_ready__", (message) => {
        browserSurface.bridgeTransportReady = true;
        browserSurface.bridgeStateReady = false;
        logBrowser("debug", `[space-browser] Guest bridge runtime ready for ${browserSurface.id}.`, message.payload);
      });
      offCoreHandlersReady = bridge.on("__core_handlers_ready__", (message) => {
        browserSurface.bridgeTransportReady = true;
        browserSurface.bridgeHandlersReady = true;
        logBrowser("debug", `[space-browser] Guest core handlers ready for ${browserSurface.id}.`, message.payload);
        void this.syncNavigationState(id, {
          attempts: 2
        });
      });
    } catch {
      // The guest bridge may not be ready until the first preload runs.
    }

    const syncState = (fallbackUrl = normalizedInitialUrl) => {
      const state = runtimeState.attached
        ? collectWebviewNavigationState(webview)
        : {
            url: resolveBrowserLocation(fallbackUrl || browserSurface.currentUrl || browserSurface.frameSrc || "")
          };
      this.applyNavigationState(id, state);
    };
    const ensureInitialSrc = () => {
      stabilizeEmbedder();

      const nextUrl = resolveBrowserLocation(
        browserSurface.currentUrl || browserSurface.frameSrc || normalizedInitialUrl || DEFAULT_FRAME_SRC
      );
      if (!nextUrl) {
        return;
      }

      const currentSrc = resolveBrowserLocation(webview.getAttribute?.("src") || webview.src || "");
      if (currentSrc === nextUrl) {
        return;
      }

      webview.setAttribute("src", nextUrl);
    };
    const handleDidAttach = () => {
      runtimeState.attached = true;
      stabilizeEmbedder();
      ensureInitialSrc();
      syncState();
    };
    const handleDidStartLoading = () => {
      browserSurface.bridgeHandlersReady = false;
      browserSurface.bridgeStateReady = false;
      browserSurface.bridgeTransportReady = false;
      browserSurface.loading = true;
      runtimeState.injected = false;
      this.markNavigationObserved(id);
      stabilizeEmbedder();
      syncState();
    };
    const handleDidStopLoading = () => {
      browserSurface.loading = false;
      stabilizeEmbedder();
      syncState();
      if (browserSurface.bridgeHandlersReady) {
        void this.syncNavigationState(id, { attempts: 2 });
      }
    };
    const handleDidNavigate = () => {
      this.markNavigationObserved(id);
      stabilizeEmbedder();
      syncState();
    };
    const handleTitleUpdated = () => {
      stabilizeEmbedder();
      syncState();
    };
    const handleSurfaceFocus = () => {
      this.rememberBrowserInteraction(id, "focus");
      this.focusBrowser(id, {
        fromBrowserSurface: true
      });
      focusWebview(webview);
    };
    const handleDomReady = () => {
      runtimeState.attached = true;
      stabilizeEmbedder();
      focusWebview(webview);
      if (runtimeState.injected) {
        syncState();
        if (browserSurface.bridgeHandlersReady) {
          void this.syncNavigationState(id, { attempts: 2 });
        }
        return;
      }

      runtimeState.injected = true;
      void injectBrowserWebviewRuntime(webview, {
        browserId: browserSurface.id,
        injectPath: BROWSER_INJECT_PATH
      }).then(() => {
        syncState();
        return true;
      }).catch((error) => {
        logBrowser("error", `[space-browser] Failed to inject browser runtime into ${browserSurface.id}.`, error);
        runtimeState.injected = false;
        syncState();
      });
    };

    const handleConsoleMessage = (event) => {
      const messageText = String(event?.message || "");
      if (!messageText.includes("[space-browser") && !messageText.includes("[space-desktop/browser-webview-preload]")) {
        return;
      }

      const level = Number(event?.level);
      const payload = {
        browserId: browserSurface.id,
        line: Number(event?.line) || 0,
        sourceId: String(event?.sourceId || "")
      };
      logBrowser(browserConsoleEventLevelToLogLevel(level), messageText, payload);
    };

    const webviewListeners = [
      ["did-attach", handleDidAttach],
      ["did-start-loading", handleDidStartLoading],
      ["did-stop-loading", handleDidStopLoading],
      ["did-navigate", handleDidNavigate],
      ["did-navigate-in-page", handleDidNavigate],
      ["page-title-updated", handleTitleUpdated],
      ["dom-ready", handleDomReady],
      ["console-message", handleConsoleMessage],
      ["pointerdown", handleSurfaceFocus],
      ["mousedown", handleSurfaceFocus],
      ["focus", handleSurfaceFocus]
    ];

    webviewListeners.forEach(([eventName, handler]) => {
      webview.addEventListener(eventName, handler);
    });

    this.frameConnections[browserSurface.id] = {
      bridge,
      iframe: null,
      offBridgeReady,
      offCoreHandlersReady,
      offNavigationState,
      offOpenWindow,
      offPreloadReady,
      offPreloadReceived,
      offWebviewEvents() {
        webviewListeners.forEach(([eventName, handler]) => {
          webview.removeEventListener(eventName, handler);
        });
      },
      webview
    };

    syncState(normalizedInitialUrl);
    ensureInitialSrc();
  },

  unregisterBrowserSurface(id, element = null) {
    unregisterDesktopBrowserSurface(id, element);

    const normalizedId = String(id || "").trim();
    const connection = this.frameConnections[normalizedId];
    if (!connection || connection.iframe) {
      return;
    }

    if (typeof connection.offNavigationState === "function") {
      connection.offNavigationState();
    }

    if (typeof connection.offOpenWindow === "function") {
      connection.offOpenWindow();
    }

    if (typeof connection.offPreloadReady === "function") {
      connection.offPreloadReady();
    }

    if (typeof connection.offPreloadReceived === "function") {
      connection.offPreloadReceived();
    }

    if (typeof connection.offBridgeReady === "function") {
      connection.offBridgeReady();
    }

    if (typeof connection.offCoreHandlersReady === "function") {
      connection.offCoreHandlersReady();
    }

    if (typeof connection.offIframeEvents === "function") {
      connection.offIframeEvents();
    }

    connection.bridge?.destroy?.();
    delete this.frameConnections[normalizedId];
    delete this.pendingNavigations[normalizedId];
    delete this.syncTokens[normalizedId];
  },

  unregisterWebview(id, webview = null) {
    const normalizedId = String(id || "").trim();
    const connection = this.frameConnections[normalizedId];
    if (!connection?.webview) {
      return;
    }

    if (webview && connection.webview !== webview) {
      return;
    }

    if (typeof connection.offNavigationState === "function") {
      connection.offNavigationState();
    }

    if (typeof connection.offOpenWindow === "function") {
      connection.offOpenWindow();
    }

    if (typeof connection.offPreloadReady === "function") {
      connection.offPreloadReady();
    }

    if (typeof connection.offPreloadReceived === "function") {
      connection.offPreloadReceived();
    }

    if (typeof connection.offBridgeReady === "function") {
      connection.offBridgeReady();
    }

    if (typeof connection.offCoreHandlersReady === "function") {
      connection.offCoreHandlersReady();
    }

    if (typeof connection.offWebviewEvents === "function") {
      connection.offWebviewEvents();
    }

    releaseWebviewEmbedder(connection.webview);
    connection.bridge?.destroy?.();
    delete this.frameConnections[normalizedId];
    delete this.pendingNavigations[normalizedId];
    delete this.syncTokens[normalizedId];
  },

  unregisterIframe(id, iframe = null) {
    const normalizedId = String(id || "").trim();
    const connection = this.frameConnections[normalizedId];

    if (!connection) {
      return;
    }

    if (iframe && connection.iframe && connection.iframe !== iframe) {
      return;
    }

    if (typeof connection.offNavigationState === "function") {
      connection.offNavigationState();
    }

    if (typeof connection.offOpenWindow === "function") {
      connection.offOpenWindow();
    }

    if (typeof connection.offPreloadReady === "function") {
      connection.offPreloadReady();
    }

    if (typeof connection.offPreloadReceived === "function") {
      connection.offPreloadReceived();
    }

    if (typeof connection.offBridgeReady === "function") {
      connection.offBridgeReady();
    }

    if (typeof connection.offCoreHandlersReady === "function") {
      connection.offCoreHandlersReady();
    }

    if (typeof connection.offIframeEvents === "function") {
      connection.offIframeEvents();
    }

    connection.bridge?.destroy?.();
    delete this.frameConnections[normalizedId];
    delete this.pendingNavigations[normalizedId];
    delete this.syncTokens[normalizedId];
  },

  applyNavigationState(id, state, options = {}) {
    const browserSurface = this.getBrowser(id);
    if (!browserSurface || !state || typeof state !== "object") {
      return;
    }

    if (options.fromBridge && this.hasUnobservedPendingNavigation(id)) {
      return;
    }

    const resolvedUrl = resolveBrowserLocation(state.url || browserSurface.currentUrl || browserSurface.frameSrc || "");
    if (resolvedUrl) {
      browserSurface.addressValue = resolvedUrl;
      browserSurface.currentUrl = resolvedUrl;
      browserSurface.frameSrc = resolvedUrl;
    }

    if (typeof state.canGoBack === "boolean") {
      browserSurface.canGoBack = state.canGoBack;
    }

    if (typeof state.canGoForward === "boolean") {
      browserSurface.canGoForward = state.canGoForward;
    }

    if (typeof state.loading === "boolean") {
      browserSurface.loading = state.loading;
    }

    if ("title" in state) {
      browserSurface.title = String(state.title || "").trim();
    }

    if (options.fromBridge) {
      browserSurface.bridgeHandlersReady = true;
      browserSurface.bridgeStateReady = true;
      browserSurface.bridgeTransportReady = true;
    }

    this.notifyBrowserElementState(id);
    if (browserSurface.isWindow) {
      this.schedulePersistedWindowsWrite();
    }
  },

  async requestBridgePayload(id, type, payload = null, options = {}) {
    const normalizedId = String(id || "").trim();
    const connection = this.frameConnections[normalizedId];
    const bridge = connection?.bridge;

    if (!bridge) {
      return null;
    }

    try {
      const response = await bridge.request(type, payload, {
        timeoutMs: Math.max(1, Number(options.timeoutMs) || FRAME_REQUEST_TIMEOUT_MS)
      });
      return response?.payload ?? null;
    } catch {
      return null;
    }
  },

  async syncNavigationState(id, options = {}) {
    const normalizedId = String(id || "").trim();
    const browserSurface = this.getBrowser(normalizedId);
    if (!browserSurface) {
      return false;
    }

    if (this.hasUnobservedPendingNavigation(normalizedId)) {
      return false;
    }

    if (!browserSurface.bridgeHandlersReady && options.allowUnready !== true) {
      const webview = this.getWebview(normalizedId);
      if (webview) {
        this.applyNavigationState(normalizedId, collectWebviewNavigationState(webview));
        return false;
      }

      const iframe = this.getIframe(normalizedId);
      this.applyNavigationState(normalizedId, collectIframeFallbackState(iframe));
      return false;
    }

    const token = this.nextSyncToken(normalizedId);
    const attempts = Math.max(1, Number(options.attempts) || FRAME_SYNC_ATTEMPTS);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.syncTokens[normalizedId] !== token || !this.getBrowser(normalizedId)) {
        return false;
      }

      const payload = await this.requestBridgePayload(normalizedId, "navigation_state_get", null, {
        timeoutMs: FRAME_REQUEST_TIMEOUT_MS + (attempt * 150)
      });

      if (payload) {
        if (this.syncTokens[normalizedId] !== token || !this.getBrowser(normalizedId)) {
          return false;
        }

        this.applyNavigationState(normalizedId, payload, { fromBridge: true });
        return true;
      }

      if (attempt < attempts - 1) {
        await wait(FRAME_SYNC_DELAY_MS * (attempt + 1));
      }
    }

    const webview = this.getWebview(normalizedId);
    if (webview) {
      this.applyNavigationState(normalizedId, collectWebviewNavigationState(webview));
      return false;
    }

    const iframe = this.getIframe(normalizedId);
    this.applyNavigationState(normalizedId, collectIframeFallbackState(iframe));

    return false;
  },

  handleFrameLoad(id, event) {
    const browserSurface = this.getBrowser(id);
    if (browserSurface) {
      browserSurface.bridgeHandlersReady = false;
      browserSurface.bridgeStateReady = false;
      browserSurface.bridgeTransportReady = false;
      browserSurface.loading = false;
    }

    this.markNavigationObserved(id);

    const iframe = event?.currentTarget;
    this.applyNavigationState(id, collectIframeFallbackState(iframe));
    void this.syncNavigationState(id, { attempts: FRAME_SYNC_ATTEMPTS + 2 });
  },

  async waitForNavigationObservation(id, options = {}) {
    const normalizedId = String(id || "").trim();
    const initialVersion = this.getObservedNavigationVersion(normalizedId);
    const timeoutMs = Math.max(0, Number(options.timeoutMs) || FRAME_NAVIGATION_WAIT_MS);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (!this.getBrowser(normalizedId)) {
        return false;
      }

      if (this.getObservedNavigationVersion(normalizedId) !== initialVersion) {
        return true;
      }

      const immediateState = this.collectImmediateNavigationState(normalizedId);
      if (immediateState?.loading === true) {
        this.applyNavigationState(normalizedId, immediateState);
        this.markNavigationObserved(normalizedId);
        return true;
      }

      await wait(25);
    }

    this.clearPendingNavigation(normalizedId);
    return false;
  },

  async waitForGuestUsableOrSettled(id, options = {}) {
    const normalizedId = String(id || "").trim();
    const timeoutMs = Math.max(0, Number(options.timeoutMs) || FRAME_NAVIGATION_READY_TIMEOUT_MS);
    const quietMs = Math.max(0, Number(options.quietMs) || FRAME_NAVIGATION_QUIET_MS);
    const deadline = Date.now() + timeoutMs;
    let observedVersion = this.getObservedNavigationVersion(normalizedId);
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      const browserSurface = this.getBrowser(normalizedId);
      if (!browserSurface) {
        return null;
      }

      const immediateState = this.collectImmediateNavigationState(normalizedId);
      if (immediateState) {
        this.applyNavigationState(normalizedId, immediateState);
      }

      const nextObservedVersion = this.getObservedNavigationVersion(normalizedId);
      if (nextObservedVersion !== observedVersion) {
        observedVersion = nextObservedVersion;
        stableSince = Date.now();
        await wait(25);
        continue;
      }

      if (browserSurface.loading) {
        stableSince = Date.now();
        await wait(25);
        continue;
      }

      if (browserSurface.bridgeHandlersReady) {
        await this.syncNavigationState(normalizedId, {
          allowUnready: false,
          attempts: Math.max(1, Number(options.syncAttempts) || 2)
        });
      }

      if (Date.now() - stableSince >= quietMs) {
        return buildRuntimeBrowserWindowSnapshot(this.getBrowser(normalizedId));
      }

      await wait(25);
    }

    const browserSurface = this.getBrowser(normalizedId);
    return browserSurface ? buildRuntimeBrowserWindowSnapshot(browserSurface) : null;
  },

  updateAddressValue(id, value) {
    const browserSurface = this.getBrowser(id);
    if (!browserSurface) {
      return;
    }

    browserSurface.addressValue = String(value ?? "");
    this.notifyBrowserElementState(id);
  },

  async navigateToAddress(id) {
    const browserSurface = this.getBrowser(id);
    if (!browserSurface) {
      return;
    }

    const nextUrl = normalizeTypedBrowserLocation(browserSurface.addressValue || browserSurface.currentUrl || browserSurface.frameSrc);
    if (!nextUrl) {
      browserSurface.addressValue = browserSurface.currentUrl || browserSurface.frameSrc || "";
      this.notifyBrowserElementState(id);
      return;
    }

    this.rememberBrowserInteraction(id, "location_navigate");
    this.focusBrowser(id);

    if (nextUrl === browserSurface.currentUrl) {
      void this.reloadFrame(id);
      return;
    }

    browserSurface.addressValue = nextUrl;
    browserSurface.currentUrl = nextUrl;
    browserSurface.frameSrc = nextUrl;
    this.startPendingNavigation(id);
    this.notifyBrowserElementState(id);
    if (browserSurface.isWindow) {
      this.persistWindowsNow();
    }
    const payload = browserSurface.bridgeStateReady
      ? await this.requestBridgePayload(id, "location_navigate", {
          url: nextUrl
        })
      : null;

    if (!payload) {
      this.performNavigateFallback(id, nextUrl);
    }

    browserSurface.bridgeStateReady = false;
    this.notifyBrowserElementState(id);
  },

  performNavigateFallback(id, nextUrl) {
    const normalizedUrl = resolveBrowserLocation(nextUrl || "");
    if (!normalizedUrl) {
      return false;
    }

    const iframe = this.getIframe(id);
    if (iframe) {
      iframe.src = normalizedUrl;
      return true;
    }

    const webview = this.getWebview(id);
    if (webview) {
      return loadWebviewUrl(webview, normalizedUrl);
    }

    if (this.usesNativeDesktopSurface) {
      navigateBrowserSurface(id, normalizedUrl);
      return true;
    }

    return false;
  },

  performHistoryFallback(id, direction) {
    const iframe = this.getIframe(id);
    if (iframe) {
      try {
        iframe.contentWindow?.history?.[direction]?.();
        return true;
      } catch {
        return false;
      }
    }

    const webview = this.getWebview(id);
    if (webview) {
      return navigateWebviewHistory(webview, direction);
    }

    if (!this.usesNativeDesktopSurface) {
      return false;
    }

    if (direction === "back") {
      goBackBrowserSurface(id);
      return true;
    }

    if (direction === "forward") {
      goForwardBrowserSurface(id);
      return true;
    }

    return false;
  },

  performReloadFallback(id) {
    const iframe = this.getIframe(id);
    if (iframe) {
      try {
        iframe.contentWindow?.location?.reload?.();
        return true;
      } catch {
        // Fall back to resetting the current src when the child page is cross-origin.
      }

      const src = resolveBrowserLocation(iframe.src || iframe.getAttribute?.("src") || this.getBrowser(id)?.frameSrc || "");
      if (!src) {
        return false;
      }

      iframe.src = src;
      return true;
    }

    const webview = this.getWebview(id);
    if (webview) {
      return reloadWebview(webview);
    }

    if (!this.usesNativeDesktopSurface) {
      return false;
    }

    reloadBrowserSurface(id);
    return true;
  },

  async goBack(id) {
    const browserSurface = this.getBrowser(id);
    if (!browserSurface) {
      return;
    }

    this.rememberBrowserInteraction(id, "history_back");
    this.focusBrowser(id);
    this.startPendingNavigation(id);

    const payload = browserSurface.bridgeStateReady
      ? await this.requestBridgePayload(id, "history_back")
      : null;

    if (!payload) {
      this.performHistoryFallback(id, "back");
    }
  },

  async goForward(id) {
    const browserSurface = this.getBrowser(id);
    if (!browserSurface) {
      return;
    }

    this.rememberBrowserInteraction(id, "history_forward");
    this.focusBrowser(id);
    this.startPendingNavigation(id);

    const payload = browserSurface.bridgeStateReady
      ? await this.requestBridgePayload(id, "history_forward")
      : null;

    if (!payload) {
      this.performHistoryFallback(id, "forward");
    }
  },

  async reloadFrame(id) {
    const browserSurface = this.getBrowser(id);
    if (!browserSurface) {
      return;
    }

    this.rememberBrowserInteraction(id, "location_reload");
    this.focusBrowser(id);
    this.startPendingNavigation(id);

    const payload = browserSurface.bridgeStateReady
      ? await this.requestBridgePayload(id, "location_reload")
      : null;

    if (!payload) {
      this.performReloadFallback(id);
    }

    browserSurface.bridgeStateReady = false;
    this.notifyBrowserElementState(id);
  }
};

const webBrowsingStore = space.fw.createStore(STORE_NAME, model);
ensureBrowserRuntimeNamespace(webBrowsingStore);
defineBrowserElement(() => webBrowsingStore);
