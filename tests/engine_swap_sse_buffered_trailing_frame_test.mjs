// Focused engine-swap coverage for N1 (P4a-3c prerequisite): the BUFFERED reader's
// trailing UNTERMINATED frame must deliver its raw payload.
//
// The defect, measured on `7686ccc`: `pumpEventStreamText` parsed its trailing frame
// as `parseEventBlock(remaining, onDelta, meta)` — WITHOUT `onPayload` — while
// `readStreamingResponse` forwarded it at its own trailing callsite. A body of ONE
// frame with no closing `\n\n` therefore delivered 0 payloads buffered and 1
// streaming. Harmless while no surface passed the hook; the moment a surface adopts
// the Tier 1 assembler, a provider that answers a buffered body ending mid-frame
// would deliver ZERO payloads and the turn would end as a blank answer with a green
// suite.
//
// WHAT MAKES THIS CASE EVIDENCE: it drives the REAL exported reader functions, and the
// assertion is a PARITY claim between the two readers over the SAME body. Before the
// fix the buffered side is 0 while the streaming side is 1, so the case is red on
// `7686ccc` and green only with the hook forwarded. A case that merely asserted
// "buffered >= 1" on the fixed tree could not tell the two readers apart.
//
// Hermetic: no disk, no network, no DOM. The fake response is a real `getReader()`.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const sse = await import("../app/L0/_all/modules/_core/framework/js/sse-stream.js");

// ONE frame, NO terminator: the body ends mid-frame, exactly as a provider that
// flushes its last chunk without a trailing blank line sends it.
const TOOL_CALL_BODY =
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"file_delete","arguments":"{\\"path\\":\\"notes.txt\\"}"}}]}}]}';

function createSingleChunkReader(bodyText) {
  let sent = false;

  return {
    async read() {
      if (sent) {
        return { done: true, value: undefined };
      }

      sent = true;

      return { done: false, value: new TextEncoder().encode(bodyText) };
    }
  };
}

function createStreamResponse(bodyText) {
  return {
    body: { getReader: () => createSingleChunkReader(bodyText) },
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : null) },
    ok: true,
    status: 200
  };
}

function createTextResponse(bodyText) {
  return {
    headers: { get: () => "text/event-stream" },
    ok: true,
    status: 200,
    text: async () => bodyText
  };
}

function collectPayloads() {
  const payloads = [];

  return {
    payloads,
    onPayload: (payload) => payloads.push(payload)
  };
}

test("buffered: an unterminated trailing frame delivers its payload (N1)", async () => {
  const collected = collectPayloads();

  await sse.readBufferedResponse(createTextResponse(TOOL_CALL_BODY), () => {}, collected.onPayload);

  assert.equal(collected.payloads.length, 1);
  assert.deepEqual(collected.payloads[0].choices[0].delta.tool_calls[0].function.name, "file_delete");
});

test("buffered and streaming agree on an unterminated trailing frame (N1 parity)", async () => {
  const buffered = collectPayloads();
  const streamed = collectPayloads();

  await sse.readBufferedResponse(createTextResponse(TOOL_CALL_BODY), () => {}, buffered.onPayload);
  await sse.readStreamingResponse(createStreamResponse(TOOL_CALL_BODY), () => {}, streamed.onPayload);

  // THE parity assertion. On `7686ccc` this reads 0 vs 1.
  assert.equal(buffered.payloads.length, streamed.payloads.length);
  assert.equal(buffered.payloads.length, 1);
});

test("pumpEventStreamText forwards the hook on its trailing frame (N1 direct)", () => {
  const collected = collectPayloads();

  sse.pumpEventStreamText(TOOL_CALL_BODY, () => {}, sse.createCompletionResponseMeta("stream"), collected.onPayload);

  assert.equal(collected.payloads.length, 1);
});

test("a terminated body still delivers exactly one payload per frame (N1 no double-count)", async () => {
  const collected = collectPayloads();

  await sse.readBufferedResponse(createTextResponse(`${TOOL_CALL_BODY}\n\n`), () => {}, collected.onPayload);

  assert.equal(collected.payloads.length, 1);
});

test("an empty body is still the documented unsupported-body error (N1 unchanged)", async () => {
  const collected = collectPayloads();

  // NOT an N1 concern: an empty body is not event-stream shaped, so the buffered
  // reader reports the unsupported-body error exactly as it did before the fix. This
  // case pins that forwarding the hook changed nothing on that path.
  await assert.rejects(
    () => sse.readBufferedResponse(createTextResponse(""), () => {}, collected.onPayload),
    /unsupported response body/iu
  );
  assert.equal(collected.payloads.length, 0);
});
