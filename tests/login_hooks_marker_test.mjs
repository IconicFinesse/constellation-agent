import assert from "node:assert/strict";
import test from "node:test";

/**
 * Regression coverage for the first-login marker written after a failed onboarding.
 *
 * Root cause: `_core/framework/js/extensions.js` dispatched every JS hook through a
 * try/catch that only logged, so `_core/login_hooks` always reached its marker write
 * even when the Big Bang onboarding hook threw. The marker then suppressed onboarding
 * forever. The checked dispatch added for the first-login point propagates the first
 * hook error, and the marker is only written when that call resolved.
 *
 * These cases drive the real `login-hooks.js` module. The failure and success cases do
 * not inject a caller: they prime the real extension cache so the production checked
 * dispatch (`callJsExtensionsChecked`) is what runs, which is exactly the layer that
 * used to swallow the error. One extra case keeps the legacy injectable seam honest.
 */

// --- browser globals required to import the real framework extension module ---------

class FakeHTMLElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener() {}

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

class FakeMutationObserver {
  observe() {}

  disconnect() {}
}

const fakeHead = new FakeHTMLElement("head");
const fakeDocumentElement = new FakeHTMLElement("html");
fakeDocumentElement.querySelectorAll = () => [];

function installBrowserGlobals() {
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.document = {
    addEventListener() {},
    createElement: (tagName) => new FakeHTMLElement(tagName),
    documentElement: fakeDocumentElement,
    head: fakeHead,
    querySelector: () => null,
    readyState: "complete"
  };
  globalThis.location = { origin: "http://space.test" };
  // Hermetic: no test may reach the network through the extension loader.
  globalThis.fetch = async () => {
    throw new Error("network disabled in this test");
  };
}

installBrowserGlobals();

const LOGIN_HOOKS_MODULE = "../app/L0/_all/modules/_core/login_hooks/login-hooks.js";
const EXTENSIONS_MODULE = "../app/L0/_all/modules/_core/framework/js/extensions.js";
const CACHE_MODULE = "../app/L0/_all/modules/_core/framework/js/cache.js";

const {
  ANY_LOGIN_EXTENSION_POINT,
  FIRST_LOGIN_EXTENSION_POINT,
  LOGIN_HOOKS_STATE_PATH,
  buildLoginHooksStateContent,
  executeLoginHooksBootstrap
} = await import(LOGIN_HOOKS_MODULE);
const { callJsExtensions, callJsExtensionsChecked } = await import(EXTENSIONS_MODULE);
const extensionCache = await import(CACHE_MODULE);

const JS_CACHE_AREA = "frontend_extensions_js(extensions)";
const FIXED_NOW = "2026-10-24T09:30:00.000Z";

function primeJsExtensions(extensionPoint, handlers) {
  // Mirrors createExtensionCacheKey() for the default (unclamped) page: the cached
  // import list is what the production dispatcher consumes.
  const cacheKey = JSON.stringify({ extensionPoint, maxLayer: null, scope: "js" });

  extensionCache.add(
    JS_CACHE_AREA,
    cacheKey,
    handlers.map((handler, index) => ({
      module: { default: handler },
      path: `/modules/_core/test/ext/js/${extensionPoint}/${index}.js`
    }))
  );
}

function createRuntime({ markerExists = false } = {}) {
  const writes = [];

  return {
    runtime: {
      api: {
        async fileInfo(path) {
          assert.equal(path, LOGIN_HOOKS_STATE_PATH);

          if (markerExists) {
            return { path };
          }

          throw new Error("File not found.");
        },
        async fileWrite(path, content, encoding) {
          writes.push({ content, encoding, path });
          return { path };
        },
        async userSelfInfo() {
          return {
            fullName: "Alice Example",
            groups: ["_all"],
            managedGroups: [],
            username: "alice"
          };
        }
      }
    },
    writes
  };
}

function captureConsoleError() {
  const messages = [];
  const original = console.error;

  console.error = (...args) => {
    messages.push(args);
  };

  return {
    messages,
    restore() {
      console.error = original;
    }
  };
}

function resetExtensionCache() {
  extensionCache.clear_all();
}

