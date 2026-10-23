const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { contextBridge, ipcRenderer } = require("electron");

const REQUEST_CHANNEL = "space-browser-component-harness:request";
const RESPONSE_CHANNEL = "space-browser-component-harness:response";
const PROGRESS_CHANNEL = "space-browser-component-harness:progress";
const SCENARIO_ENV = "SPACE_BROWSER_COMPONENT_HARNESS_SCENARIO";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const WEB_BROWSING_ROOT = path.join(PROJECT_ROOT, "app", "L0", "_all", "modules", "_core", "web_browsing");
const GUEST_RUNTIME_PATHS = Object.freeze({
  bootstrap: path.join(WEB_BROWSING_ROOT, "browser-frame-inject.js"),
  content: path.join(WEB_BROWSING_ROOT, "browser-page-content.js"),
  handlers: path.join(WEB_BROWSING_ROOT, "ext", "browser_guest_runtime", "core", "handle-message.js")
});

const harnessRequestListeners = new Set();

function readSourceWithSourceUrl(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const sourceUrl = pathToFileURL(filePath).href.replace(/[\r\n]+/gu, " ");
  return `${source}\n//# sourceURL=${sourceUrl}`;
}

const guestRuntimeSources = Object.freeze({
  bootstrap: readSourceWithSourceUrl(GUEST_RUNTIME_PATHS.bootstrap),
  content: readSourceWithSourceUrl(GUEST_RUNTIME_PATHS.content),
  handlers: readSourceWithSourceUrl(GUEST_RUNTIME_PATHS.handlers)
});

function normalizeText(value) {
  return String(value || "").trim();
}

function dispatchHarnessRequest(payload = {}) {
  harnessRequestListeners.forEach((listener) => {
    listener(payload);
  });
}

ipcRenderer.on(REQUEST_CHANNEL, (_event, payload = {}) => {
  dispatchHarnessRequest(payload);
});

contextBridge.exposeInMainWorld("browserHarnessHost", {
  buildGuestRuntimeSource(browserId = "browser-1") {
    const normalizedBrowserId = normalizeText(browserId) || "browser-1";
    const scriptUrl = pathToFileURL(GUEST_RUNTIME_PATHS.bootstrap).href.replace(/[\r\n]+/gu, " ");

    return {
      browserId: normalizedBrowserId,
      injectPath: "/modules/_core/web_browsing/browser-frame-inject.js",
      scriptUrl,
      source: [
        guestRuntimeSources.bootstrap,
        guestRuntimeSources.content,
        guestRuntimeSources.handlers
      ].join("\n;\n")
    };
  },
  config: {
    scenario: normalizeText(process.env[SCENARIO_ENV])
  },
  onRequest(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    harnessRequestListeners.add(listener);
    return () => {
      harnessRequestListeners.delete(listener);
    };
  },
  reportProgress(payload = {}) {
    ipcRenderer.send(PROGRESS_CHANNEL, payload);
  },
  respond(payload = {}) {
    ipcRenderer.send(RESPONSE_CHANNEL, payload);
  }
});
