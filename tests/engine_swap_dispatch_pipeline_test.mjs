// Focused engine-swap P2 coverage for the dispatch pipeline (plan §3.4).
//
// What this locks down:
//   - STAGE ORDER is observable, not asserted by comment: a call that fails
//     validation never reaches coercion, a call that fails coercion never reaches
//     a handler, and a held destructive call never executes at all
//   - every coaching-error class in the closed taxonomy is produced by a real
//     input, and every error carries BOTH a human line and a model-facing hint
//     (a prose-only error is a defect)
//   - the coercion table: each known-harmless slip is repaired, and a richer
//     wrong shape is rejected before execution
//   - the destructive hold: hold -> confirm -> execute once; hold -> deny ->
//     policy result; nothing executes while held
//
// Hermetic: no network, no keys, no app-data writes. Handlers are stubs that
// record what they were called with.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPATCH_OUTCOME,
  DISPATCH_STAGE,
  createDispatchPipeline,
  formatToolResultForModel
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/dispatch-pipeline.js";
import {
  DISPATCH_ERROR_CLASS,
  DISPATCH_ERROR_CLASSES,
  createDispatchError
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/dispatch-errors.js";
import {
  COERCION_RULE,
  KNOWN_HARMLESS_SLIPS,
  coerceToolArguments
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/dispatch-coercion.js";
import { createDestructiveGate } from "../app/L0/_all/modules/_core/framework/js/engine-swap/destructive-gate.js";
import { createToolRegistry } from "../app/L0/_all/modules/_core/framework/js/engine-swap/tool-registry.js";

// A recording fake for the shipped `space.api` shorthands. Every test reads
// `calls` to prove what did (or did not) reach a handler.
function createFakeApi(outcomes = {}) {
  const calls = [];

  function record(name) {
    return async (...args) => {
      calls.push({ args, name });

      if (outcomes[name] instanceof Error) {
        throw outcomes[name];
      }

      return outcomes[name] === undefined ? { ok: true, method: name } : outcomes[name];
    };
  }

  return {
    calls,
    fileDelete: record("fileDelete"),
    fileList: record("fileList"),
    fileRead: record("fileRead"),
    fileWrite: record("fileWrite")
  };
}

function createPipeline({ api = createFakeApi(), gate = createDestructiveGate(), registry = createToolRegistry() } = {}) {
  return createDispatchPipeline({ api, gate, registry });
}

// --- stage order -----------------------------------------------------------

test("an unregistered tool fails at validation and never reaches a handler", async () => {
  const api = createFakeApi();
  const pipeline = createPipeline({ api });
  const outcome = await pipeline.dispatchToolCall({ argumentsJson: "{}", callId: "c1", name: "file_nuke" });

  assert.equal(outcome.status, DISPATCH_OUTCOME.ERROR);
  assert.deepEqual([...outcome.stages], [DISPATCH_STAGE.VALIDATION]);
  assert.equal(outcome.error.class, DISPATCH_ERROR_CLASS.VALIDATION);
  assert.equal(api.calls.length, 0);
});

test("malformed argument JSON is a validation failure with coaching, not a dispatch", async () => {
  const api = createFakeApi();
  const pipeline = createPipeline({ api });
  const outcome = await pipeline.dispatchToolCall({ argumentsJson: "{\"path\": ", callId: "c1", name: "file_read" });

  assert.equal(outcome.status, DISPATCH_OUTCOME.ERROR);
  assert.equal(outcome.error.class, DISPATCH_ERROR_CLASS.VALIDATION);
  assert.match(outcome.error.message, /not valid JSON/u);
  assert.ok(outcome.error.hint.length > 20, "a model-facing retry hint is required");
  assert.equal(api.calls.length, 0);
});

test("schema-violating arguments stop before coercion and execution", async () => {
  const api = createFakeApi();
  const pipeline = createPipeline({ api });
  // `operation` is not an enum value; `path` is present so required is satisfied.
  const outcome = await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ operation: "destroy", path: "~/notes.txt" }),
    callId: "c1",
    name: "file_write"
  });

  assert.equal(outcome.status, DISPATCH_OUTCOME.ERROR);
  assert.equal(outcome.error.class, DISPATCH_ERROR_CLASS.VALIDATION);
  assert.deepEqual([...outcome.stages], [DISPATCH_STAGE.VALIDATION]);
  assert.match(outcome.error.message, /operation/u);
  assert.equal(api.calls.length, 0);
});

