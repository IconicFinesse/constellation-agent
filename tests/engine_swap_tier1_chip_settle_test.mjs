// SETTLE-ON-DISPATCH for typed tool chips (P3 final item, owner-reported).
//
// THE DEFECT: every typed chip read `run_code · Running` for the WHOLE turn and only
// flipped to `Success` when the assistant's turn ended. Two states were observable live —
// mid-turn all chips `Running` (spinner, no args block), after turn end all `Success` —
// because the chip only ever settled when the commit-time history rewrite replaced the
// provisional row.
//
// CAUSE: the Tier-1 loop already knows the outcome and says so —
// `tool-turn-loop.js` emits `{ call, outcome, position, type: "dispatch" }` — but nothing
// subscribed. `onEvent` had ZERO hits in the store, and the corrective-retry session
// passed `onEvent: null`.
//
// FOUR SEAMS, and this suite pins one contract per seam:
//   1. the session forwards `onEvent` on the post-hold continuation too
//   2. the store settles the matching provisional record on `type === "dispatch"`,
//      PRESERVING `atChars` so the chip never moves
//   3. the projection paints the settled outcome instead of a hardcoded `running`
//   4. the chip descriptor prefers the entry's OWN terminal outcome, which is the seam
//      that makes any of it visible
//
// The turn-exit clear stays the single cleanup site: an UNDISPATCHED chip must still be
// `Running` and must still be cleared, and a held call must show `Held` (never spinning).
//
// Hermetic: transport is a fake `fetch`, persistence and render are stubbed, no disk, no
// keys, no app data.

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
    // Scheduled, NOT synchronous: the store assigns the returned id into
    // `streamingRenderFrame` AFTER this call. Running the callback inline and returning
    // an id would leave that field stuck at a truthy value and silence every later
    // paint, which is indistinguishable from the defect this suite hunts.
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

const runtime = createHarness();
const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");
const { buildChatRenderProjection, createProvisionalChipEntry } = await import(
  "/modules/_core/onscreen_agent/chat-projection.js"
);
const { createAgentThreadView } = await import("/modules/_core/visual/conversation/thread-view.js");
const { canonicalMessagesToTypedEntries, projectHistoryEntryForDisplay } = await import(
  "/modules/_core/framework/js/engine-swap/history-shapes.js"
);
const { createTier1Session } = await import(
  "/modules/_core/framework/js/engine-swap/tier1-session.js"
);

const view = createAgentThreadView({});

// ---------------------------------------------------------------- helpers ----

function project(entries) {
  return entries.map((entry) => projectHistoryEntryForDisplay(entry));
}

// The descriptor the renderer actually uses, reached through the REAL grouping path
// rather than by re-deriving the rule.
function descriptorsFor(projectionHistory) {
  const groups = view.buildMessageDisplayGroups(projectionHistory, {});

  return groups
    .filter((group) => group.type === "standalone-output" && group.typedTool)
    // A RESULT entry projects a descriptor too, and one call has two entries. Only the
    // CALL row's outcome is under test here (that is the chip).
    .filter((group) => String(group.typedTool.argumentsText ?? "") !== "")
    .map((group) => ({ id: group.messageId, typedTool: group.typedTool }));
}

function chipEntry(callId, name, outcome) {
  const call = { atChars: 0, callId, name };

  if (outcome) {
    call.outcome = outcome;
  }

  return createProvisionalChipEntry(call);
}

