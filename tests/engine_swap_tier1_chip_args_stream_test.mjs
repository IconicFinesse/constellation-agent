// MID-TURN CHIP ARGUMENTS — the streaming first-delta defect (owner-reported live on
// v1.2.1+70).
//
// THE DEFECT: mid-turn a provisional tool chip read `ARGUMENTS: {}` while its OUTPUT
// pane streamed in correctly. The arguments only appeared at commit, when the committed
// row replaced the chip.
//
// THE CAUSE, measured on the REAL assembler: providers announce a tool call's id and
// name on the FIRST delta carrying an EMPTY arguments string.
// `isCompleteToolArguments("")` is TRUE — an empty body is a legal no-argument call —
// so `api.js` fired `onToolCallComplete` immediately with `arguments: ""`, the store
// recorded that empty first sighting, and every later notification for the same call id
// returned early. The real JSON arriving on a later payload was discarded forever.
// OUTPUT was unaffected because it arrives through `settleEngineSwapProvisionalCall`,
// which merges into the existing record instead of deduping it.
//
//   payload 0: complete=true   args=""                  <-- id+name only
//   payload 1: complete=false  args='{"code":'
//   payload 2: complete=true   args='{"code":"return 1"}'
//
// WHY 368 GREEN TESTS MISSED IT: every existing fixture handed the formatter a record
// that ALREADY had real arguments, and the parity suite compared two complete values.
// No fixture ever drove the real assembler through a fragmented delta stream, so the
// empty-first-delta path was never exercised. The suite proved the formatter works; it
// never proved the plumbing delivers.
//
// So every case here goes through the production path end to end:
//
//   streamOnscreenAgentToolTurn -> fetch -> readStreamingResponse -> parseEventBlock
//     -> assembler.finish() -> onToolCallComplete -> recordEngineSwapProvisionalCall
//
// and the `onToolCallComplete` wiring is the store's own line, verbatim.
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
const { streamOnscreenAgentToolTurn } = await import("/modules/_core/onscreen_agent/api.js");
const { createProvisionalChipEntry } = await import("/modules/_core/onscreen_agent/chat-projection.js");
const { createStreamingToolCallAssembler, isCompleteToolArguments } = await import(
  "/modules/_core/framework/js/engine-swap/stream-assembly.js"
);

// ---------------------------------------------------------------- transport ----

function sse(delta, finishReason = null) {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
}

function textFrame(text) {
  return sse({ content: text });
}

