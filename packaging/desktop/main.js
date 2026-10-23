const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, WebContentsView, ipcMain, net, webFrameMain } = require("electron");
const {
  resolveDesktopAuthDataDir,
  resolveDesktopServerTmpDir,
  resolvePackagedDesktopUserDataPath
} = require("./server_storage_paths");
const {
  CONNECTION_MODE,
  normalizeSavedConnections,
  readConnectionRequestFromEnv,
  resolveConnectionConfig
} = require("./connection_mode");
const {
  cleanupDesktopUpdaterArtifacts,
  writeDesktopUpdaterInstallMarker
} = require("./updater_artifacts");
const {
  resolveDesktopUpdaterLogPath
} = require("./updater_install_options");
const {
  resolveDesktopDebugReleaseAssetUrl,
  resolveDesktopDebugReleaseTag,
  resolveDesktopWindowsReleaseArchFallback,
  stageDesktopDebugRelease
} = require("./updater_debug_release");

const DESKTOP_BROWSER_PRELOAD_PATH = path.join(__dirname, "browser-preload.js");
const DESKTOP_BROWSER_WEBVIEW_PARTITION_PREFIX = "space-browser-";
const DESKTOP_BROWSER_WEBVIEW_PRELOAD_PATH = path.join(__dirname, "browser-webview-preload.js");
const BROWSER_FRAME_BRIDGE_CHANNEL = "space.web_browsing.browser_frame";
const BROWSER_FRAME_BRIDGE_EVENT_PHASE = "event";
const BROWSER_FRAME_NAVIGATION_STATE_TYPE = "navigation_state";
const DESKTOP_BROWSER_CREATE_CHANNEL = "space-desktop:browser-view-create";
const DESKTOP_BROWSER_DESTROY_CHANNEL = "space-desktop:browser-view-destroy";
const DESKTOP_BROWSER_ENVELOPE_FROM_MAIN_CHANNEL = "space-desktop:browser-envelope-to-renderer";
const DESKTOP_BROWSER_ENVELOPE_FROM_RENDERER_CHANNEL = "space-desktop:browser-envelope-from-renderer";
const DESKTOP_BROWSER_ENVELOPE_FROM_VIEW_CHANNEL = "space-desktop:browser-envelope-from-view";
const DESKTOP_BROWSER_ENVELOPE_TO_VIEW_CHANNEL = "space-desktop:browser-envelope-to-view";
const DESKTOP_BROWSER_FOCUS_CHANNEL = "space-desktop:browser-view-focus";
const DESKTOP_BROWSER_FORWARD_CHANNEL = "space-desktop:browser-view-forward";
const DESKTOP_BROWSER_GO_BACK_CHANNEL = "space-desktop:browser-view-back";
const DESKTOP_BROWSER_HOST_EVENT_CHANNEL = "space-desktop:browser-host-event";
const DESKTOP_BROWSER_NAVIGATE_CHANNEL = "space-desktop:browser-view-navigate";
const DESKTOP_BROWSER_RELOAD_CHANNEL = "space-desktop:browser-view-reload";
const DESKTOP_BROWSER_UPDATE_CHANNEL = "space-desktop:browser-view-update";
const DESKTOP_CONNECTION_CHOOSE_CHANNEL = "space-desktop:connection-choose";
const DESKTOP_CONNECTION_LIST_SAVED_CHANNEL = "space-desktop:connection-list-saved";
const DESKTOP_CONNECTION_STATUS_CHANNEL = "space-desktop:connection-status";
const DESKTOP_FRAME_PRELOAD_PATH = path.join(__dirname, "frame-preload.js");
const DESKTOP_FRAME_INJECT_REGISTER_CHANNEL = "space-desktop:frame-inject-register";
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SERVER_APP_PATH = path.join(PROJECT_ROOT, "server", "app.js");
const BASE_WINDOW_TITLE = "Constellation Agent";
const DESKTOP_UPDATE_RENDERER_LOG_LIMIT = 48;
const DESKTOP_UPDATE_FAILURE_STATUS_LIMIT = 120;
const AUTH_DATA_DIR_ENV_NAME = "SPACE_AUTH_DATA_DIR";

let serverRuntime;
let connectionConfig = resolveConnectionConfig({});
let desktopChooserWindow;
let mainWindow;
let isQuitting = false;
let updateStatusClearTimer = null;
let desktopAutoUpdater = null;
let desktopPageTitle = BASE_WINDOW_TITLE;
let desktopUpdateStatusMessage = "";
let desktopUpdateRendererLogQueue = [];
let isFlushingDesktopRendererLogs = false;
let lastDesktopUpdateFailureKey = "";
let lastDesktopUpdateFailureAt = 0;
let desktopUpdateCheckPromise = null;
let desktopUpdateDownloadPromise = null;
let desktopFramePreloadRegistrationId = "";
let lastSafeMainWindowUrl = "";
const desktopFrameInjectionRegistry = new Map();
const desktopBrowserViews = new Map();
const desktopBrowserViewsByWebContentsId = new Map();
const desktopBrowserNavigationStateTimers = new Map();
const desktopBrowserRaiseTimers = new Map();
let desktopBrowserFrontmostId = "";
let desktopUpdateState = {
  state: "idle",
  message: "",
  progress: null,
  version: ""
};

function applyPackagedDesktopUserDataOverride() {
  if (!app.isPackaged) {
    return "";
  }

  const currentUserDataPath = String(app.getPath("userData") || "").trim();
  const nextUserDataPath = resolvePackagedDesktopUserDataPath({
    appDataPath: app.getPath("appData"),
    defaultUserDataPath: currentUserDataPath,
    isPackaged: app.isPackaged
  });

  if (!nextUserDataPath || nextUserDataPath === currentUserDataPath) {
    return currentUserDataPath;
  }

  app.setPath("userData", nextUserDataPath);
  console.log(
    `[space-desktop] Using legacy packaged userData path ${nextUserDataPath} to preserve existing runtime state.`
  );
  return nextUserDataPath;
}

applyPackagedDesktopUserDataOverride();

function registerDesktopFramePreload(webContents) {
  if (!app.isPackaged || desktopFramePreloadRegistrationId) {
    return;
  }

  const currentSession = webContents?.session;
  if (!currentSession || typeof currentSession.registerPreloadScript !== "function") {
    return;
  }

  desktopFramePreloadRegistrationId = currentSession.registerPreloadScript({
    filePath: DESKTOP_FRAME_PRELOAD_PATH,
    id: "space-desktop-frame-preload",
    type: "frame"
  });
}

function replaceDesktopFrameInjectionRegistry(webContentsId, frames = []) {
  const nextRegistry = new Map();

  if (Array.isArray(frames)) {
    frames.forEach((entry) => {
      const frameName = String(entry?.frameName || "").trim();
      const injectPath = String(entry?.injectPath || "").trim();
      if (!frameName || !injectPath) {
        return;
      }

      nextRegistry.set(frameName, {
        frameName,
        iframeId: String(entry?.iframeId || frameName).trim() || frameName,
        injectPath
      });
    });
  }

  desktopFrameInjectionRegistry.set(webContentsId, nextRegistry);
}

function clearDesktopFrameInjectionRegistry(webContentsId) {
  desktopFrameInjectionRegistry.delete(webContentsId);
}

function getDesktopFrameInjectionEntry(webContentsId, frameName) {
  const registry = desktopFrameInjectionRegistry.get(webContentsId);
  if (!registry) {
    return null;
  }

  return registry.get(String(frameName || "").trim()) || null;
}

function getDesktopFrameInjectBaseOrigin(frame, webContents) {
  const topOrigin = String(frame?.top?.origin || "").trim();
  if (topOrigin && topOrigin !== "null") {
    return topOrigin;
  }

  try {
    return new URL(webContents?.getURL?.() || serverRuntime?.browserUrl || "").origin;
  } catch {
    return "";
  }
}

function resolveDesktopFrameInjectUrl(baseOrigin, injectPath) {
  const normalizedPath = String(injectPath || "").trim();
  if (!normalizedPath) {
    throw new Error("Desktop frame injection requires a non-empty inject path.");
  }

  if (!baseOrigin) {
    throw new Error("Desktop frame injection could not resolve the current app origin.");
  }

  let injectUrl = null;
  try {
    injectUrl = new URL(normalizedPath, `${baseOrigin}/`);
  } catch {
    throw new Error(`Desktop frame injection rejected invalid script path \"${normalizedPath}\".`);
  }

  if (!/^https?:$/u.test(injectUrl.protocol)) {
    throw new Error(`Desktop frame injection rejected non-http script path \"${normalizedPath}\".`);
  }

  if (injectUrl.origin !== baseOrigin) {
    throw new Error(`Desktop frame injection rejected cross-origin script path \"${normalizedPath}\".`);
  }

  const decodedPathname = decodeURIComponent(injectUrl.pathname);
  if (!decodedPathname.startsWith("/mod/")) {
    throw new Error(`Desktop frame injection rejected non-module script path \"${normalizedPath}\".`);
  }

  if (
    decodedPathname.includes("\\")
    || decodedPathname.includes("/../")
    || decodedPathname.endsWith("/..")
    || decodedPathname.includes("/./")
    || decodedPathname.endsWith("/.")
  ) {
    throw new Error(`Desktop frame injection rejected unsafe script path \"${normalizedPath}\".`);
  }

  if (injectUrl.username || injectUrl.password || injectUrl.search || injectUrl.hash) {
    throw new Error(`Desktop frame injection rejected decorated script path \"${normalizedPath}\".`);
  }

  return injectUrl;
}

