import test from "node:test";
import assert from "node:assert/strict";

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "").toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.innerHTML = "";
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  matches() {
    return false;
  }

  querySelectorAll() {
    return [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

function createFakeDocument(options = {}) {
  const head = new FakeElement("head");
  const documentElement = new FakeElement("html");
  const metaTag =
    options.maxLayer === undefined || options.maxLayer === null
      ? null
      : { content: String(options.maxLayer) };

  return {
    addEventListener() {},
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    documentElement,
    head,
    querySelector(selector) {
      if (selector === 'meta[name="space-max-layer"]') {
        return metaTag;
      }

      return null;
    },
    querySelectorAll() {
      return [];
    },
    readyState: "loading"
  };
}

async function withExtensionsTestEnvironment(run) {
  const original = {
    HTMLElement: globalThis.HTMLElement,
    MutationObserver: globalThis.MutationObserver,
    document: globalThis.document,
    fetch: globalThis.fetch,
    location: globalThis.location,
    window: globalThis.window
  };

  const requests = [];
  const document = createFakeDocument({ maxLayer: 1 });

  globalThis.document = document;
  globalThis.window = globalThis;
  globalThis.location = new URL("http://example.test/");
  globalThis.HTMLElement = FakeElement;
  globalThis.MutationObserver = class {
    disconnect() {}
    observe() {}
  };
  globalThis.fetch = async (url, options = {}) => {
    const payload =
      options.body === undefined ? null : JSON.parse(String(options.body));
    requests.push({
      payload,
      url: String(url)
    });

    const responseBody = Array.isArray(payload?.requests)
      ? {
          results: payload.requests.map(({ patterns }) => ({
            extensions: [],
            patterns: [...patterns]
          }))
        }
      : { extensions: [] };

    return new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json"
      },
      status: 200
    });
  };

  try {
    const nonce = String(Date.now()) + "-" + String(Math.random());
    const extensions = await import(
      "../app/L0/_all/modules/_core/framework/js/extensions.js?test=" + nonce
    );
    extensions.clearCache();
    await run({ extensions, requests });
  } finally {
    globalThis.HTMLElement = original.HTMLElement;
    globalThis.MutationObserver = original.MutationObserver;
    globalThis.document = original.document;
    globalThis.fetch = original.fetch;
    globalThis.location = original.location;
    globalThis.window = original.window;
  }
}

test("JS extension lookup sends top-level maxLayer and patterns only once", async () => {
  await withExtensionsTestEnvironment(async ({ extensions, requests }) => {
    await extensions.loadJsExtensions("_core/example/hook");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/extensions_load");
    assert.deepEqual(requests[0].payload, {
      maxLayer: 1,
      patterns: [
        "js/_core/example/hook/*.js",
        "js/_core/example/hook/*.mjs"
      ]
    });
  });
});

test("HTML extension batching sends one maxLayer and ordered pattern groups", async () => {
  await withExtensionsTestEnvironment(async ({ extensions, requests }) => {
    const firstTarget = new FakeElement("x-extension");
    const secondTarget = new FakeElement("x-extension");

    await Promise.all([
      extensions.importHtmlExtensions("_core/example/first", firstTarget),
      extensions.importHtmlExtensions("_core/example/second", secondTarget)
    ]);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/extensions_load");
    assert.deepEqual(requests[0].payload, {
      maxLayer: 1,
      requests: [
        {
          patterns: [
            "html/_core/example/first/*.html",
            "html/_core/example/first/*.htm",
            "html/_core/example/first/*.xhtml"
          ]
        },
        {
          patterns: [
            "html/_core/example/second/*.html",
            "html/_core/example/second/*.htm",
            "html/_core/example/second/*.xhtml"
          ]
        }
      ]
    });
    assert.equal(firstTarget.innerHTML, "");
    assert.equal(secondTarget.innerHTML, "");
  });
});
