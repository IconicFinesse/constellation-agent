// PROVISIONAL CHIP PANES (P3 surface stability, owner-reported 2026-10-27).
//
// THE DEFECT: mid-turn a provisional chip read `ARGUMENTS: success` and
// `OUTPUT: No output yet.`, both of which corrected themselves only at commit when the
// committed row replaced the chip. Two symptoms, one cause — the provisional record
// carried NO PAYLOAD:
//   - `api.js` passed only `{ id, name }` to `onToolCallComplete` although the assembler
//     in that same block had the call's `arguments`;
//   - `settleEngineSwapProvisionalCall` ignored the dispatch outcome's content;
//   - `chat-projection.js` wrote the OUTCOME WORD into the body line, and the thread view
//     reads everything after the first newline as the arguments pane;
//   - the descriptor hardcoded `outputText: ""`.
//
// THE CONTRACT THIS SUITE PINS: **full parity**. The owner explicitly rejected a
// truncated preview because it would mean two vocabularies, so the mid-turn panes must be
// the SAME BYTES the committed row will show.
//
// HOW PARITY IS GUARANTEED (the thing that makes this lane worth anything): there is no
// second result formatter. Both sides run the SAME product functions:
//   arguments -> `projectToolCallForChip` -> `createCanonicalToolCall` ->
//                `createToolCallEntry` -> `projectHistoryEntryForDisplay`
//   output    -> `projectToolResultText` (the loop's own committed tool-message string)
//                -> `canonicalMessagesToTypedEntries` -> `projectHistoryEntryForDisplay`
// A committed row reaches the identical text by the identical path, because a committed
// row IS the projection of the entries `canonicalMessagesToTypedEntries` produced. If the
// committed rendering ever changes, the chip changes with it — one formatter, two callers.
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
const {
  canonicalMessagesToTypedEntries,
  projectHistoryEntryForDisplay,
  projectToolCallForChip,
  projectToolResultText,
  readProjectedChipBody
} = await import("/modules/_core/framework/js/engine-swap/history-shapes.js");
// The SAME canonical writers `tool-turn-loop.js` announces and answers calls with, so a
// "committed row" fixture here is the shape the product really draws.
const { createAssistantToolCallMessage, createToolResultMessage } = await import(
  "/modules/_core/framework/js/engine-swap/canonical.js"
);

const view = createAgentThreadView({});

// ---------------------------------------------------------------- helpers ----

// PRODUCTION GROUPS WITH `groupToolRuns: true`.
//
// The store renders with `groupToolRuns: true` (`store.js:4203`), and that flag is what
// folds a single call's `tool_call` + `tool_result` entries into ONE chip carrying both
// panes. A harness that omits it reads the bare call entry — which legitimately has no
// output — and would compare the chip against a row the product never draws.
const RENDER_OPTIONS = Object.freeze({ groupToolRuns: true });

// The descriptor the renderer ACTUALLY uses, reached through the real grouping path.
function descriptorOf(entry) {
  const groups = view.buildMessageDisplayGroups([entry], RENDER_OPTIONS);
  const group = groups.find((candidate) => candidate.type === "standalone-output" && candidate.typedTool);

  return group ? group.typedTool : null;
}

