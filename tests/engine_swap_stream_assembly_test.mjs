// Focused engine-swap coverage for streaming tool-call assembly (plan §3.5, §7 P3).
//
// The load-bearing property is negative and absolute: NOTHING is dispatched from a
// partial argument payload. This suite pins it from both directions — the assembler
// refuses to call a fragment-laden call complete, and the loop refuses to dispatch a
// call the assembler did not bless.
//
// Hermetic: no network, no keys, no timers, no app-data writes. Every fixture is a
// literal delta list, and every assertion is on a pure return value.

import assert from "node:assert/strict";
import test from "node:test";

import {
  STREAM_ASSEMBLY_PROBLEM,
  assembleToolCallsFromDeltas,
  createStreamingToolCallAssembler,
  isCompleteToolArguments
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/stream-assembly.js";
import { extractToolCallsFromCompletion } from "../app/L0/_all/modules/_core/framework/js/engine-swap/tier1-session.js";

// An OpenAI-shape argument fragment: the provider splits the JSON string anywhere.
function fragment(index, id, name, args, options = {}) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              ...(id ? { id } : {}),
              ...(Number.isFinite(index) ? { index } : {}),
              function: {
                ...(name ? { name } : {}),
                arguments: args
              }
            }
          ]
        },
        finish_reason: options.finishReason || null
      }
    ]
  };
}

function collect(payloads) {
  const assembler = createStreamingToolCallAssembler();

  payloads.forEach((payload) => assembler.applyPayload(payload));

  return assembler.finish();
}

// --- argument completeness -------------------------------------------------

test("arguments split across four fragments assemble into one complete call", () => {
  const result = collect([
    fragment(0, "call_a", "file_read", '{"pa'),
    fragment(0, "", "", 'th":"~/notes'),
    fragment(0, "", "", '.txt"}'),
    fragment(0, "", "", "", { finishReason: "tool_calls" })
  ]);

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "file_read");
  assert.equal(result.toolCalls[0].id, "call_a");
  assert.equal(result.toolCalls[0].arguments, '{"path":"~/notes.txt"}');
  assert.equal(result.toolCalls[0].argumentsComplete, true);
  assert.equal(result.toolCalls[0].problem, "");
});

test("a single delta carrying the whole call is complete", () => {
  const result = collect([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { function: { arguments: '{"path":"~/a"}', name: "file_read" }, id: "c1", index: 0 }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    }
  ]);

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].argumentsComplete, true);
});

test("a call with no arguments at all is complete, not malformed", () => {
  const result = collect([
    fragment(0, "c1", "file_list", "", { finishReason: "tool_calls" })
  ]);

  assert.equal(result.toolCalls[0].arguments, "");
  assert.equal(result.toolCalls[0].argumentsComplete, true);
  // The empty string is complete; it is NOT an object, and the assembler says so
  // honestly rather than pretending `{}` was sent.
  assert.equal(isCompleteToolArguments(""), true);
});

test("a truncated fragment run never reports complete", () => {
  const result = collect([
    fragment(0, "c1", "file_read", '{"path":"~/no'),
    fragment(0, "", "", "tes.txt") // no closing brace, no finish marker
  ]);

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].argumentsComplete, false);
  assert.equal(result.toolCalls[0].problem, STREAM_ASSEMBLY_PROBLEM.MALFORMED_ARGUMENTS);
});

test("a provider that stopped mid-output marks every call incomplete", () => {
  const result = collect([
    fragment(0, "c1", "file_read", '{"path":"~/a"}', { finishReason: "length" })
  ]);

  assert.equal(result.truncated, true);
  // The argument text happens to parse; it is STILL refused, because the provider
  // said it stopped mid-output and a prefix can parse by luck.
  assert.equal(isCompleteToolArguments(result.toolCalls[0].arguments), true);
  assert.equal(result.toolCalls[0].argumentsComplete, false);
  assert.equal(result.toolCalls[0].problem, STREAM_ASSEMBLY_PROBLEM.TRUNCATED);
});

test("a call with no name is not dispatchable even when its arguments parse", () => {
  const result = collect([fragment(0, "c1", "", '{"path":"~/a"}', { finishReason: "tool_calls" })]);

  assert.equal(result.toolCalls[0].argumentsComplete, false);
  assert.equal(result.toolCalls[0].problem, STREAM_ASSEMBLY_PROBLEM.EMPTY_NAME);
});