async function fetchDesktopFrameInjectScript(currentSession, baseOrigin, injectPath) {
  const injectUrl = resolveDesktopFrameInjectUrl(baseOrigin, injectPath);
  const response = await currentSession.fetch(injectUrl.href);
  if (!response.ok) {
    throw new Error(`Desktop frame injection could not load ${injectUrl.href} (${response.status}).`);
  }

  return {
    scriptPath: injectUrl.pathname,
    scriptSource: await response.text(),
    scriptUrl: injectUrl.href
  };
}

function buildDesktopFrameInjectionSource(entry, script) {
  const bootstrap = JSON.stringify({
    browserId: entry.browserId || entry.iframeId || "",
    iframeId: entry.iframeId,
    scriptPath: script.scriptPath,
    scriptUrl: script.scriptUrl
  });
  const sourceUrl = String(script.scriptUrl || script.scriptPath || "space-desktop-injected-script").replace(/[\r\n]+/gu, " ");

  return `(() => {\n  const bootstrap = ${bootstrap};\n  globalThis.__spaceBrowserInjectBootstrap__ = bootstrap;\n  globalThis.__spaceBrowserFrameInjectBootstrap__ = bootstrap;\n  try {\n${script.scriptSource}\n  } finally {\n    delete globalThis.__spaceBrowserInjectBootstrap__;\n    delete globalThis.__spaceBrowserFrameInjectBootstrap__;\n  }\n})();\n//# sourceURL=${sourceUrl}`;
}

async function injectDesktopFrameScript(frame, entry, webContents) {
  if (!app.isPackaged || !frame || frame.isDestroyed?.()) {
    return;
  }

  const currentSession = webContents?.session;
  if (!currentSession || typeof currentSession.fetch !== "function") {
    throw new Error("Desktop frame injection requires a live renderer session.");
  }

  const baseOrigin = getDesktopFrameInjectBaseOrigin(frame, webContents);
  const script = await fetchDesktopFrameInjectScript(currentSession, baseOrigin, entry.injectPath);
  await frame.executeJavaScript(buildDesktopFrameInjectionSource(entry, script), true);
}

function maybeInjectDesktopFrame(frame, webContents) {
  if (!app.isPackaged || !frame || !webContents || frame.parent == null) {
    return;
  }

  const entry = getDesktopFrameInjectionEntry(webContents.id, frame.name);
  if (!entry) {
    return;
  }

  void injectDesktopFrameScript(frame, entry, webContents).catch((error) => {
    console.error(`[space-desktop/frame-inject] Failed to inject ${entry.injectPath} into frame \"${entry.frameName}\".`, error);
  });
}

function injectRegisteredDesktopFrames(webContents) {
  if (!app.isPackaged || !webContents || webContents.isDestroyed?.()) {
    return;
  }

  const registry = desktopFrameInjectionRegistry.get(webContents.id);
  if (!registry || !registry.size) {
    return;
  }

  const mainFrame = webContents.mainFrame;
  if (!mainFrame || mainFrame.isDestroyed?.()) {
    return;
  }

  mainFrame.framesInSubtree.forEach((frame) => {
    if (frame === mainFrame) {
      return;
    }

    maybeInjectDesktopFrame(frame, webContents);
  });
}

function normalizeDesktopBrowserId(value) {
  return String(value || "").trim();
}

function getDesktopBrowserIdFromWebviewPartition(partition) {
  const normalizedPartition = String(partition || "").trim();
  if (!normalizedPartition.startsWith(DESKTOP_BROWSER_WEBVIEW_PARTITION_PREFIX)) {
    return "";
  }

  return normalizeDesktopBrowserId(
    normalizedPartition.slice(DESKTOP_BROWSER_WEBVIEW_PARTITION_PREFIX.length)
  );
}

function normalizeDesktopBrowserBounds(bounds = {}) {
  return {
    height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    width: Math.max(0, Math.round(Number(bounds.width) || 0)),
    x: Math.round(Number(bounds.x) || 0),
    y: Math.round(Number(bounds.y) || 0)
  };
}

function getDesktopBrowserViewEntry(browserId) {
  return desktopBrowserViews.get(normalizeDesktopBrowserId(browserId)) || null;
}

function getDesktopBrowserViewEntryByWebContents(webContentsId) {
  return desktopBrowserViewsByWebContentsId.get(Number(webContentsId)) || null;
}

function isDesktopBrowserViewFrontmost(browserId) {
  const normalizedBrowserId = normalizeDesktopBrowserId(browserId);
  return Boolean(normalizedBrowserId) && desktopBrowserFrontmostId === normalizedBrowserId;
}

function clearDesktopBrowserRaiseTimer(browserId) {
  const normalizedBrowserId = normalizeDesktopBrowserId(browserId);
  const timer = desktopBrowserRaiseTimers.get(normalizedBrowserId);
  if (timer == null) {
    return;
  }

  clearTimeout(timer);
  desktopBrowserRaiseTimers.delete(normalizedBrowserId);
}

function clearDesktopBrowserNavigationStateTimer(browserId) {
  const normalizedBrowserId = normalizeDesktopBrowserId(browserId);
  const pending = desktopBrowserNavigationStateTimers.get(normalizedBrowserId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timer);
  desktopBrowserNavigationStateTimers.delete(normalizedBrowserId);
}

function sendDesktopBrowserEnvelopeToRenderer(browserId, envelope) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(DESKTOP_BROWSER_ENVELOPE_FROM_MAIN_CHANNEL, {
    browserId: normalizeDesktopBrowserId(browserId),
    envelope
  });
}

function collectDesktopBrowserNavigationState(entry, overrides = {}) {
  const webContents = entry?.view?.webContents;
  const rawUrl = typeof overrides.url === "string" && overrides.url.trim()
    ? overrides.url
    : webContents?.getURL?.() || entry?.pendingUrl || "";
  const rawTitle = typeof overrides.title === "string"
    ? overrides.title
    : webContents?.getTitle?.() || "";

  return {
    canGoBack: Boolean(webContents?.canGoBack?.()),
    canGoForward: Boolean(webContents?.canGoForward?.()),
    title: String(rawTitle || ""),
    url: String(rawUrl || "")
  };
}

function sendDesktopBrowserNavigationState(entry, overrides = {}) {
  if (!entry) {
    return;
  }

  sendDesktopBrowserEnvelopeToRenderer(entry.browserId, {
    channel: BROWSER_FRAME_BRIDGE_CHANNEL,
    payload: collectDesktopBrowserNavigationState(entry, overrides),
    phase: BROWSER_FRAME_BRIDGE_EVENT_PHASE,
    type: BROWSER_FRAME_NAVIGATION_STATE_TYPE
  });
}

function scheduleDesktopBrowserNavigationState(browserId, overrides = {}) {
  const normalizedBrowserId = normalizeDesktopBrowserId(browserId);
  if (!normalizedBrowserId) {
    return;
  }

  const pending = desktopBrowserNavigationStateTimers.get(normalizedBrowserId);
  const nextOverrides = {
    ...(pending?.overrides || {}),
    ...overrides
  };

  if (pending) {
    clearTimeout(pending.timer);
  }

  const timer = setTimeout(() => {
    desktopBrowserNavigationStateTimers.delete(normalizedBrowserId);

    const entry = getDesktopBrowserViewEntry(normalizedBrowserId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      return;
    }

    sendDesktopBrowserNavigationState(entry, nextOverrides);
  }, 0);

  desktopBrowserNavigationStateTimers.set(normalizedBrowserId, {
    overrides: nextOverrides,
    timer
  });
}

function sendDesktopBrowserHostEvent(browserId, type, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(DESKTOP_BROWSER_HOST_EVENT_CHANNEL, {
    browserId: normalizeDesktopBrowserId(browserId),
    disposition: String(payload.disposition || "").trim(),
    frameName: String(payload.frameName || "").trim(),
    referrerUrl: String(payload.referrerUrl || "").trim(),
    type: String(type || "").trim(),
    url: String(payload.url || "").trim()
  });
}

function getDesktopBrowserInjectBaseOrigin() {
  try {
    return new URL(mainWindow?.webContents?.getURL?.() || serverRuntime?.browserUrl || "").origin;
  } catch {
    try {
      return new URL(serverRuntime?.browserUrl || "").origin;
    } catch {
      return "";
    }
  }
}

async function injectDesktopBrowserViewScript(entry) {
  if (!entry || entry.view?.webContents?.isDestroyed?.()) {
    return;
  }

  const currentSession = entry.view.webContents.session;
  if (!currentSession || typeof currentSession.fetch !== "function") {
    throw new Error("Desktop browser view injection requires a live renderer session.");
  }

  const baseOrigin = getDesktopBrowserInjectBaseOrigin();
  const script = await fetchDesktopFrameInjectScript(currentSession, baseOrigin, entry.injectPath);
  const bootstrap = {
    browserId: entry.browserId,
    iframeId: entry.browserId,
    scriptPath: script.scriptPath,
    scriptUrl: script.scriptUrl
  };
  const sourceUrl = String(script.scriptUrl || script.scriptPath || "space-desktop-browser-injected-script").replace(/[\r\n]+/gu, " ");
  const source = `(() => {\n  const bootstrap = ${JSON.stringify(bootstrap)};\n  globalThis.__spaceBrowserInjectBootstrap__ = bootstrap;\n  globalThis.__spaceBrowserFrameInjectBootstrap__ = bootstrap;\n  try {\n${script.scriptSource}\n  } finally {\n    delete globalThis.__spaceBrowserInjectBootstrap__;\n    delete globalThis.__spaceBrowserFrameInjectBootstrap__;\n  }\n})();\n//# sourceURL=${sourceUrl}`;

  await entry.view.webContents.executeJavaScript(source, true);
}

