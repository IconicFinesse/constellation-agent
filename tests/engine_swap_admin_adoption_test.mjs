// Focused engine-swap P4a-3c coverage: the ADMIN surface adopts the shared engine.
//
// WHAT THIS PROVES, and why it had to wait for this lane. P4a-3a could only test the
// consent affordance at UNIT level: `gate.hold()` is reachable only through the Tier 1
// dispatch pipeline, admin resolved Tier 3, and no session could exist. Every case here
// drives a REAL hold instead — a real `file_delete` held by the real destructive gate,
// reached through admin's real conversation loop, the real shared turn driver, the real
// shared transport and the real dispatch pipeline. The only stubs are the transport
// response itself, persistence, render, and prompt assembly.
//
// ENTERING WHERE PRODUCTION ENTERS. The turn starts at `store.runConversationLoop()`,
// not at a hand-populated history and not at a hand-built session. The flag comes from
// the REAL runtime config seam (`runtime.config.get`), the tier from the ONE shared
// resolver, the capability from the real capability table, and the hold from the real
// gate. A fixture that hand-populates post-hold state cannot catch a wiring regression,
// which is this campaign's oldest failure mode.
//
// THE NEGATIVE CONTROL IS THE POINT. Cancel must leave the FILESYSTEM unchanged: the
// api stub really unlinks a real temp file, so 'nothing happened' is observed on disk
// rather than asserted about a boolean. Confirm must execute EXACTLY ONCE.
//
// Hermetic: no network (fetch is scripted), no app-data writes (persist is stubbed), no
// DOM (render is stubbed). Real temp files are created and removed inside a tmpdir.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const ADMIN_DIR = new URL("../app/L0/_all/modules/_core/admin/views/agent/", import.meta.url);

function createRuntime() {
  const configValues = new Map();
  const deletes = [];

  const runtime = {
    api: {
      async fileDelete(path) {
        deletes.push(path);
        // A REAL deletion, so the negative control observes the filesystem instead of
        // trusting a counter.
        rmSync(path, { force: true });
        return { deleted: path };
      },
      async fileRead() {
        return { content: "" };
      },
      async fileWrite() {
        return { ok: true };
      }
    },
    config: {
      get(name, fallback = undefined) {
        return configValues.has(name) ? configValues.get(name) : fallback;
      }
    },
    configValues,
    extend(_meta, value) {
      return value;
    },
    fw: {
      createStore(_name, model) {
        return model;
      }
    },
    proxy: { buildUrl: (url) => url },
    utils: {
      userCrypto: {
        async decryptText(v) { return v; },
        async encryptText(v) { return v; }
      },
      yaml: { parse: () => ({}), stringify: () => "" }
    }
  };

  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {}, style: {} }),
    body: { appendChild() {} },
    documentElement: { appendChild() {} }
  };
  globalThis.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };
  globalThis.window = {
    addEventListener() {},
    cancelAnimationFrame() {},
    console,
    location: { href: "http://localhost/" },
    matchMedia: () => ({ addEventListener() {}, matches: false }),
    requestAnimationFrame(callback) {
      callback(0);
      return 1;
    },
    removeEventListener() {},
    space: runtime
  };
  globalThis.space = runtime;

  return { deletes, runtime };
}

const { deletes, runtime } = createRuntime();
const storeModule = await import("/modules/_core/admin/views/agent/store.js");
const { adminAgent: store } = storeModule;

const TOOL_TURN_BODY = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"file_delete","arguments":"{\\"path\\":\\"__TARGET__\\"}"}}]},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  "",
  "data: [DONE]",
  ""
].join("\n");

const ANSWER_BODY = [
  'data: {"choices":[{"delta":{"content":"Done."}}]}',
  "",
  "data: [DONE]",
  ""
].join("\n");

function createSseResponse(bodyText) {
  let sent = false;

  return {
    body: {
      getReader: () => ({
        async read() {
          if (sent) {
            return { done: true, value: undefined };
          }

          sent = true;
          return { done: false, value: new TextEncoder().encode(bodyText) };
        }
      })
    },
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : null) },
    ok: true,
    status: 200,
    text: async () => bodyText
  };
}

// Scripted transport: one queued body per call. Nothing reaches the network.
function queueTransport(bodies) {
  const pending = [...bodies];
  const calls = [];

  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));

    if (!pending.length) {
      throw new Error("unexpected extra transport call");
    }

    return createSseResponse(pending.shift());
  };

  return calls;
}

function makeTmpTarget() {
  const dir = mkdtempSync(join(tmpdir(), "p4a3c-consent-"));
  const path = join(dir, "notes.txt");

  writeFileSync(path, "content that must survive a cancel");
  return path;
}

