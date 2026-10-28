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

// --- the promotion, and the no-fork guard ------------------------------------

test("onscreen settles a hold through the SAME shared function admin uses", async () => {
  // THE PARITY THAT MAKES THE PROMOTION SAFE. If onscreen's delegation ever diverges
  // from `replaceHeldToolResult` — a re-implemented body, a dropped argument, a narrowed
  // match — this goes red while everything else stays green. Parity is asserted by
  // RESULT over histories that exercise each branch of the guard, not by reading source.
  const { replaceHeldToolResult } = await import(
    "/modules/_core/framework/js/engine-swap/history-shapes.js"
  );
  const { onscreenAgent } = await import("/modules/_core/onscreen_agent/store.js");

  // A history whose LAST entry is the held result for `callId`.
  function historyWithHeldResult(callId) {
    return [
      { content: "delete it", id: "a1", kind: "", role: "assistant" },
      {
        content: `held: the file ${callId} is waiting for the user's confirmation in the chat.`,
        id: `tool-result-${callId}`,
        kind: "tool_result",
        role: "user",
        toolResult: { callId, name: "file_delete", payload: null }
      }
    ];
  }

  const cases = [
    { args: { content: "ok: {\"deleted\":true}", isError: false, toolCallId: "call_1" }, history: historyWithHeldResult("call_1") },
    { args: { content: "policy: the user denied the file.", isError: true, toolCallId: "call_2" }, history: historyWithHeldResult("call_2") },
    // NO MATCH: the array comes back unchanged but still as a NEW array.
    { args: { content: "ok: 1", isError: false, toolCallId: "missing" }, history: historyWithHeldResult("call_9") }
  ];

  for (const { args, history } of cases) {
    const previous = onscreenAgent.history;
    onscreenAgent.history = history;

    try {
      assert.deepEqual(
        onscreenAgent.replaceEngineSwapHeldResult(args),
        replaceHeldToolResult(history, args),
        "onscreen must settle through the shared function, identically"
      );
    } finally {
      onscreenAgent.history = previous;
    }
  }

  // The shared function must not mutate its input either.
  const original = historyWithHeldResult("call_3");
  const snapshot = JSON.stringify(original);
  replaceHeldToolResult(original, { content: "ok: 1", isError: false, toolCallId: "call_3" });
  assert.equal(JSON.stringify(original), snapshot, "the input history must not be mutated");
});

test("the shared LOOP is used, never re-implemented on admin's side", () => {
  const source = readFileSync(new URL("store.js", ADMIN_DIR), "utf8");
  const bridge = readFileSync(new URL("engine-swap-bridge.js", ADMIN_DIR), "utf8");

  // A forked loop would need the loop's own vocabulary. Neither file has any of it:
  // the iteration cap, the stop-reason set and the loop entry point all stay reachable
  // only through the shared driver/session.
  assert.doesNotMatch(source, /TOOL_TURN_MAX_ITERATIONS/u, "the iteration cap is the shared loop's");
  assert.doesNotMatch(source, /TOOL_TURN_STOP_REASON/u, "stop reasons are the shared loop's");
  assert.doesNotMatch(source, /runToolTurn/u, "admin must not call the loop directly");
  assert.doesNotMatch(bridge, /runToolTurn/u, "the bridge must not fork the loop either");
  // And the driver is reached through the bridge, not re-implemented.
  assert.match(bridge, /createTier1TurnDriver/u);
  assert.doesNotMatch(source, /engine-swap\/turn-driver\.js/u);
});

// --- N1: a second confirm inside the gate window -----------------------------

