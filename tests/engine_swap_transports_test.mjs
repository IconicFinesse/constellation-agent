// Focused engine-swap coverage for the transport adapter scaffolding.
//
// This is one of the two headline P1 deliverables (plan §3.1) and it had zero
// coverage — the audit flagged it. What this locks down:
//
//   - the launch adapter set: four providers, all OpenAI-shape, none native
//   - per-provider request assembly: tools present only where the capability
//     seam says tools resolve, strict schemas only where the seam says strict,
//     parallel calls only where the seam allows them
//   - provider identity resolving from the seam, including the real Synthetic
//     host and the conservative unknown fallback
//   - canonical message wire shape (tool calls carry JSON-string arguments)
//   - purity: the same inputs always assemble the same request
//
// Hermetic: pure functions, no network, no keys, no globals touched.

import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENAI_SHAPE_ADAPTER_ID,
  buildRequest,
  getTransportAdapter,
  listTransportAdapters
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/transports.js";
import {
  createAssistantToolCallMessage,
  createUserMessage
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/canonical.js";
import { LAUNCH_TOOL_RECORDS } from "../app/L0/_all/modules/_core/framework/js/engine-swap/tool-registry.js";

const MESSAGES = [
  createUserMessage("read my notes"),
  createAssistantToolCallMessage({
    toolCalls: [
      {
        arguments: { path: "~/notes.txt" },
        id: "call_1",
        name: "file_read"
      }
    ]
  })
];

function request(overrides = {}) {
  return buildRequest({
    endpoint: "https://api.openai.com/v1/chat/completions",
    messages: MESSAGES,
    model: "gpt-x",
    providerKey: "openai",
    stream: true,
    tools: LAUNCH_TOOL_RECORDS,
    ...overrides
  });
}

test("the launch adapter set is four OpenAI-shape providers, none native", () => {
  const adapters = listTransportAdapters();

  assert.deepEqual(adapters.map((entry) => entry.provider).sort(), ["neuralwatt", "openai", "openrouter", "synthetic"]);
  assert.ok(adapters.every((entry) => entry.adapter === OPENAI_SHAPE_ADAPTER_ID));
  assert.ok(adapters.every((entry) => entry.native === false));
});

test("getTransportAdapter resolves known providers and rejects unknown ones", () => {
  const openai = getTransportAdapter("openai");

  assert.equal(openai.adapter, OPENAI_SHAPE_ADAPTER_ID);
  assert.equal(openai.native, false);
  assert.equal(typeof openai.buildRequest, "function");
  assert.equal(getTransportAdapter("anthropic-native"), null);
  assert.equal(getTransportAdapter(""), null);
});

test("canonical messages reach the wire in the OpenAI shape", () => {
  const built = request();
  const wire = built.body.messages;

  assert.equal(wire.length, 2);
  assert.deepEqual(wire[0], { content: "read my notes", role: "user" });
  assert.equal(wire[1].role, "assistant");
  assert.equal(wire[1].tool_calls[0].type, "function");
  assert.equal(wire[1].tool_calls[0].id, "call_1");
  assert.equal(wire[1].tool_calls[0].function.name, "file_read");
  // Arguments stay a JSON string on the wire, never a re-serialized object.
  assert.equal(typeof wire[1].tool_calls[0].function.arguments, "string");
  assert.deepEqual(JSON.parse(wire[1].tool_calls[0].function.arguments), { path: "~/notes.txt" });
});

test("a strict-capable provider request carries fully strict tool schemas", () => {
  const built = request();

  assert.equal(built.provider, "openai");
  assert.equal(built.body.tools.length, LAUNCH_TOOL_RECORDS.length);
  assert.ok(built.body.tools.every((tool) => tool.function.strict === true));
  assert.ok(built.body.tools.every((tool) => tool.type === "function"));
  assert.equal(built.body.parallel_tool_calls, true);

  // `strict: true` is a promise about the SHAPE, not just a flag. A definition
  // whose `required` omits optional properties, or whose optional enum carries no
  // null, is a dead end: strict mode requires every property, so those values
  // could never legally be sent. Audit-2 finding 1 was exactly this, blessed by
  // the previous version of this test.
  built.body.tools.forEach((tool) => {
    const parameters = tool.function.parameters;
    const propertyNames = Object.keys(parameters.properties || {});

    assert.deepEqual(
      [...parameters.required].sort(),
      [...propertyNames].sort(),
      `${tool.function.name}: strict requires every property to be listed in required`
    );

    propertyNames.forEach((name) => {
      const property = parameters.properties[name];
      const declaredTypes = Array.isArray(property.type) ? property.type : [property.type];
      const isRequired = parameters.required.includes(name);

      if (!isRequired) {
        assert.ok(declaredTypes.includes("null"), `${tool.function.name}.${name}: optional strict property must accept null`);
      }

      if (Array.isArray(property.enum)) {
        const enumAcceptsNull = property.enum.includes(null);
        const typeAcceptsNull = declaredTypes.includes("null");

        assert.equal(
          enumAcceptsNull,
          typeAcceptsNull,
          `${tool.function.name}.${name}: type and enum must agree about null`
        );
      }
    });
  });
});

test("a non-strict provider request omits strict and follows the seam for parallel calls", () => {
  const built = request({
    endpoint: "https://api.neuralwatt.com/v1/chat/completions",
    model: "deepseek-v4.1-flash",
    providerKey: "neuralwatt"
  });

  assert.equal(built.provider, "neuralwatt");
  assert.ok(built.body.tools.every((tool) => !("strict" in tool.function)));
  // The model rule turns parallel calls on for this model.
  assert.equal(built.body.parallel_tool_calls, true);
});

test("parallel_tool_calls respects an explicit override", () => {
  assert.equal(request({ parallelToolCallOverride: false }).body.parallel_tool_calls, false);
});

test("OpenRouter carries its attribution header and no other provider invents headers", () => {
  const openrouter = request({ endpoint: "https://openrouter.ai/api/v1/chat/completions", providerKey: "openrouter" });
  const openai = request();

  assert.equal(openrouter.headers["X-Title"], "Constellation Agent");
  assert.deepEqual({ ...openai.headers }, {});
});

test("provider identity resolves through the capability seam, including the real Synthetic host", () => {
  const synthetic = request({ endpoint: "https://api.synthetic.new/v1/chat/completions", providerKey: "" });

  assert.equal(synthetic.provider, "synthetic");
  assert.ok(synthetic.body.tools.every((tool) => tool.function.strict === true));
});

test("an unknown provider assembles no tools at all", () => {
  const built = request({ endpoint: "https://example.invalid/v1", providerKey: "" });

  assert.equal(built.provider, "unknown");
  assert.equal("tools" in built.body, false);
  assert.equal("parallel_tool_calls" in built.body, false);
  assert.deepEqual(Object.keys(built.body).sort(), ["messages", "model", "stream"]);
});

test("request params merge into the body without disturbing the assembled shape", () => {
  const built = request({ params: { temperature: 0.2 } });

  assert.equal(built.body.temperature, 0.2);
  assert.equal(built.body.model, "gpt-x");
  // This request carries the launch tool list, so it IS a tool turn — and since P3
  // tool turns STREAM: the surface's reader assembles `tool_calls` fragments per
  // call index, so the retired P2 `stream: false` boundary must not come back.
  // (P2 audit note 5 pinned the opposite; that contract is deliberately replaced.)
  assert.equal(built.body.stream, true);
  assert.equal(built.endpoint, "https://api.openai.com/v1/chat/completions");
});

// P3 retired the P2 non-streamed boundary. A tool turn follows the SAME stream
// rule as a text turn now — one rule, not two — because fragment assembly happens
// in the reader and a provider that answers one whole JSON body is handled by the
// same assembler. This test exists so the old force-false boundary cannot quietly
// return: an explicit `stream: true` on a tool turn must survive.
test("a tool turn streams, and an explicit stream param is honoured", () => {
  const streamed = request({ params: { stream: true, temperature: 0.1 } });

  assert.equal(streamed.body.stream, true, "P3 tool turns stream");
  assert.equal(streamed.body.temperature, 0.1, "unrelated params still merge");

  // ...and a caller that explicitly disables streaming still gets its way: the
  // param is not silently ignored for tool turns any more than for text turns.
  const notStreamed = request({ stream: false, tools: [{ name: "file_read", parameters: { type: "object" } }] });

  assert.equal(notStreamed.body.stream, false, "an explicit stream:false is honoured");
});

// ...and the text path keeps today's behavior exactly: params may set `stream`.
test("a text turn still honors a stream param", () => {
  const streamed = request({ params: { stream: true }, tools: [] });

  assert.equal(streamed.body.stream, true);
  assert.equal("tools" in streamed.body, false);

  const notStreamed = request({ params: { stream: false }, stream: true, tools: [] });

  assert.equal(notStreamed.body.stream, false, "text turns keep param precedence over the default");
});

test("assembly is pure: identical inputs produce an identical request", () => {
  const first = request();
  const second = request();

  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
