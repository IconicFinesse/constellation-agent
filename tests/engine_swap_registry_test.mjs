// Focused engine-swap P1 coverage for the tool-registry skeleton.
//
// What this locks down:
//   - the launch inventory is data with the six required record fields
//   - visible-tool-list assembly is deterministic: same (config, model) in,
//     identical list, order, and hash out, across independent calls
//   - canonical ordering is alphabetical and independent of declaration order
//   - strict-mode projection widens optional fields instead of dropping them
//   - the dispatch-table stub can never execute anything
//   - the launch schemas match LIVE SERVER SOURCE, not prose: the write-operation
//     enum is read out of `ensureValidWriteOperation`, and every launch tool's
//     argument names are checked against the endpoint modules in this tree
//
// Hermetic: the only filesystem read is the repository's own server source; no
// network, no keys, no app-data writes, no globals touched.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LAUNCH_TOOL_RECORDS,
  TOOL_RISK_CLASS,
  TOOL_SOURCE,
  WRITE_ENCODING_VALUES,
  WRITE_OPERATION_VALUES,
  assembleVisibleToolList,
  canonicalToolOrder,
  createDispatchTableStub,
  createToolRegistry,
  createToolStats,
  hashAssembledList,
  toStrictSchema
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/tool-registry.js";

const FILE_ACCESS_SOURCE = new URL("../server/lib/customware/file_access.js", import.meta.url);
const FILE_WRITE_ENDPOINT_SOURCE = new URL("../server/api/file_write.js", import.meta.url);
const FILE_READ_ENDPOINT_SOURCE = new URL("../server/api/file_read.js", import.meta.url);
const FILE_LIST_ENDPOINT_SOURCE = new URL("../server/api/file_list.js", import.meta.url);
const FILE_DELETE_ENDPOINT_SOURCE = new URL("../server/api/file_delete.js", import.meta.url);

async function readSource(url) {
  return readFile(url, "utf8");
}

test("the launch inventory carries the plan's five tools as data", () => {
  const names = LAUNCH_TOOL_RECORDS.map((record) => record.name);

  assert.deepEqual([...names].sort(), ["file_delete", "file_list", "file_read", "file_write", "run_code"]);
});

test("every launch record carries all six required fields", () => {
  for (const record of LAUNCH_TOOL_RECORDS) {
    assert.equal(typeof record.name, "string");
    assert.equal(typeof record.description, "string");
    assert.ok(record.description.length > 20, `${record.name} needs a real description`);
    assert.equal(record.schema.type, "object");
    assert.ok(Object.values(TOOL_RISK_CLASS).includes(record.riskClass), `${record.name} riskClass`);
    assert.equal(typeof record.handler, "string");
    assert.ok(Object.values(TOOL_SOURCE).includes(record.source), `${record.name} source`);
    assert.equal(typeof record.deferrable, "boolean");
  }
});

test("file_delete is the only destructive launch tool", () => {
  const destructive = LAUNCH_TOOL_RECORDS.filter((record) => record.riskClass === TOOL_RISK_CLASS.DESTRUCTIVE);

  assert.deepEqual(destructive.map((record) => record.name), ["file_delete"]);
});

test("assembly is deterministic for one config and model", () => {
  const config = { provider: "neuralwatt" };
  const model = "deepseek-v4.1-flash";
  const first = assembleVisibleToolList({ config, model });
  const second = assembleVisibleToolList({ config, model });
  const third = assembleVisibleToolList({ config: { ...config }, model });

  assert.deepEqual([...first.names], [...second.names]);
  assert.deepEqual([...first.names], [...third.names]);
  assert.equal(first.hash, second.hash);
  assert.equal(first.hash, third.hash);
  assert.deepEqual(JSON.parse(JSON.stringify(first.tools)), JSON.parse(JSON.stringify(third.tools)));
});

test("assembly order is canonical (alphabetical), not declaration order", () => {
  const assembled = assembleVisibleToolList({ config: { provider: "openai" }, model: "gpt-x" });
  const sorted = [...assembled.names].sort();

  assert.deepEqual([...assembled.names], sorted);
  assert.notDeepEqual([...assembled.names], LAUNCH_TOOL_RECORDS.map((record) => record.name));
  assert.deepEqual([...canonicalToolOrder(LAUNCH_TOOL_RECORDS).map((record) => record.name)], sorted);
});

test("a config whose capabilities resolve no tools assembles an empty list", () => {
  const assembled = assembleVisibleToolList({ config: { provider: "unknown-provider" }, model: "mystery" });

  assert.deepEqual([...assembled.names], []);
  assert.equal(assembled.hash, hashAssembledList([]));
  assert.equal(assembled.capabilities.tier, "tier3");
});

test("strict-capable providers get widened schemas, others get the plain schema", () => {
  const strict = assembleVisibleToolList({ config: { provider: "openai" }, model: "gpt-x" });
  const loose = assembleVisibleToolList({ config: { provider: "neuralwatt" }, model: "deepseek-v4.1-flash" });
  const strictWrite = strict.tools.find((tool) => tool.name === "file_write");
  const looseWrite = loose.tools.find((tool) => tool.name === "file_write");

  assert.equal(strictWrite.strict, true);
  assert.deepEqual([...strictWrite.parameters.required], [...Object.keys(strictWrite.parameters.properties)]);
  assert.equal(looseWrite.strict, false);
  assert.deepEqual([...looseWrite.parameters.required], ["path", "content"]);
});

