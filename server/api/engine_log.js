// ENGINE TURN LOG endpoint (P7-1).
//
// The browser records ONE bounded, content-free record per Tier 1 turn and posts it
// here so the owner can read the trail over HTTP instead of SSH-ing into a VM. Two
// deliberate properties:
//
//   AUTHENTICATED. This is real session data (timings, tool names, outcomes), so
//   `allowAnonymous` is false and the router's default protects it.
//
//   RING BUFFERED. Only the last `MAX_TURN_LOG_RECORDS` records survive. A log that
//   grows without bound on a long-lived appliance is a disk leak wearing a feature's
//   clothes. The trim is by LINE COUNT on the JSONL file, which is the same unit the
//   reader uses, so the two cannot disagree about where the log starts.

import fs from "node:fs/promises";
import path from "node:path";

import { SERVER_TMP_DIR } from "../config.js";
import { createHttpError } from "../lib/customware/file_access.js";

// Exported so the ring-buffer test asserts against the real constant instead of a
// second copy of the number.
export const MAX_TURN_LOG_RECORDS = 500;

export const TURN_LOG_LIMIT_DEFAULT = 50;

export const OUTCOMES = Object.freeze(["answered", "display-refused", "error", "held", "iteration-cap", "stopped"]);

// A turn appends TWO records sharing one `turnId`: a `started` snapshot written before the
// first model call, and the `finished` record written on completion. The JSONL ring buffer
// is append-only, so "update the record in place" is not an option this storage offers and
// a status field is how a start is expressed. The consequence is the feature: a turn that
// WEDGES never writes `finished`, so its `started` record is the whole trail.
export const STATUSES = Object.freeze(["finished", "started"]);

// The provider usage counts a finished record may carry. Every one is NULLABLE: a provider
// that reported nothing is `null` (unknown), which is NOT the same fact as zero tokens, and
// the endpoint rejects a value that cannot tell the two apart.
export const USAGE_COUNT_FIELDS = Object.freeze([
  "cachedTokens",
  "completionTokens",
  "createdCacheTokens",
  "promptTokens",
  "totalTokens"
]);

export const STEP_TYPES = Object.freeze([
  "assistant-turn",
  "dispatch",
  "display-claim-refused",
  "incomplete-arguments-refused",
  "turn-error"
]);

// Writes are per-turn and low frequency, but two turns can finish within the same
// event-loop turn on a fast provider, and read-modify-write only trims correctly if
// the reads and writes are ordered. A single promise chain is enough: no lock
// library, no per-file map, and a rejection cannot poison the chain because the tail
// is always replaced with a resolved promise.
let writeQueue = Promise.resolve();

function resolveLogDir(context) {
  const tmpDir = typeof context?.tmpDir === "string" && context.tmpDir.trim() ? context.tmpDir : SERVER_TMP_DIR;

  return path.join(tmpDir, "engine-log");
}

// Exported for the test: it needs the SAME path the handler uses, and re-deriving it
// there would let the two drift.
export function resolveEngineLogPath(context) {
  return path.join(resolveLogDir(context), "turns.jsonl");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function requireCount(value, field) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) {
    throw createHttpError(`Engine log record field \`${field}\` must be a non-negative number.`, 400);
  }

  return Math.trunc(Number(value));
}

function requireString(value, field) {
  if (typeof value !== "string") {
    throw createHttpError(`Engine log record field \`${field}\` must be a string.`, 400);
  }

  return value;
}

function requireStep(step, index) {
  if (!isPlainObject(step)) {
    throw createHttpError(`Engine log step ${index} must be an object.`, 400);
  }

  const type = requireString(step.type, `steps[${index}].type`);

  if (!STEP_TYPES.includes(type)) {
    throw createHttpError(`Engine log step ${index} has an unknown type: ${type || "(empty)"}.`, 400);
  }

  if (type === "assistant-turn") {
    return {
      durationMs: requireCount(step.durationMs, `steps[${index}].durationMs`),
      iteration: requireCount(step.iteration, `steps[${index}].iteration`),
      textChars: requireCount(step.textChars, `steps[${index}].textChars`),
      toolCallCount: requireCount(step.toolCallCount, `steps[${index}].toolCallCount`),
      type
    };
  }

  if (type === "dispatch") {
    return {
      argsBytes: requireCount(step.argsBytes, `steps[${index}].argsBytes`),
      isError: step.isError === true,
      position: requireCount(step.position, `steps[${index}].position`),
      resultBytes: requireCount(step.resultBytes, `steps[${index}].resultBytes`),
      status: requireString(step.status, `steps[${index}].status`),
      tool: requireString(step.tool, `steps[${index}].tool`),
      type
    };
  }

  if (type === "turn-error") {
    return {
      iteration: requireCount(step.iteration, `steps[${index}].iteration`),
      message: requireString(step.message, `steps[${index}].message`),
      type
    };
  }

  // BUG-008. Content-free like the incomplete-arguments step: a COUNT, never the
  // claim phrase or any message text.
  if (type === "display-claim-refused") {
    return {
      refusedCount: requireCount(step.refusedCount, `steps[${index}].refusedCount`),
      type
    };
  }

  return {
    incompleteCount: requireCount(step.incompleteCount, `steps[${index}].incompleteCount`),
    type
  };
}