test("a missing required field is named in the validation error", async () => {
  const pipeline = createPipeline();
  const outcome = await pipeline.dispatchToolCall({ argumentsJson: "{}", callId: "c1", name: "file_read" });

  assert.equal(outcome.error.class, DISPATCH_ERROR_CLASS.VALIDATION);
  assert.match(outcome.error.message, /path/u);
  assert.match(outcome.error.message, /required/u);
});

test("an unknown extra field is rejected because the launch schemas close their shape", async () => {
  const pipeline = createPipeline();
  const outcome = await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ nonsense: true, path: "~/a.txt" }),
    callId: "c1",
    name: "file_read"
  });

  assert.equal(outcome.status, DISPATCH_OUTCOME.ERROR);
  assert.equal(outcome.error.class, DISPATCH_ERROR_CLASS.VALIDATION);
  assert.match(outcome.error.message, /nonsense/u);
});

test("a rich wrong shape is rejected at coercion, after validation passed", async () => {
  const api = createFakeApi();
  const pipeline = createPipeline({ api });
  // An object where the string `content` belongs: validation marks it coercible?
  // No — a multi-key object cannot be repaired, so coercion rejects it.
  const outcome = await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ content: { text: "x", encoding: "utf8" }, path: "~/a.txt" }),
    callId: "c1",
    name: "file_write"
  });

  assert.equal(outcome.status, DISPATCH_OUTCOME.ERROR);
  assert.equal(outcome.error.class, DISPATCH_ERROR_CLASS.COERCION);
  assert.deepEqual([...outcome.stages], [DISPATCH_STAGE.VALIDATION, DISPATCH_STAGE.COERCION]);
  assert.match(outcome.error.message, /content/u);
  assert.equal(api.calls.length, 0);
});

test("a valid read call walks every stage in order and reaches the handler", async () => {
  const api = createFakeApi({ fileRead: { content: "hello", encoding: "utf8", path: "~/a.txt" } });
  const pipeline = createPipeline({ api });
  const outcome = await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ path: "~/a.txt" }),
    callId: "c1",
    name: "file_read"
  });

  assert.equal(outcome.status, DISPATCH_OUTCOME.OK);
  assert.deepEqual([...outcome.stages], [
    DISPATCH_STAGE.VALIDATION,
    DISPATCH_STAGE.COERCION,
    DISPATCH_STAGE.RISK,
    DISPATCH_STAGE.EXECUTION
  ]);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].name, "fileRead");
  assert.deepEqual(api.calls[0].args, ["~/a.txt", undefined]);
});

// --- the coercion table ----------------------------------------------------

test("the known-harmless slip catalogue covers every declared rule", () => {
  const rules = new Set(KNOWN_HARMLESS_SLIPS.map((slip) => slip.rule));

  assert.deepEqual([...rules].sort(), Object.values(COERCION_RULE).sort());
});

test("each known-harmless slip is repaired rather than rejected", () => {
  const cases = [
    { args: { line: "42", path: "~/a", content: "c", operation: "insert" }, expect: { line: 42 } },
    { args: { path: "~/", recursive: "true" }, expect: { recursive: true } },
    { args: { path: ["~/a.txt"] }, expect: { path: "~/a.txt" } },
    { args: { encoding: { encoding: "utf8" }, path: "~/a.txt" }, expect: { encoding: "utf8" } },
    { args: { path: "~/", recursive: null }, expect: {} }
  ];

  for (const entry of cases) {
    const coerced = coerceToolArguments({ arguments: entry.args, schema: schemaForArgs(entry.args) });

    assert.equal(coerced.rejected.length, 0, `unexpected rejection for ${JSON.stringify(entry.args)}`);
    assert.ok(coerced.applied.length >= 1, `expected a repair for ${JSON.stringify(entry.args)}`);
    assert.deepEqual(Object.fromEntries(Object.entries(coerced.arguments).filter(([key]) => key in entry.expect)), entry.expect);
  }
});