function applyDesktopBrowserViewVisibility(entry) {
  if (!entry?.view || entry.view.webContents.isDestroyed?.()) {
    return;
  }

  const isVisible = entry.visible !== false && entry.bounds.width > 0 && entry.bounds.height > 0;
  if (typeof entry.view.setVisible === "function") {
    entry.view.setVisible(isVisible);
  }

  entry.view.setBounds(isVisible
    ? entry.bounds
    : {
        x: 0,
        y: 0,
        width: 0,
        height: 0
      });
}

function raiseDesktopBrowserView(browserId) {
  const entry = getDesktopBrowserViewEntry(browserId);
  if (!entry || !mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  clearDesktopBrowserRaiseTimer(entry.browserId);

  if (isDesktopBrowserViewFrontmost(entry.browserId)) {
    applyDesktopBrowserViewVisibility(entry);
    return entry;
  }

  try {
    mainWindow.contentView.removeChildView(entry.view);
  } catch {
    // Reordering is best effort only.
  }

  try {
    mainWindow.contentView.addChildView(entry.view);
  } catch {
    // The view may already be attached or the window may be closing.
  }

  desktopBrowserFrontmostId = entry.browserId;
  applyDesktopBrowserViewVisibility(entry);

  return entry;
}

function scheduleRaiseDesktopBrowserView(browserId) {
  const normalizedBrowserId = normalizeDesktopBrowserId(browserId);
  if (!normalizedBrowserId || desktopBrowserRaiseTimers.has(normalizedBrowserId)) {
    return;
  }

  const timer = setTimeout(() => {
    desktopBrowserRaiseTimers.delete(normalizedBrowserId);
    raiseDesktopBrowserView(normalizedBrowserId);
  }, 0);

  desktopBrowserRaiseTimers.set(normalizedBrowserId, timer);
}

function focusDesktopBrowserView(browserId, { notifyRenderer = false, refocus = true } = {}) {
  const entry = raiseDesktopBrowserView(browserId);
  if (!entry) {
    return;
  }

  if (refocus) {
    entry.view.webContents.focus();
  }

  if (notifyRenderer) {
    sendDesktopBrowserHostEvent(entry.browserId, "focus");
  }
}

function createDesktopBrowserView(payload = {}) {
  const browserId = normalizeDesktopBrowserId(payload.browserId);
  const injectPath = String(payload.injectPath || "").trim();
  if (!browserId || !mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  const existingEntry = getDesktopBrowserViewEntry(browserId);
  if (existingEntry) {
    if (injectPath) {
      existingEntry.injectPath = injectPath;
    }

    if (payload.url) {
      existingEntry.pendingUrl = String(payload.url || "").trim();
      void existingEntry.view.webContents.loadURL(existingEntry.pendingUrl).catch((error) => {
        console.error(`[space-desktop/browser-view] Failed to load ${existingEntry.pendingUrl} for "${browserId}".`, error);
      });
    }

    return existingEntry;
  }

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: DESKTOP_BROWSER_PRELOAD_PATH
    }
  });

  const entry = {
    bounds: normalizeDesktopBrowserBounds(payload.bounds),
    browserId,
    injectPath,
    pendingUrl: String(payload.url || "").trim(),
    view,
    visible: payload.visible !== false
  };

  desktopBrowserViews.set(browserId, entry);
  desktopBrowserViewsByWebContentsId.set(view.webContents.id, entry);
  mainWindow.contentView.addChildView(view);
  desktopBrowserFrontmostId = browserId;
  applyDesktopBrowserViewVisibility(entry);

  view.webContents.on("destroyed", () => {
    clearDesktopBrowserNavigationStateTimer(browserId);
    clearDesktopBrowserRaiseTimer(browserId);
    desktopBrowserViewsByWebContentsId.delete(view.webContents.id);
    if (desktopBrowserViews.get(browserId) === entry) {
      desktopBrowserViews.delete(browserId);
    }
    if (desktopBrowserFrontmostId === browserId) {
      desktopBrowserFrontmostId = "";
    }
  });

  view.webContents.on("did-navigate", (_event, url) => {
    entry.pendingUrl = String(url || "").trim();
    scheduleDesktopBrowserNavigationState(browserId, {
      url: entry.pendingUrl
    });
  });

  view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame = true) => {
    if (isMainFrame === false) {
      return;
    }

    entry.pendingUrl = String(url || "").trim();
    scheduleDesktopBrowserNavigationState(browserId, {
      url: entry.pendingUrl
    });
  });

  view.webContents.on("page-title-updated", (_event, title) => {
    scheduleDesktopBrowserNavigationState(browserId, {
      title: String(title || "")
    });
  });

  view.webContents.setWindowOpenHandler((details) => {
    sendDesktopBrowserHostEvent(browserId, "open_window", {
      disposition: details?.disposition,
      frameName: details?.frameName,
      referrerUrl: details?.referrer?.url,
      url: details?.url
    });

    return {
      action: "deny"
    };
  });

  view.webContents.on("focus", () => {
    if (!isDesktopBrowserViewFrontmost(browserId)) {
      scheduleRaiseDesktopBrowserView(browserId);
    }

    sendDesktopBrowserHostEvent(browserId, "focus");
  });

  view.webContents.on("did-finish-load", () => {
    entry.pendingUrl = String(view.webContents.getURL() || entry.pendingUrl || "").trim();
    scheduleDesktopBrowserNavigationState(browserId, {
      url: entry.pendingUrl
    });

    if (!entry.injectPath) {
      return;
    }

    void injectDesktopBrowserViewScript(entry).catch((error) => {
      console.error(`[space-desktop/browser-view] Failed to inject ${entry.injectPath} into "${browserId}".`, error);
    });
  });

  if (entry.pendingUrl) {
    void view.webContents.loadURL(entry.pendingUrl).catch((error) => {
      console.error(`[space-desktop/browser-view] Failed to load ${entry.pendingUrl} for "${browserId}".`, error);
    });
  }

  return entry;
}

function updateDesktopBrowserView(payload = {}) {
  const entry = getDesktopBrowserViewEntry(payload.browserId) || createDesktopBrowserView(payload);
  if (!entry) {
    return null;
  }

  entry.bounds = normalizeDesktopBrowserBounds(payload.bounds);
  entry.visible = payload.visible !== false;
  applyDesktopBrowserViewVisibility(entry);
  return entry;
}

function destroyDesktopBrowserView(browserId) {
  const entry = getDesktopBrowserViewEntry(browserId);
  if (!entry) {
    return;
  }

  clearDesktopBrowserNavigationStateTimer(entry.browserId);
  clearDesktopBrowserRaiseTimer(entry.browserId);
  desktopBrowserViews.delete(entry.browserId);
  desktopBrowserViewsByWebContentsId.delete(entry.view.webContents.id);
  if (desktopBrowserFrontmostId === entry.browserId) {
    desktopBrowserFrontmostId = "";
  }

  try {
    mainWindow?.contentView?.removeChildView?.(entry.view);
  } catch {
    // The main window may already be closing.
  }

  if (!entry.view.webContents.isDestroyed()) {
    entry.view.webContents.close();
  }
}

function destroyAllDesktopBrowserViews() {
  [...desktopBrowserViews.keys()].forEach((browserId) => {
    destroyDesktopBrowserView(browserId);
  });
}

function navigateDesktopBrowserView(browserId, url) {
  const entry = getDesktopBrowserViewEntry(browserId);
  const nextUrl = String(url || "").trim();
  if (!entry || !nextUrl) {
    return;
  }

  entry.pendingUrl = nextUrl;
  void entry.view.webContents.loadURL(nextUrl).catch((error) => {
    console.error(`[space-desktop/browser-view] Failed to navigate "${browserId}" to ${nextUrl}.`, error);
  });
}

function goBackDesktopBrowserView(browserId) {
  const entry = getDesktopBrowserViewEntry(browserId);
  if (!entry || !entry.view.webContents.canGoBack()) {
    return;
  }

  entry.view.webContents.goBack();
}

function goForwardDesktopBrowserView(browserId) {
  const entry = getDesktopBrowserViewEntry(browserId);
  if (!entry || !entry.view.webContents.canGoForward()) {
    return;
  }

  entry.view.webContents.goForward();
}

function reloadDesktopBrowserView(browserId) {
  const entry = getDesktopBrowserViewEntry(browserId);
  if (!entry) {
    return;
  }

  entry.view.webContents.reload();
}

function isConnectedMode() {
  return connectionConfig?.mode === CONNECTION_MODE.CONNECTED && Boolean(connectionConfig.origin);
}

function resolveDesktopBaseUrl() {
  if (isConnectedMode()) {
    return connectionConfig.url;
  }

  return String(serverRuntime?.browserUrl || "");
}

function resolveDesktopConnectionsFilePath() {
  return path.join(app.getPath("userData"), "connections.json");
}

