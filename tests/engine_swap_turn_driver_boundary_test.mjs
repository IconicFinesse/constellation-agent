// THE HOOK BOUNDARY (P4a-1).
//
// WHY THIS SUITE EXISTS. The twelve behaviour suites prove what a Tier 1 turn DOES. They
// do not prove the SEAM, and the seam has a failure mode they are structurally blind to:
// a surface hook that is never called — or called with swapped arguments — still yields
// green behaviour tests, because each suite stubs whichever paint method it cares about and
// asserts the resulting state. The driver's contract is not state, it is the ordered
// sequence of calls it makes into its surface. So this suite records them.
//
// PART 1 drives the driver DIRECTLY with a fake surface and scripted inputs, and asserts the
// exact ordered hook list, including the arguments each hook received. That is the boundary
// itself: the preview lifecycle (open -> delta -> delta -> chip -> settle -> seal), the abort
// controller handoff, and the engine-shaped state the driver owns.
//
// PART 2 drives the SAME turn through the REAL store (real export, real fetch stub, real
// delegating methods) and asserts the store's wiring produces the same hook NAMES in the same
// order. Part 1 alone would pass against a driver nothing calls; part 2 alone would pass
// against a store that reimplements the logic. Together they pin the delegation.
//
// Hermetic: no network, no keys, no app-data writes, no DOM beyond the stubs the store has
// always needed under `node:test`.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

function createHarness() {
  const runtime = {
    api: {},
    configValues: new Map(),
    config: {
      get(name, fallback = undefined) {
        return runtime.configValues.has(name) ? runtime.configValues.get(name) : fallback;
      }
    },
    extend(_meta, value) {
      return value;
    },
    fw: {
      createStore(_name, model) {
        return model;
      }
    },
    proxy: {
      buildUrl(url) {
        return url;
      }
    }
  };

  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
    createElement() {
      return { classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {}, style: {} };
    },
    body: { appendChild() {} },
    documentElement: { appendChild() {} }
  };
  globalThis.window = {
    space: runtime,
    console,
    addEventListener() {},
    removeEventListener() {},
    location: { href: "http://127.0.0.1:3000/" },
    matchMedia() {
      return { addEventListener() {}, matches: false };
    },
    requestAnimationFrame(callback) {
      return setTimeout(() => callback(0), 0);
    },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout
  };
  globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.space = runtime;

  return runtime;
}

createHarness();

const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

const SEPARATOR = "_____javascript";

// A recording surface. Every hook APPENDS one `{ name, args }` entry, so a missing call, an
// extra call, a reordered call or a call with the wrong arguments all change the record.
function createRecordingSurface() {
  const calls = [];
  let controller = null;

  // The preview object is MUTATED in place as deltas accumulate, so a stored reference
  // would later read the final text and the per-call evidence would silently collapse.
  // Snapshot the fields under test at call time instead.
  const snapshot = (args) =>
    args.map((arg) =>
      arg && typeof arg === "object" && "content" in arg ? { content: arg.content, id: arg.id } : arg
    );
  const record = (name) => (...args) => {
    calls.push({ args: snapshot(args), name });
  };

  return {
    calls,
    getActiveRequestController() {
      calls.push({ args: [], name: "getActiveRequestController" });

      return controller;
    },
    getPendingHold() {
      calls.push({ args: [], name: "getPendingHold" });

      return null;
    },
    maybeShowCompactStreamingAssistantBubble: record("maybeShowCompactStreamingAssistantBubble"),
    persistHistory: record("persistHistory"),
    render: record("render"),
    reportError: record("reportError"),
    scheduleEngineSwapChipRender: record("scheduleEngineSwapChipRender"),
    scheduleStreamingMessageRender: record("scheduleStreamingMessageRender"),
    setActiveRequestController(value) {
      calls.push({ args: [value], name: "setActiveRequestController" });
      controller = value;
    },
    setHistory: record("setHistory"),
    setPendingHold: record("setPendingHold"),
    setStatus: record("setStatus"),
    setStreamingAssistantStatus: record("setStreamingAssistantStatus"),
    showCompactAssistantReplyBubble: record("showCompactAssistantReplyBubble"),
    // The one place a name list is easier to assert than the whole record.
    get names() {
      return calls.map((call) => call.name);
    }
  };
}

