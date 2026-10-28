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

export const OUTCOMES = Object.freeze(["answered", "error", "held", "iteration-cap", "stopped"]);

export const STEP_TYPES = Object.freeze([
  "assistant-turn",
  "dispatch",
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

  return {
    incompleteCount: requireCount(step.incompleteCount, `steps[${index}].incompleteCount`),
    type
  };
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

  const outcome = requireString(body.outcome, "outcome");

  if (!OUTCOMES.includes(outcome)) {
    throw createHttpError(`Engine log record has an unknown outcome: ${outcome || "(empty)"}.`, 400);
  }

  return {
    durationMs: requireCount(body.durationMs, "durationMs"),
    iterations: requireCount(body.iterations, "iterations"),
    model: requireString(body.model, "model"),
    outcome,
    sessionId: requireString(body.sessionId, "sessionId"),
    steps: steps.map((step, index) => requireStep(step, index)),
    tier: requireString(body.tier, "tier"),
    toolCount: requireCount(body.toolCount, "toolCount"),
    ts: requireString(body.ts, "ts"),
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
