// Focused engine-swap coverage for TRANSCRIPT FIDELITY on Tier 1.
//
// The owner-reported live defect (VM, build b8a6536, dispatch ON) was functionally
// perfect and organizationally wrong: zero errors, zero failed calls, but
//   1. the model's first response was visible for a moment and then DISAPPEARED once
//      the tool calls landed, so intermediate narration was lost; and
//   2. tool-call chips stacked at the TOP of the turn instead of sitting
//      chronologically between the chat responses that produced them.
//
// Both symptoms have ONE cause, and it is a writer bug, not a render bug:
// `canonicalMessagesToTypedEntries` saw an assistant message carrying `toolCalls`,
// pushed one `tool_call` entry per call, and `return`ed before the assistant-text
// branch could run, so the narration was DISCARDED from the persisted record. The
// live preview showed it until the next iteration reset the slot (symptom 1), and
// what did persist was calls-only, so the order-faithful renderer drew every
// iteration's chips contiguously with no assistant anchor between them (symptom 2).
//
// Four contracts:
//   A. WRITER ORDER - an assistant turn with narration + calls emits the narration
//      message entry FIRST, then its calls in call order; results follow. The
//      per-iteration order is assistant text -> calls -> results -> next text.
//   B. DUAL SHAPE FOREVER - the reader needs no new branch (a narration entry IS a
//      plain assistant message), legacy entries round-trip byte-identically, and the
//      display-only derivation stays equal to a fresh derivation after reload.
//   C. RENDER ORDER - typed entries draw in STORED order, so a chip sits between the
//      prose that introduced it and the prose that follows. Driven through the REAL
//      grouping function, asserting order rather than presence.
//   D. PREVIEW ACCUMULATION - the streaming preview accumulates across a turn's
//      iterations instead of resetting, stays outside `this.history`, and is cleared
//      exactly once when the turn ends.
//
// Hermetic: no network, no keys, no disk. The surface half drives the REAL store and
// the REAL transport seam over a fake `fetch`, and stubs only persistence/render.

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
      return { classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {}, append() {}, style: {} };
    },
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    scrollingElement: { clientHeight: 0, scrollHeight: 0, scrollTop: 0 }
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

const historyShapes = await import("/modules/_core/framework/js/engine-swap/history-shapes.js");
const {
  canonicalMessagesToTypedEntries,
  historyEntriesToCanonicalMessages,
  normalizeTypedHistoryFields,
  projectHistoryEntryForDisplay,
  readHistoryEntry,
  serializeTypedHistoryFields
} = historyShapes;
const { createAgentThreadView, resolveExecutionCardState } = await import(
  "/modules/_core/visual/conversation/thread-view.js"
);
// The REAL execution module the product view is constructed with: without it the thread
// view cannot parse an execute display at all, so a stub would make the chip-swallow
// contract untestable.
const onscreenExecution = await import("/modules/_core/onscreen_agent/execution.js");
const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

const PREVIEW_ID = "engine-swap-streaming-preview";

// --- A. WRITER ORDER ---------------------------------------------------------

// The exact canonical turn the loop produces for one narrated parallel batch:
// ONE assistant message carrying both `content` and its two calls, then the two
// results in call order.
function narratedParallelTurn() {
  return [
    { content: "sys", role: "system" },
    { content: "read both files", role: "user" },
    {
      content: "Let me read both of those.",
      role: "assistant",
      toolCalls: [
        { arguments: { path: "~/a.txt" }, id: "c1", name: "file_read" },
        { arguments: { path: "~/b.txt" }, id: "c2", name: "file_read" }
      ]
    },
    { content: 'ok: {"content":"A"}', role: "tool", toolCallId: "c1" },
    { content: 'ok: {"content":"B"}', role: "tool", toolCallId: "c2" },
    { content: "Both files say hello.", role: "assistant" }
  ];
}

test("narration is preserved AHEAD of the calls it introduces, in call order", () => {
  const entries = canonicalMessagesToTypedEntries(narratedParallelTurn(), { fromIndex: 2 });

  assert.deepEqual(
    entries.map((entry) => (entry.kind ? `${entry.kind}:${entry.toolCall?.callId || entry.toolResult?.callId}` : `message:${entry.content}`)),
    [
      "message:Let me read both of those.",
      "tool_call:c1",
      "tool_call:c2",
      "tool_result:c1",
      "tool_result:c2",
      "message:Both files say hello."
    ],
    "the persisted order must be assistant text -> calls -> results -> next text"
  );
});