function stubSurface(t) {
  const previous = {
    applyPromptInput: store.applyPromptInput,
    chatRuntime: store.chatRuntime,
    history: store.history,
    persistHistory: store.persistHistory,
    preparePromptRequest: store.preparePromptRequest,
    render: store.render,
    settings: store.settings,
    status: store.status,
    syncCurrentChatRuntime: store.syncCurrentChatRuntime
  };

  store.chatRuntime = { attachments: { rememberMessageAttachments() {}, setActiveMessage() {} } };
  store.syncCurrentChatRuntime = () => {};
  store.applyPromptInput = () => {};
  store.persistHistory = async () => {};
  store.render = () => {};
  store.preparePromptRequest = async () => ({
    messages: [
      { content: "You are the admin agent.", role: "system" },
      { content: "delete the note file", role: "user" }
    ],
    promptInput: { requestMessages: [], systemPrompt: "You are the admin agent." },
    systemPrompt: "You are the admin agent."
  });
  store.history = [];
  store.settings = {
    ...store.settings,
    apiEndpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: "test-key-not-real",
    model: "openai/gpt-5.4-mini",
    paramsText: "temperature:0.2",
    provider: "api"
  };

  t.after(() => {
    Object.assign(store, previous);
    store.engineSwapPendingHold = null;
    store.engineSwapTier1Session = null;
    store.engineSwapHeldMessages = null;
    runtime.configValues.clear();
    store.stopRequested = false;
    store.isSending = false;
  });
}

function userMessage(id = "u1") {
  return { attachments: [], content: "delete the note file", id, kind: "", role: "user" };
}

// --- the tier seam ------------------------------------------------------------

test("a tools-capable config resolves tier1 through the ONE shared resolver", async (t) => {
  stubSurface(t);
  runtime.configValues.set("ENGINE_SWAP_DISPATCH", true);
  const bridge = await import("/modules/_core/admin/views/agent/engine-swap-bridge.js");
  const plan = await bridge.resolveAdminTier1Plan({ settings: store.settings, runtime });

  assert.equal(plan.tier, "tier1");
  assert.equal(plan.dispatchEnabled, true);
  assert.ok(plan.capabilities?.flags?.tools);
});

test("admin owns no tier rule: the bridge calls the shared resolver, never a copy", () => {
  const bridge = readFileSync(new URL("engine-swap-bridge.js", ADMIN_DIR), "utf8");
  const storeSource = readFileSync(new URL("store.js", ADMIN_DIR), "utf8");

  // The shared resolver is imported and called...
  assert.match(bridge, /resolveEngineSwapSessionPlan/u);
  // ...and no admin file re-derives the tier from the tools flag itself.
  assert.doesNotMatch(bridge, /flags\.tools\s*===\s*true\s*\?/u);
  assert.doesNotMatch(storeSource, /framework\/js\/engine-swap\/config-flag\.js/u);
  assert.doesNotMatch(storeSource, /resolveEngineSwapSessionPlan/u);
});

test("a local provider resolves tier3 and stays on the legacy chain", async (t) => {
  stubSurface(t);
  runtime.configValues.set("ENGINE_SWAP_DISPATCH", true);
  const bridge = await import("/modules/_core/admin/views/agent/engine-swap-bridge.js");
  const plan = await bridge.resolveAdminTier1Plan({
    settings: { ...store.settings, provider: "local" },
    runtime
  });

  assert.equal(plan.tier, "tier3");
  assert.equal(plan.diagnostics, "local-provider");
});

test("with the flag OFF the tier is none and nothing engine-shaped is allocated", async (t) => {
  stubSurface(t);
  // EXPLICIT OFF. The out-of-tree ON preload only supplies a flag the suite has not set
  // itself, so a case asserting the OFF behaviour has to state its own precondition
  // rather than lean on the shipped default — otherwise this case silently measures the
  // ON column's configuration instead of the OFF one.
  runtime.configValues.set("ENGINE_SWAP_DISPATCH", false);
  runtime.configValues.set("ENGINE_SWAP_SHADOW", false);
  const bridge = await import("/modules/_core/admin/views/agent/engine-swap-bridge.js");
  const plan = await bridge.resolveAdminTier1Plan({ settings: store.settings, runtime });

  assert.equal(plan.tier, "none");
  assert.equal(plan.dispatchEnabled, false);
  assert.equal(plan.capabilities, null);
});

// --- end to end consent -------------------------------------------------------

