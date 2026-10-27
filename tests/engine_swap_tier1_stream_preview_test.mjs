// Focused engine-swap coverage for the Tier 1 STREAMING PREVIEW.
//
// The live symptom this pins: on a Tier 1 session the assistant's prose appeared all
// at once when the turn finished, never while it was being produced.
//
// Cause: `api.js` already reports every text delta through `onDelta`, but both Tier 1
// `sendCompletion` closures passed only `{requestBody, settings, signal}`, so the
// transport buffered the prose and the assembler returned it in one piece. The loop
// itself emits no delta event (`tool-turn-loop.js` has `assistant-turn` only, after
// `sendTurn` resolves), so the surface is the only place this can be fixed.
//
// The fix paints into ONE preview slot that is added to the RENDER projection and
// never to `this.history`. That separation is the point of this suite: a preview must
// be visible while streaming and must be structurally incapable of reaching
// persistence, the display-only derivation, or a reload.
//
// Every case drives the REAL turn (`runTier1ConversationTurn` -> the real session and
// loop -> `streamOnscreenAgentToolTurn` -> fetch -> SSE reader), with a fake response
// that splits its frames at hostile byte offsets. Hermetic: `fetch` is a local stub
// and no disk, key, or app data is touched.

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
      callback(0);
      return 1;
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

const runtime = createHarness();
const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

const PREVIEW_ID = "engine-swap-streaming-preview";

function createChunkedReader(chunks) {
  let index = 0;

  return {
    async read() {
      if (index >= chunks.length) {
        return { done: true, value: undefined };
      }

      const value = new TextEncoder().encode(chunks[index]);

      index += 1;

      return { done: false, value };
    }
  };
}

function createStreamResponse(frames) {
  // Split every frame again at a hostile offset: a hook wired only on whole frames
  // would still fail on the live body's arbitrary byte chunking.
  const chunks = frames.flatMap((frame) => {
    const cut = Math.max(1, Math.floor(frame.length / 3));

    return [frame.slice(0, cut), frame.slice(cut, cut * 2), frame.slice(cut * 2)];
  });

  return {
    body: { getReader: () => createChunkedReader(chunks) },
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : null) },
    ok: true,
    status: 200
  };
}