test("toStrictSchema widens optional fields instead of dropping them", () => {
  const strict = toStrictSchema(LAUNCH_TOOL_RECORDS.find((record) => record.name === "file_read").schema);

  assert.deepEqual([...strict.required], ["encoding", "path"]);
  assert.deepEqual(strict.properties.encoding.type, ["string", "null"]);
  assert.equal(strict.additionalProperties, false);
});

test("the dispatch-table stub never executes anything", () => {
  const stub = createDispatchTableStub();

  assert.equal(stub.has("file_write"), true);
  assert.equal(stub.has("not_a_tool"), false);
  assert.equal(stub.size, LAUNCH_TOOL_RECORDS.length);

  const known = stub.dispatch("file_write");
  const unknown = stub.dispatch("not_a_tool");

  assert.deepEqual({ ...known }, { dispatched: false, reason: "p1-dispatch-stub", tool: "file_write" });
  assert.deepEqual({ ...unknown }, { dispatched: false, reason: "unregistered-tool", tool: "not_a_tool" });
});

test("the registry rejects an incomplete record instead of admitting it", () => {
  assert.throws(() => createToolRegistry({ records: [{ name: "broken" }] }), /Invalid tool record broken/u);
});

test("per-tool stats count calls and errors separately", () => {
  const stats = createToolStats();

  stats.recordCall("file_read");
  stats.recordCall("file_read");
  stats.recordError("file_write");

  assert.deepEqual(stats.snapshot(), { file_read: { calls: 2, errors: 0 }, file_write: { calls: 0, errors: 1 } });
});

// ---- Live-server drift assertions -----------------------------------------
// The schemas are the new contract card, and BUG-006's root lesson is that a
// written contract drifts. These assertions read the actual validators.

test("the write-operation enum matches ensureValidWriteOperation in server source", async () => {
  const source = await readSource(FILE_ACCESS_SOURCE);
  const validatorStart = source.indexOf("function ensureValidWriteOperation");

  assert.ok(validatorStart > -1, "ensureValidWriteOperation must exist in file_access.js");

  const validatorBody = source.slice(validatorStart, source.indexOf("function normalizeWriteInsertTarget", validatorStart));
  const declaredOperations = [...validatorBody.matchAll(/(?:normalizedOperation === "|Supported operations are [^;]*?)([a-z]+)/gu)]
    .map((match) => match[1])
    .filter((value) => ["replace", "append", "prepend", "insert"].includes(value));

  assert.ok(validatorBody.includes('"replace"'), "replace must be the documented default");

  for (const operation of WRITE_OPERATION_VALUES) {
    assert.ok(validatorBody.includes(`"${operation}"`), `server validator must still accept ${operation}`);
  }

  // The enum in the registry must not claim an operation the server rejects.
  const unsupportedProbe = "truncate";

  assert.equal(WRITE_OPERATION_VALUES.includes(unsupportedProbe), false);
  assert.equal(validatorBody.includes(`"${unsupportedProbe}"`), false);
  assert.ok(declaredOperations.length >= 3);
});

test("the write-encoding enum matches ensureValidWriteEncoding in server source", async () => {
  const source = await readSource(FILE_ACCESS_SOURCE);
  const validatorStart = source.indexOf("function ensureValidWriteEncoding");

  assert.ok(validatorStart > -1, "ensureValidWriteEncoding must exist in file_access.js");

  const validatorBody = source.slice(validatorStart, source.indexOf("function normalizeReadEntries", validatorStart));

  for (const encoding of WRITE_ENCODING_VALUES) {
    assert.ok(validatorBody.includes(`"${encoding}"`), `server validator must still accept encoding ${encoding}`);
  }
});

test("every file_write argument name exists in the live endpoint source", async () => {
  const source = await readSource(FILE_WRITE_ENDPOINT_SOURCE);
  const schema = LAUNCH_TOOL_RECORDS.find((record) => record.name === "file_write").schema;

  for (const name of Object.keys(schema.properties)) {
    assert.ok(
      source.includes(`payload.${name}`) || source.includes(`"${name}"`),
      `file_write.js must still read the ${name} argument`
    );
  }
});

test("every file_read argument name exists in the live endpoint source", async () => {
  const source = await readSource(FILE_READ_ENDPOINT_SOURCE);
  const schema = LAUNCH_TOOL_RECORDS.find((record) => record.name === "file_read").schema;

  for (const name of Object.keys(schema.properties)) {
    assert.ok(source.includes(`payload.${name}`), `file_read.js must still read the ${name} argument`);
  }
});

test("every file_list argument name exists in the live endpoint source", async () => {
  const source = await readSource(FILE_LIST_ENDPOINT_SOURCE);
  const schema = LAUNCH_TOOL_RECORDS.find((record) => record.name === "file_list").schema;

  for (const name of Object.keys(schema.properties)) {
    assert.ok(
      source.includes(`payload.${name}`) || source.includes(`readBooleanOption(context, "${name}")`) || source.includes(`"${name}"`),
      `file_list.js must still read the ${name} argument`
    );
  }
});

test("every file_delete argument name exists in the live endpoint source", async () => {
  const source = await readSource(FILE_DELETE_ENDPOINT_SOURCE);
  const schema = LAUNCH_TOOL_RECORDS.find((record) => record.name === "file_delete").schema;

  for (const name of Object.keys(schema.properties)) {
    assert.ok(source.includes(`payload.${name}`), `file_delete.js must still read the ${name} argument`);
  }
});

test("run_code's schema matches the plan's declared shape", () => {
  const schema = LAUNCH_TOOL_RECORDS.find((record) => record.name === "run_code").schema;

  assert.deepEqual([...schema.required], ["code"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["code", "intent"]);
});