test("a real held file_delete puts the bar up and CANCEL LEAVES THE FILE UNTOUCHED", async (t) => {
  stubSurface(t);
  runtime.configValues.set("ENGINE_SWAP_DISPATCH", true);

  const target = makeTmpTarget();
  t.after(() => rmSync(dirname(target), { force: true, recursive: true }));

  // `deletes` is shared across this file's cases, so every dispatch assertion below is
  // measured as a DELTA. A global count would let one case's deletion satisfy another
  // case's "nothing ran" claim — the precise false-green this suite exists to avoid.
  const deletesBefore = deletes.length;
  const calls = queueTransport([TOOL_TURN_BODY.replace("__TARGET__", target)]);
  const outcome = await store.runConversationLoop(userMessage());

  // The turn really ran on the shared engine.
  assert.equal(outcome, "complete");
  assert.equal(calls.length, 1, "exactly one provider request in the held turn");
  assert.ok(Array.isArray(calls[0].tools) && calls[0].tools.length > 0, "the tool list reached the wire");

  // THE HOLD IS REAL: reachable state, not a hand-populated fixture.
  assert.ok(store.engineSwapPendingHold, "a held destructive call must raise the confirm bar");
  assert.equal(store.engineSwapPendingHold.tool, "file_delete");
  assert.ok(store.engineSwapTier1Session, "the session that holds it must be kept");

  // NEGATIVE CONTROL: nothing has run, so the file is still there.
  assert.equal(deletes.length, deletesBefore);
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(target, "utf8"), "content that must survive a cancel");

  // The human says NO.
  await store.denyEngineSwapHold();

  assert.equal(deletes.length, deletesBefore, "a denied call must never reach the api handler");
  assert.equal(existsSync(target), true, "CANCEL MUST LEAVE THE FILESYSTEM UNCHANGED");
  assert.equal(store.engineSwapPendingHold, null);
  assert.equal(store.engineSwapTier1Session, null);
  assert.match(store.status, /^Cancelled: the user denied/u);
});

test("CONFIRM executes the held deletion EXACTLY ONCE and replaces the held row", async (t) => {
  stubSurface(t);
  runtime.configValues.set("ENGINE_SWAP_DISPATCH", true);

  const target = makeTmpTarget();
  t.after(() => rmSync(dirname(target), { force: true, recursive: true }));

  // One tool turn, then one continuation answer after the confirmed execution.
  const calls = queueTransport([
    TOOL_TURN_BODY.replace("__TARGET__", target),
    ANSWER_BODY
  ]);

  const deletesBefore = deletes.length;

  await store.runConversationLoop(userMessage());

  assert.ok(store.engineSwapPendingHold);
  assert.equal(existsSync(target), true);
  assert.equal(deletes.length, deletesBefore, "a held call must not execute before consent");

  await store.confirmEngineSwapHold();

  // EXACTLY ONCE.
  assert.deepEqual(deletes.slice(deletesBefore), [target]);
  assert.equal(existsSync(target), false, "a confirmed deletion must actually delete");
  assert.equal(calls.length, 2, "the confirmed call resumes the loop for one continuation");

  // ONE result per call id, and it is the SETTLED one — never a second appended row.
  const resultRows = store.history.filter(
    (entry) => entry?.kind === "tool_result" && entry?.toolResult?.callId === "call_1"
  );

  assert.equal(resultRows.length, 1, "appending a second result would invalidate the next request");
  assert.equal(store.engineSwapPendingHold, null);
  assert.equal(store.engineSwapTier1Session, null);
  assert.equal(store.status, "Confirmed and executed.");

  // A second click must not run the deletion again.
  await store.confirmEngineSwapHold();
  assert.deepEqual(deletes.slice(deletesBefore), [target], "a second confirm must not re-execute");
});

// --- BUG-007 hard line: display content never executes ------------------------

test("a fenced display reply on admin's path dispatches NOTHING", async (t) => {
  stubSurface(t);
  runtime.configValues.set("ENGINE_SWAP_DISPATCH", true);

  const fencedBody = [
    'data: {"choices":[{"delta":{"content":"Here it is:\\n\\n```\\n_____javascript\\nawait space.api.fileDelete(\\"/tmp/nope\\");\\n```"}}]}',
    "",
    "data: [DONE]",
    ""
  ].join("\n");

  const deletesBefore = deletes.length;

  queueTransport([
    fencedBody,
    // The corrective retry (if issued) answers plainly with no call.
    ANSWER_BODY
  ]);

  await store.runConversationLoop(userMessage("u-fenced"));

  assert.equal(deletes.length, deletesBefore, "display content must never execute");
  assert.equal(store.engineSwapPendingHold, null, "no hold can come from display text");
});
