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

// A turn appends TWO records that share one `turnId`: the `started` snapshot written before
// the first model call and the `finished` record written on completion. Both carry the same
// thirteen fields, so one manifest pins both shapes -- a start record that quietly grew a
// field the finished record lacks would be a shape drift the owner reads as a different
// thing.
const REQUIRED_RECORD_FIELDS = [
  "durationMs",
  "iterations",
  "model",
  "outcome",
  "sessionId",
  "status",
  "steps",
  "tier",
  "toolCount",
  "ts",
  "turnId",
  "usage",
  "wireMessageCount"
];

// The writes one REAL turn produces, split by the status the server stores. Reading them
// through this helper keeps every case honest about which record it is asserting on instead
// of indexing `records[0]` and quietly changing meaning when the design moved.
function recordsByStatus(records, status) {
  return records.filter((record) => record?.status === status);
}

function startedRecordOf(records) {
  const started = recordsByStatus(records, "started");

  assert.equal(started.length, 1, "exactly one started record per turn");

  return started[0];
}

function finishedRecordOf(records) {
  const finished = recordsByStatus(records, "finished");

  assert.equal(finished.length, 1, "exactly one finished record per turn");

  return finished[0];
}

// --- 1. the record shape ----------------------------------------------------

test("a settled turn record carries the documented shape and every required field", async () => {
  const records = [];
  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [{ text: "Hello there", toolCalls: [] }]
  });

  assert.deepEqual(
    records.map((record) => record.status),
    ["started", "finished"],
    "one turn appends a started record BEFORE the completion record, in that order"
  );

  const started = startedRecordOf(records);
  const record = finishedRecordOf(records);

  // ONE manifest for both shapes: a start record that quietly grew a field the finished
  // record lacks would read as a different artefact rather than the same turn earlier.
  for (const candidate of [started, record]) {
    assert.deepEqual(
      Object.keys(candidate).sort(),
      [...REQUIRED_RECORD_FIELDS].sort(),
      "the serialized record holds exactly the documented fields -- no hidden start time, no raw event"
    );
  }

  // What a START can honestly know: identity and when. Nothing measured yet.
  assert.equal(started.outcome, "", "a start has no outcome yet");
  assert.equal(started.usage, null, "a start has no usage yet");
  assert.deepEqual(started.steps, [], "a start has recorded no steps yet");
  assert.equal(started.iterations, 0);
  assert.equal(started.turnId, record.turnId, "start and finish share ONE turn id");
  assert.equal(started.sessionId, record.sessionId);
  assert.equal(started.tier, "tier1");
  assert.equal(started.model, "gpt-x");
  assert.equal(started.ts, record.ts, "both records name the same start instant");
  assert.equal(record.outcome, "answered");
  assert.equal(record.turnId.length > 0, true, "a turn id is always present");
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

  const steps = finishedRecordOf(records).steps;

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

  const record = finishedRecordOf(records);

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

  const record = finishedRecordOf(records);

  assert.deepEqual(record.steps.map((step) => step.type), ["turn-error"]);
  assert.equal(record.outcome, "error", "the loop's own status is the logged outcome");
  // A turn that failed at the provider still leaves BOTH records, so the pair reads as
  // "started, then errored" rather than as a turn that never happened.
  assert.equal(startedRecordOf(records).turnId, record.turnId);
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

  assert.equal(records.length, 2, "the turn really ran and produced both records");

  // BOTH records are serialized into one string: a leak into the start record would be as
  // damaging as a leak into the finished one, and asserting only the completion record
  // would leave the newer write path unexamined.
  const serialized = records.map((record) => JSON.stringify(record)).join("\n");

  // This assertion is the reason the case exists: if a later change records `text`, the
  // assistant arguments, or the result content, one of these three goes red. The usage
  // numbers this lane added are counts, so they cannot carry any of them.
  assert.equal(serialized.includes(TEXT_MARKER), false, "model reply text must never be recorded");
  assert.equal(serialized.includes(ARG_MARKER), false, "tool argument values must never be recorded");
  assert.equal(serialized.includes(RESULT_MARKER), false, "tool result payloads must never be recorded");

  // And the sanitized log still says what happened, which is what makes it evidence.
  const record = finishedRecordOf(records);

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

  // TWO attempts, because a turn writes its START record before the first model call and
  // its completion record after: a recorder that only survived the second would break the
  // first model call of every turn.
  assert.equal(attempted, 2, "the recorder really tried, so the case is not vacuous");
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

    // Both records are attempted (start + finish), and BOTH rejections must be absorbed.
    assert.equal(attempted, 2, "the recorder really tried");
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