function committedDescriptors(entries) {
  const projected = entries.map((entry) => projectHistoryEntryForDisplay(entry));
  const groups = view.buildMessageDisplayGroups(projected, RENDER_OPTIONS);

  return groups
    .filter((group) => group.type === "standalone-output" && group.typedTool)
    .map((group) => group.typedTool);
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

// Records every provisional-chip RECORD the surface paints. `render` is where a chip
// becomes visible, so a snapshot taken there is the user-visible truth rather than an
// internal intermediate. The full record is kept (not just the outcome) because the panes
// are what this suite is about.
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
  // SYNCHRONOUS chip repaint, so a settle inside the turn is OBSERVABLE. This collapses
  // only the frame DELAY; the state painted is the product's own.
  store.scheduleEngineSwapChipRender = function scheduleEngineSwapChipRender() {
    this.render({ preserveScroll: true });
  };

  store.render = () => {
    paints.push(
      (Array.isArray(store.engineSwapProvisionalCalls) ? store.engineSwapProvisionalCalls : []).map((entry) => ({
        arguments: entry?.arguments,
        atChars: entry?.atChars,
        callId: String(entry?.callId || ""),
        name: String(entry?.name || ""),
        outcome: String(entry?.outcome || ""),
        resultContent: entry?.resultContent,
        resultIsError: entry?.resultIsError
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

// The COMMITTED side, derived exactly as `runTier1TurnAndCommit` derives it.
function committedEntriesFor(turn) {
  const baseline = Number.isFinite(Number(turn?.wireMessageCount))
    ? Number(turn.wireMessageCount)
    : PREPARED.messages.length;

  return canonicalMessagesToTypedEntries(turn.result.messages, { fromIndex: baseline });
}

// The LAST painted state of one call's provisional record — that is the chip the user was
// looking at when the turn ended.
function lastPaintedRecord(paints, callId) {
  const all = paints.flat().filter((chip) => chip.callId === callId);

  return all.length ? all[all.length - 1] : null;
}

// ===========================================================================
// THE DELIVERABLE — BYTE EQUALITY between the mid-turn chip and the committed row
// ===========================================================================

test("PARITY: mid-turn arguments and output are byte-identical to the committed row", async (t) => {
  const surface = stubSurface(t);
  let call = 0;
  const resultPayload = { content: "hello from notes", path: "~/notes.txt" };
  const argsJson = '{"path":"~/notes.txt"}';

  withFetch(t, () => {
    call += 1;

    return call === 1
      ? createStreamResponse([
          textFrame("Reading it."),
          toolCallFrame("call_a", "file_read", argsJson),
          "data: [DONE]\n\n"
        ])
      : createStreamResponse(answerFrames("Your notes say hello."));
  });

  resetTurnState();
  runtime.api.fileRead = async () => resultPayload;

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.ok(turn, "the turn must return");

  // --- MID-TURN SIDE: the chip the user watched settle, with its real panes.
  const record = lastPaintedRecord(surface.paints, "call_a");

  assert.ok(record, `a provisional chip must have been painted (paints: ${JSON.stringify(surface.paints)})`);
  assert.equal(record.outcome, "success", "the chip settled on dispatch, mid-turn");
  assert.equal(record.arguments, argsJson, "the record carries the call's real arguments");
  assert.ok(
    typeof record.resultContent === "string" && record.resultContent.length > 0,
    "the record carries the committed result text"
  );

  const chipEntry = createProvisionalChipEntry(record);
  const chip = descriptorOf(chipEntry);

  assert.ok(chip, "the provisional chip renders through the real grouping path");

  // --- COMMITTED SIDE: exactly what the commit derives from the turn.
  const committed = committedDescriptors(committedEntriesFor(turn));
  const committedCall = committed.find((descriptor) => descriptor.name === "file_read");

  assert.ok(committedCall, "the committed turn renders a call row");

  // --- THE ASSERTION THIS LANE EXISTS FOR.
  assert.equal(
    chip.argumentsText,
    committedCall.argumentsText,
    "mid-turn ARGUMENTS must be the committed row's arguments, byte for byte"
  );
  assert.equal(
    chip.outputText,
    committedCall.outputText,
    "mid-turn OUTPUT must be the committed row's output, byte for byte"
  );

  // And the arguments are the CALL'S CODE, never the outcome word.
  assert.equal(chip.argumentsText, argsJson);
  assert.ok(
    !chip.argumentsText.includes("success"),
    "the outcome word must never be the arguments payload"
  );
});

// ===========================================================================
// The two owner-visible symptoms, asserted directly
// ===========================================================================

test("the arguments pane shows the call's real JSON, never the outcome word", () => {
  const rawArguments = JSON.stringify({ code: "await space.api.fileList('~/');" });
  const descriptor = descriptorOf(
    createProvisionalChipEntry({ arguments: rawArguments, callId: "c1", name: "run_code" })
  );

  assert.equal(descriptor.argumentsText, rawArguments);
  assert.notEqual(descriptor.argumentsText, "running");
  assert.notEqual(descriptor.argumentsText, "success");
  assert.ok(!descriptor.argumentsText.includes("success"));
});

test("output appears mid-turn once the call is dispatched, from the committed text", () => {
  const rawArguments = '{"path":"~/a.md"}';
  const pending = createProvisionalChipEntry({ arguments: rawArguments, callId: "c1", name: "file_read" });

  // Before dispatch there IS no output, and the chip says so honestly.
  assert.equal(descriptorOf(pending).outputText, "", "no fabricated output before dispatch");

  const settled = createProvisionalChipEntry({
    arguments: rawArguments,
    callId: "c1",
    name: "file_read",
    outcome: "success",
    resultContent: 'ok: {"content":"hi"}',
    resultIsError: false
  });
  const descriptor = descriptorOf(settled);

  assert.equal(descriptor.outcome, "success");
  assert.notEqual(descriptor.outputText, "", "a dispatched call shows its output mid-turn");
  assert.equal(descriptor.outputText, '{"content":"hi"}');
});

// ===========================================================================
// Error path — a settled Error chip shows the error text, not an empty pane
// ===========================================================================

test("a settled ERROR chip shows the error text, not an empty pane", () => {
  const rawArguments = '{"path":"~/missing.md"}';
  const errorContent = "error (execution): ENOENT: no such file\nRead the error and retry.";
  const chipEntry = createProvisionalChipEntry({
    arguments: rawArguments,
    callId: "c1",
    name: "file_read",
    outcome: "error",
    resultContent: errorContent,
    resultIsError: true
  });
  const chip = descriptorOf(chipEntry);

  assert.equal(chip.outcome, "error");
  assert.ok(chip.outputText.length > 0, "an errored chip must not show an empty pane");
  assert.ok(
    chip.outputText.includes("ENOENT"),
    `the error text must reach the pane (saw: ${JSON.stringify(chip.outputText)})`
  );

  // PARITY on the error path too: the committed error row renders the same bytes.
  const committed = committedDescriptors(
    canonicalMessagesToTypedEntries(
      [
        {
          content: "",
          role: "assistant",
          toolCalls: [{ arguments: rawArguments, id: "c1", name: "file_read" }]
        },
        { content: errorContent, isError: true, role: "tool", toolCallId: "c1" }
      ],
      { fromIndex: 0 }
    )
  );
  const committedCall = committed.find((descriptor) => descriptor.name === "file_read");

  assert.ok(committedCall, "the committed error turn renders a call row");
  assert.equal(
    chip.outputText,
    committedCall.outputText,
    "the error pane must be byte-identical mid-turn and committed"
  );
});

// ===========================================================================
// HONESTY — args complete but not dispatched still reads `Running`
// ===========================================================================

test("args-complete-but-undispatched reads Running with real arguments and empty output", () => {
  const rawArguments = JSON.stringify({ path: "~/a.md" });
  const entry = createProvisionalChipEntry({ arguments: rawArguments, callId: "c1", name: "file_read" });
  const descriptor = descriptorOf(entry);

  assert.equal(descriptor.outcome, "running", "nothing has answered this call yet");
  assert.equal(descriptor.argumentsText, rawArguments, "the real arguments are shown");
  assert.equal(descriptor.outputText, "", "no output is invented");

  // The chip's own vocabulary still reads Running.
  assert.equal(view.formatTypedToolLabel("file_read", descriptor.outcome), "file_read · Running");
});

// ===========================================================================
// SIGNATURE — a chip is never REUSED with stale arguments
// ===========================================================================

test("the render signature covers the arguments, so a chip is not reused with stale ones", () => {
  const options = { toolRunOpenState: null };
  const groupFor = (rawArguments) =>
    view.buildMessageDisplayGroups(
      [createProvisionalChipEntry({ arguments: rawArguments, callId: "c1", name: "run_code" })],
      {}
    )[0];

  const before = view.getGroupRenderSignature(groupFor('{"code":"a"}'), options);
  const after = view.getGroupRenderSignature(groupFor('{"code":"b"}'), options);

  assert.notEqual(
    before,
    after,
    "changing the arguments must change the signature, or the row is reused with stale ones"
  );

  // The output term is load-bearing for the same reason.
  const noOutput = view.getGroupRenderSignature(
    view.buildMessageDisplayGroups(
      [createProvisionalChipEntry({ arguments: '{"code":"a"}', callId: "c1", name: "run_code" })],
      {}
    )[0],
    options
  );
  const withOutput = view.getGroupRenderSignature(
    view.buildMessageDisplayGroups(
      [
        createProvisionalChipEntry({
          arguments: '{"code":"a"}',
          callId: "c1",
          name: "run_code",
          outcome: "success",
          resultContent: 'ok: {"done":true}'
        })
      ],
      {}
    )[0],
    options
  );

  assert.notEqual(noOutput, withOutput, "once the result lands the row must be rebuilt");
});

// ===========================================================================
// ONE FORMATTER — the chip and the committed row share the same product path
// ===========================================================================

test("the chip's panes come from the shared formatters the committed row uses", () => {
  const rawArguments = JSON.stringify({ path: "~/a.md" });
  const sharedCall = projectToolCallForChip({ arguments: rawArguments, name: "file_read" });
  const chipEntry = createProvisionalChipEntry({ arguments: rawArguments, callId: "c1", name: "file_read" });

  // The chip's body IS the shared formatter's output — not a local template.
  assert.equal(chipEntry.content, sharedCall.content);
  assert.equal(chipEntry.typedToolArgumentsText, sharedCall.argumentsText);

  // And the body reader is the one the committed row is read with.
  assert.equal(readProjectedChipBody(chipEntry), sharedCall.argumentsText);

  // The result side: the chip's output text is the shared result formatter's output for
  // the committed string.
  const committedResultText = 'ok: {"content":"hi"}';
  const settled = createProvisionalChipEntry({
    arguments: rawArguments,
    callId: "c1",
    name: "file_read",
    outcome: "success",
    resultContent: committedResultText
  });

  assert.equal(settled.typedToolOutputText, projectToolResultText({ content: committedResultText }));
});

// A LOOKALIKE FORMATTER MUST BE CAUGHT, and compact-JSON fixtures cannot catch one.
//
// If a second formatter is introduced that renders the RAW argument string, it agrees
// with the canonical writer on already-compact JSON — so a suite built only from compact
// fixtures certifies nothing (a seeded lookalike passed 9/9 before this case existed).
// The committed row does not pass the raw string through: it parses and re-serializes, so
// whitespace disappears and a non-object payload collapses to `{}`. These cases pin that
// normalization by comparing the chip against the committed projection on inputs where the
// two behaviours differ.
test("the chip normalizes arguments exactly as the committed row does, not like a raw copy", () => {
  const divergentArguments = [
    // Whitespace a raw-string formatter would preserve; the canonical writer compacts it.
    '{ "path" : "~/a.md" , "encoding" : "utf8" }',
    // A non-object payload: canonical argument lists are objects, so this collapses to {}.
    '["a","b"]',
    '"just a string"'
  ];

  divergentArguments.forEach((rawArguments) => {
    const chipArgumentsText = descriptorOf(
      createProvisionalChipEntry({ arguments: rawArguments, callId: "c1", name: "file_read" })
    ).argumentsText;
    // The committed side is built through the SAME canonical writer the loop uses.
    // Handing a raw argument string straight to `canonicalMessagesToTypedEntries` skips
    // `createCanonicalToolCall` and spreads the string into a character map — a shape the
    // product never draws, because `tool-turn-loop.js` always announces calls through
    // `createAssistantToolCallMessage` first.
    const committedArgumentsText = committedDescriptors(
      canonicalMessagesToTypedEntries(
        [
          createAssistantToolCallMessage({
            content: "",
            toolCalls: [{ arguments: rawArguments, id: "c1", name: "file_read" }]
          }),
          createToolResultMessage({ content: "ok: 1", toolCallId: "c1" })
        ],
        { fromIndex: 0 }
      )
    ).find((descriptor) => descriptor.name === "file_read")?.argumentsText;

    assert.equal(
      chipArgumentsText,
      committedArgumentsText,
      `the chip must normalize ${JSON.stringify(rawArguments)} exactly as the committed row does`
    );
    // A raw copy is the failure mode this case exists to catch.
    assert.notEqual(
      chipArgumentsText,
      rawArguments.trim(),
      `a raw-string formatter must not pass for ${JSON.stringify(rawArguments)}`
    );
  });
});

// ===========================================================================
// DISPLAY-ONLY HARD LINE (BUG-007) — the chip never dispatches anything
// ===========================================================================

test("a fenced display reply still dispatches ZERO calls and invents no chip", async (t) => {
  const surface = stubSurface(t);
  const executed = [];

  withFetch(t, () =>
    createStreamResponse([
      textFrame("Here is how you would read it.\n_____javascript\nawait space.api.fileRead('~/x')"),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n"
    ])
  );

  resetTurnState();
  runtime.api.fileRead = async (...args) => {
    executed.push(args);

    return { content: "x" };
  };

  const turn = await store.runTier1ConversationTurn(REQUEST_MESSAGES, PREPARED, { tier: "tier1" });

  assert.ok(turn, "the turn must return");
  assert.equal(executed.length, 0, "a separator reply must never execute anything");
  assert.equal(
    surface.paints.flat().length,
    0,
    "nothing dispatched, so no chip may claim a payload"
  );
  assert.deepEqual(store.engineSwapProvisionalCalls, [], "nothing strands after the turn");
});

// ===========================================================================
// GROUPING BYTE-IDENTITY — a provisional chip is never folded into a tool run
// ===========================================================================

test("grouping is unchanged: a provisional chip stays out of every tool run", () => {
  const committed = canonicalMessagesToTypedEntries(
    [
      {
        content: "",
        role: "assistant",
        toolCalls: [
          { arguments: '{"path":"a"}', id: "c1", name: "file_read" },
          { arguments: '{"path":"b"}', id: "c2", name: "file_read" }
        ]
      },
      { content: 'ok: "A"', role: "tool", toolCallId: "c1" },
      { content: 'ok: "B"', role: "tool", toolCallId: "c2" }
    ],
    { fromIndex: 0 }
  )
    .map((entry) => projectHistoryEntryForDisplay(entry));
  const chip = createProvisionalChipEntry({
    arguments: '{"path":"c"}',
    callId: "c3",
    name: "file_read",
    outcome: "success",
    resultContent: 'ok: "C"'
  });

  const projection = buildChatRenderProjection({
    history: committed,
    preview: null,
    provisionalCalls: []
  });
  const groups = view.buildMessageDisplayGroups([...projection, chip], RENDER_OPTIONS);
  const runs = groups.filter((group) => group.type === "tool-run");

  assert.equal(runs.length, 1, "the two committed calls still form ONE run");
  assert.equal(
    runs[0].summary.calls.length,
    2,
    "the chip is NOT a third call in the run"
  );
  assert.ok(
    groups.some((group) => group.type === "standalone-output" && group.provisional === true),
    "the chip draws on its own, as before"
  );
});
