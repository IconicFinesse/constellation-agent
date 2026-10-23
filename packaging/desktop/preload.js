const { contextBridge, ipcRenderer } = require("electron");
const DESKTOP_LAUNCHER_BRIDGE_PATHS = new Set([
  "/enter",
  "/login"
]);
const DESKTOP_BROWSER_WEBVIEW_PARTITION_PREFIX = "space-browser-";
const DESKTOP_BROWSER_WEBVIEW_PRELOAD_URL = (() => {
  const baseDir = String(typeof __dirname === "string" ? __dirname : "")
    .replace(/\\/gu, "/")
    .replace(/\/+$/u, "");
  const normalizedBaseDir = baseDir.startsWith("/") ? baseDir : `/${baseDir}`;
  return `file://${encodeURI(`${normalizedBaseDir}/browser-webview-preload.js`)}`;
})();
const DESKTOP_BROWSER_CREATE_CHANNEL = "space-desktop:browser-view-create";
const DESKTOP_BROWSER_DESTROY_CHANNEL = "space-desktop:browser-view-destroy";
const DESKTOP_BROWSER_ENVELOPE_FROM_MAIN_CHANNEL = "space-desktop:browser-envelope-to-renderer";
const DESKTOP_BROWSER_ENVELOPE_TO_MAIN_CHANNEL = "space-desktop:browser-envelope-from-renderer";
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

const browserEnvelopeListeners = new Map();
const browserHostEventListeners = new Set();

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeBrowserBounds(bounds = {}) {
  return {
    height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    width: Math.max(0, Math.round(Number(bounds.width) || 0)),
    x: Math.round(Number(bounds.x) || 0),
    y: Math.round(Number(bounds.y) || 0)
  };
}

function normalizeBrowserViewPayload(payload = {}) {
  return {
    bounds: normalizeBrowserBounds(payload.bounds),
    browserId: normalizeText(payload.browserId),
    injectPath: normalizeText(payload.injectPath),
    url: normalizeText(payload.url),
    visible: payload.visible !== false
  };
}

function dispatchBrowserEnvelope(payload = {}) {
  const browserId = normalizeText(payload.browserId);
  const envelope = payload.envelope;
  if (!browserId) {
    return;
  }

  const listeners = browserEnvelopeListeners.get(browserId);
  if (!listeners || !listeners.size) {
    return;
  }

  listeners.forEach((listener) => {
    listener(envelope);
  });
}

function dispatchBrowserHostEvent(payload = {}) {
  const event = {
    browserId: normalizeText(payload.browserId),
    disposition: normalizeText(payload.disposition),
    frameName: normalizeText(payload.frameName),
    referrerUrl: normalizeText(payload.referrerUrl),
    type: normalizeText(payload.type),
    url: normalizeText(payload.url)
  };

  browserHostEventListeners.forEach((listener) => {
    listener(event);
  });
}

ipcRenderer.on("space-desktop:update-status", (_event, payload) => {
  window.dispatchEvent(new CustomEvent("space-desktop:update-status", {
    detail: payload
  }));
});
ipcRenderer.on(DESKTOP_BROWSER_ENVELOPE_FROM_MAIN_CHANNEL, (_event, payload = {}) => {
  dispatchBrowserEnvelope(payload);
});
ipcRenderer.on(DESKTOP_BROWSER_HOST_EVENT_CHANNEL, (_event, payload = {}) => {
  dispatchBrowserHostEvent(payload);
});

const debugReinstall = (version = "") => ipcRenderer.invoke("space-desktop:debug-reinstall", {
  version
});

contextBridge.exposeInMainWorld("spaceDesktop", {
  browser: {
    available: true,
    webviewPartitionPrefix: DESKTOP_BROWSER_WEBVIEW_PARTITION_PREFIX,
    webviewPreloadURL: DESKTOP_BROWSER_WEBVIEW_PRELOAD_URL,
    create(payload = {}) {
      ipcRenderer.send(DESKTOP_BROWSER_CREATE_CHANNEL, normalizeBrowserViewPayload(payload));
    },
    destroy(browserId = "") {
      ipcRenderer.send(DESKTOP_BROWSER_DESTROY_CHANNEL, {
        browserId: normalizeText(browserId)
      });
    },
    focus(browserId = "") {
      ipcRenderer.send(DESKTOP_BROWSER_FOCUS_CHANNEL, {
        browserId: normalizeText(browserId)
      });
    },
    goBack(browserId = "") {
      ipcRenderer.send(DESKTOP_BROWSER_GO_BACK_CHANNEL, {
        browserId: normalizeText(browserId)
      });
    },
    goForward(browserId = "") {
      ipcRenderer.send(DESKTOP_BROWSER_FORWARD_CHANNEL, {
        browserId: normalizeText(browserId)
      });
    },
    navigate(browserId = "", url = "") {
      ipcRenderer.send(DESKTOP_BROWSER_NAVIGATE_CHANNEL, {
        browserId: normalizeText(browserId),
        url: normalizeText(url)
      });
    },
    onEnvelope(browserId = "", listener) {
      const normalizedBrowserId = normalizeText(browserId);
      if (!normalizedBrowserId || typeof listener !== "function") {
        return () => {};
      }

      if (!browserEnvelopeListeners.has(normalizedBrowserId)) {
        browserEnvelopeListeners.set(normalizedBrowserId, new Set());
      }

      const listeners = browserEnvelopeListeners.get(normalizedBrowserId);
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          browserEnvelopeListeners.delete(normalizedBrowserId);
        }
      };
    },
    onHostEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }

      browserHostEventListeners.add(listener);
      return () => {
        browserHostEventListeners.delete(listener);
      };
    },
    postEnvelope(browserId = "", envelope = null) {
      ipcRenderer.send(DESKTOP_BROWSER_ENVELOPE_TO_MAIN_CHANNEL, {
        browserId: normalizeText(browserId),
        envelope
      });
    },
    reload(browserId = "") {
      ipcRenderer.send(DESKTOP_BROWSER_RELOAD_CHANNEL, {
        browserId: normalizeText(browserId)
      });
    },
    update(payload = {}) {
      ipcRenderer.send(DESKTOP_BROWSER_UPDATE_CHANNEL, normalizeBrowserViewPayload(payload));
    }
  },
  connection: {
    choose(payload = {}) {
      ipcRenderer.send(DESKTOP_CONNECTION_CHOOSE_CHANNEL, {
        label: normalizeText(payload.label),
        mode: normalizeText(payload.mode),
        save: payload.save !== false,
        url: normalizeText(payload.url)
      });
    },
    listSaved() {
      return ipcRenderer.invoke(DESKTOP_CONNECTION_LIST_SAVED_CHANNEL);
    },
    onStatus(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }

      const handler = (_event, payload = {}) => {
        listener(payload);
      };
      ipcRenderer.on(DESKTOP_CONNECTION_STATUS_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(DESKTOP_CONNECTION_STATUS_CHANNEL, handler);
      };
    }
  }
});

if (DESKTOP_LAUNCHER_BRIDGE_PATHS.has(globalThis.location?.pathname || "")) {
  contextBridge.exposeInMainWorld("space", {
    platform: process.platform,
    getRuntimeInfo: () => ipcRenderer.invoke("space-desktop:get-runtime-info"),
    checkForUpdates: () => ipcRenderer.invoke("space-desktop:check-for-updates"),
    downloadUpdate: () => ipcRenderer.invoke("space-desktop:download-update"),
    installUpdate: () => ipcRenderer.invoke("space-desktop:install-update"),
    debugReinstall
  });
}
