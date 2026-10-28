// THE ENGINE TURN LOG (P7-1).
//
// WHY THIS SUITE EXISTS. The Tier 1 engine is about to become the DEFAULT, and until
// this lane a Tier 1 turn left no trail at all: `ca.shadow-diff/1` is a COMPARISON
// artifact and `config-flag.js` deliberately suppresses it on a real Tier 1 turn, so
// the owner had nothing to paste when a live VM misbehaved. This suite pins the
// replacement, and it pins it at the REAL modules: the real turn driver, the real
// loop, the real recorder leaf, and the real server handler against a tmpdir.
//
// The privacy case is the load-bearing one. A log the owner pastes into a chat must
// never carry a prompt, a reply, a tool argument value or a tool result payload, and
// an assertion that a marker is absent can only be trusted if it would go red when
// somebody records `text`. The case seeds a unique marker in all three places and
// would fail on any of them.
//
// Hermetic: no network, no keys, no app-data writes. The one disk write is the
// endpoint's own ring buffer, staged inside a `mkdtemp` tmpdir.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

// A permissive recording surface. The driver's paint leans on these; the suite cares
// only that a turn RUNS, so every hook is a no-op that never throws.
function createSurface() {
  let controller = null;

  return {
    appendEngineSwapStreamingDelta() {},
    getActiveRequestController() {
      return controller;
    },
    getPendingHold() {
      return null;
    },
    maybeShowCompactStreamingAssistantBubble() {},
    openEngineSwapPreview() {},
    persistHistory() {
      return Promise.resolve();
    },
    recordEngineSwapProvisionalCall() {},
    render() {},
    reportError() {},
    scheduleEngineSwapChipRender() {},
    scheduleStreamingMessageRender() {},
    sealEngineSwapPreview() {},
    setActiveRequestController(value) {
      controller = value;
    },
    setHistory() {},
    setPendingHold() {},
    setStatus() {},
    setStreamingAssistantStatus() {},
    showCompactAssistantReplyBubble() {},
    syncEngineSwapDisplayOnlyIds() {}
  };
}

// The fake `space.api`. `file_list` is a REAL registry tool, so the dispatch step is
// produced by the real pipeline rather than by a fabricated event.
function createApi({ onWrite = null, writeThrows = false } = {}) {
  return {
    async fileList(_path, _options) {
      return { entries: [] };
    },
    engineLogWrite(record) {
      if (writeThrows) {
        throw new Error("engine log write exploded");
      }

      onWrite?.(record);

      return Promise.resolve({ ok: true, stored: 1 });
    }
  };
}

// Drives ONE real Tier 1 conversation turn: the real driver composes the real session
// (real loop, real dispatch pipeline, real recorder) over a scripted completion queue.
//
// `responses` is the per-iteration completion queue; `sessionFor` builds the REAL
// `createTier1Session` exactly as the surface bridge does.
async function runRealTurn({ api = null, onWrite = null, responses, runtimeOverride = null, wireMessages = null } = {}) {
  const { createTier1Session } = await import(
    "/modules/_core/framework/js/engine-swap/tier1-session.js"
  );
  const { createTier1TurnDriver } = await import(
    "/modules/_core/framework/js/engine-swap/turn-driver.js"
  );

  const queue = [...responses];
  const activeApi = api || createApi({ onWrite });
  const runtime = runtimeOverride || { api: activeApi };

  const inputs = {
    createStreamingAssistantMessage: () => ({ content: "", id: "", role: "assistant", streaming: true }),
    envelopeMarkers: { USER: "_____user" },
    executionContext: () => null,
    executionOutputOverrides: () => ({}),
    fenceRegions: () => [],
    findSeparatorIndex: () => -1,
    isFrameworkFollowUpKind: () => false,
    parseParams: () => ({}),
    // The REAL session, composed here exactly as `runOnscreenTier1Turn` composes it, and
    // the REAL loop emits the events the recorder consumes.
    runTier1Turn: async (request) => {
      const session = createTier1Session({
        api: request.api,
        apiEndpoint: "https://api.openai.com/v1/chat/completions",
        executionContext: request.executionContext,
        initialMessages: request.initialMessages,
        isStopRequested: request.isStopRequested,
        model: "gpt-x",
        onEvent: request.onEvent,
        params: {},
        providerKey: "openai",
        sendCompletion: async () => {
          const next = queue.shift();

          if (!next) {
            return { text: "", toolCalls: [] };
          }

          if (next instanceof Error) {
            throw next;
          }

          return next;
        }
      });

      const result = await session.run({ isStopRequested: request.isStopRequested });

      return { result, session };
    },
    runtime: () => runtime,
    separator: "_____javascript",
    settings: () => ({
      apiEndpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: "test-key-not-real",
      model: "gpt-x",
      paramsText: ""
    }),
    shapeSystemPrompt: async ({ promptText }) => promptText,
    stopRequested: () => false,
    streamToolTurn: async ({ onDelta, onToolCallComplete }) => queue.shift() ?? { text: "", toolCalls: [] }
  };

  const driver = createTier1TurnDriver({ inputs, surface: createSurface() });
  const messages = wireMessages || [{ content: "hello", role: "user" }];
  const turn = await driver.runTier1ConversationTurn(messages, { messages }, { tier: "tier1" });

  return turn;
}

