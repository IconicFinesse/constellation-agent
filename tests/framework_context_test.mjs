import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSkillTags } from "../app/L0/_all/modules/_core/skillset/skills.js";
import {
  getAttributeValues,
  getContents,
  getContexts,
  getTags,
  RUNTIME_CONTEXT,
  resolveRuntimeContext,
  syncRuntimeContext
} from "../app/L0/_all/modules/_core/framework/js/context.js";

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || "").toLowerCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.textContent = "";
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    this.ownerDocument.registerTree(child);
    return child;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  matches(selector) {
    return selector === "x-context" && this.tagName === "x-context";
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

class FakeDocument {
  constructor() {
    this._elements = [];
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  querySelector(selector) {
    if (selector !== "x-context[data-runtime]") {
      return null;
    }

    return this._elements.find((element) => (
      element.tagName === "x-context" &&
      element.getAttribute("data-runtime")
    )) || null;
  }

  querySelectorAll(selector) {
    if (selector !== "x-context") {
      return [];
    }

    return this._elements.filter((element) => element.tagName === "x-context");
  }

  registerTree(node) {
    if (!this._elements.includes(node)) {
      this._elements.push(node);
    }

    node.children.forEach((child) => this.registerTree(child));
  }

  runtimeElementCount() {
    return this.querySelectorAll("x-context").filter((element) => (
      Boolean(element.getAttribute("data-runtime"))
    )).length;
  }
}

test("framework context helpers collect contexts, attributes, contents, and tags", () => {
  const document = new FakeDocument();
  const overlayContext = document.createElement("x-context");
  overlayContext.setAttribute("data-tags", "onscreen");
  overlayContext.setAttribute("data-surface", "chat");
  overlayContext.textContent = "overlay";
  document.body.appendChild(overlayContext);

  const routeContext = document.createElement("x-context");
  routeContext.setAttribute("data-tags", "route:spaces space:open space:id:space-7");
  routeContext.setAttribute("data-surface", "route");
  routeContext.textContent = "route";
  document.body.appendChild(routeContext);

  assert.equal(getContexts(document).length, 2);
  assert.deepEqual(getAttributeValues("data-surface", document), ["chat", "route"]);
  assert.deepEqual(getContents(document), ["overlay", "route"]);
  assert.deepEqual(getTags(document), ["onscreen", "route:spaces", "space:id:space-7", "space:open"]);
  assert.deepEqual(normalizeSkillTags(getTags(document)), ["onscreen", "route:spaces", "space:id:space-7", "space:open"]);
});

test("runtime context defaults to browser without a desktop bridge", async () => {
  const runtime = await resolveRuntimeContext({
    desktopApi: null,
    frontendConfig: { SINGLE_USER_APP: false }
  });

  assert.equal(runtime, RUNTIME_CONTEXT.BROWSER);
});

test("runtime context resolves to app for bundled desktop runs", async () => {
  const runtime = await resolveRuntimeContext({
    desktopApi: {
      getRuntimeInfo: async () => ({ isBundledApp: true })
    },
    frontendConfig: { SINGLE_USER_APP: false }
  });

  assert.equal(runtime, RUNTIME_CONTEXT.APP);
});

test("runtime context falls back to app when desktop runtime info fails in packaged mode", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    const runtime = await resolveRuntimeContext({
      desktopApi: {
        getRuntimeInfo: async () => {
          throw new Error("desktop bridge failed");
        }
      },
      frontendConfig: { SINGLE_USER_APP: true }
    });

    assert.equal(runtime, RUNTIME_CONTEXT.APP);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
});

test("runtime context sync injects one runtime x-context element with derived tags", async () => {
  const document = new FakeDocument();

  await syncRuntimeContext({
    root: document,
    desktopApi: {
      getRuntimeInfo: async () => ({ isBundledApp: false })
    },
    frontendConfig: { SINGLE_USER_APP: false }
  });

  assert.deepEqual(getAttributeValues("data-runtime", document), [RUNTIME_CONTEXT.BROWSER]);
  assert.deepEqual(getTags(document), ["runtime-browser"]);
  assert.deepEqual(normalizeSkillTags(getTags(document)), ["runtime-browser"]);
  assert.equal(document.runtimeElementCount(), 1);

  await syncRuntimeContext({
    root: document,
    desktopApi: {
      getRuntimeInfo: async () => ({ isBundledApp: true })
    },
    frontendConfig: { SINGLE_USER_APP: true }
  });

  assert.deepEqual(getAttributeValues("data-runtime", document), [RUNTIME_CONTEXT.APP]);
  assert.deepEqual(getTags(document), ["runtime-app"]);
  assert.deepEqual(normalizeSkillTags(getTags(document)), ["runtime-app"]);
  assert.equal(document.runtimeElementCount(), 1);
});