function schemaForArgs(args) {
  // The launch schemas, narrowed to the fields under test.
  if ("content" in args) {
    return {
      additionalProperties: false,
      properties: {
        content: { type: "string" },
        line: { minimum: 1, type: "integer" },
        operation: { enum: ["replace", "append", "prepend", "insert"], type: "string" },
        path: { type: "string" }
      },
      required: ["path", "content"],
      type: "object"
    };
  }

  return {
    additionalProperties: false,
    properties: {
      encoding: { enum: ["utf8", "base64"], type: "string" },
      path: { type: "string" },
      recursive: { type: "boolean" }
    },
    required: ["path"],
    type: "object"
  };
}

test("a coercible slip still executes and the handler sees the repaired value", async () => {
  const api = createFakeApi({ fileList: { access: "read", path: "~/", paths: [] } });
  const pipeline = createPipeline({ api });
  const outcome = await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ path: "~/", recursive: "true" }),
    callId: "c1",
    name: "file_list"
  });

  assert.equal(outcome.status, DISPATCH_OUTCOME.OK);
  assert.equal(api.calls[0].args[1].recursive, true);
});

// --- error taxonomy --------------------------------------------------------

test("the taxonomy is closed and every class carries both faces", () => {
  assert.deepEqual([...DISPATCH_ERROR_CLASSES].sort(), ["api", "coercion", "execution", "policy", "validation"]);

  for (const className of DISPATCH_ERROR_CLASSES) {
    const error = createDispatchError({ className, message: "one line", retryHint: "try this instead" });

    assert.equal(error.class, className);
    assert.ok(error.message.length > 0);
    assert.ok(error.hint.length > 0);
    assert.equal(error.coaching, "one line\ntry this instead");
  }
});

test("an unknown error class is refused at construction", () => {
  assert.throws(() => createDispatchError({ className: "catastrophe" }), /Unknown dispatch error class/u);
});

test("an api rejection is classified api, not execution", async () => {
  const api = createFakeApi({ fileRead: new Error("Path not found: ~/missing.txt") });
  const pipeline = createPipeline({ api });
  const outcome = await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ path: "~/missing.txt" }),
    callId: "c1",
    name: "file_read"
  });

  assert.equal(outcome.status, DISPATCH_OUTCOME.ERROR);
  assert.equal(outcome.error.class, DISPATCH_ERROR_CLASS.API);
  assert.match(outcome.error.hint, /path|permission|scope/iu);
});

test("an unexpected handler throw is classified execution", async () => {
  const api = createFakeApi({ fileRead: new TypeError("cannot read properties of undefined") });
  const pipeline = createPipeline({ api });
  const outcome = await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ path: "~/a.txt" }),
    callId: "c1",
    name: "file_read"
  });

  assert.equal(outcome.error.class, DISPATCH_ERROR_CLASS.EXECUTION);
});

test("a destructive call without a gate is refused with a policy error, never executed", async () => {
  const api = createFakeApi();
  const pipeline = createDispatchPipeline({ api, gate: null, registry: createToolRegistry() });
  const outcome = await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ path: "~/a.txt" }),
    callId: "c1",
    name: "file_delete"
  });

  assert.equal(outcome.status, DISPATCH_OUTCOME.ERROR);
  assert.equal(outcome.error.class, DISPATCH_ERROR_CLASS.POLICY);
  assert.equal(api.calls.length, 0);
});

// --- destructive hold ------------------------------------------------------

test("a destructive call is HELD, not failed, and nothing executes", async () => {
  const api = createFakeApi();
  const gate = createDestructiveGate();
  const pipeline = createPipeline({ api, gate });
  const outcome = await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ path: "~/a.txt" }),
    callId: "c1",
    name: "file_delete"
  });

  assert.equal(outcome.status, DISPATCH_OUTCOME.HELD);
  assert.ok(gate.isHeld);
  assert.equal(api.calls.length, 0, "a held call must not execute");
  // The stage list stops at risk: execution never ran.
  assert.deepEqual([...outcome.stages], [DISPATCH_STAGE.VALIDATION, DISPATCH_STAGE.COERCION, DISPATCH_STAGE.RISK]);
  // The model is told HELD, not failed.
  assert.match(formatToolResultForModel(outcome), /^held:/u);
});

