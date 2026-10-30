import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import test from "node:test";

/**
 * Regression coverage for BUG-013 (agent turn stalled behind render refresh).
 *
 * Root cause: every agent-reachable `space.spaces.*` mutation awaited
 * `handleExternalMutation(...)`, which replays the mounted space. A widget
 * renderer that never settles its own await keeps that replay pending forever,
 * so the agent's tool call never returns and the turn wedges.
 *
 * What this harness pins:
 *   1. a mutation returns its tool result while the render refresh is still in
 *      flight (deferred gate), and the `Current Widget` transient is re-emitted
 *      afterwards so the agent envelope fills in behind the fast return;
 *   2. the decoupled refresh is SCHEDULED and actually RUNS (not deleted);
 *   3. a mutation whose refresh can never settle still returns (bounded race),
 *      and that refresh stays recorded as in-flight rather than dropped.
 *
 * A node harness cannot reproduce the browser wedge itself; it can only prove
 * the ordering property that caused it.
 */

const appModRootUrl = new URL("../app/L0/_all/modules/", import.meta.url).href;
const serverRootUrl = new URL("../server/", import.meta.url).href;

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("/modules/")) {
      return { url: `${appModRootUrl}${specifier.slice("/modules/".length)}`, shortCircuit: true };
    }

    if (specifier.startsWith("/pages/") || specifier.startsWith("/api/") || specifier.startsWith("/lib/")) {
      return { url: `${serverRootUrl}${specifier.slice(1)}`, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  }
});

class FakeClassList {
  constructor() {
    this.tokens = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.tokens.add(String(token)));
  }

  remove(...tokens) {
    tokens.forEach((token) => this.tokens.delete(String(token)));
  }

  toggle(token, force) {
    const next = force === undefined ? !this.tokens.has(String(token)) : Boolean(force);

    if (next) {
      this.tokens.add(String(token));
    } else {
      this.tokens.delete(String(token));
    }

    return next;
  }

  contains(token) {
    return this.tokens.has(String(token));
  }
}

class FakeStyle {
  constructor() {
    this.values = {};
  }

  setProperty(name, value) {
    this.values[String(name)] = String(value);
  }

  removeProperty(name) {
    delete this.values[String(name)];
    return "";
  }

  getPropertyValue(name) {
    return this.values[String(name)] || "";
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.style = new FakeStyle();
    this.dataset = {};
    this.children = [];
    this.attributes = {};
    this.classList = new FakeClassList();
    this.className = "";
    this.innerHTML = "";
    this.textContent = "";
    this.isConnected = true;
    this.clientWidth = 1024;
    this.clientHeight = 768;
    this.offsetWidth = 1024;
    this.offsetHeight = 768;
    this.listeners = new Map();
  }

  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((entry) => entry !== child);
    return child;
  }

  replaceChildren(...nodes) {
    this.children = [];
    nodes.forEach((node) => this.appendChild(node));
  }

  insertBefore(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
  }

  removeEventListener() {}

  setAttribute(name, value) {
    this.attributes[String(name)] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, String(name))
      ? this.attributes[String(name)]
      : null;
  }

  removeAttribute(name) {
    delete this.attributes[String(name)];
  }

  remove() {
    this.isConnected = false;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  getBoundingClientRect() {
    return { bottom: 100, height: 100, left: 0, right: 100, top: 0, width: 100, x: 0, y: 0 };
  }

  focus() {}

  blur() {}

  click() {}

  get firstChild() {
    return this.children[0] || null;
  }
}

function installFakeDom() {
  globalThis.HTMLElement = FakeElement;
  globalThis.Element = FakeElement;
  globalThis.Node = FakeElement;
  globalThis.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init || {});
    }
  };
  globalThis.Event = globalThis.CustomEvent;
  globalThis.document = {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
    head: new FakeElement("head"),
    readyState: "complete",
    createElement: (tagName) => new FakeElement(tagName),
    createDocumentFragment: () => new FakeElement("fragment"),
    createTextNode: (text) => {
      const node = new FakeElement("text");
      node.textContent = String(text);
      return node;
    },
    addEventListener() {},
    removeEventListener() {},
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  globalThis.window = {
    addEventListener() {},
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    clearTimeout: (handle) => clearTimeout(handle),
    devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    innerHeight: 768,
    innerWidth: 1024,
    matchMedia: () => ({ addEventListener() {}, matches: true, removeEventListener() {} }),
    removeEventListener() {},
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs)
  };
  globalThis.matchMedia = globalThis.window.matchMedia;
  globalThis.getComputedStyle = globalThis.window.getComputedStyle;
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
  globalThis.customElements = { define() {}, get: () => undefined };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };
  globalThis.location = { href: "http://localhost/", origin: "http://localhost" };
}