const REQUIRED_RECORD_FIELDS = [
  "durationMs",
  "iterations",
  "model",
  "outcome",
  "sessionId",
  "steps",
  "tier",
  "toolCount",
  "ts",
  "wireMessageCount"
];

// --- 1. the record shape ----------------------------------------------------

test("a settled turn record carries the documented shape and every required field", async () => {
  const records = [];
  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [{ text: "Hello there", toolCalls: [] }]
  });

  assert.equal(records.length, 1, "exactly one record per turn");

  const record = records[0];

  assert.deepEqual(
    Object.keys(record).sort(),
    [...REQUIRED_RECORD_FIELDS].sort(),
    "the serialized record holds exactly the documented fields -- no hidden start time, no raw event"
  );
  assert.equal(record.outcome, "answered");
  assert.equal(record.tier, "tier1");
  assert.equal(record.model, "gpt-x");
  assert.equal(record.wireMessageCount, 1);
  assert.equal(record.iterations, 1);
  assert.ok(Number.isInteger(record.durationMs) && record.durationMs >= 0);
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof record.sessionId, "string");
  assert.ok(record.sessionId.length > 0);
  assert.ok(record.toolCount > 0, "the model was offered the real registry tool list");
  assert.ok(Array.isArray(record.steps));

  // The session id is stable across the turns of one page session, which is what makes
  // two records readable as a sequence.
  const second = [];
  await runRealTurn({ onWrite: (value) => second.push(value), responses: [{ text: "Again", toolCalls: [] }] });
  assert.equal(second[0].sessionId, record.sessionId, "one session id per page session");
});

// --- 2. the step sequences --------------------------------------------------

test("a plain answer turn records exactly one assistant-turn step", async () => {
  const records = [];
  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [{ text: "Hello there", toolCalls: [] }]
  });

  const steps = records[0].steps;

  assert.deepEqual(
    steps.map((step) => step.type),
    ["assistant-turn"],
    "an answer turn is one assistant turn and nothing else -- no dispatch, no error"
  );
  assert.deepEqual(Object.keys(steps[0]).sort(), [
    "durationMs",
    "iteration",
    "textChars",
    "toolCallCount",
    "type"
  ]);
  assert.equal(steps[0].iteration, 0);
  assert.equal(steps[0].textChars, "Hello there".length, "a LENGTH, never the text");
  assert.equal(steps[0].toolCallCount, 0);
});

test("a tool turn records assistant-turn, dispatch, assistant-turn in order", async () => {
  const records = [];
  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [
      {
        text: "Let me look",
        toolCalls: [{ arguments: '{"path":"~/"}', id: "c1", name: "file_list" }]
      },
      { text: "All done", toolCalls: [] }
    ]
  });

  const record = records[0];

  assert.deepEqual(
    record.steps.map((step) => step.type),
    ["assistant-turn", "dispatch", "assistant-turn"],
    "the ordered sequence a real tool turn produces"
  );

  const dispatchStep = record.steps[1];

  assert.deepEqual(Object.keys(dispatchStep).sort(), [
    "argsBytes",
    "isError",
    "position",
    "resultBytes",
    "status",
    "tool",
    "type"
  ]);
  assert.equal(dispatchStep.tool, "file_list", "the tool NAME is recorded");
  assert.equal(dispatchStep.position, 0);
  assert.equal(dispatchStep.status, "ok");
  assert.equal(dispatchStep.isError, false);
  assert.ok(dispatchStep.argsBytes > 0, "a byte LENGTH, never the arguments");
  assert.ok(dispatchStep.resultBytes > 0, "a byte LENGTH, never the payload");
  assert.equal(record.iterations, 2);
  assert.equal(record.outcome, "answered");
});

