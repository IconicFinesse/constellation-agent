// Focused engine-swap P4a-3d coverage: ONE render projection, TWO surfaces.
//
// The owner's first live admin tool turn on v1.2.1+97 produced three defects with a
// correct final transcript:
//
//   1. nothing visible until the whole reply appeared at the end,
//   2. one call's input and output drawn as two separate chunks,
//   3. no grouping of tool calls.
//
// Symptoms 2 and 3 are one flag (`groupToolRuns`); symptom 1 is the render projection
// never reaching admin. These cases pin all three THROUGH admin's real render path:
// `store.render()` → `agentView.renderMessages(...)` → `buildMessageDisplayGroups`.
//
// TWO PROPERTIES ARE PROVEN RATHER THAN ASSERTED.
//
//   * `one painter` is proven by MUTATING the shared projection at runtime and watching
//     admin's painted history change. A lookalike implementation in admin would ignore
//     that mutation, so this case cannot pass for the wrong reason.
//   * the state is READ FROM THE DRIVER, not copied, by mutating DRIVER state directly
//     and watching the paint follow — a store-side mirror would not.
//
// ENTERING WHERE PRODUCTION ENTERS. The streaming cases start at
// `store.runConversationLoop()` with the REAL flag seam, the REAL tier resolver, the REAL
// turn driver and the REAL transport, with only `fetch` scripted. Nothing hand-populates
// post-turn state, because a fixture that does cannot catch a wiring regression — this
// campaign's oldest failure mode.
//
// Hermetic: no network (fetch is scripted), no app-data writes (persist is stubbed), no
// real DOM (the renderer is recorded through the harness loader).

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./p4a3d_paint_loader.mjs", import.meta.url), import.meta.url);

const DISPATCH_FLAG = "ENGINE_SWAP_DISPATCH";

function createRuntime() {
  const runtime = {
    api: {
      async fileRead() {
        return { content: "notes" };
      },
      async fileWrite() {
        return { ok: true };
      }
    },
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
    proxy: { buildUrl: (url) => url },
    utils: {
      userCrypto: {
        async decryptText(value) {
          return value;
        },
        async encryptText(value) {
          return value;
        }
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
    // SYNCHRONOUS: a frame callback runs before the next statement, so a recorded paint
    // is unambiguously the paint this turn caused, not a later stray frame.
    requestAnimationFrame(callback) {
      callback(0);
      // 0, NOT a handle: the callback already ran synchronously, and returning a truthy
      // handle would make the store believe a frame is still pending, suppressing every
      // later streaming paint for the rest of the turn.
      return 0;
    },
    removeEventListener() {},
    space: runtime
  };
  globalThis.space = runtime;

  return runtime;
}

const runtime = createRuntime();
const storeModule = await import("/modules/_core/admin/views/agent/store.js");
const { adminAgent: store } = storeModule;

const viewModule = await import("/modules/_core/admin/views/agent/view.js");
const { p4a3dPaints } = viewModule;

const projectionModule = await import("/modules/_core/framework/js/engine-swap/chat-projection.js");
const { p4a3dProjectionCalls, p4a3dTransformers } = projectionModule;

const { createAgentThreadView } = await import("/modules/_core/visual/conversation/thread-view.js");
const { canonicalMessagesToTypedEntries, projectHistoryEntryForDisplay } = await import(
  "/modules/_core/framework/js/engine-swap/history-shapes.js"
);

// The REAL renderer, unrecorded: grouping and folding are judged by the code that ships.
const realView = createAgentThreadView({});

function sseBody(frames) {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
}

// ONE CHUNK PER FRAME, AWAITED BETWEEN READS — this is what makes the streaming case a
// streaming case. Handing the reader the whole body in a single chunk (the shape earlier
// suites used) applies every delta before the first paint can run, so the turn would look
// correct while proving nothing about text arriving over time: a live preview and a
// reply that appears all at once are indistinguishable from a single-chunk fixture.
function createSseResponse(bodyText) {
  const chunks = bodyText
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => new TextEncoder().encode(`${block}\n\n`));
  let index = 0;

  return {
    body: {
      getReader: () => ({
        async read() {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }

          const value = chunks[index];
          index += 1;
          // A real network read is not instantaneous: yielding here lets the frame paint
          // that belongs to this chunk run BEFORE the next delta lands, which is exactly
          // the interleaving the owner watched on screen.
          await Promise.resolve();
          return { done: false, value };
        }
      })
    },
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : null) },
    ok: true,
    status: 200,
    text: async () => bodyText
  };
}