function logicalToDisk(rootDir, logicalPath) {
  const normalized = String(logicalPath || "").replace(/^~\//u, "");
  return path.join(rootDir, normalized);
}

function diskToLogical(rootDir, diskPath) {
  return `~/${path.relative(rootDir, diskPath).split(path.sep).join("/")}`;
}

async function walkFiles(rootDir, startDir) {
  const results = [];

  let entries = [];

  try {
    entries = await fs.readdir(startDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const entryPath = path.join(startDir, entry.name);

    if (entry.isDirectory()) {
      results.push(...(await walkFiles(rootDir, entryPath)));
      continue;
    }

    results.push(diskToLogical(rootDir, entryPath));
  }

  return results;
}

function notFoundError(logicalPath) {
  return new Error(`API file_read failed with status 404: Path not found: ${logicalPath}`);
}

/**
 * tmpdir-backed stand-in for the authenticated `space.api` file surface. Every
 * read/write in this suite goes through real storage.js code, so the widget
 * YAML and space.yaml that the refresh replays are genuinely persisted files.
 */
function createTmpdirSpaceApi(rootDir) {
  const calls = { fileRead: 0, fileWrite: 0 };

  return {
    calls,
    async fileRead(pathOrOptions) {
      calls.fileRead += 1;

      if (pathOrOptions && typeof pathOrOptions === "object") {
        const files = Array.isArray(pathOrOptions.files) ? pathOrOptions.files : [];
        const results = [];

        for (const logicalPath of files) {
          try {
            const content = await fs.readFile(logicalToDisk(rootDir, logicalPath), "utf8");
            results.push({ content, path: String(logicalPath) });
          } catch {
            results.push({ content: "", path: String(logicalPath) });
          }
        }

        return { files: results };
      }

      const logicalPath = String(pathOrOptions || "");

      try {
        const content = await fs.readFile(logicalToDisk(rootDir, logicalPath), "utf8");
        return { content, path: logicalPath };
      } catch {
        throw notFoundError(logicalPath);
      }
    },
    async fileList(logicalPath) {
      const paths = await walkFiles(rootDir, logicalToDisk(rootDir, logicalPath));
      return { paths };
    },
    async fileInfo(logicalPath) {
      const diskPath = logicalToDisk(rootDir, logicalPath);

      try {
        const stats = await fs.stat(diskPath);
        return { path: String(logicalPath), size: stats.size };
      } catch {
        throw notFoundError(logicalPath);
      }
    },
    async fileWrite(input) {
      calls.fileWrite += 1;

      if (typeof input === "string") {
        await fs.mkdir(logicalToDisk(rootDir, input), { recursive: true });
        return { path: input };
      }

      const files = Array.isArray(input?.files) ? input.files : [input];

      for (const file of files) {
        const logicalPath = String(file?.path || "");
        const diskPath = logicalToDisk(rootDir, logicalPath);

        // The real file API treats a trailing slash as "ensure this directory
        // exists" and everything else as a file write.
        if (logicalPath.endsWith("/")) {
          await fs.mkdir(diskPath, { recursive: true });
          continue;
        }

        await fs.mkdir(path.dirname(diskPath), { recursive: true });
        await fs.writeFile(diskPath, String(file?.content ?? ""), "utf8");
      }

      return { files: files.map((file) => ({ path: String(file?.path || "") })) };
    },
    async fileDelete(pathOrOptions) {
      const targets =
        pathOrOptions && typeof pathOrOptions === "object"
          ? Array.isArray(pathOrOptions.paths)
            ? pathOrOptions.paths
            : [pathOrOptions.path]
          : [pathOrOptions];

      for (const logicalPath of targets) {
        await fs.rm(logicalToDisk(rootDir, String(logicalPath || "")), { force: true, recursive: true });
      }

      return { paths: targets.map((entry) => String(entry || "")) };
    }
  };
}

function createTransientRuntime() {
  const store = new Map();

  return {
    delete(key) {
      return store.delete(String(key));
    },
    entries() {
      return store;
    },
    get(key) {
      return store.get(String(key));
    },
    set(key, value) {
      store.set(String(key), value);
      return value;
    }
  };
}

const renderStats = {
  calls: 0,
  gate: async () => {}
};

function rendererSource() {
  return [
    "async (parent, currentSpace, ctx) => {",
    "  globalThis.__decoupleRenderStats.calls += 1;",
    "  await globalThis.__decoupleRenderStats.gate();",
    "  parent.textContent = 'rendered';",
    "}"
  ].join("\n");
}

async function waitUntil(predicate, { timeoutMs = 5000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

async function bounded(promise, timeoutMs) {
  let timer = null;

  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });

  try {
    const result = await Promise.race([
      promise.then((value) => ({ settled: true, value })),
      timeout
    ]);
    return result;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "spaces-decouple-"));
installFakeDom();

globalThis.__decoupleRenderStats = renderStats;
globalThis.space = {
  api: createTmpdirSpaceApi(rootDir),
  chat: { transient: createTransientRuntime() },
  fw: {
    createStore(name, model) {
      globalThis.__stores = globalThis.__stores || {};
      globalThis.__stores[name] = model;
      return model;
    }
  },
  router: {
    getParam() {
      return "";
    },
    goTo: async () => {},
    replaceTo: async () => {}
  },
  utils: {}
};

const yamlLite = await import("../app/L0/_all/modules/_core/framework/js/yaml-lite.js");
globalThis.space.utils.yaml = {
  parse: (source) => yamlLite.parseSimpleYaml(source),
  stringify: (value) => yamlLite.serializeSimpleYaml(value)
};

const storage = await import("../app/L0/_all/modules/_core/spaces/storage.js");
const spacesStoreModule = await import("../app/L0/_all/modules/_core/spaces/store.js");

const spacesStore = globalThis.__stores.spacesPage;
const spacesRuntimeNamespace = globalThis.space.spaces;

function readDiagnostics() {
  return spacesStoreModule.readDecoupledSpacesRefreshDiagnostics?.() || null;
}

const transientKey = "spaces/current-widget";

function currentWidgetTransient() {
  return globalThis.space.chat.transient.get(transientKey) || null;
}

async function mountStore() {
  const canvas = null;
  const grid = new FakeElement("section");

  spacesStore.refs = { canvas, grid };
  spacesStore.motionQuery = { addEventListener() {}, matches: true, removeEventListener() {} };
  spacesStore.queueCanvasViewportHeightSync = () => {};
  spacesStore.handleViewportResize = () => {};
  spacesStore.ensureEmptyCanvasSeenStorageLoaded = async () => {};
  spacesStore.refreshFromRoute = async () => {};
  spacesStore.mount({ canvas, grid });

  return { grid };
}

async function seedSpace({ spaceId, title }) {
  const created = await storage.createSpace({ id: spaceId, title });

  await storage.upsertWidget({
    cols: 6,
    id: "w1",
    name: "Counter",
    renderer: rendererSource(),
    rows: 3,
    spaceId: created.id
  });

  return created.id;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test("a decoupled mutation returns before the render refresh settles and still re-emits the Current Widget transient", async () => {
  await mountStore();

  const spaceId = await seedSpace({ spaceId: "space-decouple-deferred", title: "Deferred" });

  // Let the initial load render normally.
  renderStats.calls = 0;
  renderStats.gate = async () => {};
  await spacesStore.loadCurrentSpace(spaceId);
  assert.equal(spacesStore.currentSpaceId, spaceId, "the seeded space must be the mounted current space");

  // From here on, every widget render parks on a gate we control. This is the
  // shape of the reported wedge: the replay cannot settle while the turn waits.
  let releaseGate = null;
  const gatePromise = new Promise((resolve) => {
    releaseGate = resolve;
  });
  renderStats.gate = () => gatePromise;

  const mutation = bounded(
    spacesRuntimeNamespace.upsertWidget({
      cols: 6,
      id: "w1",
      name: "Counter",
      refresh: true,
      renderer: rendererSource(),
      rows: 3,
      spaceId
    }),
    3000
  );

  const result = await mutation;
  assert.equal(result.settled, true, "the agent-facing mutation must return while the render refresh is still parked");

  // The refresh is still in flight at this point, so nothing has re-emitted the
  // envelope yet. Clearing it makes the later assertion unambiguous: only the
  // decoupled re-emit can put it back.
  globalThis.space.chat.transient.delete(transientKey);
  assert.equal(currentWidgetTransient(), null, "the transient must be clear before the re-emit proof");

  releaseGate();

  await waitUntil(() => Boolean(currentWidgetTransient()), {
    label: "the Current Widget transient to be re-emitted by the decoupled refresh",
    timeoutMs: 5000
  });

  const envelope = currentWidgetTransient();
  assert.ok(envelope, "the decoupled refresh must re-emit the Current Widget transient");
  assert.match(String(envelope.content || ""), /widgetId: w1/u, "the envelope must describe the touched widget");
  assert.match(String(envelope.content || ""), /source↓/u, "the envelope must carry the numbered source readback");
  assert.equal(envelope.heading, "Current Widget");
  assert.equal(envelope.key, transientKey);

  // And the refresh really ran, rather than being queued and forgotten.
  await waitUntil(
    () => {
      const diagnostics = readDiagnostics();
      return diagnostics ? diagnostics.pendingKeys.length === 0 : true;
    },
    { label: "the decoupled refresh queue to drain", timeoutMs: 5000 }
  );

  assert.ok(renderStats.calls >= 1, "the replayed widget renderer must actually execute");
});

test("the decoupled refresh is scheduled and completes rather than being deleted", async () => {
  await mountStore();

  const spaceId = await seedSpace({ spaceId: "space-decouple-scheduled", title: "Scheduled" });

  renderStats.calls = 0;
  renderStats.gate = async () => {};
  await spacesStore.loadCurrentSpace(spaceId);

  const before = readDiagnostics();

  // Park the replay so "returned already" cannot be confused with "the replay
  // happened to be fast". On the pre-fix ordering this await never returns.
  let releaseGate = null;
  const gatePromise = new Promise((resolve) => {
    releaseGate = resolve;
  });
  renderStats.gate = () => gatePromise;

  const result = await bounded(
    spacesRuntimeNamespace.upsertWidget({
      cols: 6,
      id: "w1",
      name: "Counter",
      refresh: true,
      renderer: rendererSource(),
      rows: 3,
      spaceId
    }),
    3000
  );

  assert.equal(result.settled, true, "the mutation must return without waiting for the replay");

  const whileParked = readDiagnostics();

  if (whileParked) {
    assert.ok(
      whileParked.pendingKeys.includes(spaceId),
      "the refresh must be recorded as SCHEDULED (in flight) when the mutation returns"
    );
  }

  // Nothing rendered through the gate yet: the refresh is genuinely off the
  // critical path, not merely queued behind a fast path.
  const callsWhileParked = renderStats.calls;

  releaseGate();

  await waitUntil(
    () => {
      const diagnostics = readDiagnostics();
      return diagnostics ? diagnostics.pendingKeys.length === 0 : true;
    },
    { label: "the scheduled refresh to finish", timeoutMs: 5000 }
  );

  const after = readDiagnostics();

  if (before && after) {
    assert.equal(
      after.completed,
      before.completed + 1,
      "exactly one decoupled refresh must have been scheduled AND run for this space"
    );
    assert.equal(after.failed, before.failed, "the scheduled refresh must not have failed");
  }

  assert.ok(
    renderStats.calls > callsWhileParked,
    "the replayed widget renderer must actually execute after the gate is released"
  );
  assert.ok(spacesStore.currentSpace, "the mounted space must still be present after the scheduled refresh");
});

test("a mutation whose refresh can never settle still returns instead of wedging the caller", async () => {
  await mountStore();

  const spaceId = await seedSpace({ spaceId: "space-decouple-stall", title: "Stall" });

  renderStats.calls = 0;
  renderStats.gate = async () => {};
  await spacesStore.loadCurrentSpace(spaceId);

  // The render refresh now awaits a fetch that never resolves. On the pre-fix
  // ordering this is exactly the reported wedge: the awaited replay never
  // settles, so the tool call never returns.
  let requestCount = 0;
  globalThis.fetch = () => {
    requestCount += 1;
    return new Promise(() => {});
  };
  renderStats.gate = () => globalThis.fetch("/api/probe");

  const result = await bounded(
    spacesRuntimeNamespace.upsertWidget({
      cols: 6,
      id: "w1",
      name: "Counter",
      refresh: true,
      renderer: rendererSource(),
      rows: 3,
      spaceId
    }),
    3000
  );

  assert.equal(result.settled, true, "a never-settling render must not block the mutation result");

  // The decoupled refresh starts on its own; wait until it has actually reached
  // the never-settling work instead of asserting on a scheduling race.
  await waitUntil(() => requestCount >= 1, {
    label: "the stalled refresh to start its never-settling work",
    timeoutMs: 5000
  });

  const diagnostics = readDiagnostics();

  if (diagnostics) {
    assert.ok(
      diagnostics.pendingKeys.includes(spaceId),
      "the stalled refresh must stay recorded as in-flight, not silently dropped"
    );
  }

  assert.ok(requestCount >= 1, "the stalled refresh must have actually started the never-settling work");
});

test.after(async () => {
  await fs.rm(rootDir, { force: true, recursive: true });
});