// --- parallel interleaving -------------------------------------------------

test("interleaved parallel calls keep their own argument buffers", () => {
  const result = collect([
    fragment(0, "c1", "file_read", '{"path":'),
    fragment(1, "c2", "file_list", '{"path":'),
    fragment(0, "", "", '"~/a"}'),
    fragment(1, "", "", '"~/b"}'),
    fragment(0, "", "", "", { finishReason: "tool_calls" })
  ]);

  assert.equal(result.toolCalls.length, 2, "two calls, not one merged buffer");
  assert.deepEqual(result.toolCalls.map((call) => call.id), ["c1", "c2"]);
  assert.deepEqual(result.toolCalls.map((call) => call.name), ["file_read", "file_list"]);
  assert.equal(result.toolCalls[0].arguments, '{"path":"~/a"}');
  assert.equal(result.toolCalls[1].arguments, '{"path":"~/b"}');
  assert.equal(result.toolCalls.every((call) => call.argumentsComplete), true);
});

test("a provider with no index keeps calls apart by id", () => {
  const result = collect([
    fragment(null, "c1", "file_read", '{"path":"~/a"}'),
    fragment(null, "c2", "file_list", '{"path":"~/b"}')
  ]);

  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(result.toolCalls.map((call) => call.id), ["c1", "c2"]);
  assert.equal(result.toolCalls[0].arguments, '{"path":"~/a"}');
  assert.equal(result.toolCalls[1].arguments, '{"path":"~/b"}');
});

test("a bare fragment with no index continues the current call", () => {
  const result = collect([
    fragment(null, "c1", "file_read", '{"path":'),
    fragment(null, "", "", '"~/a"}', { finishReason: "tool_calls" })
  ]);

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].arguments, '{"path":"~/a"}');
  assert.equal(result.toolCalls[0].argumentsComplete, true);
});

// --- text and the convenience wrapper --------------------------------------

test("text deltas accumulate while calls assemble", () => {
  const assembler = createStreamingToolCallAssembler();

  assembler.applyDelta({ content: "Reading " });
  assembler.applyDelta({ content: "your file." });
  assembler.applyPayload(fragment(0, "c1", "file_read", '{"path":"~/a"}', { finishReason: "tool_calls" }));

  const result = assembler.finish();

  assert.equal(result.text, "Reading your file.");
  assert.equal(result.toolCalls.length, 1);
});

test("a text-only stream assembles no calls and stays a plain answer", () => {
  const result = assembleToolCallsFromDeltas([{ content: "All done." }]);

  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.text, "All done.");
});

// --- the extractor carries the verdict through -----------------------------

test("the session extractor passes the assembler's completeness verdict through", () => {
  const assembled = assembleToolCallsFromDeltas([
    { tool_calls: [{ function: { arguments: '{"path":"~/a"}', name: "file_read" }, id: "c1", index: 0 }] }
  ]);
  const extracted = extractToolCallsFromCompletion(assembled);

  assert.equal(extracted.toolCalls.length, 1);
  assert.equal(extracted.toolCalls[0].argumentsComplete, true);
  assert.equal(extracted.toolCalls[0].name, "file_read");
});

test("the session extractor refuses to re-derive a negative completeness verdict", () => {
  const extracted = extractToolCallsFromCompletion({
    finishReason: "tool_calls",
    text: "",
    toolCalls: [{ arguments: '{"path":"~/a"}', argumentsComplete: false, id: "c1", name: "file_read" }]
  });

  // The argument string parses perfectly. The verdict still stands: ONE owner of
  // the completeness decision, and it is the assembler.
  assert.equal(extracted.toolCalls[0].argumentsComplete, false);
});

// --- purity -----------------------------------------------------------------

test("assembly is pure: the same deltas produce the same result twice", () => {
  const deltas = [
    fragment(0, "c1", "file_read", '{"path":'),
    fragment(0, "", "", '"~/a"}', { finishReason: "tool_calls" })
  ];
  const first = collect(deltas);
  const second = collect(deltas);

  assert.deepEqual(first, second);
  // And the input payloads are untouched: assembly never mutates its evidence.
  assert.equal(deltas[0].choices[0].delta.tool_calls[0].function.arguments, '{"path":');
});