test("a narrated single-call iteration keeps text, call and result adjacent", () => {
  const entries = canonicalMessagesToTypedEntries(
    [
      {
        content: "Checking the notes.",
        role: "assistant",
        toolCalls: [{ arguments: { path: "~/notes.txt" }, id: "call_a", name: "file_read" }]
      },
      { content: 'ok: {"content":"hello"}', role: "tool", toolCallId: "call_a" }
    ],
    { fromIndex: 0 }
  );

  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, "");
  assert.equal(entries[0].content, "Checking the notes.");
  assert.equal(entries[1].kind, "tool_call");
  assert.equal(entries[2].kind, "tool_result");
});

test("a narration-less assistant turn still emits only its calls", () => {
  const entries = canonicalMessagesToTypedEntries(
    [
      { content: "", role: "assistant", toolCalls: [{ arguments: {}, id: "c9", name: "file_list" }] },
      { content: "", role: "assistant" }
    ],
    { fromIndex: 0 }
  );

  assert.equal(entries.length, 1, "an empty assistant turn contributes nothing");
  assert.equal(entries[0].kind, "tool_call");
  assert.equal(entries[0].toolCall.callId, "c9");
});

// Two iterations of one turn: the stored order must read as the transcript the user
// watched, which is exactly what makes chips interleave instead of stacking.
test("two narrated iterations read as an alternating transcript", () => {
  const entries = canonicalMessagesToTypedEntries(
    [
      {
        content: "First, reading.",
        role: "assistant",
        toolCalls: [{ arguments: { path: "~/a" }, id: "c1", name: "file_read" }]
      },
      { content: 'ok: {"content":"A"}', role: "tool", toolCallId: "c1" },
      {
        content: "Now writing the summary.",
        role: "assistant",
        toolCalls: [{ arguments: { content: "S", path: "~/s" }, id: "c2", name: "file_write" }]
      },
      { content: 'ok: {"wrote":true}', role: "tool", toolCallId: "c2" }
    ],
    { fromIndex: 0 }
  );

  assert.deepEqual(
    entries.map((entry) => (entry.kind ? entry.kind : entry.content)),
    ["First, reading.", "tool_call", "tool_result", "Now writing the summary.", "tool_call", "tool_result"]
  );
});

// --- B. DUAL SHAPE FOREVER ---------------------------------------------------

// The reader must handle the richer tail with NO new branch: a narration entry is a
// plain assistant message, which is a shape it has always read.
test("the richer tail replays into a valid canonical conversation", () => {
  const entries = canonicalMessagesToTypedEntries(narratedParallelTurn(), { fromIndex: 2 });
  const replayed = historyEntriesToCanonicalMessages(entries);
  const announced = [];
  const answered = [];

  replayed.forEach((message) => {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      message.toolCalls.forEach((call) => announced.push(call.id));
    }

    if (message.role === "tool") {
      answered.push(message.toolCallId);
    }
  });

  // The narration SURVIVES the replay as its own assistant text message, ahead of the
  // call announcements. This is the documented reader shape (one assistant message
  // per call entry); the writer change adds no reader branch and rewrites nothing,
  // so the narration arrives as the plain assistant message it is.
  assert.deepEqual(
    replayed.map((message) => message.role),
    ["assistant", "assistant", "assistant", "tool", "tool", "assistant"],
    "narration, one announcement per call, results, final answer"
  );
  assert.equal(replayed[0].content, "Let me read both of those.", "narration survives the replay");
  assert.equal(Array.isArray(replayed[0].toolCalls), false, "narration carries no calls of its own");
  assert.equal(announced.length, 2);
  assert.deepEqual(answered, announced, "every announced call is answered exactly once");
});

test("a legacy entry round-trips byte-identically and gains no keys", () => {
  const legacy = { attachments: [], content: "hello", id: "u1", kind: "", role: "user" };

  assert.deepEqual({ ...serializeTypedHistoryFields(legacy) }, {}, "a legacy write adds nothing");
  assert.deepEqual({ ...normalizeTypedHistoryFields(legacy) }, {}, "a legacy read adds nothing");
  assert.equal(readHistoryEntry(legacy).content, "hello");
});