function createScriptedInputs({ deltas = ["Hel", "lo"], toolCall = null } = {}) {
  const surfaceLESS = {};

  return {
    ...surfaceLESS,
    createStreamingAssistantMessage: () => ({ content: "", id: "", role: "assistant", streaming: true }),
    envelopeMarkers: { USER: "_____user" },
    executionContext: () => null,
    executionOutputOverrides: () => ({}),
    fenceRegions: () => [],
    findSeparatorIndex: () => -1,
    isFrameworkFollowUpKind: () => false,
    parseParams: () => ({}),
    // The turn itself: the loop calls `sendCompletion` exactly as the real one does, so the
    // preview lifecycle (open on the FIRST request) is reached the production way.
    runTier1Turn: async (request) => {
      await request.sendCompletion({ request: { body: {} } });

      if (toolCall) {
        request.onEvent({ call: { id: toolCall.id }, outcome: { status: "ok" }, position: 0, type: "dispatch" });
      }

      request.onEvent({ text: "ignored", type: "assistant-turn" });

      return {
        result: { answer: "Hello", messages: [{ content: "Hello", role: "assistant" }], status: "answered" },
        session: {}
      };
    },
    runtime: () => ({}),
    separator: SEPARATOR,
    settings: () => ({
      apiEndpoint: "https://example.test/v1",
      apiKey: "test-key-not-real",
      model: "test-model",
      paramsText: ""
    }),
    shapeSystemPrompt: async ({ promptText }) => promptText,
    stopRequested: () => false,
    streamToolTurn: async ({ onDelta, onToolCallComplete }) => {
      for (const delta of deltas) {
        onDelta(delta);
      }

      if (toolCall) {
        onToolCallComplete(toolCall);
      }

      return { text: deltas.join(""), toolCalls: [] };
    }
  };
}

const REQUEST_MESSAGES = [{ content: "say hello", id: "u1", role: "user" }];
const PREPARED = { messages: [{ content: "say hello", role: "user" }] };
const PLAN = { tier: "tier1" };

// -----------------------------------------------------------------------------------------
// PART 1 — the boundary itself, driven directly, arguments included.
// -----------------------------------------------------------------------------------------
test("a real Tier 1 turn calls every surface hook in the exact order, with the exact arguments", async () => {
  // Imported HERE, not at module load: this case is about the driver, which does not
  // exist before this lane, and the suite's other two cases must still load on the base
  // commit to show that the DELEGATION is what they are missing.
  const { createTier1TurnDriver } = await import("/modules/_core/framework/js/engine-swap/turn-driver.js");
  const surface = createRecordingSurface();
  const driver = createTier1TurnDriver({
    inputs: createScriptedInputs({ toolCall: { arguments: '{"code":"1"}', id: "c1", name: "run_code" } }),
    surface
  });

  const turn = await driver.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.equal(turn.result.answer, "Hello");
  assert.equal(turn.wireMessageCount, 1, "the wire baseline comes from the sanitized wire length");

  // THE ORDERED CONTRACT. Read it as the turn's shape: take the abort controller, stream two
  // deltas (each painting status + bubble + render), paint a chip, settle that chip on the
  // loop's own dispatch event, then release the controller. `assistant-turn` must NOT settle
  // anything — only `dispatch` does.
  assert.deepEqual(surface.names, [
    "setActiveRequestController",
    "setStreamingAssistantStatus",
    "maybeShowCompactStreamingAssistantBubble",
    "scheduleStreamingMessageRender",
    "setStreamingAssistantStatus",
    "maybeShowCompactStreamingAssistantBubble",
    "scheduleStreamingMessageRender",
    "scheduleEngineSwapChipRender",
    "scheduleEngineSwapChipRender",
    "getActiveRequestController",
    "setActiveRequestController"
  ]);

  // Arguments, not just names: a swapped pair (`scheduleStreamingMessageRender(status)` /
  // `setStreamingAssistantStatus(message)`) preserves the name list and breaks the product.
  const streamingStatusCalls = surface.calls.filter((call) => call.name === "setStreamingAssistantStatus");

  assert.deepEqual(
    streamingStatusCalls.map((call) => call.args[0]),
    ["Hel", "Hello"],
    "the status hook receives the ACCUMULATED preview text, in delta order"
  );

  const renderCalls = surface.calls.filter((call) => call.name === "scheduleStreamingMessageRender");

  assert.deepEqual(
    renderCalls.map((call) => call.args[0]?.content),
    ["Hel", "Hello"],
    "the render hook receives the preview OBJECT, whose content is the accumulated text"
  );
  assert.deepEqual(
    renderCalls.map((call) => call.args[0]?.id),
    ["engine-swap-streaming-preview", "engine-swap-streaming-preview"],
    "the preview keeps its reserved id, which is what lets the row patch replace one row"
  );

  // The abort handoff is a real controller, set then cleared, and cleared only for its own.
  assert.ok(surface.calls[0].args[0] instanceof AbortController, "a real abort controller is installed");
  assert.equal(surface.calls.at(-1).args[0], null, "and released at turn end");

  // Engine-shaped state is the DRIVER's, and the turn left it in the post-seal state.
  assert.equal(driver.state.engineSwapPreviewSealed, true, "the turn seals on the way out");
  assert.equal(driver.state.engineSwapStreamingPreview, null, "and clears the preview");
  assert.deepEqual(driver.state.engineSwapProvisionalCalls, [], "and every provisional chip with it");
  assert.equal(driver.state.engineSwapTier1Session, null);
  assert.equal(driver.state.engineSwapHeldMessages, null);
});