function loadSavedConnectionRecords() {
  try {
    const raw = fs.readFileSync(resolveDesktopConnectionsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.connections) ? parsed.connections : [];
  } catch {
    return [];
  }
}

function saveConnectionRecord(config) {
  if (!config || !config.origin) {
    return;
  }

  try {
    const records = loadSavedConnectionRecords();
    const existing = records.find(
      (entry) => String(entry?.origin || "").trim() === config.origin
    );
    if (existing) {
      return;
    }

    const next = [
      ...records,
      {
        label: config.label || config.origin,
        url: config.url,
        origin: config.origin
      }
    ];
    const file = resolveDesktopConnectionsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ connections: next }, null, 2), { mode: 0o600 });
    console.log(`[space-desktop] Pinned connected server origin: ${config.origin}`);
  } catch (error) {
    console.warn("[space-desktop] Could not persist the connected server record.", error);
  }
}

function rememberConnectedServerOrigin() {
  if (!isConnectedMode()) {
    return;
  }

  saveConnectionRecord(connectionConfig);
}

function createDesktopRuntimeParamOverrides() {
  const overrides = {};

  if (app.isPackaged) {
    overrides.WORKERS = "1";
    overrides.SINGLE_USER_APP = "true";
    overrides.CUSTOMWARE_PATH = path.join(app.getPath("userData"), "customware");
  }

  return overrides;
}

function createDesktopServerOptions(runtimeParamOverrides) {
  const serverOptions = {
    host: "127.0.0.1",
    port: 0,
    projectRoot: PROJECT_ROOT,
    runtimeParamOverrides
  };

  const tmpDir = resolveDesktopServerTmpDir({
    isPackaged: app.isPackaged,
    tempPath: app.getPath("temp")
  });

  if (tmpDir) {
    serverOptions.tmpDir = tmpDir;
  }

  return serverOptions;
}

function applyPackagedDesktopStorageOverrides() {
  const authDataDir = resolveDesktopAuthDataDir({
    isPackaged: app.isPackaged,
    userDataPath: app.getPath("userData")
  });

  if (authDataDir && !process.env[AUTH_DATA_DIR_ENV_NAME]) {
    process.env[AUTH_DATA_DIR_ENV_NAME] = authDataDir;
  }
}

function resolveDesktopLaunchPath() {
  if (isConnectedMode()) {
    return "";
  }

  return serverRuntime?.runtimeParams?.get?.("SINGLE_USER_APP", false) ? "/enter" : "/";
}

function normalizeDesktopNavigationUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  try {
    return new URL(normalized).href;
  } catch {
    return "";
  }
}

function resolveDesktopAppOrigin() {
  if (isConnectedMode()) {
    return connectionConfig.origin;
  }

  try {
    return new URL(serverRuntime?.browserUrl || "").origin;
  } catch {
    return "";
  }
}

function isDesktopMainWindowAllowedUrl(value) {
  const normalizedUrl = normalizeDesktopNavigationUrl(value);
  const appOrigin = resolveDesktopAppOrigin();
  if (!normalizedUrl || !appOrigin) {
    return false;
  }

  try {
    return new URL(normalizedUrl).origin === appOrigin;
  } catch {
    return false;
  }
}

function rememberDesktopSafeMainWindowUrl(value = mainWindow?.webContents?.getURL?.() || "") {
  const normalizedUrl = normalizeDesktopNavigationUrl(value);
  if (!isDesktopMainWindowAllowedUrl(normalizedUrl)) {
    return "";
  }

  lastSafeMainWindowUrl = normalizedUrl;
  return lastSafeMainWindowUrl;
}

function revertDesktopMainWindowToSafeUrl(blockedUrl = "") {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const safeUrl = rememberDesktopSafeMainWindowUrl()
    || normalizeDesktopNavigationUrl(lastSafeMainWindowUrl)
    || normalizeDesktopNavigationUrl(`${resolveDesktopBaseUrl()}${resolveDesktopLaunchPath()}`);
  if (!safeUrl) {
    return;
  }

  const currentUrl = normalizeDesktopNavigationUrl(mainWindow.webContents.getURL());
  if (currentUrl === safeUrl) {
    return;
  }

  queueMicrotask(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const liveUrl = normalizeDesktopNavigationUrl(mainWindow.webContents.getURL());
    if (liveUrl === safeUrl) {
      return;
    }

    void mainWindow.webContents.loadURL(safeUrl).catch((error) => {
      console.error(
        `[space-desktop] Failed to restore main window after blocked navigation to ${String(blockedUrl || "").trim() || "<unknown>"}.`,
        error
      );
    });
  });
}

function blockDesktopMainWindowNavigation(event, url, isMainFrame = true) {
  if (!isMainFrame || isDesktopMainWindowAllowedUrl(url)) {
    return false;
  }

  event.preventDefault();
  console.warn(`[space-desktop] Blocked main-window navigation away from app origin: ${String(url || "").trim() || "<unknown>"}`);
  revertDesktopMainWindowToSafeUrl(url);
  return true;
}

function showMainWindow() {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function clearUpdateStatusSoon(delayMs = 5000) {
  if (updateStatusClearTimer) {
    clearTimeout(updateStatusClearTimer);
  }

  updateStatusClearTimer = setTimeout(() => {
    updateStatusClearTimer = null;
    setDesktopUpdateStatus("");
  }, delayMs);
}

function normalizeDesktopWindowTitle(value) {
  const normalized = String(value || "").trim();
  return normalized || BASE_WINDOW_TITLE;
}

function formatDesktopDisplayVersion(value) {
  const normalized = String(value || "").trim().replace(/^v/u, "");
  if (!normalized) {
    return "";
  }

  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) {
    return normalized;
  }

  return Number(match[3]) === 0 ? `${match[1]}.${match[2]}` : normalized;
}

function refreshDesktopWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const titleParts = [normalizeDesktopWindowTitle(desktopPageTitle)];
  if (desktopUpdateStatusMessage) {
    titleParts.push(desktopUpdateStatusMessage);
  }

  mainWindow.setTitle(titleParts.join(" - "));
}

function setDesktopUpdateStatus(message, progress = null) {
  desktopUpdateStatusMessage = String(message || "").trim();

  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  refreshDesktopWindowTitle();

  if (progress === "indeterminate") {
    mainWindow.setProgressBar(2);
    return;
  }

  if (Number.isFinite(progress)) {
    mainWindow.setProgressBar(Math.max(0, Math.min(1, progress)));
    return;
  }

  mainWindow.setProgressBar(-1);
}

function setDesktopUpdateState(nextState = {}) {
  desktopUpdateState = {
    ...desktopUpdateState,
    ...nextState
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("space-desktop:update-status", desktopUpdateState);
  }
}

function prepareDesktopForQuit() {
  isQuitting = true;
}

async function cleanupStaleDesktopUpdaterArtifacts() {
  let cleanupResult = null;

  try {
    cleanupResult = await cleanupDesktopUpdaterArtifacts({
      isPackaged: app.isPackaged,
      userDataPath: app.getPath("userData")
    });
  } catch (error) {
    logDesktopUpdateEvent("Could not clean stale desktop updater artifacts.", {
      level: "warn",
      error
    });
    return {
      cleaned: false,
      clearedPaths: [],
      marker: null,
      markerPath: "",
      removedRoots: [],
      reason: "error"
    };
  }

  if (!cleanupResult.cleaned) {
    return cleanupResult;
  }

  const targetVersion = String(cleanupResult.marker?.targetVersion || "").trim();
  const summary = cleanupResult.clearedPaths.length
    ? cleanupResult.clearedPaths
      .map((entry) => path.join(path.basename(path.dirname(entry)), path.basename(entry)))
      .join(", ")
    : "no pending payloads";
  logDesktopUpdateEvent(
    targetVersion
      ? `Cleaned stale desktop updater artifacts after the previous install attempt for ${targetVersion} (${summary}).`
      : `Cleaned stale desktop updater artifacts after the previous install attempt (${summary}).`
  );
  return cleanupResult;
}


function getDesktopRuntimeInfo() {
  const canCheckForUpdates = shouldEnableDesktopAutoUpdate() && Boolean(loadDesktopAutoUpdater());

  return {
    platform: process.platform,
    isBundledApp: app.isPackaged,
    connectionMode: isConnectedMode() ? CONNECTION_MODE.CONNECTED : CONNECTION_MODE.STANDALONE,
    connectedOrigin: isConnectedMode() ? connectionConfig.origin : "",
    canCheckForUpdates,
    updateStatus: desktopUpdateState
  };
}

