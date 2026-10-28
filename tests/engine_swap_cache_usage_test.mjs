// P5-1 cache accounting coverage: the usage block is parsed, and UNKNOWN is not 0.
//
// Fixtures are CAPTURED provider shapes, not invented ones:
//   - NeuralWatt cold call: `prompt_tokens_details: null`
//   - NeuralWatt warm call: `prompt_tokens_details: { cached_tokens: 7424 }`
//   - Synthetic cold call: `{ cached_tokens: 0, created_cache_tokens: 7424 }`
//
// The load-bearing distinction: a provider that SAYS NOTHING has not told us it
// missed. Null reports unknown; a present 0 reports a genuine miss. Reporting a
// null as 0 would be a lie in the opposite direction to the one this lane came to
// fix, so both directions are pinned here.
//
// The `choices: []` case is pinned because it is the shape a provider uses to carry
// the usage block on a final chunk. This lane does NOT send
// `stream_options.include_usage` (that is a request-body change), but if a provider
// volunteers such a chunk the assembler must not fall over -- and must not miss the
// numbers by reading usage after the no-choice guard.
//
// Hermetic: no network, no keys, no timers, no app-data writes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createStreamingToolCallAssembler,
  formatCacheUsageLine,
  normalizeUsageBlock
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/stream-assembly.js";
import {
  extractToolCallsFromCompletion,
  usageFromCompletion
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/tier1-session.js";
import { USAGE_FIXTURES } from "./prefix_digest_fixtures.mjs";

function chunk(options = {}) {
  return {
    choices: options.noChoices
      ? []
      : [
          {
            delta: options.delta || {},
            finish_reason: options.finishReason || null
          }
        ],
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.usageNull ? { usage: null } : {})
  };
}

// ------------------------------------------------- absent versus zero --------

test("NeuralWatt cold call (prompt_tokens_details: null) reports UNKNOWN, not zero", () => {
  const usage = normalizeUsageBlock({ usage: USAGE_FIXTURES.neuralwattCold });

  assert.notEqual(usage, null, "the usage block itself WAS present");
  assert.equal(usage.cachedTokens, null);
  assert.equal(usage.promptTokens, 7538);
  assert.equal(usage.completionTokens, 114);
  // The distinction is explicit, not a happy accident of null coercion.
  assert.notEqual(usage.cachedTokens, 0);
});

test("NeuralWatt warm call reports the captured hit count", () => {
  const usage = normalizeUsageBlock({ usage: USAGE_FIXTURES.neuralwattWarm });

  assert.equal(usage.cachedTokens, 7424);
  assert.equal(usage.promptTokens, 7538);
  assert.equal(usage.createdCacheTokens, null);
});

test("Synthetic cold call reports a real 0 cached plus 7,424 created", () => {
  const usage = normalizeUsageBlock({ usage: USAGE_FIXTURES.syntheticCold });

  // A present 0 is a genuine miss and must survive as 0 -- conflating it with
  // unknown would be the same lie in the other direction.
  assert.equal(usage.cachedTokens, 0);
  assert.equal(usage.createdCacheTokens, 7424);
});

test("a payload with no usage block at all reports null", () => {
  assert.equal(normalizeUsageBlock({ choices: [] }), null);
  assert.equal(normalizeUsageBlock({ usage: null }), null);
  assert.equal(normalizeUsageBlock(null), null);
});

test("an absent prompt_tokens_details is unknown, an absent cached_tokens too", () => {
  assert.equal(normalizeUsageBlock({ usage: { prompt_tokens: 10 } }).cachedTokens, null);
  assert.equal(
    normalizeUsageBlock({ usage: { prompt_tokens: 10, prompt_tokens_details: {} } }).cachedTokens,
    null
  );
});

// ------------------------------------- the choices: [] chunk tolerance ------

test("a usage-only final chunk with choices: [] is tolerated AND its numbers read", () => {
  const assembler = createStreamingToolCallAssembler();

  assembler.applyPayload(chunk({ delta: { content: "hello" }, finishReason: "stop" }));
  // The include_usage shape: no choices, only usage. It must neither throw nor be
  // dropped -- reading usage after the no-choice guard would lose the numbers.
  assembler.applyPayload({ choices: [], usage: USAGE_FIXTURES.neuralwattWarm });

  const result = assembler.finish();

  assert.equal(result.text, "hello");
  assert.equal(result.usage.cachedTokens, 7424);
  // A usage-only chunk is not a completion payload, so it must not change this.
  assert.equal(result.sawAnyPayload, true);
});

test("a usage-only chunk FIRST does not make the turn look like a blank stream", () => {
  const assembler = createStreamingToolCallAssembler();

  assembler.applyPayload({ choices: [], usage: USAGE_FIXTURES.syntheticCold });
  assembler.applyPayload(chunk({ delta: { content: "answer" }, finishReason: "stop" }));

  const result = assembler.finish();

  assert.equal(result.sawAnyPayload, true);
  assert.equal(result.usage.cachedTokens, 0);
  assert.equal(result.usage.createdCacheTokens, 7424);
});