// -----------------------------------------------------------------------------------------
// PART 2 — the wiring: the SAME turn through the real store, same hook names.
// -----------------------------------------------------------------------------------------
test("the real store drives the same hook sequence through its delegation", async (t) => {
  const names = [];
  const previous = {
    maybeShowCompactStreamingAssistantBubble: store.maybeShowCompactStreamingAssistantBubble,
    persistHistory: store.persistHistory,
    render: store.render,
    scheduleEngineSwapChipRender: store.scheduleEngineSwapChipRender,
    scheduleStreamingMessageRender: store.scheduleStreamingMessageRender,
    setStreamingAssistantStatus: store.setStreamingAssistantStatus,
    settings: store.settings,
    showCompactAssistantReplyBubble: store.showCompactAssistantReplyBubble,
    status: store.status,
    stopRequested: store.stopRequested
  };

  const record = (name) => (...args) => {
    names.push(name);

    return undefined;
  };

  store.displayMode = "full";
  store.settings = {
    apiEndpoint: "https://example.test/v1",
    apiKey: "test-key-not-real",
    model: "test-model",
    paramsText: ""
  };
  store.stopRequested = false;
  store.setStreamingAssistantStatus = record("setStreamingAssistantStatus");
  store.maybeShowCompactStreamingAssistantBubble = record("maybeShowCompactStreamingAssistantBubble");
  store.scheduleStreamingMessageRender = record("scheduleStreamingMessageRender");
  store.scheduleEngineSwapChipRender = record("scheduleEngineSwapChipRender");
  store.persistHistory = async () => {
    names.push("persistHistory");
  };
  store.render = record("render");
  store.showCompactAssistantReplyBubble = record("showCompactAssistantReplyBubble");

  t.after(() => {
    store.maybeShowCompactStreamingAssistantBubble = previous.maybeShowCompactStreamingAssistantBubble;
    store.showCompactAssistantReplyBubble = previous.showCompactAssistantReplyBubble;
    store.persistHistory = previous.persistHistory;
    store.render = previous.render;
    store.scheduleEngineSwapChipRender = previous.scheduleEngineSwapChipRender;
    store.scheduleStreamingMessageRender = previous.scheduleStreamingMessageRender;
    store.setStreamingAssistantStatus = previous.setStreamingAssistantStatus;
    store.settings = previous.settings;
    store.status = previous.status;
    store.stopRequested = previous.stopRequested;
  });

  // A REAL turn through the REAL transport seam, with an SSE body that streams "Hello" and
  // stops. No tool calls, so this is the plain-answer path: open -> delta -> delta -> seal,
  // then the commit hooks.
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n";
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    body: {
      getReader: () => {
        let done = false;

        return {
          read: async () => {
            if (done) {
              return { done: true, value: undefined };
            }

            done = true;

            return { done: false, value: new TextEncoder().encode(body) };
          }
        };
      }
    },
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : null) },
    ok: true,
    status: 200
  });

  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const outcome = await store.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.equal(outcome, "complete");

  // The same shape Part 1 asserted, minus the abort plumbing (which lives in the store, not a
  // hook) and plus the commit hooks. A hook dropped at the injection site removes a line here
  // even when every behaviour suite stays green — which is precisely this suite's job.
  assert.deepEqual(names, [
    "setStreamingAssistantStatus",
    "maybeShowCompactStreamingAssistantBubble",
    "scheduleStreamingMessageRender",
    "setStreamingAssistantStatus",
    "maybeShowCompactStreamingAssistantBubble",
    "scheduleStreamingMessageRender",
    "persistHistory",
    "showCompactAssistantReplyBubble",
    "render"
  ]);
});