test("the narration entry persists through the serializer/reader pair", () => {
  const [narration] = canonicalMessagesToTypedEntries(
    [{ content: "Reading now.", role: "assistant", toolCalls: [{ arguments: {}, id: "c1", name: "file_read" }] }],
    { fromIndex: 0 }
  );
  const stored = { ...narration, ...serializeTypedHistoryFields(narration) };
  const restored = { ...stored, ...normalizeTypedHistoryFields(stored) };

  assert.equal(restored.content, "Reading now.");
  assert.equal(restored.role, "assistant");
  assert.equal(restored.kind, "");
  assert.equal("toolCall" in restored, false, "a narration carries no tool payload");
});

// --- C. RENDER ORDER --------------------------------------------------------

// Driven through the REAL grouping function the renderer uses, asserting ORDER.
// A presence-only assertion would pass on the stacked layout this fix removes.
test("typed entries draw in stored order, with chips after their narration", () => {
  const view = createAgentThreadView({});
  const entries = canonicalMessagesToTypedEntries(narratedParallelTurn(), { fromIndex: 1 });
  const projected = entries.map((entry) => projectHistoryEntryForDisplay(entry));
  const groups = view.buildMessageDisplayGroups(projected, {});

  // The writer maps the assistant/tool TAIL only (user turns are already in history),
  // so what it contributes is narration -> four chips -> the answer.
  assert.deepEqual(
    groups.map((group) => (group.type === "standard" ? `message:${group.message.content}` : group.type)),
    [
      "message:Let me read both of those.",
      "standalone-output",
      "standalone-output",
      "standalone-output",
      "standalone-output",
      "message:Both files say hello."
    ],
    "narration must sit AHEAD of the chips it introduced, and the answer after them"
  );

  // The chips carry the call/result ids in order, so the rows are individually
  // addressable by the existing row patch.
  assert.deepEqual(
    groups.filter((group) => group.type === "standalone-output").map((group) => group.messageId),
    ["tool-call-c1", "tool-call-c2", "tool-result-c1", "tool-result-c2"]
  );
});

// The ordering guarantee must hold for the interleaved two-iteration shape, which is
// the exact live symptom: without narration both calls bunched at the top.
test("two iterations interleave chips between the responses that produced them", () => {
  const view = createAgentThreadView({});
  const entries = canonicalMessagesToTypedEntries(
    [
      {
        content: "First, reading.",
        role: "assistant",
        toolCalls: [{ arguments: { path: "~/a" }, id: "c1", name: "file_read" }]
      },
      { content: 'ok: {"content":"A"}', role: "tool", toolCallId: "c1" },
      {
        content: "Now writing.",
        role: "assistant",
        toolCalls: [{ arguments: {}, id: "c2", name: "file_write" }]
      },
      { content: 'ok: {"wrote":true}', role: "tool", toolCallId: "c2" },
      { content: "All done.", role: "assistant" }
    ],
    { fromIndex: 0 }
  );
  const groups = view.buildMessageDisplayGroups(
    entries.map((entry) => projectHistoryEntryForDisplay(entry)),
    {}
  );
  const layout = groups.map((group) =>
    group.type === "standard" ? `text:${group.message.content}` : `chip:${group.messageId}`
  );

  assert.deepEqual(layout, [
    "text:First, reading.",
    "chip:tool-call-c1",
    "chip:tool-result-c1",
    "text:Now writing.",
    "chip:tool-call-c2",
    "chip:tool-result-c2",
    "text:All done."
  ]);

  // The precise regression: no two chips from DIFFERENT iterations are adjacent, and
  // no text follows a chip that belongs to the previous iteration.
  const firstChipOfSecondIteration = layout.indexOf("chip:tool-call-c2");

  assert.ok(
    layout.slice(0, firstChipOfSecondIteration).includes("text:First, reading."),
    "iteration 1's narration must be drawn before iteration 2's chips"
  );
});

// --- D. PREVIEW ACCUMULATION ------------------------------------------------

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