test("a transport failure records a turn-error step and the error outcome", async () => {
  const records = [];
  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [new Error("provider went away")]
  });

  const record = records[0];

  assert.deepEqual(record.steps.map((step) => step.type), ["turn-error"]);
  assert.equal(record.outcome, "error", "the loop's own status is the logged outcome");
  assert.match(record.steps[0].message, /provider went away/);
});

test("a turn error message is truncated to 500 characters", async () => {
  const { turnLogStepFromEvent, TURN_LOG_MAX_ERROR_CHARS } = await import(
    "/modules/_core/framework/js/engine-swap/turn-log.js"
  );
  const long = "e".repeat(4000);
  const step = turnLogStepFromEvent({ error: new Error(long), iteration: 0, type: "turn-error" });

  assert.equal(TURN_LOG_MAX_ERROR_CHARS, 500);
  assert.equal(step.message.length, 500);
});

// --- 3. the privacy rule ----------------------------------------------------

test("no message content, argument value or result payload reaches the record", async () => {
  // Three DISTINCT markers so a failure names which thing leaked.
  const TEXT_MARKER = "ZMARKERreplytext9c1";
  const ARG_MARKER = "ZMARKERargumentvalue4f7";
  const RESULT_MARKER = "ZMARKERresultpayload2b3";
  const records = [];

  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [
      {
        text: `Looking now ${TEXT_MARKER}`,
        toolCalls: [
          { arguments: JSON.stringify({ path: `~/notes/${ARG_MARKER}.txt` }), id: "c1", name: "file_list" }
        ]
      },
      { text: `Finished ${TEXT_MARKER}`, toolCalls: [] }
    ],
    // The result payload the tool returns is where the third marker lives.
    api: {
      async fileList() {
        return { entries: [RESULT_MARKER] };
      },
      engineLogWrite(record) {
        records.push(record);

        return Promise.resolve({ ok: true, stored: 1 });
      }
    }
  });

  assert.equal(records.length, 1, "the turn really ran and produced a record");

  const serialized = JSON.stringify(records[0]);

  // This assertion is the reason the case exists: if a later change records `text`, the
  // assistant arguments, or the result content, one of these three goes red.
  assert.equal(serialized.includes(TEXT_MARKER), false, "model reply text must never be recorded");
  assert.equal(serialized.includes(ARG_MARKER), false, "tool argument values must never be recorded");
  assert.equal(serialized.includes(RESULT_MARKER), false, "tool result payloads must never be recorded");

  // And the sanitized log still says what happened, which is what makes it evidence.
  const record = records[0];

  assert.deepEqual(record.steps.map((step) => step.type), ["assistant-turn", "dispatch", "assistant-turn"]);
  assert.equal(record.steps[1].tool, "file_list");
  assert.ok(record.steps[1].argsBytes > ARG_MARKER.length, "the argument BYTE LENGTH is recorded");
  assert.ok(record.steps[0].textChars > TEXT_MARKER.length, "the reply CHARACTER COUNT is recorded");
});

// --- 4. the ring buffer -----------------------------------------------------

function createRecord(index) {
  return {
    durationMs: index,
    iterations: 1,
    model: "gpt-x",
    outcome: "answered",
    sessionId: `s-ring-${index}`,
    steps: [
      { durationMs: 1, iteration: 0, textChars: 3, toolCallCount: 0, type: "assistant-turn" }
    ],
    tier: "tier1",
    toolCount: 5,
    ts: new Date(1800000000000 + index).toISOString(),
    wireMessageCount: 1
  };
}