function textFrame(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function toolCallFrame(callId, name, argsJson) {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ function: { arguments: argsJson, name }, id: callId, index: 0 }]
        },
        finish_reason: "tool_calls"
      }
    ]
  })}\n\n`;
}

function answerFrames(text) {
  return [
    textFrame(text),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ];
}

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
  // Split each frame again at a hostile offset: a hook wired only on whole frames would
  // still fail on a live body's arbitrary byte chunking.
  const chunks = frames.flatMap((frame) => {
    const cut = Math.max(1, Math.floor(frame.length / 2));

    return [frame.slice(0, cut), frame.slice(cut)];
  });

  return {
    body: { getReader: () => createChunkedReader(chunks) },
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : null) },
    ok: true,
    status: 200
  };
}

function withFetch(t, respond) {
  const previous = globalThis.fetch;

  globalThis.fetch = async () => respond();

  t.after(() => {
    globalThis.fetch = previous;
  });
}

// Records every provisional-chip state the surface tries to PAINT. `render` is where a
// chip becomes visible, so a snapshot taken there is the user-visible truth rather than an
// internal intermediate.
function stubSurface(t) {
  const previous = {
    displayMode: store.displayMode,
    engineSwapDisplayOnlyMessageIds: store.engineSwapDisplayOnlyMessageIds,
    engineSwapPreviewSealed: store.engineSwapPreviewSealed,
    engineSwapProvisionalCalls: store.engineSwapProvisionalCalls,
    engineSwapStreamingPreview: store.engineSwapStreamingPreview,
    history: store.history,
    persistHistory: store.persistHistory,
    render: store.render,
    scheduleEngineSwapChipRender: store.scheduleEngineSwapChipRender,
    scheduleStreamingMessageRender: store.scheduleStreamingMessageRender,
    setStreamingAssistantStatus: store.setStreamingAssistantStatus,
    settings: store.settings,
    status: store.status,
    stopRequested: store.stopRequested
  };
  const paints = [];

  store.displayMode = "full";
  store.scheduleStreamingMessageRender = () => {};
  store.setStreamingAssistantStatus = () => {};
  store.persistHistory = async () => {};
  // SYNCHRONOUS chip repaint. The product coalesces a chip repaint into one rAF, which
  // is right but makes a settle UNOBSERVABLE here: the rAF id is truthy until its
  // callback runs, so a settle inside the turn is deferred past the turn's own cleanup
  // and the assertion would measure timer order instead of the settle. Collapsing the
  // frame removes only the DELAY; the state painted is the product's own.
  store.scheduleEngineSwapChipRender = function scheduleEngineSwapChipRender() {
    this.render({ preserveScroll: true });
  };

  store.render = () => {
    paints.push(
      (Array.isArray(store.engineSwapProvisionalCalls) ? store.engineSwapProvisionalCalls : []).map((entry) => ({
        atChars: entry?.atChars,
        callId: String(entry?.callId || ""),
        name: String(entry?.name || ""),
        outcome: String(entry?.outcome || "")
      }))
    );
  };

  t.after(() => {
    store.displayMode = previous.displayMode;
    store.engineSwapDisplayOnlyMessageIds = previous.engineSwapDisplayOnlyMessageIds;
    store.engineSwapPreviewSealed = previous.engineSwapPreviewSealed;
    store.engineSwapProvisionalCalls = previous.engineSwapProvisionalCalls;
    store.engineSwapStreamingPreview = previous.engineSwapStreamingPreview;
    store.history = previous.history;
    store.persistHistory = previous.persistHistory;
    store.render = previous.render;
    store.scheduleEngineSwapChipRender = previous.scheduleEngineSwapChipRender;
    store.scheduleStreamingMessageRender = previous.scheduleStreamingMessageRender;
    store.setStreamingAssistantStatus = previous.setStreamingAssistantStatus;
    store.settings = previous.settings;
    store.status = previous.status;
    store.stopRequested = previous.stopRequested;
  });

  return { paints };
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

function resetTurnState() {
  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;
  store.engineSwapProvisionalCalls = [];
  store.engineSwapPreviewSealed = false;
}

// ===========================================================================
// SEAM 4 — the descriptor prefers the entry's OWN terminal outcome
// ===========================================================================

test("a settled provisional paints its real outcome through the existing vocabulary", () => {
  const expectations = [
    ["success", { iconName: "check_circle", label: "file_read · Success", tone: "is-success" }],
    ["error", { iconName: "error", label: "file_read · Error", tone: "is-error" }],
    ["held", { iconName: "visibility", label: "file_read · Held", tone: "is-pending" }],
    ["deferred", { iconName: "schedule", label: "file_read · Deferred", tone: "is-pending" }]
  ];

  expectations.forEach(([outcome, expected]) => {
    const [descriptor] = descriptorsFor([chipEntry("c1", "file_read", outcome)]);

    assert.equal(descriptor.typedTool.outcome, outcome, `descriptor must carry ${outcome}`);
    assert.equal(
      view.formatTypedToolLabel(descriptor.typedTool.name, descriptor.typedTool.outcome),
      expected.label
    );

    // ICON AND TONE, through the REAL resolver that decides what the user sees.
    //
    // This half used to be decoration: the previous lines read `const card =
    // view.resolveTypedToolCardState ? null : null` (null by construction, because the
    // resolver was closure-local) and `assert.equal(expected.iconName === "sync", false)`,
    // which compares the expectations table to itself. Neither touched product code, so
    // the case claimed to pin the vocabulary while pinning only the label (audit N2).
    // `resolveTypedToolCardState` is now exported for this, following the same precedent
    // as `formatTypedToolLabel` above.
    const card = view.resolveTypedToolCardState(
      descriptor.typedTool.name,
      descriptor.typedTool.outcome
    );

    assert.deepEqual(
      { iconName: card.iconName, label: card.label, tone: card.tone },
      expected,
      `the ${outcome} chip must render the shared icon, label and tone`
    );

    // The spinner is the visual claim that work is in flight, so no settled outcome may
    // carry it.
    assert.notEqual(card.iconName, "sync", "a settled outcome never spins");
    assert.notEqual(card.tone, "is-running", "a settled outcome is never in the running tone");
  });
});