function truncateDesktopUpdateStatus(value, maxLength = DESKTOP_UPDATE_FAILURE_STATUS_LIMIT) {
  const normalized = String(value || "").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function collectDesktopUpdateErrorDetails(error) {
  const details = [];

  if (!error || typeof error !== "object") {
    return details;
  }

  if (error.name) {
    details.push(`name: ${error.name}`);
  }

  if (error.code) {
    details.push(`code: ${error.code}`);
  }

  if (Number.isFinite(Number(error.statusCode))) {
    details.push(`statusCode: ${Number(error.statusCode)}`);
  }

  if (error.method) {
    details.push(`method: ${error.method}`);
  }

  if (error.url) {
    details.push(`url: ${error.url}`);
  }

  if (error.stack) {
    details.push(String(error.stack));
  }

  return details;
}

function formatDesktopUpdateError(error) {
  if (!error) {
    return {
      summary: "Unknown updater error.",
      details: []
    };
  }

  if (typeof error === "string") {
    const summary = String(error).trim();
    return {
      summary: summary || "Unknown updater error.",
      details: summary ? [summary] : []
    };
  }

  const summary = String(error.message || error.stack || error).trim();
  const details = collectDesktopUpdateErrorDetails(error);

  if (!details.length && summary) {
    details.push(summary);
  }

  return {
    summary: summary || "Unknown updater error.",
    details
  };
}

function queueDesktopRendererLog(level, lines) {
  const entry = {
    level,
    timestamp: new Date().toISOString(),
    lines: Array.isArray(lines) ? lines.filter(Boolean) : []
  };

  desktopUpdateRendererLogQueue.push(entry);
  if (desktopUpdateRendererLogQueue.length > DESKTOP_UPDATE_RENDERER_LOG_LIMIT) {
    desktopUpdateRendererLogQueue = desktopUpdateRendererLogQueue.slice(-DESKTOP_UPDATE_RENDERER_LOG_LIMIT);
  }
}

function flushDesktopRendererLogs() {
  if (!mainWindow || mainWindow.isDestroyed() || !desktopUpdateRendererLogQueue.length || isFlushingDesktopRendererLogs) {
    return;
  }

  const pendingEntries = desktopUpdateRendererLogQueue.slice();
  const script = `(() => {
    const entries = ${JSON.stringify(pendingEntries)};
    for (const entry of entries) {
      const method = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "log";
      const prefix = "[space-desktop/updater]";
      const body = Array.isArray(entry.lines) ? entry.lines.join("\\n") : "";
      console[method](prefix + " " + entry.timestamp + "\\n" + body);
    }
  })();`;

  isFlushingDesktopRendererLogs = true;
  mainWindow.webContents
    .executeJavaScript(script, true)
    .then(() => {
      desktopUpdateRendererLogQueue = desktopUpdateRendererLogQueue.slice(pendingEntries.length);
      isFlushingDesktopRendererLogs = false;
      if (desktopUpdateRendererLogQueue.length) {
        flushDesktopRendererLogs();
      }
    })
    .catch(() => {
      isFlushingDesktopRendererLogs = false;
      // Keep the buffered logs so the next page load can print them.
    });
}

function logDesktopUpdateEvent(message, { level = "log", error = null } = {}) {
  const formattedError = error ? formatDesktopUpdateError(error) : null;
  const lines = [`[desktop-updater] ${message}`];

  if (formattedError?.summary) {
    lines.push(`summary: ${formattedError.summary}`);
  }

  if (formattedError?.details?.length) {
    lines.push(...formattedError.details);
  }

  lines.forEach((line) => {
    console[level](line);
  });

  queueDesktopRendererLog(level, lines);
  flushDesktopRendererLogs();

  return formattedError;
}

function buildDesktopUpdateFailureStatus(error) {
  const { summary } = formatDesktopUpdateError(error);
  return truncateDesktopUpdateStatus(`Update check failed: ${summary}`);
}

function reportDesktopUpdateFailure(message, error) {
  const formattedError = formatDesktopUpdateError(error);
  const failureKey = `${message}::${formattedError.summary}`;
  const now = Date.now();

  if (failureKey === lastDesktopUpdateFailureKey && now - lastDesktopUpdateFailureAt < 2000) {
    return formattedError;
  }

  lastDesktopUpdateFailureKey = failureKey;
  lastDesktopUpdateFailureAt = now;

  logDesktopUpdateEvent(message, { level: "error", error });
  setDesktopUpdateStatus(buildDesktopUpdateFailureStatus(error));
  setDesktopUpdateState({
    state: "error",
    message: formattedError.summary,
    progress: null,
    version: ""
  });
  clearUpdateStatusSoon(15000);

  return formattedError;
}

function shouldEnableDesktopAutoUpdate() {
  return app.isPackaged && !isConnectedMode();
}

function loadDesktopAutoUpdater() {
  if (desktopAutoUpdater) {
    return desktopAutoUpdater;
  }

  try {
    ({ autoUpdater: desktopAutoUpdater } = require("electron-updater"));
  } catch (error) {
    logDesktopUpdateEvent("Desktop auto-update is unavailable.", { level: "warn", error });
    desktopAutoUpdater = null;
  }

  return desktopAutoUpdater;
}

async function appendDesktopUpdaterPersistentLog(logPath, message, details = null) {
  const resolvedLogPath = String(logPath || "").trim();
  const normalizedMessage = String(message || "").trim();

  if (!resolvedLogPath || !normalizedMessage) {
    return;
  }

  const lines = [
    `${new Date().toISOString()} [space-desktop/updater] ${normalizedMessage}`
  ];

  if (details && typeof details === "object") {
    try {
      lines.push(JSON.stringify(details));
    } catch {
      // Keep logging best effort only.
    }
  }

  try {
    await fsPromises.mkdir(path.dirname(resolvedLogPath), {
      recursive: true
    });
    await fsPromises.appendFile(resolvedLogPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Persistent updater logging must never block launch or install handoff.
  }
}

function resolveDesktopUpdaterLogPathForCurrentRun() {
  return resolveDesktopUpdaterLogPath({
    userDataPath: app.getPath("userData")
  });
}

function isDesktopNetworkOnline() {
  try {
    return !net || typeof net.isOnline !== "function" || net.isOnline();
  } catch (error) {
    reportDesktopUpdateFailure("Could not determine desktop network status.", error);
    return true;
  }
}

function resolveDesktopDebugReinstallRequestVersion(payload = {}) {
  if (typeof payload === "string") {
    return String(payload || "").trim();
  }

  if (payload && typeof payload === "object") {
    return String(payload.version || "").trim();
  }

  return "";
}

async function fetchDesktopUpdateMetadataText(metadataUrl) {
  const response = await fetch(metadataUrl, {
    headers: {
      accept: "text/yaml, text/x-yaml, text/plain, */*"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Could not download desktop update metadata ${metadataUrl} (${response.status} ${response.statusText || "Unknown"}).`
    );
  }

  return await response.text();
}

async function downloadDesktopUpdateAssetToFile(assetUrl, destinationPath, { onProgress } = {}) {
  const response = await fetch(assetUrl, {
    headers: {
      accept: "application/octet-stream, */*"
    }
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download desktop update asset ${assetUrl} (${response.status} ${response.statusText || "Unknown"}).`
    );
  }

  const totalBytes = Number(response.headers.get("content-length")) || 0;
  const destinationDir = path.dirname(destinationPath);
  const temporaryPath = path.join(destinationDir, `temp-${path.basename(destinationPath)}`);
  const hash = createHash("sha512");
  let downloadedBytes = 0;

  await fsPromises.mkdir(destinationDir, {
    recursive: true
  });
  await fsPromises.rm(temporaryPath, {
    force: true
  });
  await fsPromises.rm(destinationPath, {
    force: true
  });

  const hashAndProgress = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      downloadedBytes += chunk.length;
      onProgress?.({
        downloadedBytes,
        totalBytes,
        progress: totalBytes > 0 ? downloadedBytes / totalBytes : null
      });
      callback(null, chunk);
    }
  });

  try {
    await pipeline(Readable.fromWeb(response.body), hashAndProgress, fs.createWriteStream(temporaryPath));
    await fsPromises.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fsPromises.rm(temporaryPath, {
      force: true
    });
    throw error;
  }

  return {
    sha512: hash.digest("base64"),
    size: downloadedBytes
  };
}