test("the recorder's usage normalizer agrees with the engine's, value for value", async () => {
  const { summarizeTurnLogUsage, TURN_LOG_USAGE_FIELDS } = await import(
    "/modules/_core/framework/js/engine-swap/turn-log.js"
  );
  const { normalizeUsageBlock } = await import(
    "/modules/_core/framework/js/engine-swap/stream-assembly.js"
  );

  // The recorder cannot IMPORT `stream-assembly.js` (see the leaf contract), so the usage
  // counts are a MIRROR. A mirror that drifts silently would log a number the engine never
  // parsed, so this drives BOTH normalizers over one corpus and compares them field by
  // field -- the same discipline the outcome mirror gets.
  const corpus = [
    {
      completion_tokens: 7,
      created_cache_tokens: 2,
      prompt_tokens: 11,
      prompt_tokens_details: { cached_tokens: 3 },
      total_tokens: 18
    },
    // The NeuralWatt cold-call shape: details present but literal null -> UNKNOWN.
    { completion_tokens: 4, prompt_tokens: 40, prompt_tokens_details: null, total_tokens: 44 },
    // Older provider shape: no details key at all, also UNKNOWN.
    { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
    // A GENUINE miss: details present with a zero, which must stay 0, not null.
    { completion_tokens: 1, prompt_tokens: 2, prompt_tokens_details: { cached_tokens: 0 }, total_tokens: 3 }
  ];

  for (const block of corpus) {
    const engine = normalizeUsageBlock({ usage: block });
    // One call reporting this block: a per-turn summary of a single call IS that call's
    // numbers, which makes the two comparable without a second summing rule.
    const recorder = summarizeTurnLogUsage([{ usage: engine }]);

    for (const field of TURN_LOG_USAGE_FIELDS) {
      assert.equal(
        recorder[field],
        engine[field],
        `field ${field} disagrees for ${JSON.stringify(block)}`
      );
    }
  }

  // The differential CAN see a difference: a seeded wrong count must not compare equal.
  const engine = normalizeUsageBlock({ usage: corpus[0] });

  assert.notEqual(engine.totalTokens, 999);
  // And the corpus really exercises the 0-vs-null distinction, or the comparison above is
  // weaker than it claims.
  assert.equal(normalizeUsageBlock({ usage: corpus[3] }).cachedTokens, 0, "a real miss stays 0");
  assert.equal(normalizeUsageBlock({ usage: corpus[2] }).cachedTokens, null, "an absent block stays null");
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

// --- 8. TURN STARTS (the wedge defect) --------------------------------------
//
// The defect this section exists for: the log only wrote on COMPLETION, so a turn that
// hung forever -- the live beta wedge, 43 requests and no hanging response -- left zero
// record anywhere. A start record written BEFORE the first model call is the fix, and
// 'a turn that never completes still leaves one' is the case that proves it.

// A driver with just enough surface/runtime to open and close a turn log, so the wedge
// case drives the REAL recorder without a transport to hang.
async function createLogOnlyDriver({ api = null } = {}) {
  const { createTier1TurnDriver } = await import(
    "/modules/_core/framework/js/engine-swap/turn-driver.js"
  );

  return createTier1TurnDriver({
    inputs: { runtime: () => ({ api }) },
    surface: createSurface()
  });
}

test("a start record is written before any completion, carrying a stable turn id", async () => {
  const records = [];
  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [{ text: "Hello there", toolCalls: [] }]
  });

  // ORDER is part of the contract: the start is appended first, so a reader scrolling the
  // JSONL sees the turn begin before it ends.
  assert.equal(records[0].status, "started");
  assert.equal(records[1].status, "finished");
  assert.equal(typeof records[0].turnId, "string");
  assert.ok(records[0].turnId.length > 0, "the start names the turn");
  assert.equal(records[0].turnId, records[1].turnId, "start and finish are linkable by id");
  assert.equal(records[0].tier, "tier1", "the start names the tier it resolved");
  assert.equal(records[0].model, "gpt-x", "the start names the engine it resolved");
});

test("two turns of one session get DIFFERENT turn ids", async () => {
  const first = [];
  const second = [];

  await runRealTurn({ onWrite: (record) => first.push(record), responses: [{ text: "one", toolCalls: [] }] });
  await runRealTurn({ onWrite: (record) => second.push(record), responses: [{ text: "two", toolCalls: [] }] });

  assert.equal(first[0].sessionId, second[0].sessionId, "one page session");
  assert.notEqual(first[0].turnId, second[0].turnId, "but two distinct turns");
});

test("a turn that NEVER completes still leaves its start record", async () => {
  const records = [];
  const api = {
    engineLogWrite(record) {
      records.push(record);

      return Promise.resolve({ ok: true, stored: records.length });
    }
  };
  const driver = await createLogOnlyDriver({ api });

  // The wedge, simulated exactly: the turn opens and then nothing ever finalizes it. This
  // is the whole defect -- before this lane the log held NOTHING for such a turn.
  driver.beginEngineTurnLog({ model: "gpt-x", tier: "tier1" });

  assert.equal(records.length, 1, "the wedged turn left exactly one record");
  assert.equal(records[0].status, "started", "and it says the turn BEGAN");
  assert.ok(records[0].turnId.length > 0);
  assert.equal(records[0].model, "gpt-x");
  assert.equal(records[0].tier, "tier1");
  assert.match(records[0].ts, /^\d{4}-\d{2}-\d{2}T/, "it names WHEN it began, which is the point");

  // No finished record exists for it, so a reader pairing by id sees started-without-
  // finished -- the honest signature of a wedge.
  assert.equal(records.some((record) => record.status === "finished"), false);
});

test("the start record is a SNAPSHOT, so later turn activity cannot rewrite what was sent", async () => {
  const records = [];
  const api = {
    engineLogWrite(record) {
      records.push(record);

      return Promise.resolve({ ok: true, stored: records.length });
    }
  };
  const driver = await createLogOnlyDriver({ api });

  driver.beginEngineTurnLog({ model: "gpt-x", tier: "tier1" });
  // A step recorded AFTER the start was handed to the writer must not appear in it: an
  // aliased record would be rewritten in the caller's hands.
  driver.recordEngineTurnLogEvent({ iteration: 0, text: "hello", toolCalls: [], type: "assistant-turn" });

  const sent = records[0];

  assert.deepEqual(sent.steps, [], "the emitted start record kept its own empty step list");
  assert.equal(sent.iterations, 0);
  // And the live record really did see the step, so the assertion is not vacuous.
  const finished = driver.finishEngineTurnLog({ outcome: "answered", wireMessageCount: 1 });

  assert.equal(finished.steps.length, 1, "the live record accumulated the step");
  assert.equal(finished.turnId, sent.turnId);
});

// --- 9. TOKEN USAGE ---------------------------------------------------------
//
// Cost was unmeasurable: the engine parsed the provider usage block and formatted a
// console cache line, but nothing persisted it. These cases pin the persistence AND the
// absent-vs-zero rule, which is the load-bearing half -- a provider that reports nothing
// is not reporting zero, and storing 0 would fabricate a measurement.

function usageResponse({ content = "done", usage = null, toolCalls = [] } = {}) {
  const payload = {
    choices: [
      {
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
        message: {
          content,
          // The RAW wire shape: a provider completion names a call as
          // `{ id, function: { name, arguments } }`. The assembled stream shape uses
          // `{ id, name, arguments }` instead, which is why the two are never mixed here.
          ...(toolCalls.length
            ? {
                tool_calls: toolCalls.map((call) => ({
                  function: { arguments: call.arguments, name: call.name },
                  id: call.id,
                  type: "function"
                }))
              }
            : {})
        }
      }
    ]
  };

  return usage ? { ...payload, usage } : payload;
}

test("usage is persisted with the provider's exact counts", async () => {
  const records = [];

  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [
      usageResponse({
        usage: {
          completion_tokens: 7,
          created_cache_tokens: 2,
          prompt_tokens: 11,
          prompt_tokens_details: { cached_tokens: 3 },
          total_tokens: 18
        }
      })
    ]
  });

  const record = finishedRecordOf(records);

  assert.deepEqual(record.usage, {
    cachedTokens: 3,
    completionTokens: 7,
    createdCacheTokens: 2,
    modelCalls: 1,
    promptTokens: 11,
    totalTokens: 18,
    turnsWithUsage: 1
  });
  // The start record cannot know usage yet, and says so rather than guessing.
  assert.equal(startedRecordOf(records).usage, null);
});