test("an UNsettled provisional stays byte-identical to the pre-fix running chip", () => {
  const [descriptor] = descriptorsFor([chipEntry("c1", "run_code")]);

  assert.equal(descriptor.typedTool.outcome, "running");
  assert.equal(view.formatTypedToolLabel("run_code", "running"), "run_code · Running");

  // The projection entry itself is unchanged too: same id, same prose, same outcome.
  const [entry] = [chipEntry("c1", "run_code")];

  assert.equal(entry.content, "execution run_code call\nrunning");
  assert.equal(entry.typedToolOutcome, "running");
  assert.equal(entry.id, "provisional-call-c1");
});

// PARITY (owner constraint on seam 4). A COMMITTED call entry carries `pending` from the
// shared history reader and must keep resolving its outcome from its own RESULT entry,
// exactly as before this change. This test must pass on BOTH the pristine base and the
// fix; it is the guard that the committed path was not touched.
test("a committed call entry resolves exactly as before: pending falls through to its result", () => {
  const entries = canonicalMessagesToTypedEntries([
    {
      content: "Reading.",
      role: "assistant",
      toolCalls: [
        { arguments: { path: "~/a" }, id: "c1", name: "file_read" },
        { arguments: { path: "~/b" }, id: "c2", name: "file_read" }
      ]
    },
    { content: 'ok: "A"', role: "tool", toolCallId: "c1" },
    { content: "error (execution): nope", isError: true, role: "tool", toolCallId: "c2" }
  ]);

  const descriptors = descriptorsFor(project(entries));
  const byOutcome = descriptors.map((descriptor) => descriptor.typedTool.outcome);

  // c1 -> its result succeeds; c2 -> its result errored. Both came from the RESULT entry,
  // never from the call entry's own `pending` marker.
  assert.deepEqual(byOutcome, ["success", "error"]);

  // A committed call with NO result still reads `running`, which is the only truthful
  // reading for it and is what the pre-fix path produced.
  const orphan = canonicalMessagesToTypedEntries([
    { content: "", role: "assistant", toolCalls: [{ arguments: {}, id: "c9", name: "file_list" }] }
  ]);

  assert.equal(descriptorsFor(project(orphan))[0].typedTool.outcome, "running");
});

// ===========================================================================
// SEAM 3 — the projection paints the settled outcome
// ===========================================================================