async function downloadDesktopWindowsUpdateWithArchFallback(autoUpdater) {
  if (process.platform !== "win32") {
    return null;
  }

  const updateInfoAndProvider = autoUpdater?.updateInfoAndProvider;
  const updateInfo = updateInfoAndProvider?.info || null;
  const fallback = resolveDesktopWindowsReleaseArchFallback(updateInfo, process.arch);
  if (!fallback) {
    return null;
  }

  const publishConfig = await autoUpdater.configOnDisk.value;
  const tag = resolveDesktopDebugReleaseTag(updateInfo?.version || "");
  const installerUrl = resolveDesktopDebugReleaseAssetUrl({
    publishConfig,
    tag,
    fileName: fallback.expectedFileName
  });
  const downloadedUpdateHelper = await autoUpdater.getOrCreateDownloadHelper();
  const pendingDir = downloadedUpdateHelper.cacheDirForPendingUpdate;
  const destinationPath = path.join(pendingDir, fallback.expectedFileName);
  const logPath = resolveDesktopUpdaterLogPathForCurrentRun();

  logDesktopUpdateEvent(
    `Windows release metadata is missing the ${fallback.expectedArch} installer; downloading ${fallback.expectedFileName} directly from the release assets.`
  );
  await appendDesktopUpdaterPersistentLog(logPath, "Windows update metadata is missing the current arch installer; using the canonical release asset fallback.", {
    actualFiles: fallback.actualFiles,
    currentArch: process.arch,
    expectedArch: fallback.expectedArch,
    expectedFileName: fallback.expectedFileName,
    installerUrl,
    targetVersion: updateInfo?.version || ""
  });

  await downloadedUpdateHelper.clear();

  setDesktopUpdateStatus("Downloading update...", "indeterminate");
  setDesktopUpdateState({
    state: "downloading",
    message: "Downloading update...",
    progress: null,
    version: formatDesktopDisplayVersion(updateInfo?.version || "")
  });

  const downloadedFile = await downloadDesktopUpdateAssetToFile(installerUrl, destinationPath, {
    onProgress({ progress }) {
      if (!Number.isFinite(progress)) {
        return;
      }

      const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
      const message = `Downloading update ${percent}%`;
      setDesktopUpdateStatus(message, progress);
      setDesktopUpdateState({
        state: "downloading",
        message,
        progress,
        version: formatDesktopDisplayVersion(updateInfo?.version || "")
      });
    }
  });

  const fileInfo = {
    url: new URL(installerUrl),
    info: {
      url: fallback.expectedFileName,
      sha512: downloadedFile.sha512,
      size: String(downloadedFile.size)
    }
  };
  const normalizedUpdateInfo = {
    ...updateInfo,
    files: [fileInfo.info],
    path: fallback.expectedFileName,
    sha512: downloadedFile.sha512
  };

  await downloadedUpdateHelper.setDownloadedFile(
    destinationPath,
    null,
    normalizedUpdateInfo,
    fileInfo,
    fallback.expectedFileName,
    true
  );
  autoUpdater.updateInfoAndProvider = {
    info: normalizedUpdateInfo,
    provider: updateInfoAndProvider.provider
  };

  await appendDesktopUpdaterPersistentLog(logPath, "Downloaded Windows update using the release-asset arch fallback.", {
    currentArch: process.arch,
    expectedArch: fallback.expectedArch,
    expectedFileName: fallback.expectedFileName,
    installerUrl,
    sha512: downloadedFile.sha512,
    size: downloadedFile.size,
    targetVersion: normalizedUpdateInfo.version || ""
  });

  const version = formatDesktopDisplayVersion(normalizedUpdateInfo.version);
  setDesktopUpdateStatus("Update ready to install");
  setDesktopUpdateState({
    state: "downloaded",
    message: version ? `Update ${version} is ready to install.` : "Update ready to install.",
    progress: null,
    version
  });

  return {
    ok: true,
    status: "downloaded",
    version
  };
}

async function stageDesktopDebugReinstall(payload = {}) {
  if (!shouldEnableDesktopAutoUpdate()) {
    return { ok: false, reason: "unavailable" };
  }

  const autoUpdater = loadDesktopAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: "unavailable" };
  }

  if (!isDesktopNetworkOnline()) {
    const message = "Debug reinstall skipped while offline.";
    logDesktopUpdateEvent(`Desktop ${message.toLowerCase()}`);
    setDesktopUpdateStatus(message);
    setDesktopUpdateState({
      state: "offline",
      message,
      progress: null,
      version: ""
    });
    clearUpdateStatusSoon();
    return { ok: false, reason: "offline", message };
  }

  const requestedVersion = resolveDesktopDebugReinstallRequestVersion(payload);
  const currentVersion = app.getVersion();
  const requestedLabel = requestedVersion || currentVersion;

  setDesktopUpdateStatus("Preparing debug reinstall...", "indeterminate");
  setDesktopUpdateState({
    state: "checking",
    message: "Preparing debug reinstall...",
    progress: null,
    version: ""
  });

  try {
    const publishConfig = await autoUpdater.configOnDisk.value;
    const stagedRelease = await stageDesktopDebugRelease({
      requestedVersion,
      currentVersion,
      platform: process.platform,
      arch: process.arch,
      publishConfig,
      fetchText: fetchDesktopUpdateMetadataText
    });
    const targetVersion = formatDesktopDisplayVersion(stagedRelease.info?.version || stagedRelease.requestedVersion);
    const action =
      stagedRelease.comparison < 0
        ? "downgrade"
        : stagedRelease.comparison === 0
          ? "reinstall"
          : "update";
    const logPath = resolveDesktopUpdaterLogPathForCurrentRun();

    autoUpdater.allowDowngrade = stagedRelease.comparison < 0;
    autoUpdater.updateInfoAndProvider = {
      info: stagedRelease.info,
      provider: stagedRelease.provider
    };

    logDesktopUpdateEvent(
      `Prepared desktop debug ${action} ${targetVersion || stagedRelease.requestedVersion} from ${stagedRelease.tag} using ${stagedRelease.metadataFileName}.`
    );

    await appendDesktopUpdaterPersistentLog(logPath, "Prepared desktop debug reinstall staging.", {
      action,
      currentVersion,
      metadataFileName: stagedRelease.metadataFileName,
      metadataUrl: stagedRelease.metadataUrl,
      requestedVersion: requestedLabel,
      targetVersion: stagedRelease.info?.version || stagedRelease.requestedVersion,
      tag: stagedRelease.tag
    });

    setDesktopUpdateStatus(targetVersion ? `Update ${targetVersion} available` : "Update available");
    setDesktopUpdateState({
      state: "update-available",
      message: targetVersion ? `Update ${targetVersion} is available.` : "A desktop update is available.",
      progress: null,
      version: targetVersion
    });

    const downloadResult = await downloadDesktopUpdate();
    if (!downloadResult?.ok) {
      return downloadResult;
    }

    return {
      ok: true,
      action,
      metadataUrl: stagedRelease.metadataUrl,
      status: desktopUpdateState.state,
      tag: stagedRelease.tag,
      version: desktopUpdateState.version || targetVersion
    };
  } catch (error) {
    const formattedError = reportDesktopUpdateFailure(
      `Desktop debug reinstall preparation failed for ${requestedLabel}.`,
      error
    );
    return {
      ok: false,
      reason: "error",
      message: formattedError.summary
    };
  }
}

async function checkForDesktopUpdates({ userInitiated = false } = {}) {
  if (!shouldEnableDesktopAutoUpdate()) {
    return { ok: false, reason: "unavailable" };
  }

  const autoUpdater = loadDesktopAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: "unavailable" };
  }

  if (desktopUpdateCheckPromise) {
    return desktopUpdateCheckPromise;
  }

  if (!isDesktopNetworkOnline()) {
    const message = "Update check skipped while offline.";
    logDesktopUpdateEvent(`Desktop ${message.toLowerCase()}`);
    setDesktopUpdateStatus(message);
    setDesktopUpdateState({
      state: "offline",
      message,
      progress: null,
      version: ""
    });
    clearUpdateStatusSoon();
    return { ok: false, reason: "offline", message };
  }

  desktopUpdateCheckPromise = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = formatDesktopDisplayVersion(result?.updateInfo?.version);

      return {
        ok: true,
        status: desktopUpdateState.state || "checked",
        version
      };
    } catch (error) {
      const formattedError = reportDesktopUpdateFailure(
        userInitiated ? "Desktop update check failed." : "Desktop auto-update check failed.",
        error
      );

      return {
        ok: false,
        reason: "error",
        message: formattedError.summary
      };
    } finally {
      desktopUpdateCheckPromise = null;
    }
  })();

  return desktopUpdateCheckPromise;
}

async function downloadDesktopUpdate() {
  if (!shouldEnableDesktopAutoUpdate()) {
    return { ok: false, reason: "unavailable" };
  }

  const autoUpdater = loadDesktopAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: "unavailable" };
  }

  if (desktopUpdateState.state === "downloaded") {
    return { ok: true, status: "downloaded", version: desktopUpdateState.version || "" };
  }

  if (desktopUpdateDownloadPromise) {
    return desktopUpdateDownloadPromise;
  }

  if (desktopUpdateState.state !== "update-available") {
    return { ok: false, reason: "not-ready", message: "No downloaded desktop update is ready yet." };
  }

  desktopUpdateDownloadPromise = (async () => {
    try {
      const windowsArchFallbackResult = await downloadDesktopWindowsUpdateWithArchFallback(autoUpdater);
      if (windowsArchFallbackResult) {
        return windowsArchFallbackResult;
      }

      await autoUpdater.downloadUpdate();
      return {
        ok: true,
        status: "downloading",
        version: desktopUpdateState.version || ""
      };
    } catch (error) {
      const formattedError = reportDesktopUpdateFailure("Desktop update download failed.", error);
      return {
        ok: false,
        reason: "error",
        message: formattedError.summary
      };
    } finally {
      desktopUpdateDownloadPromise = null;
    }
  })();

  return desktopUpdateDownloadPromise;
}