test("a SECOND confirm arriving inside the gate window neither re-executes nor blanks the settled row (N1)", async (t) => {
  stubSurface(t);
  runtime.configValues.set("ENGINE_SWAP_DISPATCH", true);

  const target = makeTmpTarget();
  t.after(() => rmSync(dirname(target), { force: true, recursive: true }));

  const deletesBefore = deletes.length;

  queueTransport([TOOL_TURN_BODY.replace("__TARGET__", target), ANSWER_BODY]);

  await store.runConversationLoop(userMessage());

  const realSession = store.engineSwapTier1Session;

  assert.ok(realSession, "the held turn must keep its session");

  // A REAL GATE WINDOW. The real gate still settles on the first call; only the
  // RESUMPTION is delayed by a promise we hold open. That is exactly the interval a
  // double click occupies in a browser: the handler has started, the gate has run, and
  // the transcript has not been settled yet.
  let openWindow;
  const windowGate = new Promise((resolve) => {
    openWindow = resolve;
  });
  let gateCalls = 0;

  store.engineSwapTier1Session = {
    cancelHeld: () => realSession.cancelHeld?.(),
    confirmHeld: async () => {
      gateCalls += 1;

      const settled = await realSession.confirmHeld();

      await windowGate;
      return settled;
    },
    denyHeld: () => realSession.denyHeld?.(),
    formatOutcome: (outcome) => realSession.formatOutcome(outcome),
    runContinuation: (options) => realSession.runContinuation(options)
  };

  // Both clicks are fired before either can resume; neither is awaited in between, or a
  // regressed handler would deadlock the test instead of failing it.
  const firstClick = store.confirmEngineSwapHold();
  const secondClick = store.confirmEngineSwapHold();

  openWindow();
  await Promise.all([firstClick, secondClick]);

  // EXACTLY ONCE, on both counts that matter: the deletion and the gate settlement.
  assert.deepEqual(deletes.slice(deletesBefore), [target], "the held deletion must run exactly once");
  assert.equal(existsSync(target), false, "the confirmed deletion must still have happened");
  assert.equal(gateCalls, 1, "a second confirm must not re-enter the gate");

  // THE SETTLED ROW IS ACCURATE. A regressed handler blanks it with 'the held call could
  // not be executed' while claiming the call failed — a direct lie about a deletion that
  // did happen. Exactly one result row, carrying the real outcome.
  const resultRows = store.history.filter(
    (entry) => entry?.kind === "tool_result" && entry?.toolResult?.callId === "call_1"
  );

  assert.equal(resultRows.length, 1, "one result per call id, never a second row");
  assert.equal(
    Boolean(resultRows[0]?.toolResult?.error),
    false,
    "a confirmed deletion must not settle as a failed row"
  );
  assert.equal(store.status, "Confirmed and executed.", "the status must describe what actually happened");
  assert.equal(store.engineSwapPendingHold, null);
  assert.equal(store.engineSwapTier1Session, null);
});

// --- N2: parity that can see INSIDE the shared function ----------------------