test("a throwing first-login hook does not write the marker", async () => {
  resetExtensionCache();
  primeJsExtensions(FIRST_LOGIN_EXTENSION_POINT, [
    async () => {
      throw new Error("big bang install failed");
    }
  ]);

  const { runtime, writes } = createRuntime({ markerExists: false });
  const captured = captureConsoleError();
  let result;

  try {
    result = await executeLoginHooksBootstrap({
      now: FIXED_NOW,
      origin: "http://space.test",
      referrer: "http://space.test/enter",
      runtime
    });
  } finally {
    captured.restore();
  }

  assert.equal(writes.length, 0, "the marker must not be written when onboarding failed");
  assert.equal(result.isFirstLogin, true);
  assert.equal(result.markerExists, false);
  assert.equal(result.ranFirstLogin, false);
  assert.equal(result.ranAnyLogin, false);
  assert.equal(captured.messages.length, 1, "one console.error, not a silent swallow");
  assert.match(String(captured.messages[0][0] || ""), /first-login marker not written/u);
  assert.match(String(captured.messages[0][1]?.message || ""), /big bang install failed/u);
});

test("a clean first-login hook writes the marker once", async () => {
  resetExtensionCache();
  const hookCalls = [];

  primeJsExtensions(FIRST_LOGIN_EXTENSION_POINT, [
    async (context) => {
      hookCalls.push(context);
    }
  ]);

  const { runtime, writes } = createRuntime({ markerExists: false });
  const captured = captureConsoleError();
  let result;

  try {
    result = await executeLoginHooksBootstrap({
      now: FIXED_NOW,
      origin: "http://space.test",
      referrer: "http://space.test/enter",
      runtime
    });
  } finally {
    captured.restore();
  }

  assert.equal(hookCalls.length, 1, "the real cached hook must be the one that ran");
  assert.equal(hookCalls[0].isFirstLogin, true);
  assert.equal(hookCalls[0].markerPath, LOGIN_HOOKS_STATE_PATH);
  assert.equal(hookCalls[0].username, "alice");
  assert.deepEqual(writes, [
    {
      content: buildLoginHooksStateContent({ firstLoginCompletedAt: FIXED_NOW }),
      encoding: "utf8",
      path: LOGIN_HOOKS_STATE_PATH
    }
  ]);
  assert.equal(result.isFirstLogin, true);
  assert.equal(result.ranFirstLogin, true);
  assert.equal(captured.messages.length, 0);
});

test("an existing marker keeps the first-login hook from re-running", async () => {
  resetExtensionCache();
  const calls = [];

  primeJsExtensions(FIRST_LOGIN_EXTENSION_POINT, [
    async () => {
      calls.push("first_login");
    }
  ]);
  primeJsExtensions(ANY_LOGIN_EXTENSION_POINT, [
    async (context) => {
      calls.push(`any_login:${context.isFirstLogin}`);
    }
  ]);

  const { runtime, writes } = createRuntime({ markerExists: true });
  const captured = captureConsoleError();
  let result;

  try {
    result = await executeLoginHooksBootstrap({
      now: FIXED_NOW,
      origin: "http://space.test",
      referrer: "http://space.test/login",
      runtime
    });
  } finally {
    captured.restore();
  }

  assert.deepEqual(calls, ["any_login:false"], "first-login hooks must not run again");
  assert.equal(writes.length, 0, "an existing marker is never rewritten");
  assert.equal(result.isFirstLogin, false);
  assert.equal(result.markerExists, true);
  assert.equal(result.ranFirstLogin, false);
  assert.equal(result.ranAnyLogin, true);
  assert.equal(captured.messages.length, 0);
});

test("the injected extensionCaller seam also gates the marker", async () => {
  resetExtensionCache();

  const { runtime, writes } = createRuntime({ markerExists: false });
  const captured = captureConsoleError();
  let result;

  try {
    result = await executeLoginHooksBootstrap({
      extensionCaller: async () => {
        throw new Error("injected onboarding failure");
      },
      now: FIXED_NOW,
      origin: "http://space.test",
      referrer: "http://space.test/enter",
      runtime
    });
  } finally {
    captured.restore();
  }

  assert.equal(writes.length, 0);
  assert.equal(result.ranFirstLogin, false);
  assert.equal(captured.messages.length, 1);
  assert.match(String(captured.messages[0][1]?.message || ""), /injected onboarding failure/u);
});

test("checked dispatch propagates while best-effort still swallows", async () => {
  resetExtensionCache();
  primeJsExtensions(FIRST_LOGIN_EXTENSION_POINT, [
    async () => {
      throw new Error("dispatch failure");
    },
    async () => {
      return undefined;
    }
  ]);

  const captured = captureConsoleError();

  try {
    await assert.rejects(
      () => callJsExtensionsChecked(FIRST_LOGIN_EXTENSION_POINT, { isFirstLogin: true }),
      /dispatch failure/u
    );
    // Best-effort callers keep their historical log-and-continue behavior.
    await callJsExtensions(FIRST_LOGIN_EXTENSION_POINT, { isFirstLogin: true });
  } finally {
    captured.restore();
  }

  assert.equal(captured.messages.length, 1, "only the best-effort call logs the failure");
});