function toolCallFrame(id, name, args) {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: { tool_calls: [{ function: { arguments: args, name }, id, index: 0 }] },
        finish_reason: "tool_calls"
      }
    ]
  })}\n\n`;
}

function stopFrame() {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;
}

// THREE iterations: narrate+call, narrate+call, plain answer. The two narrations are
// what must BOTH survive in the preview.
function twoNarratedIterationsThenAnswer() {
  return [
    [textFrame("First, "), textFrame("reading."), toolCallFrame("c1", "file_read", '{"path":"~/a"}'), "data: [DONE]\n\n"],
    [textFrame("Now "), textFrame("writing."), toolCallFrame("c2", "file_read", '{"path":"~/b"}'), "data: [DONE]\n\n"],
    [textFrame("All done."), stopFrame(), "data: [DONE]\n\n"]
  ];
}

function withFetch(t, frameSets) {
  const previous = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, init) => {
    const index = requests.length;

    requests.push({ init, url: String(url) });

    return createStreamResponse(frameSets[Math.min(index, frameSets.length - 1)]);
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
  const paintSteps = [];

  store.render = () => {};
  store.persistHistory = async () => {};
  store.displayMode = "full";
  store.scheduleStreamingMessageRender = () => {};
  // A REAL call site of the append method: it receives the accumulated preview text
  // on every delta, so this is the preview as the user's row saw it.
  store.setStreamingAssistantStatus = (content) => {
    paintSteps.push({
      content: String(content || ""),
      historyIds: (Array.isArray(store.history) ? store.history : []).map((entry) => String(entry?.id || ""))
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
    { content: "read my files", role: "user" }
  ]
});

const REQUEST_MESSAGES = Object.freeze([
  { content: "You are a test agent.", role: "system" },
  { content: "read my files", id: "u1", role: "user" }
]);

test("the streaming preview accumulates across iterations instead of resetting", async (t) => {
  const surface = stubSurface(t);

  withFetch(t, twoNarratedIterationsThenAnswer());

  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;
  runtime.api.fileRead = async () => ({ content: "hello" });

  await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  const contents = surface.paintSteps.map((step) => step.content);
  const last = contents[contents.length - 1] || "";

  // THE ASSERTION the live bug needed: iteration 1's prose is STILL THERE after
  // iteration 2 streamed, and both appear in the order the user watched them.
  assert.ok(last.includes("First, reading."), `iteration 1's narration must survive (saw ${JSON.stringify(last)})`);
  assert.ok(last.includes("Now writing."), `iteration 2's narration must also be present (saw ${JSON.stringify(last)})`);
  assert.ok(
    last.indexOf("First, reading.") < last.indexOf("Now writing."),
    "the preview reads chronologically, never reordered"
  );

  // No paint step may ever be SHORTER than the one before it within the turn: a
  // shorter step means the slot was reset mid-turn, which is the defect.
  for (let index = 1; index < contents.length; index += 1) {
    assert.ok(
      contents[index].length >= contents[index - 1].length,
      `the preview must only grow within a turn (step ${index}: ${JSON.stringify(contents[index])})`
    );
  }

  // ...and it never becomes history.
  for (const step of surface.paintSteps) {
    assert.ok(!step.historyIds.includes(PREVIEW_ID), "the preview is structurally outside history");
  }
});

test("the accumulated preview is cleared exactly once when the turn ends", async (t) => {
  stubSurface(t);
  withFetch(t, twoNarratedIterationsThenAnswer());

  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;
  runtime.api.fileRead = async () => ({ content: "hello" });

  await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.equal(store.engineSwapStreamingPreview, null, "no streamed row may outlive its turn");
});

test("a transport failure mid-turn still clears the accumulated preview", async (t) => {
  stubSurface(t);

  const previousFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;

    // The first iteration narrates and calls, so a preview exists; the second fails.
    if (calls === 1) {
      return createStreamResponse(twoNarratedIterationsThenAnswer()[0]);
    }

    return { headers: { get: () => "application/json" }, ok: false, status: 500, text: async () => "boom" };
  };

  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;
  runtime.api.fileRead = async () => ({ content: "hello" });

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.equal(turn?.result?.status, "error", "the failure surfaces as a structured error turn");
  assert.equal(store.engineSwapStreamingPreview, null, "an error must not strand a half-streamed row");
});

// --- D2. the corrective retry CONTINUES the same preview ---------------------