// One OpenAI-shape tool-call delta. Deliberately allows EVERY part to be absent,
// because a fragmented stream omits whatever it is not saying in that payload.
function toolDelta({ args, id, index = 0, name } = {}) {
  const call = { function: {}, index };

  if (id) {
    call.id = id;
  }

  if (name !== undefined) {
    call.function.name = name;
  }

  if (args !== undefined) {
    call.function.arguments = args;
  }

  return sse({ tool_calls: [call] });
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

// Every frame is split again at an awkward offset, so a hook wired only on whole
// frames would still fail here.
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

function baseSettings() {
  return {
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: "test-key-not-real",
    model: "test-model",
    provider: "openai"
  };
}

function requestBody() {
  return {
    messages: [{ content: "run it", role: "user" }],
    model: "test-model",
    stream: true,
    tools: [{ function: { name: "run_code" }, type: "function" }]
  };
}

// A record snapshot taken at PAINT time: `render` is where a chip becomes visible, so a
// snapshot from there is the user-visible truth rather than an internal intermediate.
function snapshotRecords() {
  return (Array.isArray(store.engineSwapProvisionalCalls) ? store.engineSwapProvisionalCalls : []).map(
    (entry) => ({
      arguments: entry?.arguments,
      atChars: entry?.atChars,
      callId: String(entry?.callId || ""),
      name: String(entry?.name || ""),
      outcome: String(entry?.outcome || "")
    })
  );
}

// Drives the REAL transport with the store's OWN `onToolCallComplete` wiring.
async function probe(t, frames) {
  const paints = [];
  const executed = [];
  const previous = {
    displayMode: store.displayMode,
    engineSwapPreviewSealed: store.engineSwapPreviewSealed,
    engineSwapProvisionalCalls: store.engineSwapProvisionalCalls,
    engineSwapStreamingPreview: store.engineSwapStreamingPreview,
    fetch: globalThis.fetch,
    render: store.render,
    scheduleEngineSwapChipRender: store.scheduleEngineSwapChipRender,
    scheduleStreamingMessageRender: store.scheduleStreamingMessageRender
  };

  store.displayMode = "full";
  store.engineSwapPreviewSealed = false;
  store.engineSwapProvisionalCalls = [];
  store.engineSwapStreamingPreview = { content: "" };
  store.scheduleStreamingMessageRender = () => {};
  // SYNCHRONOUS chip repaint, so every notification's effect is OBSERVABLE. This
  // collapses only the frame DELAY; the state painted is the product's own.
  store.scheduleEngineSwapChipRender = function scheduleEngineSwapChipRender() {
    this.render({ preserveScroll: true });
  };
  store.render = () => {
    paints.push(snapshotRecords());
  };

  globalThis.fetch = async () => createStreamResponse(frames);

  runtime.api.run_code = async (...args) => {
    executed.push(args);

    return { content: "executed" };
  };

  t.after(() => {
    store.displayMode = previous.displayMode;
    store.engineSwapPreviewSealed = previous.engineSwapPreviewSealed;
    store.engineSwapProvisionalCalls = previous.engineSwapProvisionalCalls;
    store.engineSwapStreamingPreview = previous.engineSwapStreamingPreview;
    store.render = previous.render;
    store.scheduleEngineSwapChipRender = previous.scheduleEngineSwapChipRender;
    store.scheduleStreamingMessageRender = previous.scheduleStreamingMessageRender;
    globalThis.fetch = previous.fetch;
  });

  const assembled = await streamOnscreenAgentToolTurn({
    // Text deltas paint the prose the chip interleaves with. Appending here is what the
    // store's own `appendPreviewDelta` does to the same field, which is what makes the
    // frozen-`atChars` assertion meaningful.
    onDelta: (delta) => {
      store.engineSwapStreamingPreview.content += delta;
    },
    // THE PRODUCTION WIRING, verbatim from the Tier-1 `sendCompletion` closure.
    onToolCallComplete: (call) => store.recordEngineSwapProvisionalCall(call),
    requestBody: requestBody(),
    settings: baseSettings()
  });

  return { assembled, executed, paints, records: store.engineSwapProvisionalCalls };
}

// ------------------------------------------------- the measured assembler ----

// The premise, pinned: the trap is that an EMPTY argument body is legally complete. If
// this ever stops being true the detector below changes shape, and the lane must know.
test("an empty argument body is COMPLETE, which is why the surface hears about the call first", () => {
  assert.equal(isCompleteToolArguments(""), true, "an empty body is a legal no-argument call");
  assert.equal(isCompleteToolArguments('{"code":'), false, "a partial body is never complete");
  assert.equal(isCompleteToolArguments('{"code":"return 1"}'), true);

  const assembler = createStreamingToolCallAssembler();
  const verdicts = [];

  [
    toolDelta({ args: "", id: "call_x", name: "run_code" }),
    toolDelta({ args: '{"code":' }),
    toolDelta({ args: '"return 1"}' })
  ].forEach((frame) => {
    assembler.applyPayload(JSON.parse(frame.slice("data: ".length)));
    verdicts.push(
      (assembler.finish().toolCalls || []).map((call) => ({
        arguments: call.arguments,
        complete: call.argumentsComplete
      }))
    );
  });

  assert.deepEqual(
    verdicts,
    [
      [{ arguments: "", complete: true }],
      [{ arguments: '{"code":', complete: false }],
      [{ arguments: '{"code":"return 1"}', complete: true }]
    ],
    "the measured sequence: complete/empty, partial, complete"
  );
});

// ===========================================================================
// THE DELIVERABLE — the real arguments reach the chip, and the chip does not move
// ===========================================================================

test("PARITY: a chip announced with empty arguments ends the stream carrying the real JSON", async (t) => {
  const argsJson = '{"code":"return 1"}';
  const frames = [
    textFrame("Reading it."),
    // payload 0: id + name only, EMPTY arguments -> complete, so the chip paints now.
    toolDelta({ args: "", id: "call_x", name: "run_code" }),
    // More prose arrives after the chip appeared. It must not move the chip.
    textFrame(" Now running."),
    // payload 1: a partial body -> NOT complete.
    toolDelta({ args: '{"code":' }),
    // payload 2: the real body -> complete, and this is the payload the old code threw away.
    toolDelta({ args: '"return 1"}' }),
    sse({}, "tool_calls"),
    "data: [DONE]\n\n"
  ];
  const { assembled, executed, paints, records } = await probe(t, frames);

  assert.equal(assembled.toolCalls.length, 1, "one call assembled");
  assert.equal(assembled.toolCalls[0].arguments, argsJson);
  assert.equal(assembled.toolCalls[0].argumentsComplete, true);

  // --- exactly ONE chip for the call (dedupe by id survives the update path).
  assert.equal(records.length, 1, `exactly one chip per call (records: ${JSON.stringify(records)})`);

  const record = records[0];

  assert.equal(record.callId, "call_x");
  assert.equal(record.name, "run_code", "the name is the provider's, never a concatenation");

  // --- THE ASSERTION THIS LANE EXISTS FOR.
  assert.equal(
    record.arguments,
    argsJson,
    `the chip must carry the arguments that arrived later, not the empty first sighting (records: ${JSON.stringify(records)})`
  );

  // --- the chip never moved: `atChars` is frozen from the FIRST sighting, when the
  // preview was exactly "Reading it." long.
  assert.equal(record.atChars, "Reading it.".length, "atChars stays at the first sighting");

  // --- the empty first sighting still painted immediately and honestly.
  assert.ok(paints.length >= 1, "the chip must paint the instant the call is announced");
  assert.deepEqual(
    paints[0].map((chip) => chip.arguments),
    [""],
    "the first paint is the honest empty sighting, one chip"
  );
  assert.equal(paints[0].length, 1, "never two chips for one call id");

  // --- displayed, never executed (BUG-007 hard line), and the empty sighting dispatched
  // nothing on its own. A fresh record carries no outcome at all — absence IS the honest
  // unsettled state, so nothing may invent one.
  assert.deepEqual(executed, [], "a streamed fragment never dispatches anything");
  assert.equal(record.outcome, undefined, "no outcome: nothing dispatched in this probe");
});

// ===========================================================================
// Arguments delivered in MANY small fragments
// ===========================================================================

test("arguments arriving in many small fragments are all captured", async (t) => {
  const argsJson = '{"code":"const a = 1; return a;"}';
  const pieces = [];

  for (let index = 0; index < argsJson.length; index += 3) {
    pieces.push(argsJson.slice(index, index + 3));
  }

  assert.ok(pieces.length > 6, "the fixture must really be fragmented");

  const frames = [
    textFrame("Working."),
    toolDelta({ args: "", id: "call_many", name: "run_code" }),
    ...pieces.map((args) => toolDelta({ args })),
    sse({}, "tool_calls"),
    "data: [DONE]\n\n"
  ];
  const { records } = await probe(t, frames);

  assert.equal(records.length, 1, "one chip for one call id");
  assert.equal(records[0].arguments, argsJson, "every fragment contributed to the stored body");
  assert.equal(records[0].name, "run_code");
});

// ===========================================================================
// A provider that repeats the name on every delta
// ===========================================================================

test("a provider repeating the name on every delta keeps one name, never a concatenation", async (t) => {
  const argsJson = '{"code":"return 1"}';
  const frames = [
    textFrame("Working."),
    toolDelta({ args: "", id: "call_n", name: "run_code" }),
    toolDelta({ args: '{"code":', name: "run_code" }),
    toolDelta({ args: '"return 1"}', name: "run_code" }),
    toolDelta({ args: "", name: "run_code" }),
    sse({}, "tool_calls"),
    "data: [DONE]\n\n"
  ];
  const { assembled, records } = await probe(t, frames);

  assert.equal(records.length, 1, "one chip");
  assert.equal(records[0].name, "run_code", `name must not accumulate (got "${records[0].name}")`);
  assert.equal(records[0].arguments, argsJson, "the repeated name never disturbs the arguments");
  assert.equal(assembled.toolCalls[0].name, "run_code", "the assembler itself takes the last name");
});

// ===========================================================================
// The store's OWN overwrite guard — pinned at the seam where it lives
// ===========================================================================

// WHY THIS IS NOT TRANSPORT-DRIVEN: the assembler ACCUMULATES argument text
// (`record.argumentsText += fragment`), so once real JSON has landed, every later
// `finish()` reports that same full text. An empty-after-non-empty sequence therefore
// cannot be produced through the stream, which means the guard that protects it is a
// property of the STORE's own contract and has to be pinned there. It is not decoration:
// the store is a public surface method, the settle path calls into the same records, and a
// provider repeating a call is exactly the shape that arrives here twice.
test("a later empty arguments value never clobbers the real JSON already stored", (t) => {
  const previous = {
    engineSwapPreviewSealed: store.engineSwapPreviewSealed,
    engineSwapProvisionalCalls: store.engineSwapProvisionalCalls,
    engineSwapStreamingPreview: store.engineSwapStreamingPreview,
    render: store.render,
    scheduleEngineSwapChipRender: store.scheduleEngineSwapChipRender
  };
  const paints = [];

  store.engineSwapPreviewSealed = false;
  store.engineSwapProvisionalCalls = [];
  store.engineSwapStreamingPreview = { content: "abcdef" };
  store.scheduleEngineSwapChipRender = function scheduleEngineSwapChipRender() {
    this.render({ preserveScroll: true });
  };
  store.render = () => paints.push(snapshotRecords());

  t.after(() => {
    store.engineSwapPreviewSealed = previous.engineSwapPreviewSealed;
    store.engineSwapProvisionalCalls = previous.engineSwapProvisionalCalls;
    store.engineSwapStreamingPreview = previous.engineSwapStreamingPreview;
    store.render = previous.render;
    store.scheduleEngineSwapChipRender = previous.scheduleEngineSwapChipRender;
  });

  // First sighting: empty, painted immediately at the current interleave offset.
  assert.equal(store.recordEngineSwapProvisionalCall({ arguments: "", id: "call_e", name: "run_code" }), true);
  assert.equal(store.engineSwapProvisionalCalls[0].atChars, "abcdef".length);

  // The real payload lands.
  const argsJson = '{"code":"return 1"}';

  assert.equal(store.recordEngineSwapProvisionalCall({ arguments: argsJson, id: "call_e", name: "run_code" }), true);
  assert.equal(store.engineSwapProvisionalCalls[0].arguments, argsJson, "the real payload is stored");

  // Prose keeps growing, then a repeat of the call arrives with an empty body. It must be
  // refused: the payload the user is reading cannot be erased by a later blank.
  store.engineSwapStreamingPreview.content += " more prose";

  assert.equal(
    store.recordEngineSwapProvisionalCall({ arguments: "", id: "call_e", name: "run_code" }),
    false,
    "an empty body changes nothing, so nothing is scheduled"
  );
  assert.equal(
    store.engineSwapProvisionalCalls[0].arguments,
    argsJson,
    "the stored JSON survives a later empty value"
  );
  assert.equal(
    store.engineSwapProvisionalCalls[0].atChars,
    "abcdef".length,
    "and the frozen offset is untouched too"
  );
  assert.equal(store.engineSwapProvisionalCalls.length, 1, "still exactly one chip");
  assert.equal(paints.length, 2, "one paint per real change, never one per repeat");
});

test("a call with no arguments keeps an honest empty chip and invents nothing", async (t) => {
  const frames = [
    textFrame("Listing."),
    // A no-argument call really is id+name with an empty body, and nothing follows.
    toolDelta({ args: "", id: "call_empty", name: "run_code" }),
    sse({}, "tool_calls"),
    "data: [DONE]\n\n"
  ];
  const { assembled, paints, records } = await probe(t, frames);

  assert.equal(assembled.toolCalls[0].argumentsComplete, true, "a no-argument call is dispatchable");
  assert.equal(records.length, 1);
  assert.equal(records[0].arguments, "", "the honest empty body is preserved, not invented over");
  assert.equal(records[0].name, "run_code", "the real name is kept");
  assert.equal(paints.length, 1, "exactly one paint: nothing new arrived to repaint");

  // The chip renders through the ONE shared formatter, so its arguments pane is whatever
  // an empty body projects to — never a fabricated payload, never the outcome word.
  const chip = createProvisionalChipEntry(records[0]);

  assert.ok(
    !chip.typedToolArgumentsText.includes("run_code") && !chip.typedToolArgumentsText.includes("running"),
    `an empty body must not invent a payload (got "${chip.typedToolArgumentsText}")`
  );
  assert.equal(chip.typedToolOutcome, "running", "undispatched reads running");
});
