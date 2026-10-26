// Focused engine-swap P2 coverage for the registry <-> transport seam.
//
// This suite exists because of audit-2 finding 2: P1's two headline deliverables
// did not compose. `assembleVisibleToolList` emitted `{ description, name,
// parameters, riskClass, strict }` while `buildRequest` read `record.schema`, so
// the per-session visible list reached the transport with `parameters: undefined`
// and nothing noticed, because no test crossed the seam.
//
// What this locks down now:
//   - an assembled visible list builds a real request end to end, with every tool
//     carrying its parameter schema (no green-with-undefined anywhere)
//   - the strict promise survives that seam: a request built from assembled tools
//     on a strict-capable provider is fully strict (every property required,
//     optional ones nullable, type and enum agreeing about null)
//   - a non-strict provider gets the plain schemas and no strict flag
//   - the registry record shape still works too, so both shapes compose
//   - a tool definition with no schema at all is refused loudly instead of shipped
//
// Hermetic: pure functions only, no network, no keys, no app-data writes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleVisibleToolList,
  createToolRegistry
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/tool-registry.js";
import { buildRequest } from "../app/L0/_all/modules/_core/framework/js/engine-swap/transports.js";
import {
  toStrictSchema,
  toolRecordToOpenAiTool
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/canonical.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const NEURALWATT_ENDPOINT = "https://api.neuralwatt.com/v1/chat/completions";

function assembledFor({ apiEndpoint, model, provider }) {
  return assembleVisibleToolList({
    config: { apiEndpoint, provider },
    model,
    registry: createToolRegistry()
  });
}

function buildFrom(assembled, { endpoint = OPENAI_ENDPOINT, model = "gpt-x", providerKey = "openai" } = {}) {
  return buildRequest({
    endpoint,
    messages: [],
    model,
    providerKey,
    tools: assembled.tools
  });
}

// --- the seam that was broken ----------------------------------------------

test("an assembled visible list builds a real request with every schema present", () => {
  const assembled = assembledFor({ apiEndpoint: OPENAI_ENDPOINT, model: "gpt-x", provider: "openai" });
  const built = buildFrom(assembled);

  assert.equal(built.body.tools.length, assembled.tools.length);

  built.body.tools.forEach((tool) => {
    const parameters = tool.function.parameters;

    // The exact failure audit-2 found: `parameters: undefined`.
    assert.notEqual(parameters, undefined, tool.function.name + " must carry its parameter schema");
    assert.equal(typeof parameters, "object");
    assert.equal(parameters.type, "object");
    assert.ok(parameters.properties && Object.keys(parameters.properties).length > 0);
  });
});

test("the transport sends the same tool names the registry assembled", () => {
  const assembled = assembledFor({ apiEndpoint: OPENAI_ENDPOINT, model: "gpt-x", provider: "openai" });
  const built = buildFrom(assembled);

  assert.deepEqual(
    built.body.tools.map((tool) => tool.function.name),
    [...assembled.names]
  );
});

// --- the strict promise crosses the seam -----------------------------------

test("a request built from assembled tools is fully strict on a strict provider", () => {
  const assembled = assembledFor({ apiEndpoint: OPENAI_ENDPOINT, model: "gpt-x", provider: "openai" });
  const built = buildFrom(assembled);

  assert.equal(built.capabilities.flags.tools_strict, true);

  built.body.tools.forEach((tool) => {
    const parameters = tool.function.parameters;
    const propertyNames = Object.keys(parameters.properties || {});

    assert.equal(tool.function.strict, true);
    assert.deepEqual([...parameters.required].sort(), [...propertyNames].sort());
    assert.equal(parameters.additionalProperties, false);

    propertyNames.forEach((name) => {
      const property = parameters.properties[name];
      const types = Array.isArray(property.type) ? property.type : [property.type];

      // Optional properties are nullable in strict mode, always.
      if (!parameters.required.includes(name)) {
        assert.ok(types.includes("null"), tool.function.name + "." + name + " must accept null");
      }

      if (Array.isArray(property.enum)) {
        assert.equal(
          property.enum.includes(null),
          types.includes("null"),
          tool.function.name + "." + name + ": enum and type must agree about null"
        );
      }
    });
  });
});

test("a non-strict provider gets plain schemas and no strict flag", () => {
  const assembled = assembledFor({
    apiEndpoint: NEURALWATT_ENDPOINT,
    model: "deepseek-v4.1-flash",
    provider: "neuralwatt"
  });
  const built = buildFrom(assembled, {
    endpoint: NEURALWATT_ENDPOINT,
    model: "deepseek-v4.1-flash",
    providerKey: "neuralwatt"
  });

  assert.equal(built.capabilities.flags.tools_strict, false);
  assert.ok(built.body.tools.every((tool) => !("strict" in tool.function)));
  // The plain schema keeps its original required list rather than the widened one.
  const fileWrite = built.body.tools.find((tool) => tool.function.name === "file_write");

  assert.deepEqual([...fileWrite.function.parameters.required], ["path", "content"]);
});

// --- both shapes compose ---------------------------------------------------

test("the registry record shape and the assembled shape produce the same wire tool", () => {
  const registry = createToolRegistry();
  const record = registry.get("file_read");
  const assembled = assembledFor({ apiEndpoint: OPENAI_ENDPOINT, model: "gpt-x", provider: "openai" });
  const assembledTool = assembled.tools.find((tool) => tool.name === "file_read");

  const fromRecord = toolRecordToOpenAiTool(record, { strict: true });
  const fromAssembled = toolRecordToOpenAiTool(assembledTool, { strict: true });

  assert.deepEqual(fromAssembled, fromRecord);
});

test("a tool definition with no schema at all is refused loudly", () => {
  assert.throws(
    () => toolRecordToOpenAiTool({ description: "no schema", name: "broken" }),
    /no parameter schema/u
  );
});

test("toStrictSchema widens optional properties and stays one implementation", () => {
  const widened = toStrictSchema({ properties: { a: { type: "string" } }, required: [], type: "object" });

  assert.deepEqual([...widened.required], ["a"]);
  assert.deepEqual(widened.properties.a.type, ["string", "null"]);
});

// --- assembly determinism across the seam ----------------------------------

test("the same config assembles the same list and builds the same request twice", () => {
  const first = assembledFor({ apiEndpoint: OPENAI_ENDPOINT, model: "gpt-x", provider: "openai" });
  const second = assembledFor({ apiEndpoint: OPENAI_ENDPOINT, model: "gpt-x", provider: "openai" });

  assert.equal(first.hash, second.hash);
  assert.equal(JSON.stringify(buildFrom(first)), JSON.stringify(buildFrom(second)));
});