function queueTransport(bodies) {
  const pending = [...bodies];
  const requestedBodies = [];

  globalThis.fetch = async (_url, init) => {
    requestedBodies.push(JSON.parse(init.body));

    if (!pending.length) {
      throw new Error("unexpected extra transport call");
    }

    return createSseResponse(pending.shift());
  };

  return requestedBodies;
}

function stubSurface(t) {
  const previous = {
    applyPromptInput: store.applyPromptInput,
    chatRuntime: store.chatRuntime,
    history: store.history,
    isSending: store.isSending,
    persistHistory: store.persistHistory,
    preparePromptRequest: store.preparePromptRequest,
    thread: store.refs.thread,
    settings: store.settings,
    status: store.status,
    stopRequested: store.stopRequested,
    syncCurrentChatRuntime: store.syncCurrentChatRuntime
  };

  store.chatRuntime = { attachments: { rememberMessageAttachments() {}, setActiveMessage() {} } };
  // A THREAD IS REQUIRED FOR THE STREAMING PATH TO EXIST. Admin's scheduled streaming paint
  // returns early when `refs.thread` is null (a real surface always has one). The stub answers
  // `querySelector` with null, which is exactly the first-delta case: no streaming row has been
  // mounted yet, so the patch misses and the paint must come from a full re-render.
  store.refs.thread = { querySelector: () => null };
  store.syncCurrentChatRuntime = () => {};
  store.applyPromptInput = () => {};
  store.persistHistory = async () => {};
  store.preparePromptRequest = async (requestMessages) => ({
    messages: requestMessages.map((message) => ({
      content: String(message?.content || ""),
      role: message?.role === "assistant" ? "assistant" : "user"
    })),
    promptInput: { requestMessages: [], systemPrompt: "You are the admin agent." },
    systemPrompt: "You are the admin agent."
  });
  store.history = [];
  store.ready = true;
  store.settings = {
    ...store.settings,
    apiEndpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: "test-key-not-real",
    model: "openai/gpt-5.4-mini",
    paramsText: "temperature:0.2",
    provider: "api"
  };

  p4a3dPaints.length = 0;
  p4a3dTransformers.length = 0;

  t.after(() => {
    store.refs.thread = previous.thread;
    delete previous.thread;
    Object.assign(store, previous);
    store.engineSwapPendingHold = null;
    runtime.configValues.clear();
    store.stopRequested = false;
    store.isSending = false;
    p4a3dPaints.length = 0;
    p4a3dTransformers.length = 0;
  });
}

function userMessage(id = "u1") {
  return { attachments: [], content: "read my notes", id, kind: "", role: "user" };
}


// The turn driver's OWN state object, reached through the product's projection method
// (`syncEngineSwapTurnState` returns `driver.state`). The suite needs the driver's real
// slot to write to; it does not get its own copy of it.
function driverStateFor(agentStore) {
  return agentStore.syncEngineSwapTurnState();
}

// The text AS PAINTED. Never re-read `paint.history`: the streaming preview entry is mutated
// in place by the driver, so re-reading it would show the finished sentence in every frame.
function paintedContents(paint) {
  return Array.isArray(paint?.contents) ? paint.contents : [];
}

function lastPaint() {
  return p4a3dPaints[p4a3dPaints.length - 1] || null;
}

function groupsFor(paint) {
  return realView.buildMessageDisplayGroups(paint.history, paint.options);
}

// --- the streaming paint (symptom 1) ------------------------------------------

const STREAMING_ANSWER = sseBody([
  { choices: [{ delta: { content: "Your notes " } }] },
  { choices: [{ delta: { content: "say hello." } },] },
  { choices: [{ delta: {}, finish_reason: "stop" }] }
]);