// A usage count may be NULL. Null is the documented spelling of "the provider did not
// report this", and it must survive normalization as null: coercing it to 0 would store a
// measurement the provider never made, which is the defect this field exists to end.
function requireNullableCount(value, field) {
  if (value === null || value === undefined) {
    return null;
  }

  return requireCount(value, field);
}

// Usage is normalized to the documented key set, so an unknown key is dropped here for the
// same reason an unknown top-level key is: nothing reaches the file that this endpoint does
// not name. `null` in, `null` out.
function requireUsage(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isPlainObject(value)) {
    throw createHttpError("Engine log record field `usage` must be an object or null.", 400);
  }

  const usage = {
    modelCalls: requireCount(value.modelCalls ?? 0, "usage.modelCalls"),
    turnsWithUsage: requireCount(value.turnsWithUsage ?? 0, "usage.turnsWithUsage")
  };

  for (const field of USAGE_COUNT_FIELDS) {
    usage[field] = requireNullableCount(value[field], `usage.${field}`);
  }

  return usage;
}

// Validation RETURNS the normalized record rather than only judging it, so what gets
// written is the exact set of documented fields. A caller that smuggled an extra key
// into a record -- the failure mode that would let conversation content reach the
// file after a future edit -- has it dropped here, not trusted.
export function normalizeTurnLogRecord(body) {
  if (!isPlainObject(body)) {
    throw createHttpError("Engine log payload must be a JSON object.", 400);
  }

  const steps = body.steps === undefined ? [] : body.steps;

  if (!Array.isArray(steps)) {
    throw createHttpError("Engine log record field `steps` must be an array.", 400);
  }

  // Absent status means `finished`: a record written before this field existed is a
  // completed turn, and defaulting it here keeps such a record storable instead of
  // rejecting it for missing a field nobody had invented yet.
  const status = body.status === undefined ? "finished" : requireString(body.status, "status");

  if (!STATUSES.includes(status)) {
    throw createHttpError(`Engine log record has an unknown status: ${status || "(empty)"}.`, 400);
  }

  const outcome = requireString(body.outcome, "outcome");
  const usage = requireUsage(body.usage);

  if (status === "started") {
    // A START HAS NO OUTCOME AND NO USAGE YET, and accepting either would let a caller
    // store a finished-shaped record under a started label, which is the one thing this
    // field exists to make impossible to confuse.
    if (outcome !== "") {
      throw createHttpError("Engine log record with status `started` must carry an empty outcome.", 400);
    }

    if (usage !== null) {
      throw createHttpError("Engine log record with status `started` must not carry usage.", 400);
    }
  } else if (!OUTCOMES.includes(outcome)) {
    throw createHttpError(`Engine log record has an unknown outcome: ${outcome || "(empty)"}.`, 400);
  }

  return {
    durationMs: requireCount(body.durationMs, "durationMs"),
    iterations: requireCount(body.iterations, "iterations"),
    model: requireString(body.model, "model"),
    outcome,
    sessionId: requireString(body.sessionId, "sessionId"),
    status,
    steps: steps.map((step, index) => requireStep(step, index)),
    tier: requireString(body.tier, "tier"),
    toolCount: requireCount(body.toolCount, "toolCount"),
    ts: requireString(body.ts, "ts"),
    turnId: body.turnId === undefined ? "" : requireString(body.turnId, "turnId"),
    usage,
    wireMessageCount: requireCount(body.wireMessageCount, "wireMessageCount")
  };
}

async function readLines(filePath) {
  try {
    const contents = await fs.readFile(filePath, "utf8");

    return contents.split("\n").filter((line) => line.trim());
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function appendTurnLogRecord(context, record) {
  const filePath = resolveEngineLogPath(context);

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const lines = await readLines(filePath);

  lines.push(JSON.stringify(record));

  // Keep only the last N: the append is line-oriented, so the trim is line-oriented
  // too and the surface of a trim can never be a half-written record.
  const keptLines = lines.slice(-MAX_TURN_LOG_RECORDS);

  await fs.writeFile(filePath, `${keptLines.join("\n")}\n`, "utf8");

  return keptLines.length;
}

function enqueueWrite(task) {
  const run = writeQueue.then(task, task);

  writeQueue = run.then(
    () => undefined,
    () => undefined
  );

  return run;
}

export async function post(context) {
  const record = normalizeTurnLogRecord(context?.body);
  const stored = await enqueueWrite(() => appendTurnLogRecord(context, record));

  return { ok: true, stored };
}

export function readLimit(context) {
  const raw = context?.params?.limit ?? context?.body?.limit;
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return TURN_LOG_LIMIT_DEFAULT;
  }

  return Math.min(Math.trunc(parsed), MAX_TURN_LOG_RECORDS);
}

export async function get(context) {
  const limit = readLimit(context);
  const lines = await readLines(resolveEngineLogPath(context));
  const records = [];

  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn final line from a crash is skipped rather than failing the read: the
      // log exists to be readable when something already went wrong.
    }
  }

  return { ok: true, records, total: lines.length };
}