test("the projection paints a settled outcome and leaves an unsettled one running", () => {
  const projection = buildChatRenderProjection({
    history: [],
    preview: null,
    provisionalCalls: [
      { atChars: 0, callId: "c1", name: "file_read", outcome: "success" },
      { atChars: 12, callId: "c2", name: "file_write" }
    ]
  });

  assert.equal(projection.length, 2);
  assert.equal(projection[0].typedToolOutcome, "success");
  assert.equal(projection[0].content, "execution file_read call\nsuccess");
  // Unsettled: byte-identical to the pre-fix shape.
  assert.equal(projection[1].typedToolOutcome, "running");
  assert.equal(projection[1].content, "execution file_write call\nrunning");
});

// ===========================================================================
// SEAM 2 — the store settles in place, and the one cleanup site still owns exit
// ===========================================================================

test("settling preserves chip ORDER and every atChars offset", () => {
  const previous = store.engineSwapProvisionalCalls;

  store.engineSwapPreviewSealed = false;
  store.engineSwapProvisionalCalls = [
    { atChars: 5, callId: "c1", name: "file_read" },
    { atChars: 40, callId: "c2", name: "file_write" },
    { atChars: 90, callId: "c3", name: "run_code" }
  ];

  try {
    assert.equal(store.settleEngineSwapProvisionalCall({ callId: "c2", outcome: "error" }), true);

    assert.deepEqual(
      store.engineSwapProvisionalCalls.map((entry) => ({
        atChars: entry.atChars,
        callId: entry.callId,
        outcome: String(entry.outcome || "")
      })),
      [
        { atChars: 5, callId: "c1", outcome: "" },
        { atChars: 40, callId: "c2", outcome: "error" },
        { atChars: 90, callId: "c3", outcome: "" }
      ],
      "the array order and every offset must survive a settle"
    );

    // Idempotent: a repeated dispatch for the same call cannot flip it back.
    assert.equal(store.settleEngineSwapProvisionalCall({ callId: "c2", outcome: "success" }), false);
    assert.equal(store.engineSwapProvisionalCalls[1].outcome, "error");

    // An unknown call id invents NOTHING (a provider that never streamed the call must not
    // grow a chip the user never watched arrive).
    assert.equal(store.settleEngineSwapProvisionalCall({ callId: "nope", outcome: "success" }), false);
    assert.equal(store.engineSwapProvisionalCalls.length, 3);

    // Only terminal words settle; `running`/`pending` are not news.
    assert.equal(store.settleEngineSwapProvisionalCall({ callId: "c1", outcome: "running" }), false);
    assert.equal(String(store.engineSwapProvisionalCalls[0].outcome || ""), "");
  } finally {
    store.engineSwapProvisionalCalls = previous;
  }
});

test("only a dispatch event settles, and a malformed event never throws", () => {
  const previous = store.engineSwapProvisionalCalls;

  store.engineSwapPreviewSealed = false;

  try {
    store.engineSwapProvisionalCalls = [{ atChars: 0, callId: "c1", name: "file_read" }];

    // Every OTHER loop event is already carried by the turn RESULT; consuming it here would
    // be a second source of the same truth.
    assert.equal(store.handleEngineSwapTurnEvent({ type: "assistant-turn", text: "hi" }), false);
    assert.equal(String(store.engineSwapProvisionalCalls[0].outcome || ""), "");

    // A dispatch carrying an unknown status settles nothing.
    assert.equal(
      store.handleEngineSwapTurnEvent({ call: { id: "c1" }, outcome: { status: "mystery" }, type: "dispatch" }),
      false
    );
    assert.equal(String(store.engineSwapProvisionalCalls[0].outcome || ""), "");

    // Garbage in: ignored, never raised (this runs inside a live transport event path).
    assert.equal(store.handleEngineSwapTurnEvent(null), false);
    assert.equal(store.handleEngineSwapTurnEvent({ type: "dispatch" }), false);

    // The real event shape from `tool-turn-loop.js:272`.
    assert.equal(
      store.handleEngineSwapTurnEvent({ call: { id: "c1" }, outcome: { status: "ok" }, position: 0, type: "dispatch" }),
      true
    );
    assert.equal(store.engineSwapProvisionalCalls[0].outcome, "success");
  } finally {
    store.engineSwapProvisionalCalls = previous;
  }
});