// The retry is a second attempt with its own request, so a per-attempt reset would make
// the first attempt's prose blink out -- the same defect as a per-iteration reset, one
// level up. The first attempt's prose is KEPT in the committed history (only the
// coaching turn is dropped), so what the user watched must stay too.
test("a corrective retry accumulates both attempts' prose and clears once", async (t) => {
  const surface = stubSurface(t);

  withFetch(t, [
    // Attempt 1: separator prose, ZERO tool calls -> the bounded corrective retry fires.
    [
      textFrame("Reading notes.txt from your root now.\n"),
      textFrame("_____javascript\nreturn await space.api.fileRead({\n  path: \"~/notes.txt\"\n});"),
      stopFrame(),
      "data: [DONE]\n\n"
    ],
    // Attempt 2: a real answer.
    [textFrame("Here is your notes content."), stopFrame(), "data: [DONE]\n\n"]
  ]);

  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;
  runtime.api.fileRead = async () => ({ content: "hello" });

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.equal(turn?.correctiveRetry, true, "the fixture must really trigger the retry");

  const contents = surface.paintSteps.map((step) => step.content);
  const last = contents[contents.length - 1] || "";

  // BOTH attempts' prose survive in the one preview, in the order they were watched.
  assert.ok(
    last.includes("Reading notes.txt from your root now."),
    `attempt 1's prose must survive the retry (saw ${JSON.stringify(last)})`
  );
  assert.ok(
    last.includes("Here is your notes content."),
    `attempt 2's prose must accumulate after it (saw ${JSON.stringify(last)})`
  );
  assert.ok(
    last.indexOf("Reading notes.txt") < last.indexOf("Here is your notes content."),
    "the preview reads chronologically across attempts"
  );

  // Only growth within the turn: a shorter step means the slot was reset mid-turn.
  for (let index = 1; index < contents.length; index += 1) {
    assert.ok(
      contents[index].length >= contents[index - 1].length,
      `the preview must only grow across attempts (step ${index}: ${JSON.stringify(contents[index])})`
    );
  }

  // ...and it is cleared exactly once, at the end of the whole turn.
  assert.equal(store.engineSwapStreamingPreview, null);
  assert.ok(
    !surface.paintSteps.some((step) => step.historyIds.includes(PREVIEW_ID)),
    "no attempt's prose may become history through the preview"
  );
});

// --- C2. the separator narration must not swallow the chip -------------------

// The audit blocker (2026-10-27). A Tier 1 narration CAN contain an executable
// separator, and the iteration that produced it also emits typed calls. The renderer's
// execute-section branch PEEK-AHEADS and consumes the next entry as its own output pane
// -- correct for the text protocol, whose execution follow-up really is that shape --
// but `projectHistoryEntryForDisplay` projects typed calls onto the SAME shape. Before
// the guard, the card absorbed the tool-call chip (entries 3 -> groups 2) and then
// reported `check_circle` / `is-success` for code that never ran.
const SEPARATOR_NARRATION =
  "Let me read that.\n_____javascript\nreturn await space.api.fileRead({\n  path: \"~/notes.txt\"\n});";

function separatorNarrationTurn() {
  return [
    {
      content: SEPARATOR_NARRATION,
      role: "assistant",
      toolCalls: [{ arguments: { path: "~/notes.txt" }, id: "c1", name: "file_read" }]
    },
    { content: 'ok: {"content":"hi"}', role: "tool", toolCallId: "c1" }
  ];
}

function executorView() {
  // The REAL product construction: the thread view only parses an execute display when
  // the execution module is wired (see `_core/onscreen_agent/view.js`).
  return createAgentThreadView({ execution: onscreenExecution });
}

test("a separator-bearing narration does not swallow the tool-call chip", () => {
  const view = executorView();
  const entries = canonicalMessagesToTypedEntries(separatorNarrationTurn(), { fromIndex: 0 });
  const groups = view.buildMessageDisplayGroups(
    entries.map((entry) => projectHistoryEntryForDisplay(entry)),
    {}
  );

  assert.equal(entries.length, 3, "narration plus call plus result");
  assert.equal(
    groups.length,
    3,
    "the chip and its result must each keep their OWN row; a consumed chip is a lost row"
  );
  assert.deepEqual(
    groups.map((group) => group.type),
    ["assistant-sequence", "standalone-output", "standalone-output"]
  );

  const section = groups[0].sections[0];

  assert.equal(section.outputResults, null, "a typed chip is never another message's output pane");

  const state = resolveExecutionCardState({
    displayOnly: section.displayOnly === true,
    hasResults: Array.isArray(section.outputResults) && section.outputResults.length > 0
  });

  assert.notEqual(state.tone, "is-success", "code that never ran must never read as a success");
  assert.notEqual(state.iconName, "check_circle");
});