test("the shared held-result replacement matches the base implementation case by case (N2)", async () => {
  // WHY THIS EXISTS. The delegation-parity case above compares onscreen's method with the
  // function it delegates to, so it is green by construction and blind to a change INSIDE
  // that function: removing the last-position guard left the whole battery green while its
  // own differential probe reported 25/154 differences.
  //
  // So this compares the shared function against a LITERAL TRANSCRIPTION of the base
  // implementation, over a table that exercises every branch of the guard. The
  // transcription keeps `position === last`, which is the whole point: an unguarded shared
  // function then diverges on the non-last-match case and this goes red.
  //
  // The transcription uses the shared shape helpers (`canonicalMessagesToTypedEntries`,
  // `isToolResultEntry`) for entry construction, exactly as base did — the property under
  // test is the GUARD AND REPLACE logic, not the shape mapping.
  const {
    canonicalMessagesToTypedEntries,
    isToolResultEntry,
    replaceHeldToolResult
  } = await import("/modules/_core/framework/js/engine-swap/history-shapes.js");

  function baseReplaceHeldResult(history, { content = "", isError = false, toolCallId = "" } = {}) {
    const entries = canonicalMessagesToTypedEntries([
      {
        content,
        isError: isError === true,
        role: "tool",
        toolCallId: String(toolCallId || "")
      }
    ]);
    const next = Array.isArray(history) ? [...history] : [];
    const index = next.findIndex(
      (entry, position) =>
        isToolResultEntry(entry) &&
        String(entry?.toolResult?.callId || "") === String(toolCallId || "") &&
        position === next.length - 1
    );

    if (index === -1 || !entries.length) {
      return next;
    }

    next[index] = entries[entries.length - 1];
    return next;
  }

  const callEntry = (callId) => ({
    content: "delete it",
    id: `call-${callId}`,
    kind: "tool_call",
    role: "assistant",
    toolCall: { arguments: { path: "~/notes.txt" }, callId, name: "file_delete" }
  });

  const heldEntry = (callId, id) => ({
    content: `held: the file ${callId} is waiting for the user's confirmation in the chat.`,
    id,
    kind: "tool_result",
    role: "user",
    toolResult: { callId, name: "file_delete", payload: null }
  });

  const settleOk = (callId) => ({ content: `ok: {"deleted":"${callId}"}`, isError: false, toolCallId: callId });
  const settleDenied = (callId) => ({ content: "policy: the user denied the file ~/notes.txt.", isError: true, toolCallId: callId });

  const cases = [
    {
      args: settleOk("c1"),
      history: [callEntry("c1"), heldEntry("c1", "r1")],
      name: "match on the LAST entry"
    },
    {
      // THE GUARD CASE. A held result further back must never be rewritten: an older row
      // is history the user already watched.
      args: settleOk("c1"),
      history: [heldEntry("c1", "r1"), callEntry("c2"), { content: "later turn", id: "u9", kind: "", role: "user" }],
      name: "match on a NON-LAST entry"
    },
    {
      args: settleOk("c1"),
      history: [callEntry("c12"), heldEntry("c12", "r12")],
      name: "call-id prefix must not match"
    },
    {
      args: settleOk("missing"),
      history: [callEntry("c1"), heldEntry("c1", "r1")],
      name: "no match at all"
    },
    {
      // Two results for one call id cannot exist on the wire, but a history can hold one
      // if an older row leaked: only the last-position duplicate may be replaced.
      args: settleOk("c1"),
      history: [heldEntry("c1", "r1"), callEntry("c1"), heldEntry("c1", "r2")],
      name: "duplicate ids: only the last-position duplicate"
    },
    {
      args: settleDenied("c1"),
      history: [callEntry("c1"), heldEntry("c1", "r1")],
      name: "denied settle"
    },
    { args: settleOk("c1"), history: [], name: "empty history" },
    { args: settleOk("c1"), history: null, name: "non-array history" },
    {
      args: settleOk("c1"),
      history: Object.freeze([Object.freeze(callEntry("c1")), Object.freeze(heldEntry("c1", "r1"))]),
      name: "frozen input array and entries"
    }
  ];

  for (const testCase of cases) {
    const snapshot = JSON.stringify(testCase.history ?? null);
    const shared = replaceHeldToolResult(testCase.history, testCase.args);
    const base = baseReplaceHeldResult(testCase.history, testCase.args);

    assert.deepEqual(shared, base, `shared and base must agree: ${testCase.name}`);
    assert.equal(
      JSON.stringify(testCase.history ?? null),
      snapshot,
      `the input history must not be mutated: ${testCase.name}`
    );

    if (Array.isArray(testCase.history)) {
      assert.notEqual(shared, testCase.history, `a new array is returned: ${testCase.name}`);
    }
  }

  // OMITTED ARGUMENTS: both must behave identically rather than throw.
  const heldHistory = [callEntry("c1"), heldEntry("c1", "r1")];

  assert.deepEqual(
    replaceHeldToolResult(heldHistory),
    baseReplaceHeldResult(heldHistory),
    "an omitted argument object must behave identically"
  );
});