test("usage arriving mid-stream is not erased by a later chunk that omits it", () => {
  const assembler = createStreamingToolCallAssembler();

  assembler.applyPayload(chunk({ delta: { content: "a" }, usage: USAGE_FIXTURES.neuralwattWarm }));
  assembler.applyPayload(chunk({ delta: { content: "b" }, finishReason: "stop" }));

  assert.equal(assembler.finish().usage.cachedTokens, 7424);
});

// --------------------------------------------- through the turn result ------

test("an assembled stream result carries its usage through the completion extractor", () => {
  const assembler = createStreamingToolCallAssembler();

  assembler.applyPayload(chunk({ delta: { content: "done" }, finishReason: "stop" }));
  assembler.applyPayload({ choices: [], usage: USAGE_FIXTURES.neuralwattWarm });

  const extracted = extractToolCallsFromCompletion(assembler.finish());

  // The assembled record is ALREADY normalized; re-normalizing it would read an
  // absent prompt_tokens_details and turn a live hit into unknown.
  assert.equal(extracted.usage.cachedTokens, 7424);
  assert.equal(extracted.text, "done");
});

test("a non-streamed completion body carries usage through the same extractor", () => {
  const payload = {
    choices: [{ finish_reason: "stop", message: { content: "plain", tool_calls: [] } }],
    usage: USAGE_FIXTURES.syntheticCold
  };
  const extracted = extractToolCallsFromCompletion(payload);

  assert.equal(extracted.usage.cachedTokens, 0);
  assert.equal(extracted.usage.createdCacheTokens, 7424);
  assert.equal(extracted.text, "plain");
});

test("a completion with no usage reports null through the extractor, not zero", () => {
  const extracted = extractToolCallsFromCompletion({
    choices: [{ finish_reason: "stop", message: { content: "x", tool_calls: [] } }]
  });

  assert.equal(extracted.usage, null);
  assert.equal(usageFromCompletion({ choices: [] }), null);
});

// ------------------------------------------------------- the log line -------

test("the cache log line spells out unknown rather than printing 0", () => {
  assert.equal(
    formatCacheUsageLine(null),
    "[engine-swap] cache cached=unknown prompt=unknown created=unknown"
  );
  assert.equal(
    formatCacheUsageLine({ cachedTokens: null, createdCacheTokens: null, promptTokens: 7538 }),
    "[engine-swap] cache cached=unknown prompt=7538 created=unknown"
  );
  // A real zero is printed as 0 -- the two states are visually distinct in the log.
  assert.equal(
    formatCacheUsageLine({ cachedTokens: 0, createdCacheTokens: 7424, promptTokens: 7538 }),
    "[engine-swap] cache cached=0 prompt=7538 created=7424"
  );
});

// ------------------------------------------- report-only, never control -----

// ------------------------------------------ every turn of the session --------

test("the post-hold continuation logs cache accounting through the same sendTurn", async () => {
  // A second inline `sendTurn` in `runContinuation` would build the same request and
  // return the same result while emitting NO cache line -- a turn with no
  // observability, and a parallel path for one behaviour. This drives the real
  // continuation so reverting that wiring reddens instead of passing quietly.
  const { createTier1Session } = await import(
    "../app/L0/_all/modules/_core/framework/js/engine-swap/tier1-session.js"
  );
  const lines = [];
  const session = createTier1Session({
    apiEndpoint: "https://api.synthetic.new/v1/chat/completions",
    logger: { info: (line) => lines.push(String(line)) },
    model: "DeepSeek-V4.1-Flash-1017",
    providerKey: "synthetic",
    sendCompletion: async () => ({
      choices: [{ finish_reason: "stop", message: { content: "done", tool_calls: [] } }],
      usage: USAGE_FIXTURES.neuralwattWarm
    }),
    systemPrompt: "SYS",
    userContent: "hi"
  });

  const result = await session.runContinuation({
    messages: [
      { content: "", role: "assistant" },
      { content: "held", role: "tool", toolCallId: "call_1" }
    ],
    toolResultText: "the real outcome"
  });

  assert.equal(result.status, "answered");
  assert.equal(lines.filter((line) => line.includes("cache cached=")).length, 1);
  assert.equal(lines.filter((line) => line.includes("prefix digest=")).length, 1);
  // The numbers are the same ones the primary path reports: one accounting rule.
  assert.match(lines.join("\n"), /cache cached=7424 prompt=7538/u);
});

test("a cache hit does not change stream assembly or truncation verdicts", () => {
  const warm = createStreamingToolCallAssembler();
  const cold = createStreamingToolCallAssembler();
  const delta = {
    tool_calls: [{ function: { arguments: "{}", name: "file_read" }, id: "call_1", index: 0 }]
  };

  warm.applyPayload(chunk({ delta, usage: USAGE_FIXTURES.neuralwattWarm }));
  cold.applyPayload(chunk({ delta, usage: USAGE_FIXTURES.neuralwattCold }));

  const warmResult = warm.finish();
  const coldResult = cold.finish();

  // Everything except the reported usage is identical: usage is display-only.
  assert.deepEqual(
    { ...warmResult, usage: null },
    { ...coldResult, usage: null }
  );
});