test("the ring buffer keeps exactly the last 500 records", async (testContext) => {
  const { MAX_TURN_LOG_RECORDS, get, post, resolveEngineLogPath } = await import(
    "../server/api/engine_log.js"
  );
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "space-engine-log-"));

  testContext.after(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  assert.equal(MAX_TURN_LOG_RECORDS, 500);

  // The REAL handler, through the REAL path resolution, into a hermetic tmpdir.
  for (let index = 0; index < 501; index += 1) {
    const result = await post({ body: createRecord(index), tmpDir });

    assert.equal(result.ok, true);
    assert.equal(result.stored, Math.min(index + 1, MAX_TURN_LOG_RECORDS));
  }

  const filePath = resolveEngineLogPath({ tmpDir });
  assert.equal(filePath, path.join(tmpDir, "engine-log", "turns.jsonl"), "the documented storage path");

  const contents = await readFile(filePath, "utf8");
  const lines = contents.split("\n").filter((line) => line.trim());

  assert.equal(lines.length, MAX_TURN_LOG_RECORDS, "501 appends leave exactly 500 records");

  const kept = lines.map((line) => JSON.parse(line));

  assert.equal(kept[0].sessionId, "s-ring-1", "the oldest record is gone");
  assert.equal(kept[kept.length - 1].sessionId, "s-ring-500", "the newest record survives");
  assert.equal(
    kept.some((record) => record.sessionId === "s-ring-0"),
    false,
    "the trimmed record is really absent, not merely unlisted"
  );

  // The read side sees the same window, newest last, capped by `limit`.
  const read = await get({ params: { limit: "3" }, tmpDir });

  assert.equal(read.ok, true);
  assert.equal(read.total, MAX_TURN_LOG_RECORDS);
  assert.deepEqual(
    read.records.map((record) => record.sessionId),
    ["s-ring-498", "s-ring-499", "s-ring-500"]
  );
});

