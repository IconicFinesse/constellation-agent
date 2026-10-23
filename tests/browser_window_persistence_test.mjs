import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const PERSISTED_BROWSER_WINDOWS_STORAGE_KEY = "space.web_browsing.windows.v1";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName || "").toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.isConnected = true;
    this.style = {
      setProperty() {}
    };
    this.tabIndex = 0;
    this.__listeners = new Map();
  }

  addEventListener(eventName, handler) {
    if (!this.__listeners.has(eventName)) {
      this.__listeners.set(eventName, new Set());
    }

    this.__listeners.get(eventName).add(handler);
  }

  dispatchEvent(eventName, payload = {}) {
    const listeners = this.__listeners.get(eventName);
    if (!listeners) {
      return;
    }

    listeners.forEach((handler) => {
      handler({
        currentTarget: this,
        target: this,
        type: eventName,
        ...payload
      });
    });
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeEventListener(eventName, handler) {
    this.__listeners.get(eventName)?.delete(handler);
  }

  remove() {
    this.isConnected = false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

class FakeIframeElement extends FakeElement {
  constructor() {
    super("iframe");
    this.src = "";
    this.contentDocument = {
      readyState: "complete",
      title: ""
    };
    this.contentWindow = {
      history: {
        length: 1
      },
      location: {
        href: ""
      }
    };
  }
}

class FakeWebviewElement extends FakeElement {
  constructor() {
    super("webview");
    this.focusCalls = 0;
    this.shadowRoot = null;
    this.src = "";
  }

  focus() {
    this.focusCalls += 1;
  }
}

function createFakeLocalStorage() {
  const values = new Map();

  return {
    clear() {
      values.clear();
    },
    dump(key) {
      return values.has(key) ? values.get(key) : null;
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
}

function createFakeDocument() {
  return {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
    getElementById() {
      return null;
    },
    getElementsByName() {
      return [];
    }
  };
}

function createStoreRuntime() {
  const runtime = {
    extend(_meta, value) {
      return value;
    },
    fw: {
      createStore(_name, model) {
        const store = Object.create(Object.getPrototypeOf(model));
        Object.defineProperties(store, Object.getOwnPropertyDescriptors(model));
        Object.assign(store, {
          browserSurfaces: [],
          frameConnections: Object.create(null),
          interaction: null,
          lastInteractedBrowserId: "",
          lastInteractedBrowserInstanceKey: null,
          observedNavigationVersions: Object.create(null),
          offDesktopBrowserHostEvents: null,
          pendingNavigations: Object.create(null),
          persistedWindowsWriteTimeoutId: null,
          syncTokens: Object.create(null),
          windows: []
        });
        runtime.__store = store;
        return store;
      }
    }
  };

  globalThis.space = runtime;
  globalThis.spaceDesktop = {
    browser: {
      available: false
    }
  };
  return runtime;
}

async function withStoreEnvironment(run, options = {}) {
  const original = {
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
    ShadowRoot: globalThis.ShadowRoot,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    location: globalThis.location,
    space: globalThis.space,
    spaceDesktop: globalThis.spaceDesktop,
    window: globalThis.window
  };

  const fakeLocalStorage = createFakeLocalStorage();
  const fakeDocument = createFakeDocument();
  const fakeLocation = new URL("http://example.test/");

  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  globalThis.MutationObserver = class FakeMutationObserver {
    disconnect() {}
    observe() {}
  };
  globalThis.ResizeObserver = class FakeResizeObserver {
    disconnect() {}
    observe() {}
  };
  globalThis.ShadowRoot = class FakeShadowRoot {};
  globalThis.document = fakeDocument;
  globalThis.getComputedStyle = () => ({ fontSize: "16px" });
  globalThis.localStorage = fakeLocalStorage;
  globalThis.location = fakeLocation;
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  globalThis.window = {
    innerHeight: options.innerHeight ?? 720,
    innerWidth: options.innerWidth ?? 1280,
    location: fakeLocation
  };

  const runtime = createStoreRuntime();
  const moduleUrl = pathToFileURL(path.resolve("app/L0/_all/modules/_core/web_browsing/store.js")).href;

  try {
    await import(`${moduleUrl}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await run({
      runtime,
      storage: fakeLocalStorage,
      store: runtime.__store,
      window: globalThis.window
    });
  } finally {
    globalThis.Element = original.Element;
    globalThis.HTMLElement = original.HTMLElement;
    globalThis.MutationObserver = original.MutationObserver;
    globalThis.ResizeObserver = original.ResizeObserver;
    globalThis.ShadowRoot = original.ShadowRoot;
    globalThis.document = original.document;
    globalThis.getComputedStyle = original.getComputedStyle;
    globalThis.localStorage = original.localStorage;
    globalThis.requestAnimationFrame = original.requestAnimationFrame;
    globalThis.location = original.location;
    globalThis.space = original.space;
    globalThis.spaceDesktop = original.spaceDesktop;
    globalThis.window = original.window;
  }
}

test("browser store restores persisted windows on mount and clamps them to the viewport", async () => {
  await withStoreEnvironment(async ({ storage, store }) => {
    storage.setItem(PERSISTED_BROWSER_WINDOWS_STORAGE_KEY, JSON.stringify([
      {
        id: "browser-1",
        instanceKey: 7,
        isMinimized: true,
        position: {
          x: 9_999,
          y: 9_999
        },
        size: {
          height: 9_999,
          width: 9_999
        },
        url: "https://example.com/ethereum",
        zIndex: 2147481300
      }
    ]));

    store.mount();

    assert.equal(store.windows.length, 1);
    const browserWindow = store.windows[0];
    const panelSize = store.getPanelSize(browserWindow);

    assert.equal(browserWindow.currentUrl, "https://example.com/ethereum");
    assert.equal(browserWindow.frameSrc, "https://example.com/ethereum");
    assert.equal(browserWindow.addressValue, "https://example.com/ethereum");
    assert.equal(browserWindow.isMinimized, true);
    assert.equal(browserWindow.instanceKey, 7);
    assert.equal(browserWindow.id, "browser-1");
    assert.ok(browserWindow.position.x >= 16);
    assert.ok(browserWindow.position.y >= 0);
    assert.ok(browserWindow.position.x + panelSize.width <= 1280 - 16);
    assert.ok(browserWindow.position.y + panelSize.height <= 720 - 16);

    const persistedWindows = JSON.parse(storage.dump(PERSISTED_BROWSER_WINDOWS_STORAGE_KEY));
    assert.equal(persistedWindows.length, 1);
    assert.equal(persistedWindows[0].position.x, browserWindow.position.x);
    assert.equal(persistedWindows[0].position.y, browserWindow.position.y);

    const nextWindowId = store.createWindow({
      url: "https://example.com/next"
    });
    assert.equal(nextWindowId, "browser-2");
  });
});

test("browser store persists viewport-fitted geometry after resize", async () => {
  await withStoreEnvironment(async ({ storage, store, window }) => {
    const browserId = store.createWindow({
      url: "https://example.com/initial"
    });
    const browserWindow = store.getWindow(browserId);

    browserWindow.position = {
      x: 1_100,
      y: 640
    };
    browserWindow.size = {
      height: 690,
      width: 1_240
    };

    window.innerWidth = 960;
    window.innerHeight = 580;
    store.handleViewportResize();

    assert.ok(browserWindow.position.x >= 16);
    assert.ok(browserWindow.position.y >= 0);
    assert.ok(browserWindow.position.x + browserWindow.size.width <= 960 - 16);
    assert.ok(browserWindow.position.y + browserWindow.size.height <= 580 - 16);

    const persistedWindows = JSON.parse(storage.dump(PERSISTED_BROWSER_WINDOWS_STORAGE_KEY));
    assert.equal(persistedWindows.length, 1);
    assert.equal(persistedWindows[0].position.x, browserWindow.position.x);
    assert.equal(persistedWindows[0].position.y, browserWindow.position.y);
    assert.equal(persistedWindows[0].size.width, browserWindow.size.width);
    assert.equal(persistedWindows[0].size.height, browserWindow.size.height);
  });
});

test("browser store registers inline x-browser elements as generic browser surfaces", async () => {
  await withStoreEnvironment(async ({ store }) => {
    const browserElement = new FakeElement("x-browser");
    browserElement.setAttribute("src", "google.com");

    const browserSurface = store.registerBrowserElement(browserElement, {
      src: browserElement.getAttribute("src")
    });

    assert.equal(browserSurface.id, "browser-1");
    assert.equal(browserElement.dataset.browserId, "browser-1");
    assert.equal(browserSurface.currentUrl, "https://google.com/");
    assert.equal(browserSurface.frameSrc, "https://google.com/");
    assert.equal(browserSurface.isWindow, false);
    assert.equal(store.getWindow("browser-1"), null);
    assert.deepEqual(store.getBrowserList().map((entry) => entry.id), ["browser-1"]);
    assert.equal(store.hasOpenBrowsers, true);

    store.updateBrowserElementSource(browserElement, "localhost:3000");
    assert.equal(browserSurface.currentUrl, "http://localhost:3000/");
    assert.equal(browserSurface.frameSrc, "http://localhost:3000/");

    store.rememberBrowserInteraction("browser-1", "focus");
    assert.equal(store.lastInteractedBrowserId, "browser-1");
    assert.equal(store.lastInteractedBrowserInstanceKey, browserSurface.instanceKey);

    store.unregisterBrowserElement(browserElement);
    assert.equal(store.hasOpenBrowsers, false);
    assert.equal(store.getBrowser("browser-1"), null);
  });
});

test("browser store raises a window when its iframe surface is focused directly", async () => {
  await withStoreEnvironment(async ({ store }) => {
    const firstId = store.createWindow({
      url: "https://example.com/first"
    });
    const secondId = store.createWindow({
      url: "https://example.com/second"
    });

    const firstWindow = store.getWindow(firstId);
    const secondWindow = store.getWindow(secondId);
    const iframe = new FakeIframeElement();
    iframe.src = firstWindow.frameSrc;
    iframe.contentWindow.location.href = firstWindow.frameSrc;

    const previousTopZIndex = Math.max(firstWindow.zIndex, secondWindow.zIndex);
    store.registerIframe(firstId, iframe);
    iframe.dispatchEvent("focus");

    assert.ok(firstWindow.zIndex > previousTopZIndex);
    assert.ok(firstWindow.zIndex > secondWindow.zIndex);
  });
});

test("browser store raises a window when its webview surface is clicked directly", async () => {
  await withStoreEnvironment(async ({ store }) => {
    const firstId = store.createWindow({
      url: "https://example.com/first"
    });
    const secondId = store.createWindow({
      url: "https://example.com/second"
    });

    const firstWindow = store.getWindow(firstId);
    const secondWindow = store.getWindow(secondId);
    const webview = new FakeWebviewElement();
    const previousTopZIndex = Math.max(firstWindow.zIndex, secondWindow.zIndex);

    store.registerWebview(firstId, webview, firstWindow.frameSrc);
    webview.dispatchEvent("pointerdown");

    assert.ok(firstWindow.zIndex > previousTopZIndex);
    assert.ok(firstWindow.zIndex > secondWindow.zIndex);
    assert.ok(webview.focusCalls >= 1);
  });
});