test("a tool turn SUMS usage across its model calls instead of reporting the last one", async () => {
  const records = [];

  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [
      usageResponse({
        content: "Looking",
        toolCalls: [{ arguments: '{"path":"~/"}', id: "c1", name: "file_list" }],
        usage: { completion_tokens: 5, prompt_tokens: 100, total_tokens: 105 }
      }),
      usageResponse({
        content: "Done",
        usage: { completion_tokens: 9, prompt_tokens: 250, total_tokens: 259 }
      })
    ]
  });

  const record = finishedRecordOf(records);

  assert.equal(record.iterations, 2, "two model calls really happened");
  assert.equal(record.usage.modelCalls, 2);
  assert.equal(record.usage.turnsWithUsage, 2);
  assert.equal(record.usage.promptTokens, 350, "the turn's cost is the sum of its calls");
  assert.equal(record.usage.completionTokens, 14);
  assert.equal(record.usage.totalTokens, 364);
  // Both calls omitted the cache details, so cached is UNKNOWN for the turn -- not zero.
  assert.equal(record.usage.cachedTokens, null, "unknown survives the sum");
});

test("usage is NULL when the provider reported none -- never zero", async () => {
  const records = [];

  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [usageResponse({ content: "no usage block here" })]
  });

  const record = finishedRecordOf(records);

  assert.equal(record.usage, null, "absent usage is recorded as absent");
  // THE ASSERTION THAT MATTERS: `0` would claim the provider measured a free turn.
  assert.notEqual(record.usage, 0);
  assert.equal(JSON.stringify(record).includes('"usage":0'), false);
  assert.equal(JSON.stringify(record).includes('"usage":null'), true, "serialized as an explicit null");
});