test("a separator narration settles display-only while the chips keep their own rows", () => {
  const view = executorView();
  const entries = canonicalMessagesToTypedEntries(separatorNarrationTurn(), { fromIndex: 0 });
  // Derived by the STORE's own collector, so this is the set a reload would compute.
  const displayOnlyIds = store.collectEngineSwapDisplayOnlyIds(entries, null);

  assert.deepEqual([...displayOnlyIds], ["assistant-0"], "the narration is the display-only turn");

  const groups = view.buildMessageDisplayGroups(
    entries.map((entry) => projectHistoryEntryForDisplay(entry)),
    { displayOnlyMessageIds: displayOnlyIds }
  );
  const section = groups[0].sections[0];
  const state = resolveExecutionCardState({
    displayOnly: section.displayOnly === true,
    hasResults: Array.isArray(section.outputResults) && section.outputResults.length > 0
  });

  assert.equal(groups.length, 3);
  assert.equal(state.pendingState, "display-only", "the honest label survives the separation");
  assert.equal(state.iconName, "visibility");

  // ...and the derivation is still reload-safe with this shape in the trail.
  assert.deepEqual(
    [...store.collectEngineSwapDisplayOnlyIds(entries, null)].sort(),
    [...displayOnlyIds].sort()
  );
});

test("a deployed Tier 1 turn keeps the chip and never claims execution end to end", async (t) => {
  stubSurface(t);
  withFetch(t, [
    [
      textFrame("Let me read that.\n"),
      textFrame("_____javascript\nreturn await space.api.fileRead({\n  path: \"~/notes.txt\"\n});"),
      toolCallFrame("c1", "file_read", '{"path":"~/notes.txt"}'),
      "data: [DONE]\n\n"
    ],
    [textFrame("Your notes say hello."), stopFrame(), "data: [DONE]\n\n"]
  ]);

  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;
  runtime.api.fileRead = async () => ({ content: "hello" });

  await store.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  const view = executorView();
  const groups = view.buildMessageDisplayGroups(store.getRenderHistory(), {
    displayOnlyMessageIds: store.engineSwapDisplayOnlyMessageIds
  });

  // Every persisted entry draws as its own row: nothing was absorbed.
  assert.equal(groups.length, store.history.length, "one row per persisted entry");

  const narrationGroup = groups.find(
    (group) =>
      group.type === "assistant-sequence" &&
      String(group.sections?.[0]?.message?.content || "").includes("Let me read that.")
  );

  assert.ok(narrationGroup, "the narration must keep its own card");

  const section = narrationGroup.sections[0];
  const state = resolveExecutionCardState({
    displayOnly: section.displayOnly === true,
    hasResults: Array.isArray(section.outputResults) && section.outputResults.length > 0
  });

  assert.equal(section.outputResults, null, "the chip was not eaten as a result pane");
  assert.notEqual(state.tone, "is-success");
  assert.equal(state.pendingState, "display-only");

  // Reload determinism still holds with the separator narration present.
  assert.deepEqual(
    [...store.engineSwapDisplayOnlyMessageIds].sort(),
    [...store.collectEngineSwapDisplayOnlyIds(store.history, store.executionOutputOverrides)].sort()
  );
});

// --- the commit keeps the derivation reload-safe -----------------------------

// Adding narration entries must not disturb the display-only derivation: the set the
// surface ends with has to equal a FRESH derivation over the persisted history, or a
// reload would relabel chips.
test("the committed history re-derives the same display-only ids after the turn", async (t) => {
  stubSurface(t);
  withFetch(t, twoNarratedIterationsThenAnswer());

  store.settings = baseSettings();
  store.stopRequested = false;
  store.history = [...REQUEST_MESSAGES];
  store.engineSwapStreamingPreview = null;
  runtime.api.fileRead = async () => ({ content: "hello" });

  await store.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  const persisted = store.history;
  const fresh = store.collectEngineSwapDisplayOnlyIds(persisted, store.executionOutputOverrides);

  assert.deepEqual(
    [...store.engineSwapDisplayOnlyMessageIds].sort(),
    [...fresh].sort(),
    "commit and reload must agree on what was shown but never executed"
  );

  // The narration really is in the persisted transcript, ahead of its call.
  const narrationIndex = persisted.findIndex(
    (entry) => entry?.role === "assistant" && entry.content === "First, reading."
  );
  const firstCallIndex = persisted.findIndex((entry) => entry?.kind === "tool_call");

  assert.ok(narrationIndex !== -1, "the narration must be committed, not discarded");
  assert.ok(firstCallIndex !== -1, "the call must be committed");
  assert.ok(narrationIndex < firstCallIndex, "the narration precedes the call it introduced");
});