async function installDesktopUpdate() {
  if (!shouldEnableDesktopAutoUpdate()) {
    return { ok: false, reason: "unavailable" };
  }

  const autoUpdater = loadDesktopAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: "unavailable" };
  }

  if (desktopUpdateState.state !== "downloaded") {
    return { ok: false, reason: "not-ready", message: "No downloaded update is ready to install yet." };
  }

  logDesktopUpdateEvent("Installing downloaded desktop update.");
  setDesktopUpdateStatus("Restarting to install update...");
  setDesktopUpdateState({
    state: "installing",
    message: "",
    progress: null
  });
  const logPath = resolveDesktopUpdaterLogPathForCurrentRun();
  const useSilentWindowsInstall = process.platform === "win32";

  try {
    await stopServerRuntime();
  } catch (error) {
    const formattedError = reportDesktopUpdateFailure("Desktop update install preparation failed.", error);
    return {
      ok: false,
      reason: "error",
      message: formattedError.summary
    };
  }

  try {
    await writeDesktopUpdaterInstallMarker({
      fromVersion: app.getVersion(),
      targetVersion: desktopUpdateState.version || "",
      userDataPath: app.getPath("userData")
    });
    await appendDesktopUpdaterPersistentLog(logPath, "Updater cleanup marker written.", {
      fromVersion: app.getVersion(),
      targetVersion: desktopUpdateState.version || ""
    });
  } catch (error) {
    await appendDesktopUpdaterPersistentLog(logPath, "Could not persist the updater cleanup marker.", {
      message: String(error?.message || error || "Unknown error")
    });
    logDesktopUpdateEvent("Could not persist the desktop updater cleanup marker.", {
      level: "warn",
      error
    });
  }

  await appendDesktopUpdaterPersistentLog(logPath, "Installing downloaded desktop update with the direct updater handoff.", {
    installerPath: autoUpdater?.installerPath || "",
    isForceRunAfter: useSilentWindowsInstall,
    isSilent: useSilentWindowsInstall,
    packagePath: autoUpdater?.downloadedUpdateHelper?.packageFile || "",
    targetVersion: desktopUpdateState.version || ""
  });

  logDesktopUpdateEvent("Installing downloaded desktop update with the direct updater handoff.");

  // Electron emits before-quit after updater-triggered window close events on macOS,
  // so the host must mark updater restarts as real quits before calling quitAndInstall().
  prepareDesktopForQuit();
  setImmediate(() => {
    autoUpdater.quitAndInstall(useSilentWindowsInstall, useSilentWindowsInstall);
  });

  return { ok: true, status: "installing", version: desktopUpdateState.version || "" };
}

function configureDesktopAutoUpdate() {
  if (!shouldEnableDesktopAutoUpdate()) {
    return;
  }

  const autoUpdater = loadDesktopAutoUpdater();
  if (!autoUpdater) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = console;

  autoUpdater.on("checking-for-update", () => {
    logDesktopUpdateEvent("Checking GitHub Releases for a desktop update...");
    setDesktopUpdateStatus("Checking for updates...", "indeterminate");
    setDesktopUpdateState({
      state: "checking",
      message: "Checking for updates...",
      progress: null,
      version: ""
    });
  });

  autoUpdater.on("update-available", (info) => {
    const version = formatDesktopDisplayVersion(info?.version);
    logDesktopUpdateEvent(version ? `Desktop update available: ${version}` : "Desktop update available.");
    setDesktopUpdateStatus(version ? `Update ${version} available` : "Update available");
    setDesktopUpdateState({
      state: "update-available",
      message: version ? `Update ${version} is available.` : "A desktop update is available.",
      progress: null,
      version
    });
  });

  autoUpdater.on("update-not-available", () => {
    logDesktopUpdateEvent("Desktop app is already up to date.");
    setDesktopUpdateStatus("");
    setDesktopUpdateState({
      state: "up-to-date",
      message: "",
      progress: null,
      version: ""
    });
  });

  autoUpdater.on("error", (error) => {
    reportDesktopUpdateFailure("Desktop auto-update failed.", error);
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Number(progress && progress.percent);
    if (!Number.isFinite(percent)) {
      setDesktopUpdateStatus("Downloading update...", "indeterminate");
      setDesktopUpdateState({
        state: "downloading",
        message: "Downloading update...",
        progress: null
      });
      return;
    }

    const message = `Downloading update ${Math.round(percent)}%`;
    setDesktopUpdateStatus(message, percent / 100);
    setDesktopUpdateState({
      state: "downloading",
      message,
      progress: percent / 100
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const version = formatDesktopDisplayVersion(info?.version);
    logDesktopUpdateEvent(version ? `Desktop update downloaded: ${version}` : "Desktop update downloaded.");
    setDesktopUpdateStatus("Update ready to install");
    setDesktopUpdateState({
      state: "downloaded",
      message: version ? `Update ${version} is ready to install.` : "Update ready to install.",
      progress: null,
      version
    });
  });
}

async function loadCreateAgentServer() {
  const serverModule = await import(pathToFileURL(SERVER_APP_PATH).href);
  return serverModule.createAgentServer;
}

function shouldShowConnectionChooser() {
  if (readConnectionRequestFromEnv()) {
    return false;
  }

  return app.isPackaged || String(process.env.SPACE_DESKTOP_SHOW_CHOOSER || "").trim() === "1";
}

function openConnectionChooser() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (pick) => {
      if (settled) {
        return;
      }

      settled = true;
      desktopChooserWindow = null;
      resolve(pick);
    };

    const chooser = new BrowserWindow({
      width: 520,
      height: 760,
      minWidth: 460,
      minHeight: 620,
      backgroundColor: "#040a12",
      title: "Open Constellation Agent",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    desktopChooserWindow = chooser;

    ipcMain.removeHandler(DESKTOP_CONNECTION_LIST_SAVED_CHANNEL);
    ipcMain.handle(DESKTOP_CONNECTION_LIST_SAVED_CHANNEL, () => {
      return normalizeSavedConnections(loadSavedConnectionRecords());
    });

    ipcMain.removeAllListeners(DESKTOP_CONNECTION_CHOOSE_CHANNEL);
    ipcMain.on(DESKTOP_CONNECTION_CHOOSE_CHANNEL, (event, payload = {}) => {
      if (event.sender !== chooser.webContents) {
        return;
      }

      const mode = String(payload?.mode || "").trim();
      if (mode === CONNECTION_MODE.STANDALONE) {
        finish({ mode: CONNECTION_MODE.STANDALONE });
        chooser.close();
        return;
      }

      const resolved = resolveConnectionConfig({
        mode: CONNECTION_MODE.CONNECTED,
        url: String(payload?.url || ""),
        label: String(payload?.label || ""),
        savedConnections: loadSavedConnectionRecords()
      });

      if (resolved.error) {
        chooser.webContents.send(DESKTOP_CONNECTION_STATUS_CHANNEL, { error: resolved.error });
        return;
      }

      if (payload?.save !== false) {
        saveConnectionRecord(resolved);
      }

      finish(resolved);
      chooser.close();
    });

    chooser.once("closed", () => finish(null));

    chooser.webContents.on("did-finish-load", () => {
      const screenshotPath = String(process.env.SPACE_DESKTOP_CHOOSER_E2E_SCREENSHOT || "").trim();
      if (screenshotPath) {
        setTimeout(() => {
          chooser.webContents
            .capturePage()
            .then((image) => {
              fs.writeFileSync(screenshotPath, image.toPNG());
              console.log(`[E2E] CHOOSER_SCREENSHOT ${screenshotPath}`);
              app.exit(0);
            })
            .catch((error) => {
              console.log(`[E2E] CHOOSER_SCREENSHOT_FAILED ${String(error && error.message ? error.message : error)}`);
              app.exit(1);
            });
        }, 900);
        return;
      }

      const scriptedPick = String(process.env.SPACE_DESKTOP_CHOOSER_E2E_PICK || "").trim();
      if (scriptedPick) {
        setTimeout(() => {
          chooser.webContents
            .executeJavaScript(`window.__spaceChooserPick(${JSON.stringify(scriptedPick)})`)
            .catch((error) => console.warn("[space-desktop] Scripted chooser pick failed.", error));
        }, 400);
      }
    });

    chooser.loadFile(path.join(__dirname, "connect.html"));
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#000000",
    title: BASE_WINDOW_TITLE,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  registerDesktopFramePreload(mainWindow.webContents);

  const mainWebContentsId = mainWindow.webContents.id;
  mainWindow.webContents.once("destroyed", () => {
    clearDesktopFrameInjectionRegistry(mainWebContentsId);
  });
  mainWindow.webContents.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) {
      return;
    }

    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (!frame) {
      return;
    }

    maybeInjectDesktopFrame(frame, mainWindow?.webContents);
  });
  mainWindow.webContents.on("will-navigate", (event, url, _isInPlace, isMainFrame = true) => {
    blockDesktopMainWindowNavigation(event, url, isMainFrame);
  });
  mainWindow.webContents.on("will-redirect", (event, url, _isInPlace, isMainFrame = true) => {
    blockDesktopMainWindowNavigation(event, url, isMainFrame);
  });
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const browserId = getDesktopBrowserIdFromWebviewPartition(params?.partition);
    if (!browserId) {
      return;
    }

    webPreferences.preload = DESKTOP_BROWSER_WEBVIEW_PRELOAD_PATH;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.sandbox = false;
    webPreferences.additionalArguments = [
      ...(Array.isArray(webPreferences.additionalArguments) ? webPreferences.additionalArguments : []),
      `--space-browser-id=${browserId}`
    ];
  });

  desktopPageTitle = BASE_WINDOW_TITLE;
  refreshDesktopWindowTitle();

  mainWindow.on("close", (event) => {
    // On macOS, Cmd+W should hide the app and preserve renderer state.
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    destroyAllDesktopBrowserViews();
    mainWindow = null;
    desktopPageTitle = BASE_WINDOW_TITLE;
  });

  mainWindow.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    desktopPageTitle = normalizeDesktopWindowTitle(title);
    refreshDesktopWindowTitle();
  });

  mainWindow.webContents.on("did-navigate", (_event, url) => {
    rememberDesktopSafeMainWindowUrl(url);
  });
  mainWindow.webContents.on("did-navigate-in-page", (_event, url, isMainFrame = true) => {
    if (isMainFrame === false) {
      return;
    }

    rememberDesktopSafeMainWindowUrl(url);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    rememberDesktopSafeMainWindowUrl();
    if (!isConnectedMode() && String(process.env.SPACE_DESKTOP_E2E_EXIT_AFTER_LOAD || "").trim() === "1") {
      const finishUrl = normalizeDesktopNavigationUrl(mainWindow?.webContents?.getURL?.() || "");
      const finishTitle = String(mainWindow?.webContents?.getTitle?.() || "");
      const expectedOrigin = resolveDesktopAppOrigin();
      mainWindow.webContents
        .executeJavaScript(
          "Boolean(window.spaceDesktop && window.spaceDesktop.browser && window.spaceDesktop.browser.available === true)"
        )
        .then((bridgeAvailable) => {
          const ok = Boolean(bridgeAvailable) && Boolean(expectedOrigin) && finishUrl.startsWith(expectedOrigin);
          console.log(
            `[E2E] ${ok ? "PASS" : "FAIL"} standalone-window origin=${finishUrl} pinned=${expectedOrigin} title=${JSON.stringify(finishTitle)} preloadBridge=${bridgeAvailable === true}`
          );
          setTimeout(() => app.exit(ok ? 0 : 1), 250);
        })
        .catch((error) => {
          console.log(`[E2E] FAIL standalone-window bridge check error=${String(error && error.message ? error.message : error)}`);
          setTimeout(() => app.exit(1), 250);
        });
    }
    if (isConnectedMode()) {
      console.log(`[space-desktop] Connected main window loaded: ${normalizeDesktopNavigationUrl(mainWindow?.webContents?.getURL?.() || "")}`);
      rememberConnectedServerOrigin();
      if (String(process.env.SPACE_DESKTOP_E2E_EXIT_AFTER_LOAD || "").trim() === "1") {
        const finishUrl = normalizeDesktopNavigationUrl(mainWindow?.webContents?.getURL?.() || "");
        const finishTitle = String(mainWindow?.webContents?.getTitle?.() || "");
        const expectedOrigin = String(connectionConfig?.origin || "");
        mainWindow.webContents
          .executeJavaScript(
            "Boolean(window.spaceDesktop && window.spaceDesktop.browser && window.spaceDesktop.browser.available === true)"
          )
          .then((bridgeAvailable) => {
            const ok = Boolean(bridgeAvailable) && Boolean(expectedOrigin) && finishUrl.startsWith(expectedOrigin);
            console.log(
              `[E2E] ${ok ? "PASS" : "FAIL"} connected-window origin=${finishUrl} pinned=${expectedOrigin} title=${JSON.stringify(finishTitle)} preloadBridge=${bridgeAvailable === true}`
            );
            setTimeout(() => app.exit(ok ? 0 : 1), 250);
          })
          .catch((error) => {
            console.log(`[E2E] FAIL connected-window bridge check error=${String(error && error.message ? error.message : error)}`);
            setTimeout(() => app.exit(1), 250);
          });
      }
    }
    desktopPageTitle = normalizeDesktopWindowTitle(mainWindow?.webContents?.getTitle?.() || desktopPageTitle);
    refreshDesktopWindowTitle();
    flushDesktopRendererLogs();
    mainWindow.webContents.send("space-desktop:update-status", desktopUpdateState);
  });
  mainWindow.webContents.on("did-start-navigation", (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && isDesktopMainWindowAllowedUrl(url)) {
      destroyAllDesktopBrowserViews();
    }
  });

  lastSafeMainWindowUrl = normalizeDesktopNavigationUrl(`${resolveDesktopBaseUrl()}${resolveDesktopLaunchPath()}`);
  mainWindow.loadURL(lastSafeMainWindowUrl);
  return mainWindow;
}

