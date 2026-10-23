import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

function createStoreRuntime() {
  const runtime = {
    extend(_meta, value) {
      return value;
    },
    fw: {
      createStore(_name, model) {
        const store = {
          ...model,
          frameConnections: Object.create(null),
          interaction: null,
          lastInteractedBrowserId: "",
          lastInteractedBrowserInstanceKey: null,
          observedNavigationVersions: Object.create(null),
          offDesktopBrowserHostEvents: null,
          pendingNavigations: Object.create(null),
          syncTokens: Object.create(null),
          windows: []
        };
        runtime.__store = store;
        return store;
      }
    }
  };

  globalThis.space = runtime;
  globalThis.spaceDesktop = {
    browser: {
      available: true
    }
  };
  return runtime;
}

async function loadWebBrowsingStoreModule() {
  const runtime = createStoreRuntime();
  const moduleUrl = pathToFileURL(path.resolve("app/L0/_all/modules/_core/web_browsing/store.js")).href;
  await import(`${moduleUrl}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    runtime,
    store: runtime.__store
  };
}

function createBrowserWindowState(url, overrides = {}) {
  return {
    addressValue: url,
    bridgeHandlersReady: true,
    bridgeStateReady: true,
    bridgeTransportReady: true,
    canGoBack: true,
    canGoForward: false,
    currentUrl: url,
    frameSrc: url,
    id: "browser-1",
    instanceKey: 3,
    isMinimized: false,
    loading: false,
    position: {
      x: 101,
      y: 88
    },
    size: {
      height: 698,
      width: 1344
    },
    title: "",
    zIndex: 2147481215,
    ...overrides
  };
}

test("browser store does not query the old guest bridge while navigation is still unobserved", async () => {
  const youtubeUrl = "https://www.youtube.com/@AgentZeroFW/videos";
  const githubUrl = "https://github.com/frdel/agent-zero";
  const { store } = await loadWebBrowsingStoreModule();
  const browserWindow = createBrowserWindowState(youtubeUrl, {
    addressValue: githubUrl,
    currentUrl: githubUrl,
    frameSrc: githubUrl,
    title: "Agent Zero - YouTube"
  });

  store.windows = [browserWindow];
  store.startPendingNavigation("browser-1");

  const bridgeRequests = [];
  store.requestBridgePayload = async (_id, type) => {
    bridgeRequests.push(type);
    return {
      canGoBack: true,
      canGoForward: false,
      title: "Agent Zero - YouTube",
      url: youtubeUrl
    };
  };

  const synced = await store.syncNavigationState("browser-1", {
    attempts: 1
  });

  assert.equal(synced, false);
  assert.deepEqual(bridgeRequests, []);
  assert.equal(browserWindow.currentUrl, githubUrl);
  assert.equal(browserWindow.frameSrc, githubUrl);
  assert.equal(browserWindow.title, "Agent Zero - YouTube");
});

test("space.browser.navigate waits for observed browser navigation before returning state", async () => {
  const youtubeUrl = "https://www.youtube.com/@AgentZeroFW/videos";
  const githubUrl = "https://github.com/frdel/agent-zero";
  const githubTitle = "GitHub - frdel/agent-zero: Agent Zero AI framework · GitHub";
  const { runtime, store } = await loadWebBrowsingStoreModule();
  const browserWindow = createBrowserWindowState(youtubeUrl, {
    title: "Agent Zero - YouTube"
  });

  store.windows = [browserWindow];
  store.focusWindow = () => {};

  const stateReadVersions = [];
  store.requestBridgePayload = async (id, type) => {
    if (type === "location_navigate") {
      return {
        scheduled: "navigate",
        state: {
          url: githubUrl
        }
      };
    }

    if (type === "navigation_state_get") {
      stateReadVersions.push(store.getObservedNavigationVersion(id));
      if (store.getObservedNavigationVersion(id) === 0) {
        return {
          canGoBack: true,
          canGoForward: false,
          loading: false,
          title: "Agent Zero - YouTube",
          url: youtubeUrl
        };
      }

      return {
        canGoBack: false,
        canGoForward: false,
        loading: false,
        title: githubTitle,
        url: githubUrl
      };
    }

    return null;
  };

  const observation = (async () => {
    await delay(40);
    browserWindow.loading = true;
    browserWindow.bridgeHandlersReady = false;
    browserWindow.bridgeStateReady = false;
    browserWindow.bridgeTransportReady = false;
    store.markNavigationObserved("browser-1");

    await delay(40);
    browserWindow.loading = false;
    browserWindow.addressValue = githubUrl;
    browserWindow.bridgeHandlersReady = true;
    browserWindow.bridgeStateReady = true;
    browserWindow.bridgeTransportReady = true;
    browserWindow.canGoBack = false;
    browserWindow.currentUrl = githubUrl;
    browserWindow.frameSrc = githubUrl;
    browserWindow.title = githubTitle;
  })();

  const result = await runtime.browser.navigate(1, githubUrl);
  await observation;

  assert.equal(result?.currentUrl, githubUrl, JSON.stringify({
    result,
    stateReadVersions
  }, null, 2));
  assert.equal(result?.frameSrc, githubUrl, JSON.stringify({
    result,
    stateReadVersions
  }, null, 2));
  assert.equal(result?.title, githubTitle, JSON.stringify({
    result,
    stateReadVersions
  }, null, 2));
  assert.ok(stateReadVersions.length >= 1, JSON.stringify({
    result,
    stateReadVersions
  }, null, 2));
  assert.ok(stateReadVersions.every((version) => version > 0), JSON.stringify({
    result,
    stateReadVersions
  }, null, 2));
});