// ===========================================================================
// END TO END: the REAL turn subscribes and settles mid-turn
// ===========================================================================

test("a real Tier 1 turn settles its chip on dispatch, before the turn ends", async (t) => {
  const surface = stubSurface(t);
  let call = 0;

  withFetch(t, () => {
    call += 1;

    return call === 1
      ? createStreamResponse([
          textFrame("Reading it."),
          toolCallFrame("call_a", "file_read", '{"path":"~/notes.txt"}'),
          "data: [DONE]\n\n"
        ])
      : createStreamResponse(answerFrames("Your notes say hello."));
  });

  resetTurnState();
  runtime.api.fileRead = async () => ({ content: "hello" });

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.ok(turn, "the turn must return");

  // At least one paint must show the chip SETTLED. This is the assertion the defect
  // failed: pre-fix the only observable chip state was `Running` for the whole turn.
  const settled = surface.paints.find((paint) =>
    paint.some((chip) => chip.callId === "call_a" && chip.outcome === "success")
  );

  assert.ok(
    settled,
    `a dispatched call must settle its chip mid-turn (paints: ${JSON.stringify(surface.paints)})`
  );

  // The chip never moved: its offset is the preview length where it appeared, and settling
  // did not rewrite it.
  const recorded = surface.paints.flat().filter((chip) => chip.callId === "call_a");
  const offsets = new Set(recorded.map((chip) => chip.atChars));

  assert.equal(offsets.size, 1, "settling must not move the chip's interleave offset");

  // THE ONE CLEANUP SITE still owns exit: nothing survives the turn.
  assert.deepEqual(store.engineSwapProvisionalCalls, []);
  assert.equal(store.engineSwapStreamingPreview, null);
});

test("a display-only turn dispatches nothing and leaves no chip stranded", async (t) => {
  const surface = stubSurface(t);
  const calls = [];

  withFetch(t, () =>
    createStreamResponse([
      textFrame("Here is how you would read it."),
      textFrame("\n_____javascript\nawait space.api.fileRead('~/notes.txt')"),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ])
  );

  resetTurnState();
  runtime.api.fileRead = async (...args) => {
    calls.push(args);

    return { content: "hello" };
  };

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.ok(turn, "the turn must return");

  // HARD LINE: fenced/separator display content never executes on this tier.
  assert.equal(calls.length, 0, "a separator reply must not execute anything");

  // No chip was invented, and none survives the turn.
  assert.deepEqual(store.engineSwapProvisionalCalls, []);
  assert.equal(
    surface.paints.flat().some((chip) => chip.outcome === "success"),
    false,
    "nothing settled, because nothing was dispatched"
  );
});

// ===========================================================================
// NO DOUBLE ROW: a committed call retires its provisional chip
// ===========================================================================

test("a settled chip is dropped once the committed history speaks for that call", () => {
  const committed = project(
    canonicalMessagesToTypedEntries([
      { content: "", role: "assistant", toolCalls: [{ arguments: {}, id: "c1", name: "file_read" }] },
      { content: 'ok: "A"', role: "tool", toolCallId: "c1" }
    ])
  );

  // A chip that settled mid-turn, now that the commit owns the same call id: the committed
  // typed row is the truth and a second row for the same call would be a duplicate.
  const projection = buildChatRenderProjection({
    history: committed,
    preview: null,
    provisionalCalls: [{ atChars: 0, callId: "c1", name: "file_read", outcome: "success" }]
  });

  assert.equal(
    projection.filter((entry) => String(entry?.typedToolCallId || "") === "c1").length,
    2,
    "one committed call row and one committed result row survive; no THIRD row appears"
  );
  assert.equal(
    projection.some((entry) => entry?.provisional === true),
    false,
    "the provisional chip must not be drawn beside its committed row"
  );
});

