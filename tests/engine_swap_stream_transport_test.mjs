// Focused engine-swap coverage for the STREAMED TOOL-TURN TRANSPORT (P3 audit B1).
//
// Why this suite exists: the assembler suite drives `applyPayload` directly, which
// cannot prove the surface's SSE reader ever calls it. The P3 audit blocker was
// exactly that gap — `readStreamingResponse` declared the raw-payload hook and its
// two `parseEventBlock` callsites dropped it, so on a real streaming provider the
// assembler saw zero fragments and the turn ended as a blank answer. Hermetic
// assembler greenness hid it.
//
// So every case here goes through the REAL path the live surface uses:
//
//   streamOnscreenAgentToolTurn -> fetch -> readStreamingResponse -> parseEventBlock
//     -> onPayload -> assembler.applyPayload -> finish
//
// The fake response supplies a real `body.getReader()`, and the frames are split at
// awkward byte offsets so the reader's own buffering is exercised too. Dropping the
// forwarded hook (or the buffered-path hook) turns these cases red.
//
// Hermetic: `fetch` is a local stub, the module loader is the SHARED one already used
// by other surface suites, and nothing touches the network, a key, or app data.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The SHARED resolve hook — not a second copy of the loader.
register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

globalThis.window = globalThis;
globalThis.location = new URL("http://127.0.0.1:3000/");
globalThis.space = {
  ...(globalThis.space && typeof globalThis.space === "object" ? globalThis.space : {}),
  extend: (_moduleRef, extensionTarget) => extensionTarget
};

const { streamOnscreenAgentToolTurn } = await import(
  "../app/L0/_all/modules/_core/onscreen_agent/api.js"
);
const { extractToolCallsFromCompletion } = await import(
  "../app/L0/_all/modules/_core/framework/js/engine-swap/tier1-session.js"
);

const SETTINGS = Object.freeze({
  apiEndpoint: "http://127.0.0.1:3000/v1/chat/completions",
  apiKey: "test-key-not-real",
  model: "test-model",
  provider: "openai"
});

// A reader over pre-split byte chunks. The split points are deliberately hostile:
// some fall inside a `data:` line, some inside a JSON string, some between frames.
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

function createStreamResponse(chunks) {
  return {
    body: { getReader: () => createChunkedReader(chunks) },
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : null) },
    ok: true,
    status: 200
  };
}

function createJsonResponse(payload) {
  return {
    body: null,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => payload,
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload)
  };
}

// Installs a fetch stub for one test and restores the previous one afterwards.
async function withFetch(t, respond, run) {
  const previous = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, init) => {
    requests.push({ init, url: String(url), body: JSON.parse(String(init?.body || "{}")) });

    return respond(requests[requests.length - 1]);
  };

  t.after(() => {
    globalThis.fetch = previous;
  });

  return run(requests);
}

function requestBody() {
  return {
    messages: [{ content: "read my notes", role: "user" }],
    model: "test-model",
    stream: true,
    tools: [{ function: { name: "file_read" }, type: "function" }]
  };
}

// --- B1: the incremental reader must forward the payload hook ----------------

test("a streamed turn assembles split tool-call fragments through the REAL reader", async (t) => {
  // The arguments arrive in four fragments across four frames, and the chunk splits
  // land mid-line and mid-JSON so the reader's buffering is exercised as well.
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"file_read","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"~/notes"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".txt\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n"
  ];
  // Split every frame again at a hostile offset: byte-level chunking is what the
  // live body does, and a hook wired only on whole frames would still fail here.
  const chunks = frames.flatMap((frame) => {
    const cut = Math.max(1, Math.floor(frame.length / 3));

    return [frame.slice(0, cut), frame.slice(cut, cut * 2), frame.slice(cut * 2)];
  });

  await withFetch(t, () => createStreamResponse(chunks), async (requests) => {
    const assembled = await streamOnscreenAgentToolTurn({
      requestBody: requestBody(),
      settings: SETTINGS
    });

    assert.equal(requests.length, 1, "one transport call");
    assert.equal(requests[0].body.stream, true, "the tool turn asked to stream");

    // THE BLOCKER ASSERTION: a fragment nobody forwarded leaves this empty.
    assert.equal(assembled.toolCalls.length, 1, "the reader must feed the assembler its fragments");
    assert.equal(assembled.toolCalls[0].name, "file_read");
    assert.equal(assembled.toolCalls[0].id, "call_a");
    assert.equal(assembled.toolCalls[0].arguments, '{"path":"~/notes.txt"}');
    assert.equal(assembled.toolCalls[0].argumentsComplete, true);

    // And the verdict survives the session's extractor, so the loop sees a call.
    const extracted = extractToolCallsFromCompletion(assembled);

    assert.equal(extracted.toolCalls.length, 1);
    assert.equal(extracted.toolCalls[0].argumentsComplete, true);
  });
});