test("a turn that DIES before returning a result records usage as null", async () => {
  const records = [];

  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [new Error("provider went away")]
  });

  const record = finishedRecordOf(records);

  assert.equal(record.outcome, "error");
  assert.equal(record.usage, null, "a turn that never reported is unknown, not free");
});

test("an unknown SETTING inside a reported block makes only that total unknown", async () => {
  const records = [];

  await runRealTurn({
    onWrite: (record) => records.push(record),
    responses: [
      // NeuralWatt's cold-call shape: `prompt_tokens_details` present but literal null.
      usageResponse({
        usage: {
          completion_tokens: 4,
          prompt_tokens: 40,
          prompt_tokens_details: null,
          total_tokens: 44
        }
      })
    ]
  });

  const record = finishedRecordOf(records);

  assert.equal(record.usage.cachedTokens, null, "null details means UNKNOWN cache, not 0");
  assert.equal(record.usage.promptTokens, 40, "the counts the provider DID report survive");
});

// --- 10. the endpoint stores the new fields faithfully ----------------------

test("the endpoint stores status, turnId and usage, and preserves null as null", async (testContext) => {
  const { get, post } = await import("../server/api/engine_log.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "space-engine-log-usage-"));

  testContext.after(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  const started = { ...createRecord(1), outcome: "", status: "started", turnId: "t-1", usage: null };
  const finished = {
    ...createRecord(2),
    status: "finished",
    turnId: "t-1",
    usage: {
      cachedTokens: null,
      completionTokens: 7,
      createdCacheTokens: 2,
      modelCalls: 1,
      promptTokens: 11,
      totalTokens: 18,
      turnsWithUsage: 1
    }
  };

  await post({ body: started, tmpDir });
  await post({ body: finished, tmpDir });

  const read = await get({ tmpDir });

  assert.equal(read.records.length, 2);
  assert.equal(read.records[0].status, "started");
  assert.equal(read.records[0].turnId, "t-1");
  assert.equal(read.records[0].usage, null);
  assert.equal(read.records[1].status, "finished");
  assert.equal(read.records[1].turnId, "t-1", "the pair survives the round trip as a pair");
  assert.equal(read.records[1].usage.cachedTokens, null, "an unknown count is still unknown after storage");
  assert.equal(read.records[1].usage.totalTokens, 18);
  // Null would be coerced to 0 by a careless normalizer; assert the distinction explicitly.
  assert.notEqual(read.records[1].usage.cachedTokens, 0);
});

test("the endpoint refuses a started record that carries an outcome or usage", async (testContext) => {
  const { post } = await import("../server/api/engine_log.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "space-engine-log-badstart-"));

  testContext.after(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  const isBadRequest = (error) => {
    assert.equal(error.statusCode, 400);

    return true;
  };

  // A finished-shaped record wearing a started label is exactly the confusion the status
  // field exists to prevent, so both halves are rejected.
  await assert.rejects(
    () => post({ body: { ...createRecord(1), status: "started" }, tmpDir }),
    isBadRequest
  );
  await assert.rejects(
    () =>
      post({
        body: { ...createRecord(1), outcome: "", status: "started", usage: { promptTokens: 1 } },
        tmpDir
      }),
    isBadRequest
  );
});

test("the endpoint drops unknown USAGE keys instead of storing them", async (testContext) => {
  const { get, post } = await import("../server/api/engine_log.js");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "space-engine-log-usage-extra-"));

  testContext.after(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  // The privacy rule reaches the new field too: a usage object is not a hiding place.
  await post({
    body: {
      ...createRecord(3),
      usage: { promptTokens: 5, smuggledPrompt: "ZMARKERusageprompt" }
    },
    tmpDir
  });

  const stored = await readFile(path.join(tmpDir, "engine-log", "turns.jsonl"), "utf8");

  assert.equal(stored.includes("ZMARKERusageprompt"), false);
  assert.equal(JSON.parse(stored.trim()).usage.smuggledPrompt, undefined);
});