test("a streaming Tier 1 turn paints its preview WHILE it arrives, not only at commit", async (t) => {
  stubSurface(t);
  runtime.configValues.set(DISPATCH_FLAG, true);
  queueTransport([STREAMING_ANSWER]);

  const outcome = await store.runConversationLoop(userMessage());

  // A turn that never reached the model would leave the streaming assertions below
  // vacuous: assert it completed before reading anything into the paints.
  assert.equal(outcome, "complete", "the scripted streaming turn must complete");
  assert.ok(p4a3dPaints.length >= 2, `a streaming turn must paint more than once (saw ${p4a3dPaints.length})`);

  // The committed reply is the LAST thing that appears. Every paint BEFORE the one that
  // first carries the committed text is a streaming paint, and it must already show the
  // prose the user is watching arrive.
  // The COMMIT is identified structurally — an entry that is not streaming and carries the
  // reply — not by matching text, so a preview that has already accumulated the whole
  // sentence cannot be mistaken for the committed row.
  const committedIndex = p4a3dPaints.findIndex(
    (paint) =>
      paint.streamingFlags.some((streaming) => streaming === false) &&
      paintedContents(paint).some((content) => content.includes("Your notes say hello."))
  );

  assert.ok(committedIndex > 0, `the committed reply must not be the first paint (index ${committedIndex})`);

  const streamingPaints = p4a3dPaints.slice(0, committedIndex);
  const streamingProse = streamingPaints
    .flatMap((paint) => paintedContents(paint))
    .filter((content) => content.includes("Your notes"));

  assert.ok(
    streamingProse.length > 0,
    `a paint before the commit must carry the streaming preview (saw ${JSON.stringify(
      streamingPaints.map(paintedContents)
    )})`
  );
  // PARTIAL text, not the finished sentence: this is what distinguishes a live preview
  // from a projection that only ever draws the committed reply.
  assert.ok(
    streamingProse.some((content) => !content.includes("say hello.")),
    "at least one streaming paint must carry PARTIAL text, or the preview is not live"
  );
});

// --- grouping and the single-call fold (symptoms 2 and 3) ----------------------

const TWO_CALL_BODY = sseBody([
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call_a", type: "function", function: { name: "file_read", arguments: '{"path":"a.txt"}' } }
          ]
        }
      }
    ]
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
]);

const ONE_CALL_BODY = sseBody([
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call_one", type: "function", function: { name: "file_read", arguments: '{"path":"a.txt"}' } }
          ]
        }
      }
    ]
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
]);