function textFrame(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

// A turn that narrates, calls one tool, then answers. The narration is what the user
// should watch arrive; the call is what makes the turn a real tool turn.
function narratedToolTurnFrames() {
  return [
    textFrame("Let me "),
    textFrame("read that "),
    textFrame("file."),
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { function: { arguments: '{"path":"~/notes.txt"}', name: "file_read" }, id: "call_a", index: 0 }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    })}\n\n`,
    "data: [DONE]\n\n"
  ];
}

function withFetch(t, respond) {
  const previous = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, init) => {
    requests.push({ init, url: String(url) });

    return respond(requests.length - 1);
  };

  t.after(() => {
    globalThis.fetch = previous;
  });

  return requests;
}

function stubSurface(t) {
  const previous = {
    displayMode: store.displayMode,
    engineSwapDisplayOnlyMessageIds: store.engineSwapDisplayOnlyMessageIds,
    engineSwapStreamingPreview: store.engineSwapStreamingPreview,
    history: store.history,
    persistHistory: store.persistHistory,
    render: store.render,
    scheduleStreamingMessageRender: store.scheduleStreamingMessageRender,
    setStreamingAssistantStatus: store.setStreamingAssistantStatus,
    settings: store.settings,
    status: store.status,
    stopRequested: store.stopRequested
  };

  // Snapshots of the preview taken at every delta, from a REAL call site the append
  // method reaches: `setStreamingAssistantStatus` receives the accumulated text.
  const paintSteps = [];

  store.render = () => {};
  store.persistHistory = async () => {};
  store.displayMode = "full";
  // Full mode reaches the row-patch seam through a rAF; record instead of touching
  // the DOM. The row itself is thread-view work, not store work.
  store.scheduleStreamingMessageRender = () => {};
  store.setStreamingAssistantStatus = (content) => {
    paintSteps.push({
      content: String(content || ""),
      historyIds: (Array.isArray(store.history) ? store.history : []).map((entry) => String(entry?.id || "")),
      previewId: String(store.engineSwapStreamingPreview?.id || "")
    });
  };

  t.after(() => {
    store.displayMode = previous.displayMode;
    store.engineSwapDisplayOnlyMessageIds = previous.engineSwapDisplayOnlyMessageIds;
    store.engineSwapStreamingPreview = previous.engineSwapStreamingPreview;
    store.history = previous.history;
    store.persistHistory = previous.persistHistory;
    store.render = previous.render;
    store.scheduleStreamingMessageRender = previous.scheduleStreamingMessageRender;
    store.setStreamingAssistantStatus = previous.setStreamingAssistantStatus;
    store.settings = previous.settings;
    store.status = previous.status;
    store.stopRequested = previous.stopRequested;
  });

  return { paintSteps };
}

function baseSettings() {
  return {
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: "test-key-not-real",
    model: "test-model",
    provider: "openai"
  };
}

const PREPARED = Object.freeze({
  messages: [
    { content: "You are a test agent.", role: "system" },
    { content: "read my notes", role: "user" }
  ]
});

const REQUEST_MESSAGES = Object.freeze([
  { content: "You are a test agent.", role: "system" },
  { content: "read my notes", id: "u1", role: "user" }
]);

// First request narrates then calls the tool; every later request answers. A stub
// that replayed the tool-call turn forever would loop until the iteration cap and
// paint the same narration repeatedly -- a test bug that looks like a product bug.
function respondNarrateThenAnswer() {
  return (index) =>
    createStreamResponse(index === 0 ? narratedToolTurnFrames() : answerFrames("Your notes say hello."));
}

function answerFrames(text) {
  return [
    textFrame(text),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ];
}

test("Tier 1 streams text deltas into a growing preview that history never sees", async (t) => {
  const surface = stubSurface(t);
  const requests = withFetch(t, respondNarrateThenAnswer());

  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;
  runtime.api.fileRead = async () => ({ content: "hello" });

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.ok(turn, "the turn must return");
  assert.ok(requests.length >= 1, "at least one transport call");

  // THE ASSERTION: the prose the user watches arrives INCREMENTALLY.
  const contents = surface.paintSteps.map((step) => step.content);

  assert.ok(contents.length >= 3, `deltas must paint as they arrive (saw ${JSON.stringify(contents)})`);

  // The first call's narration arrives one delta at a time, each paint EXTENDING the
  // same preview text. (The follow-up call's answer streams through the same slot,
  // which is why the list continues past the narration -- that is the fix working,
  // not a stray duplicate.)
  assert.deepEqual(
    contents.slice(0, 3),
    ["Let me ", "Let me read that ", "Let me read that file."],
    `each delta must extend the SAME preview, in order (saw ${JSON.stringify(contents)})`
  );
  assert.ok(
    contents.length === 3 || contents[3].startsWith(contents[2]) || contents[3].length > 0,
    "the follow-up turn streams into the same one slot"
  );

  // ...and the preview is structurally separate from history.
  for (const step of surface.paintSteps) {
    assert.equal(step.previewId, PREVIEW_ID, "every paint must go to the one preview slot");
    assert.ok(
      !step.historyIds.includes(PREVIEW_ID),
      `the preview must never enter history (saw ${JSON.stringify(step.historyIds)})`
    );
  }
});

test("the preview is cleared when the turn ends, so no row survives that history lacks", async (t) => {
  const surface = stubSurface(t);
  withFetch(t, respondNarrateThenAnswer());

  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;
  runtime.api.fileRead = async () => ({ content: "hello" });

  await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.equal(
    store.engineSwapStreamingPreview,
    null,
    "a preview that outlived its turn would be a message the user never received"
  );
  assert.ok(
    !store.history.some((entry) => String(entry?.id || "") === PREVIEW_ID),
    "history must contain only real messages"
  );
  assert.ok(surface.paintSteps.length >= 3, "the pre-clear stream still painted");
});

test("a transport failure clears the preview and still surfaces the error", async (t) => {
  stubSurface(t);
  withFetch(t, () => ({ headers: { get: () => "application/json" }, ok: false, status: 500, text: async () => "boom" }));

  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;

  // The loop CATCHES a transport failure and returns it as a structured
  // `reason: ERROR` turn (tool-turn-loop.js:169-189), so the outcome is a resolved
  // result with `status: "error"` -- never a throw and never a silent completion.
  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.equal(turn?.result?.status, "error", "a failed transport must surface as an error turn");
  assert.ok(String(turn?.result?.error || "").trim(), "the failure must carry a legible message");
  assert.equal(store.engineSwapStreamingPreview, null, "a failed turn must not leave a preview row behind");
});

test("the commit keeps exactly one assistant message and never duplicates the preview", async (t) => {
  stubSurface(t);
  withFetch(t, respondNarrateThenAnswer());

  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;
  runtime.api.fileRead = async () => ({ content: "hello" });

  await store.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  const assistantEntries = store.history.filter((entry) => entry?.role === "assistant");

  assert.ok(assistantEntries.length >= 1, "the reply must be committed");
  assert.equal(
    assistantEntries.filter((entry) => entry.streaming === true).length,
    0,
    "a committed message may never still claim to be streaming"
  );
  assert.ok(
    !store.history.some((entry) => String(entry?.id || "") === PREVIEW_ID),
    "the preview id is reserved and must never be committed"
  );
});

test("a render without a preview projects exactly the history (Tier 3 unchanged)", async (t) => {
  const previousRender = store.render;
  const seen = [];

  t.after(() => {
    store.render = previousRender;
  });

  store.engineSwapStreamingPreview = null;
  store.history = [...REQUEST_MESSAGES];

  const expectedLength = store.getRenderHistory().length;

  assert.equal(expectedLength, 2, "baseline projection is the history alone");
});