test("text deltas reach onDelta while tool-call fragments assemble", async (t) => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"Reading "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"your file."}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"file_read","arguments":"{\\"path\\":\\"~/a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n"
  ];
  const deltas = [];

  await withFetch(t, () => createStreamResponse(frames), async () => {
    const assembled = await streamOnscreenAgentToolTurn({
      onDelta: (delta) => deltas.push(delta),
      requestBody: requestBody(),
      settings: SETTINGS
    });

    assert.equal(deltas.join(""), "Reading your file.", "prose still renders as it arrives");
    assert.equal(assembled.toolCalls.length, 1, "the call is assembled in the same stream");
    assert.equal(assembled.toolCalls[0].argumentsComplete, true);
  });
});

test("interleaved parallel calls stay separate through the REAL reader", async (t) => {
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"file_read","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"file_list","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"~/a\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"~/b\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n"
  ];

  await withFetch(t, () => createStreamResponse(frames), async () => {
    const assembled = await streamOnscreenAgentToolTurn({
      requestBody: requestBody(),
      settings: SETTINGS
    });

    assert.equal(assembled.toolCalls.length, 2, "two calls, not one merged buffer");
    assert.deepEqual(assembled.toolCalls.map((call) => call.id), ["c1", "c2"]);
    assert.equal(assembled.toolCalls[0].arguments, '{"path":"~/a"}');
    assert.equal(assembled.toolCalls[1].arguments, '{"path":"~/b"}');
    assert.equal(assembled.toolCalls.every((call) => call.argumentsComplete), true);
  });
});

// --- the buffered paths must forward the same hook ---------------------------

test("a provider that ignores stream:true is consumed by the same assembler", async (t) => {
  const payload = {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "Reading it now.",
          tool_calls: [
            { function: { arguments: '{"path":"~/notes.txt"}', name: "file_read" }, id: "c1", type: "function" }
          ]
        }
      }
    ]
  };

  await withFetch(t, () => createJsonResponse(payload), async () => {
    const assembled = await streamOnscreenAgentToolTurn({
      requestBody: requestBody(),
      settings: SETTINGS
    });

    assert.equal(assembled.toolCalls.length, 1, "one whole JSON body becomes one call");
    assert.equal(assembled.toolCalls[0].argumentsComplete, true);
    assert.equal(assembled.toolCalls[0].arguments, '{"path":"~/notes.txt"}');
  });
});

// --- N1: a silent-empty stream must be an explicit outcome -------------------

test("a stream that delivered no payload throws instead of posing as a blank answer", async (t) => {
  await withFetch(t, () => createStreamResponse(["data: [DONE]\n\n"]), async () => {
    await assert.rejects(
      () =>
        streamOnscreenAgentToolTurn({
          requestBody: requestBody(),
          settings: SETTINGS
        }),
      /no completion payload/u,
      "an empty stream is a transport anomaly, not a silent empty turn"
    );
  });
});

// --- truncation through the real reader --------------------------------------

test("finish_reason:length refuses a call whose arguments happen to parse", async (t) => {
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"file_read","arguments":"{\\"path\\":\\"~/a\\"}"}}]},"finish_reason":"length"}]}\n\n',
    "data: [DONE]\n\n"
  ];

  await withFetch(t, () => createStreamResponse(frames), async () => {
    const assembled = await streamOnscreenAgentToolTurn({
      requestBody: requestBody(),
      settings: SETTINGS
    });

    assert.equal(assembled.truncated, true);
    assert.equal(assembled.toolCalls[0].argumentsComplete, false, "a cut stream dispatches nothing");
  });
});

// --- N2: the call index survives the boundary --------------------------------

test("the session extractor carries each call's index", () => {
  const extracted = extractToolCallsFromCompletion({
    finishReason: "tool_calls",
    text: "",
    toolCalls: [
      { arguments: '{"path":"~/a"}', argumentsComplete: true, id: "c1", index: 0, name: "file_read" },
      { arguments: '{"path":"~/b"}', argumentsComplete: true, id: "c2", index: 1, name: "file_list" }
    ]
  });

  assert.deepEqual(extracted.toolCalls.map((call) => call.index), [0, 1], "index travels with the call");

  // A whole-body payload (no assembler index) falls back to array position rather
  // than inventing one.
  const fromPayload = extractToolCallsFromCompletion({
    choices: [
      {
        finish_reason: "tool_calls",
        message: { content: "", tool_calls: [{ function: { arguments: "{}", name: "file_list" }, id: "c9" }] }
      }
    ]
  });

  assert.equal(fromPayload.toolCalls[0].index, undefined, "a non-streamed payload carries no invented index");
});