const ANSWER_AFTER_TOOL = sseBody([{ choices: [{ delta: { content: "Read it." } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);

function typedHistoryFrom(canonicalMessages) {
  return canonicalMessagesToTypedEntries(canonicalMessages).map((entry) => projectHistoryEntryForDisplay(entry));
}

function oneCallTurn(committed = false) {
  const canonical = [
    { content: "read my notes", role: "user" },
    { content: "", role: "assistant", toolCalls: [{ arguments: '{"path":"a.txt"}', id: "call_one", name: "file_read" }] },
    { content: 'ok: {"content":"notes"}', role: "tool", toolCallId: "call_one" }
  ];

  return typedHistoryFrom(canonical);
}

function multiCallTurn() {
  const canonical = [
    { content: "read both", role: "user" },
    {
      content: "Reading both.",
      role: "assistant",
      toolCalls: [
        { arguments: '{"path":"a.txt"}', id: "call_1", name: "file_read" },
        { arguments: '{"path":"b.txt"}', id: "call_2", name: "file_read" }
      ]
    },
    { content: 'ok: {"a":1}', role: "tool", toolCallId: "call_1" },
    { content: 'ok: {"b":2}', role: "tool", toolCallId: "call_2" }
  ];

  return typedHistoryFrom(canonical);
}

test("admin passes groupToolRuns, so ONE call paints ONE chip and a batch paints ONE row", (t) => {
  stubSurface(t);
  store.history = oneCallTurn();
  store.render();

  const singlePaint = lastPaint();
  assert.equal(singlePaint.options.groupToolRuns, true, "admin must opt into the shared grouping");

  const singleGroups = groupsFor(singlePaint);
  assert.equal(
    singleGroups.filter((group) => group.type === "standalone-output").length,
    1,
    `a one-call turn must fold to ONE chip (saw ${JSON.stringify(singleGroups.map((group) => group.type))})`
  );
  assert.equal(singleGroups.length, 1, "the call and its result must not draw two rows");

  store.history = multiCallTurn();
  store.render();

  const multiGroups = groupsFor(lastPaint());
  const runGroups = multiGroups.filter((group) => group.type === "tool-run");

  assert.equal(runGroups.length, 1, `a two-call batch must paint ONE grouped row (saw ${JSON.stringify(
    multiGroups.map((group) => group.type)
  )})`);
  assert.equal(runGroups[0].summary.total, 2, "the grouped row must count both calls");
});

// --- one painter, not two ------------------------------------------------------

test("a change to the SHARED projection changes what admin paints", (t) => {
  stubSurface(t);
  store.history = oneCallTurn();
  store.render();

  const baseline = paintedContents(lastPaint());
  assert.ok(baseline.length > 0, "the baseline paint must draw something before the mutation is meaningful");

  const marker = "SHARED-PROJECTION-MUTATION";
  p4a3dTransformers.push((projection) => [
    ...projection,
    { content: marker, id: "mutation-row", kind: "", role: "assistant" }
  ]);

  store.render();

  const mutated = paintedContents(lastPaint());

  assert.ok(
    mutated.includes(marker),
    "admin must paint through the SHARED projection: a runtime change to it must reach admin's paint"
  );
  // A lookalike in admin could not produce this tag, because it would never call the
  // shared module at all.
  assert.equal(lastPaint().history.p4a3dShared, true, "admin's painted history must come from the shared module");
  assert.ok(p4a3dProjectionCalls.count > 0, "the shared projection must actually be exercised");
});

// --- access, do not copy -------------------------------------------------------

test("admin paints the DRIVER's own preview object, not a store-side copy", (t) => {
  stubSurface(t);
  runtime.configValues.set(DISPATCH_FLAG, true);
  store.history = [];

  const preview = {
    content: "a sentence still arriving",
    id: "engine-swap-streaming-preview",
    kind: "",
    role: "assistant",
    streaming: true,
    tier1Turn: true
  };

  // THE TURN DRIVER WRITES ITS OWN SLOT — this is the driver's state assignment verbatim,
  // not a store field. A store-side mirror would not see it and the paint below would stay
  // empty, which is exactly the failure shape this case forbids.
  driverStateFor(store).engineSwapStreamingPreview = preview;

  t.after(() => {
    driverStateFor(store).engineSwapStreamingPreview = null;
  });

  store.render();

  assert.equal(
    store.engineSwapStreamingPreview,
    preview,
    "the accessor must expose the driver's own object, not a copy of its value"
  );
  assert.ok(
    paintedContents(lastPaint()).includes("a sentence still arriving"),
    `the paint must follow driver state (saw ${JSON.stringify(paintedContents(lastPaint()))})`
  );
  const descriptor = Object.getOwnPropertyDescriptor(store, "engineSwapStreamingPreview");

  assert.ok(descriptor && typeof descriptor.get === "function", "it must be an accessor");
  assert.equal(descriptor.value, undefined, "it must not be a data property");
});

// --- flag OFF stays inert ------------------------------------------------------

test("with the flag OFF, admin's paint is the committed projection and grouping still applies", (t) => {
  stubSurface(t);
  // LEGACY entries, not typed ones: this case is about the flag being OFF on an ordinary
  // thread, and the converter is a separate contract with its own suite.
  store.history = [
    { attachments: [], content: "hello", id: "a1", kind: "", role: "assistant" },
    { attachments: [], content: "read my notes", id: "u1", kind: "", role: "user" }
  ];

  store.render();

  const paint = lastPaint();

  assert.deepEqual(
    paintedContents(paint),
    ["hello", "read my notes"],
    "a legacy thread with no live turn must paint its committed entries unchanged"
  );
  assert.equal(paint.options.groupToolRuns, true, "grouping is a render option, not a flag behaviour");
  assert.equal(store.engineSwapStreamingPreview, null, "OFF must not fabricate live state");
});

// --- the legacy import path still resolves to the ONE implementation -----------

test("the old onscreen import path re-exports the SAME functions, not a second copy", async () => {
  const shared = await import("/modules/_core/framework/js/engine-swap/chat-projection.js");
  const legacy = await import("/modules/_core/onscreen_agent/chat-projection.js");

  assert.equal(legacy.buildChatRenderProjection, shared.buildChatRenderProjection);
  assert.equal(legacy.createProvisionalChipEntry, shared.createProvisionalChipEntry);
  assert.equal(legacy.resolvePreviewTailContent, shared.resolvePreviewTailContent);
  assert.equal(legacy.PROVISIONAL_CHIP_PREFIX, shared.PROVISIONAL_CHIP_PREFIX);
  assert.equal(legacy.PREVIEW_SEGMENT_SUFFIX, shared.PREVIEW_SEGMENT_SUFFIX);
});