async function stopServerRuntime() {
  if (!serverRuntime) {
    return;
  }

  const runtime = serverRuntime;
  serverRuntime = null;

  if (typeof runtime.close === "function") {
    try {
      await runtime.close();
      return;
    } catch (error) {
      logDesktopUpdateEvent("Desktop server runtime close failed; falling back to best-effort shutdown.", {
        level: "warn",
        error
      });
    }
  }

  if (runtime.jobRunner && typeof runtime.jobRunner.stop === "function") {
    runtime.jobRunner.stop();
  }

  if (runtime.watchdog && typeof runtime.watchdog.stop === "function") {
    runtime.watchdog.stop();
  }

  if (runtime.tmpWatch && typeof runtime.tmpWatch.stop === "function") {
    runtime.tmpWatch.stop();
  }

  if (runtime.server && runtime.server.listening) {
    await new Promise((resolve) => {
      runtime.server.close(() => {
        resolve();
      });
    });
  }
}

async function resolveDesktopConnectionForLaunch() {
  const request = readConnectionRequestFromEnv();
  if (!request) {
    if (shouldShowConnectionChooser()) {
      const pick = await openConnectionChooser();
      if (pick && pick.mode === CONNECTION_MODE.CONNECTED && pick.origin) {
        console.log(`[space-desktop] Chooser selected connected: ${pick.origin}`);
        return pick;
      }

      console.log("[space-desktop] Chooser did not select a remote server; using standalone mode.");
      return resolveConnectionConfig({});
    }

    return resolveConnectionConfig({});
  }

  const resolved = resolveConnectionConfig({
    mode: request.mode,
    url: request.url,
    savedConnections: loadSavedConnectionRecords()
  });

  if (resolved.error) {
    console.warn(`[space-desktop] Connected mode unavailable: ${resolved.error} Falling back to standalone mode.`);
    return resolveConnectionConfig({});
  }

  console.log(`[space-desktop] Connected mode requested: ${resolved.origin}`);
  return resolved;
}

async function startDesktop() {
  await app.whenReady();
  await cleanupStaleDesktopUpdaterArtifacts();
  connectionConfig = await resolveDesktopConnectionForLaunch();

  if (!isConnectedMode()) {
    applyPackagedDesktopStorageOverrides();
    const runtimeParamOverrides = createDesktopRuntimeParamOverrides();
    const createAgentServer = await loadCreateAgentServer();
    serverRuntime = await createAgentServer(createDesktopServerOptions(runtimeParamOverrides));
    await serverRuntime.listen();
  }

  createWindow();
  configureDesktopAutoUpdate();

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindow();
      return;
    }

    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("space-desktop:get-runtime-info", () => getDesktopRuntimeInfo());
ipcMain.on(DESKTOP_BROWSER_CREATE_CHANNEL, (_event, payload = {}) => {
  createDesktopBrowserView(payload);
});
ipcMain.on(DESKTOP_BROWSER_UPDATE_CHANNEL, (_event, payload = {}) => {
  updateDesktopBrowserView(payload);
});
ipcMain.on(DESKTOP_BROWSER_DESTROY_CHANNEL, (_event, payload = {}) => {
  destroyDesktopBrowserView(payload.browserId);
});
ipcMain.on(DESKTOP_BROWSER_FOCUS_CHANNEL, (_event, payload = {}) => {
  focusDesktopBrowserView(payload.browserId);
});
ipcMain.on(DESKTOP_BROWSER_NAVIGATE_CHANNEL, (_event, payload = {}) => {
  navigateDesktopBrowserView(payload.browserId, payload.url);
});
ipcMain.on(DESKTOP_BROWSER_GO_BACK_CHANNEL, (_event, payload = {}) => {
  goBackDesktopBrowserView(payload.browserId);
});
ipcMain.on(DESKTOP_BROWSER_FORWARD_CHANNEL, (_event, payload = {}) => {
  goForwardDesktopBrowserView(payload.browserId);
});
ipcMain.on(DESKTOP_BROWSER_RELOAD_CHANNEL, (_event, payload = {}) => {
  reloadDesktopBrowserView(payload.browserId);
});
ipcMain.on(DESKTOP_BROWSER_ENVELOPE_FROM_RENDERER_CHANNEL, (_event, payload = {}) => {
  const entry = getDesktopBrowserViewEntry(payload.browserId);
  if (!entry || entry.view.webContents.isDestroyed()) {
    return;
  }

  entry.view.webContents.send(DESKTOP_BROWSER_ENVELOPE_TO_VIEW_CHANNEL, {
    envelope: payload.envelope
  });
});
ipcMain.on(DESKTOP_BROWSER_ENVELOPE_FROM_VIEW_CHANNEL, (event, payload = {}) => {
  const entry = getDesktopBrowserViewEntryByWebContents(event.sender.id);
  if (!entry) {
    return;
  }

  sendDesktopBrowserEnvelopeToRenderer(entry.browserId, payload.envelope);
});
ipcMain.on(DESKTOP_FRAME_INJECT_REGISTER_CHANNEL, (event, payload = {}) => {
  replaceDesktopFrameInjectionRegistry(event.sender.id, payload.frames);
  injectRegisteredDesktopFrames(event.sender);
});
ipcMain.handle("space-desktop:check-for-updates", () => checkForDesktopUpdates({ userInitiated: true }));
ipcMain.handle("space-desktop:download-update", () => downloadDesktopUpdate());
ipcMain.handle("space-desktop:install-update", () => installDesktopUpdate());
ipcMain.handle("space-desktop:debug-reinstall", (_event, payload) => stageDesktopDebugReinstall(payload));

app.on("before-quit", () => {
  prepareDesktopForQuit();
  void stopServerRuntime();
});

startDesktop().catch((error) => {
  console.error("Failed to start desktop harness.");
  console.error(error);
  app.quit();
});