test("hold -> confirm executes exactly once with the held arguments", async () => {
  const api = createFakeApi();
  const gate = createDestructiveGate();
  const pipeline = createPipeline({ api, gate });

  await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ path: "~/a.txt" }),
    callId: "c1",
    name: "file_delete"
  });

  const settled = gate.confirm();
  const executed = await pipeline.executeConfirmedHold(settled);

  assert.equal(executed.status, DISPATCH_OUTCOME.OK);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].name, "fileDelete");
  assert.deepEqual(api.calls[0].args, ["~/a.txt"]);
  assert.equal(gate.isHeld, false);
  assert.equal(gate.confirm(), null, "a second confirm settles nothing");
  assert.equal(api.calls.length, 1, "confirm is idempotent on the handler too");
});

test("hold -> deny yields a policy result and never executes", async () => {
  const api = createFakeApi();
  const gate = createDestructiveGate();
  const pipeline = createPipeline({ api, gate });

  await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ path: "~/a.txt" }),
    callId: "c1",
    name: "file_delete"
  });

  const settled = gate.deny();

  assert.equal(settled.status, "denied");
  assert.equal(api.calls.length, 0);
  assert.equal(gate.isHeld, false);
});

test("session end always exits the hold state", async () => {
  const gate = createDestructiveGate();

  gate.hold({ callId: "c1", tool: "file_delete" });
  assert.equal(gate.isHeld, true);

  const cancelled = gate.cancelHeld();

  assert.equal(cancelled.status, "cancelled");
  assert.equal(gate.isHeld, false);
  // And the terminal state is recognized as terminal.
  assert.equal(gate.isTerminalStatus("cancelled"), true);
});

test("holding twice is a programmer error, not a silent overwrite", () => {
  const gate = createDestructiveGate();

  gate.hold({ callId: "c1", tool: "file_delete" });
  assert.throws(() => gate.hold({ callId: "c2", tool: "file_delete" }), /already held/u);
});

// --- structured results ----------------------------------------------------

test("a success result reaches the model as compact JSON", async () => {
  const api = createFakeApi({ fileRead: { content: "hi", encoding: "utf8", path: "~/a.txt" } });
  const pipeline = createPipeline({ api });
  const outcome = await pipeline.dispatchToolCall({
    argumentsJson: JSON.stringify({ path: "~/a.txt" }),
    callId: "c1",
    name: "file_read"
  });

  const text = formatToolResultForModel(outcome);

  assert.match(text, /^ok: /u);
  assert.deepEqual(JSON.parse(text.slice(4)), { content: "hi", encoding: "utf8", path: "~/a.txt" });
});

test("an error result reaches the model as class plus coaching, never bare prose", async () => {
  const pipeline = createPipeline();
  const outcome = await pipeline.dispatchToolCall({ argumentsJson: "", callId: "c1", name: "file_read" });
  const text = formatToolResultForModel(outcome);

  assert.match(text, /^error \(validation\): /u);
  assert.ok(text.split("\n").length >= 2, "an error must carry a human line and a hint");
});

test("per-tool stats record one call per execution and one error per failure", async () => {
  const api = createFakeApi({ fileRead: new Error("Path not found: ~/x") });
  const registry = createToolRegistry();
  const statsCalls = [];
  const stats = {
    recordCall: (name) => statsCalls.push(["call", name]),
    recordError: (name) => statsCalls.push(["error", name])
  };
  const pipeline = createDispatchPipeline({ api, gate: createDestructiveGate(), registry, stats });

  await pipeline.dispatchToolCall({ argumentsJson: JSON.stringify({ path: "~/x" }), callId: "c1", name: "file_read" });

  assert.deepEqual(statsCalls, [["call", "file_read"], ["error", "file_read"]]);
});