test("a concurrent burst of appends still trims to exactly 500 records", async (testContext) => {
  const { MAX_TURN_LOG_RECORDS, get, post } = await import("../server/api/engine_log.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "space-engine-log-burst-"));

  testContext.after(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  // Issued WITHOUT awaiting each other: read-modify-write only stays correct because the
  // endpoint serializes through one chain.
  const writes = [];

  for (let index = 0; index < 510; index += 1) {
    writes.push(post({ body: createRecord(index), tmpDir }));
  }

  await Promise.all(writes);

  const read = await get({ params: { limit: String(MAX_TURN_LOG_RECORDS) }, tmpDir });

  assert.equal(read.total, MAX_TURN_LOG_RECORDS, "interleaved appends must not lose the trim");

  const ids = read.records.map((record) => Number(record.sessionId.replace("s-ring-", "")));

  assert.deepEqual(
    ids,
    Array.from({ length: MAX_TURN_LOG_RECORDS }, (_value, offset) => 10 + offset),
    "the survivors are the newest 500, in append order"
  );
});

// --- 5. the endpoint rejects a malformed payload ----------------------------

test("the endpoint rejects a malformed payload with 400 and stores nothing", async (testContext) => {
  const { get, post } = await import("../server/api/engine_log.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "space-engine-log-bad-"));

  testContext.after(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  const isBadRequest = (error) => {
    assert.equal(error.statusCode, 400, "a bad payload is a client error, not a 500");

    return true;
  };

  await assert.rejects(() => post({ body: null, tmpDir }), isBadRequest);
  await assert.rejects(() => post({ body: { steps: [] }, tmpDir }), isBadRequest);
  await assert.rejects(
    () => post({ body: { ...createRecord(1), outcome: "invented" }, tmpDir }),
    isBadRequest
  );
  await assert.rejects(() => post({ body: { ...createRecord(1), steps: "nope" }, tmpDir }), isBadRequest);
  await assert.rejects(
    () =>
      post({
        body: { ...createRecord(1), steps: [{ type: "made-up-step" }] },
        tmpDir
      }),
    isBadRequest
  );

  const read = await get({ tmpDir });

  assert.equal(read.total, 0, "nothing malformed reached the file");
});

test("the endpoint drops unknown keys instead of storing them", async (testContext) => {
  const { get, post } = await import("../server/api/engine_log.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "space-engine-log-extra-"));

  testContext.after(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  // A caller that smuggled conversation content into a record -- the failure mode that
  // would make the log unsafe to paste after some future edit -- is normalized away.
  const smuggled = {
    ...createRecord(7),
    leakedPrompt: "ZMARKERsmuggledprompt",
    steps: [{ ...createRecord(7).steps[0], leakedText: "ZMARKERsmuggledstep" }]
  };

  await post({ body: smuggled, tmpDir });

  const stored = await readFile(path.join(tmpDir, "engine-log", "turns.jsonl"), "utf8");

  assert.equal(stored.includes("ZMARKERsmuggledprompt"), false);
  assert.equal(stored.includes("ZMARKERsmuggledstep"), false);

  const read = await get({ tmpDir });

  assert.deepEqual(Object.keys(read.records[0]).sort(), [...REQUIRED_RECORD_FIELDS].sort());
});

// --- 6. a recorder failure cannot break a turn ------------------------------

test("a throwing engineLogWrite does not break the turn", async () => {
  const { createTier1TurnDriver } = await import(
    "/modules/_core/framework/js/engine-swap/turn-driver.js"
  );
  let attempted = 0;
  const api = {
    engineLogWrite() {
      attempted += 1;
      throw new Error("storage exploded");
    },
    async fileList() {
      return { entries: [] };
    }
  };

  const turn = await runRealTurn({
    api,
    responses: [{ text: "Hello there", toolCalls: [] }]
  });

  assert.equal(attempted, 1, "the recorder really tried, so the case is not vacuous");
  assert.equal(turn.result.answer, "Hello there");
  assert.equal(turn.result.status, "answered");
  assert.equal(typeof createTier1TurnDriver, "function");
});

test("a runtime without a space.api leaves the turn untouched", async () => {
  const turn = await runRealTurn({
    responses: [{ text: "Hello there", toolCalls: [] }],
    runtimeOverride: { api: null }
  });

  assert.equal(turn.result.answer, "Hello there");
  assert.equal(turn.result.status, "answered");
});

test("a rejected engineLogWrite promise never surfaces as an unhandled rejection", async () => {
  // The synchronous-throw case is covered above. This is the OTHER failure mode: the
  // client returns a promise that rejects (a 401, a dead server, a network drop), and an
  // uncaught rejection would be noise in the console at best and a crash on a stricter
  // host at worst. The recorder's own `.catch` is what absorbs it.
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);

  process.on("unhandledRejection", onRejection);

  try {
    let attempted = 0;
    const turn = await runRealTurn({
      api: {
        engineLogWrite() {
          attempted += 1;

          return Promise.reject(new Error("401 unauthorized"));
        },
        async fileList() {
          return { entries: [] };
        }
      },
      responses: [{ text: "Hello there", toolCalls: [] }]
    });

    // Let the microtask queue drain so a rejection would have been reported by now.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(attempted, 1, "the recorder really tried");
    assert.equal(turn.result.answer, "Hello there");
    assert.deepEqual(rejections, [], "a failed log post is absorbed, never left unhandled");
  } finally {
    process.removeListener("unhandledRejection", onRejection);
  }
});

// --- 7. the single vocabulary, and the inert import graph -------------------

test("the recorder's outcome vocabulary is the loop's own, value for value", async () => {
  const { TURN_LOG_OUTCOME } = await import(
    "/modules/_core/framework/js/engine-swap/turn-log.js"
  );
  const { TOOL_TURN_STOP_REASON } = await import(
    "/modules/_core/framework/js/engine-swap/tool-turn-loop.js"
  );

  // The recorder deliberately does not IMPORT the loop's constant: `turn-driver.js` is
  // statically loaded by both surface stores, so a loop import here would ship the whole
  // dispatch machinery to every session with the flag off. The mirror is asserted equal
  // instead, which keeps one vocabulary without the import.
  assert.deepEqual({ ...TURN_LOG_OUTCOME }, { ...TOOL_TURN_STOP_REASON });
});

test("the recorder leaf imports nothing, so a dispatch-OFF session stays inert", async () => {
  const source = await readFile(
    path.join(
      process.cwd(),
      "app/L0/_all/modules/_core/framework/js/engine-swap/turn-log.js"
    ),
    "utf8"
  );
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");

  const importLines = code.split("\n").filter((line) => /^\s*import\b/.test(line));

  assert.deepEqual(importLines, [], "a dependency-free leaf, by contract");
  // Self-check: the scanner can see an import when one exists.
  assert.equal(/^\s*import\b/m.test("import x from 'y';"), true);
});