// -----------------------------------------------------------------------------------------
// The split itself: engine-shaped state is single-copy, and the hold field stayed put.
// -----------------------------------------------------------------------------------------
test("engine-shaped state is single-copy through the store, and the hold stayed surface-owned", () => {
  // NO second driver here: creating one would prove nothing about the store. Everything
  // below goes through the store's PUBLIC surface, which is the only path a caller has.
  // Single-copy is the claim, and it is observable from outside in both directions:
  // a write through the store is READ BACK identically, and a mutation the DRIVER makes
  // (reached by calling the store's own delegating method) is visible through the getter.
  store.engineSwapProvisionalCalls = [{ callId: "c-written", name: "run_code" }];

  assert.deepEqual(
    store.engineSwapProvisionalCalls,
    [{ callId: "c-written", name: "run_code" }],
    "a reset through the store survives — this is what the SETTER half buys"
  );
  assert.equal(
    store.engineSwapProvisionalCalls,
    store.engineSwapProvisionalCalls,
    "and the getter returns ONE identity, not a fresh copy per read"
  );

  store.engineSwapStreamingPreview = { content: "abcdef" };
  store.engineSwapPreviewSealed = false;

  // Drive the DRIVER through the store's own delegation: the chip's interleave offset is
  // read off the preview the store just wrote. If these were two copies, `atChars` would
  // be 0 and every chip would jump to the bottom of the prose.
  assert.equal(store.recordEngineSwapProvisionalCall({ arguments: "", id: "c-2", name: "run_code" }), true);
  assert.equal(
    store.engineSwapProvisionalCalls[1].atChars,
    6,
    "the driver reads the SAME preview the store wrote — one copy, no drift"
  );

  // The seal the DRIVER sets is visible through the store, and it then refuses new chips.
  store.sealEngineSwapPreview();

  assert.equal(store.engineSwapPreviewSealed, true, "the store reads the driver's seal, never a copy");
  assert.equal(store.engineSwapStreamingPreview, null, "and the seal cleared the shared preview");
  assert.deepEqual(store.engineSwapProvisionalCalls, [], "and every chip with it");
  assert.equal(
    store.recordEngineSwapProvisionalCall({ arguments: "", id: "c-3", name: "run_code" }),
    false,
    "a sealed slot refuses a late chip — reachable only through the shared state"
  );

  store.engineSwapPreviewSealed = false;
  store.engineSwapProvisionalCalls = [];

  // `engineSwapPendingHold` is NOT driver state. It is the confirm bar's reactive
  // binding, and it must stay a real data property ON the store, because a plain getter
  // onto driver state never passes through the store proxy's set trap: no trigger would
  // fire and the confirm bar would silently stop appearing on a real held deletion.
  // A DATA property, checked through its descriptor rather than `hasOwnProperty`: an
  // accessor is an own property too, so hasOwnProperty cannot see the difference that the
  // reactivity argument is actually about. `value` present and no `get`/`set` is exactly
  // the shape Vue tracks through this store's set trap.
  const holdDescriptor = Object.getOwnPropertyDescriptor(store, "engineSwapPendingHold");

  assert.ok(holdDescriptor, "the hold must be an own property of the store");
  assert.ok(
    "value" in holdDescriptor,
    "the hold must be a DATA property, not an accessor: a getter never passes through the store proxy's set trap, so no trigger fires"
  );
  assert.equal(holdDescriptor.get, undefined, "and it must not be read through a getter");
  assert.equal(holdDescriptor.set, undefined, "nor written through a setter");
  store.engineSwapPendingHold = { callId: "c-hold" };
  assert.deepEqual(store.engineSwapPendingHold, { callId: "c-hold" }, "and it round-trips as plain data");
  store.engineSwapPendingHold = null;
});

// -----------------------------------------------------------------------------------------
// The boundary that makes this a FRAMEWORK module rather than a moved chunk of the store.
// -----------------------------------------------------------------------------------------
test("the driver imports no surface, and carries no surface identity branch", async () => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL(
    "../app/L0/_all/modules/_core/framework/js/engine-swap/turn-driver.js",
    import.meta.url
  );
  const source = await readFile(url, "utf8");

  // Every module specifier it actually imports, in source order.
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);

  assert.ok(specifiers.length > 0, "the driver imports something, or this check is vacuous");

  for (const specifier of specifiers) {
    const isFramework =
      specifier.startsWith("/modules/_core/framework/js/") || specifier.startsWith("./") || specifier.startsWith("../");

    assert.ok(
      isFramework,
      `a framework module may not import a surface (onscreen_agent/ or admin/): saw ${specifier}`
    );
  }

  // The OTHER way this boundary dies: it still imports only framework code but starts
  // behaving differently per caller. A surface identity check is that failure.
  //
  // COMMENTS ARE STRIPPED FIRST, and that is load-bearing rather than tidy: this
  // driver's header DOCUMENTS the forbidden shape (it names `surface === admin` as
  // the signal that the seam is wrong), so a raw text scan would fire on the
  // documentation of the rule and report a defect that does not exist. Scan code.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/^\s*\/\/.*$/gmu, " ");

  assert.equal(
    /\b(surface|onscreenAgent|admin)\s*(===|!==)\s*["'`a-zA-Z]/u.test(code),
    false,
    "the driver must never branch on which surface it serves"
  );
});