// ===========================================================================
// RENDER SIGNATURE: a settled chip cannot be reused as a running row
// ===========================================================================

test("the render signature changes when a chip settles, so its row is rebuilt", () => {
  const groupsFor = (outcome) =>
    view.buildMessageDisplayGroups([chipEntry("c1", "file_read", outcome)], {});
  const options = { toolRunOpenState: null };
  const running = view.getGroupRenderSignature(groupsFor(undefined)[0], options);
  const settled = view.getGroupRenderSignature(groupsFor("success")[0], options);

  assert.notEqual(running, settled, "a settled chip must not reuse the running row");
  assert.notEqual(
    view.getGroupRenderSignature(groupsFor("success")[0], options),
    view.getGroupRenderSignature(groupsFor("error")[0], options),
    "success and error must not share a row either"
  );
});

// THE OUTCOME TERM IS LOAD-BEARING ON ITS OWN.
//
// The case above would ALSO pass if the signature ignored the outcome entirely, because a
// settled chip's projected prose differs from a running one and that already changes the
// parsed-output signature. A seeded mutation proved it: removing the outcome term from the
// signature left every case green. This case removes the prose as a variable — identical
// content, identical id, only `typedToolOutcome` differing — so the signature can pass only
// if it actually carries the resolved outcome.
test("the signature carries the resolved outcome even when the prose is identical", () => {
  const runningEntry = { ...chipEntry("c1", "file_read") };
  // Same chip, same prose, settled outcome. The prose is deliberately left stale so nothing
  // but the outcome can distinguish the two rows.
  const settledEntry = { ...runningEntry, typedToolOutcome: "success" };
  const options = { toolRunOpenState: null };
  const runningGroup = view.buildMessageDisplayGroups([runningEntry], {})[0];
  const settledGroup = view.buildMessageDisplayGroups([settledEntry], {})[0];

  assert.equal(runningGroup.messageId, settledGroup.messageId, "the row id is shared");
  assert.equal(
    runningGroup.typedTool.outcome,
    "running",
    "guard: the stale-prose chip really is unsettled"
  );
  assert.equal(settledGroup.typedTool.outcome, "success");
  assert.notEqual(
    view.getGroupRenderSignature(runningGroup, options),
    view.getGroupRenderSignature(settledGroup, options),
    "identical prose must still produce different signatures once the outcome settles"
  );
});

// ===========================================================================
// SEAM 1 — onEvent reaches the post-hold continuation
// ===========================================================================

test("onEvent is forwarded on the post-hold continuation, not nulled", async () => {
  const events = [];
  const script = [
    {
      toolCalls: [{ arguments: '{"path":"~/a"}', id: "h1", name: "file_list" }]
    },
    { text: "Done." }
  ];
  let index = 0;
  const api = {
    fileList: async () => ({ files: [] })
  };
  const session = createTier1Session({
    api,
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    model: "test-model",
    onEvent: (event) => events.push(event),
    params: {},
    providerKey: "",
    sendCompletion: async () => {
      const step = script[Math.min(index, script.length - 1)];

      index += 1;

      const toolCalls = Array.isArray(step.toolCalls)
        ? step.toolCalls.map((call) => ({ function: { arguments: call.arguments, name: call.name }, id: call.id }))
        : [];

      return {
        choices: [
          {
            finish_reason: toolCalls.length ? "tool_calls" : "stop",
            message: { content: step.text || "", tool_calls: toolCalls }
          }
        ]
      };
    }
  });

  await session.runContinuation({
    messages: [{ content: "go", role: "user" }],
    toolResultText: ""
  });

  assert.ok(
    events.some((event) => event?.type === "dispatch"),
    `a continuation must report its dispatch events (saw: ${JSON.stringify(events.map((event) => event?.type))})`
  );
  assert.equal(events.find((event) => event?.type === "dispatch")?.call?.id, "h1");
});
