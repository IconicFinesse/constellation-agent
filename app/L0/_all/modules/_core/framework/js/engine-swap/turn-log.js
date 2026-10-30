// THE ENGINE TURN LOG (P7-1). A per-turn record of what the NEW engine DID.
//
// WHY THIS IS NOT THE SHADOW RECORDER. `ca.shadow-diff/1` answers a COMPARISON
// question -- what would the old engine have done differently -- and `config-flag.js`
// deliberately suppresses it on a real Tier 1 turn, because a Tier 1 turn executes no
// Tier 3 blocks and an empty diff would read as a false pass. A Tier 1 turn becoming
// the DEFAULT therefore produces no trail at all. This module records the OTHER
// question: what did this turn actually do, step by step, so the owner can paste
// evidence when something breaks on a live VM. The shadow layer's semantics are
// untouched by it.
//
// DEPENDENCY-FREE BY CONTRACT. `turn-driver.js` is statically imported by both
// surface stores, so anything it imports statically ships to every session even with
// `ENGINE_SWAP_DISPATCH` off. This leaf imports NOTHING: no canonical shapes, no
// dispatch pipeline, no loop. It also does not import `TOOL_TURN_STOP_REASON`; the
// outcome vocabulary is mirrored below and a named test asserts the mirror equals the
// loop's real constant, so there is still exactly one vocabulary in the product while
// the import graph stays inert when dispatch is off.
//
// HARD PRIVACY RULE, and it is load-bearing: never record message content. No user
// prompts, no model reply text, no tool argument VALUES, no tool result payloads.
// Only counts, byte lengths, tool NAMES, outcome words, and the ONE bounded exception
// stated below.
//
// THE ONE EXCEPTION, written down rather than implied: `turn-error.message` carries a
// provider's OWN error text, and providers commonly echo the rejected input back inside
// a validation error (`invalid value for messages[0].content: "..."`). So up to
// TURN_LOG_MAX_ERROR_CHARS (500) characters of provider-supplied text -- which MAY
// contain request content -- can reach the record. It is bounded, it only appears when
// a turn already failed at the provider, and the owner pastes this log into a chat, so
// the honest scope is "content-free apart from one truncated provider error string".
// Everything else here is a count or a name.
//
// The event -> step mapping below is the ONE choke point where a raw event becomes a
// record entry, and it is the reason no other call site ever touches raw text.

export const TURN_LOG_MAX_ERROR_CHARS = 500;

// A turn leaves TWO records sharing ONE `turnId`: a `started` snapshot written BEFORE
// the first model call, and the `finished` record written on completion. The append-only
// JSONL ring buffer cannot update a record in place, so a status field is the honest way
// to express "this turn began" without inventing a second file or a second endpoint.
// The consequence is the point of the lane: a turn that WEDGES and never completes leaves
// its `started` record alone in the log, and a reader can tell started-without-finished
// from finished by pairing records on the id.
export const TURN_LOG_STATUS = Object.freeze({
  FINISHED: "finished",
  STARTED: "started"
});

// The provider usage counts this log carries, unchanged from the normalized record the
// engine already parses (`normalizeUsageBlock` in `stream-assembly.js`). Mirrored here
// rather than imported: see the module header. `tests/engine_swap_turn_log_test.mjs`
// drives both normalizers over one corpus and asserts they agree value for value, so the
// mirror cannot drift while the import graph stays inert.
export const TURN_LOG_USAGE_FIELDS = Object.freeze([
  "cachedTokens",
  "completionTokens",
  "createdCacheTokens",
  "promptTokens",
  "totalTokens"
]);

// Mirror of `TOOL_TURN_STOP_REASON` in `tool-turn-loop.js`. Deliberately NOT an
// import: see the module header. `tests/engine_swap_turn_log_test.mjs` asserts every
// value here equals the loop's constant, so the two cannot drift silently.
export const TURN_LOG_OUTCOME = Object.freeze({
  ANSWERED: "answered",
  ERROR: "error",
  HELD: "held",
  ITERATION_CAP: "iteration-cap",
  STOPPED: "stopped"
});

const KNOWN_OUTCOMES = new Set(Object.values(TURN_LOG_OUTCOME));

// The closed set of step types. An event whose type is not here produces NO step
// rather than an invented one: a log that records things it does not understand is
// worse than a log that says less.
export const TURN_LOG_STEP_TYPE = Object.freeze({
  ASSISTANT_TURN: "assistant-turn",
  DISPATCH: "dispatch",
  INCOMPLETE_ARGUMENTS_REFUSED: "incomplete-arguments-refused",
  TURN_ERROR: "turn-error"
});

const KNOWN_STEP_TYPES = new Set(Object.values(TURN_LOG_STEP_TYPE));

// Turn start times live OUTSIDE the record (a WeakMap, not a field) so the record
// that is serialized has exactly the documented schema at every moment. A hidden
// `startedAt` field would be one `delete` away from leaking into a pasted log; here
// it cannot leak because it is never a field.
const STARTED_AT = new WeakMap();

let pageSessionId = "";

// A short id per PAGE SESSION, generated once and stable across turns. Deliberately
// not a security token: it exists so two turns of one browser session can be read as
// a sequence, nothing more.
let sessionIdFallback = 0;

export function resolveTurnLogSessionId(explicitId = "") {
  const given = String(explicitId || "").trim();

  if (given) {
    return given;
  }

  if (!pageSessionId) {
    sessionIdFallback += 1;
    pageSessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  return pageSessionId;
}

// Byte length of a UTF-8 string, never the string itself. TextEncoder exists in both
// runtimes this module is driven from (browser and `node:test`); the fallback keeps a
// total function for an exotic host rather than throwing mid-turn.
function byteLengthOf(value) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);

  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function characterCountOf(value) {
  return typeof value === "string" ? value.length : value == null ? 0 : String(value).length;
}

function truncateError(value) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);

  return text.length > TURN_LOG_MAX_ERROR_CHARS ? text.slice(0, TURN_LOG_MAX_ERROR_CHARS) : text;
}

function toInteger(value) {
  const number = Number(value);

  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

export function isTurnLogOutcome(value) {
  return KNOWN_OUTCOMES.has(String(value || ""));
}

export function isTurnLogStatus(value) {
  return Object.values(TURN_LOG_STATUS).includes(String(value || ""));
}

// A short id per TURN, stable across its `started` and `finished` records. The counter is
// what makes two turns created inside the same millisecond distinguishable; the random
// suffix only keeps ids from two browser tabs of one page session apart. Deliberately not
// a security token and not derived from message content.
let turnCounter = 0;

export function createTurnLogTurnId(now = Date.now()) {
  turnCounter += 1;

  return `t-${toInteger(now).toString(36)}-${turnCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

// A count that is ALLOWED to be unknown. Distinct from `toInteger`, which coerces a
// missing value to 0: for token accounting that coercion is the defect this lane exists to
// fix, because "the provider reported nothing" and "the provider reported zero" are
// different facts and only one of them is a measurement.
function toNullableCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// THE per-turn usage summary, derived from the loop's own `turns[]` records -- the ONE
// place a model call's usage is stored (`tool-turn-loop.js`). A tool turn makes SEVERAL
// model calls, so the turn's cost is their SUM, never the last call's numbers alone.
//
// THE RULE: a total is only reported when every model call of the turn reported that
// field. One unknown part makes the total unknown (`null`), because summing the known
// parts would silently understate the turn and read as a measurement. `turnsWithUsage`
// and `modelCalls` are recorded so a reader can tell how complete the reading is without
// having to trust a boolean.
//
// `null` for the whole `usage` field means the provider said nothing at all. It never
// means zero.
export function summarizeTurnLogUsage(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const reported = list.filter((turn) => turn && typeof turn.usage === "object" && turn.usage !== null);

  if (!reported.length) {
    return null;
  }

  const summary = {
    modelCalls: list.length,
    turnsWithUsage: reported.length
  };

  const complete = reported.length === list.length;

  for (const field of TURN_LOG_USAGE_FIELDS) {
    const values = reported.map((turn) => toNullableCount(turn.usage[field]));

    summary[field] = complete && values.every((value) => value !== null)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  }

  return Object.freeze(summary);
}

// One live record per turn. Fields that are not known until the turn ends (`iterations`,
// `outcome`, the counts, the usage) start at an honest empty/zero/`null` and are filled by
// finalize. The record itself is NEVER emitted; `createTurnLogStartRecord` snapshots it.
export function createTurnLogRecord({
  model = "",
  sessionId = "",
  startedAt = Date.now(),
  tier = "",
  turnId = ""
} = {}) {
  const at = toInteger(startedAt) || Date.now();
  const record = {
    durationMs: 0,
    iterations: 0,
    model: String(model || ""),
    outcome: "",
    sessionId: resolveTurnLogSessionId(sessionId),
    status: TURN_LOG_STATUS.STARTED,
    steps: [],
    tier: String(tier || ""),
    toolCount: 0,
    ts: new Date(at).toISOString(),
    turnId: String(turnId || "") || createTurnLogTurnId(at),
    usage: null,
    wireMessageCount: 0
  };

  STARTED_AT.set(record, at);

  return record;
}

// The record a turn leaves BEHIND IF IT NEVER FINISHES. This is the whole point of the
// lane: the log used to write only on completion, so a wedged turn -- the most interesting
// turn there is -- left nothing anywhere. It is a fresh object with fresh arrays, not a
// reference to the live record, so a later step append into the live record cannot mutate
// the snapshot that was already handed to the writer.
//
// Only start-known facts travel: when it began, which tier/model it resolved, its session
// and its turn id. Everything measured during the turn stays zero/empty here and appears
// on the `finished` record that shares this id.
export function createTurnLogStartRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  return {
    durationMs: 0,
    iterations: 0,
    model: String(record.model || ""),
    outcome: "",
    sessionId: String(record.sessionId || ""),
    status: TURN_LOG_STATUS.STARTED,
    steps: [],
    tier: String(record.tier || ""),
    toolCount: 0,
    ts: String(record.ts || ""),
    turnId: String(record.turnId || ""),
    usage: null,
    wireMessageCount: 0
  };
}

export function appendTurnLogStep(record, step) {
  if (!record || !Array.isArray(record.steps) || !step || typeof step !== "object") {
    return record;
  }

  if (!KNOWN_STEP_TYPES.has(String(step.type || ""))) {
    return record;
  }

  record.steps.push(step);

  return record;
}

// The ONE event -> step mapping. Every field below is a count, a byte length, a tool
// NAME, an outcome word, or a truncated error string. There is deliberately no
// branch that can copy `event.text`, `event.call.arguments` or `event.result.content`
// into the record: the only thing read from each of them is its LENGTH.
export function turnLogStepFromEvent(event, { durationMs = 0 } = {}) {
  const type = String(event?.type || "");

  if (type === TURN_LOG_STEP_TYPE.ASSISTANT_TURN) {
    return {
      durationMs: toInteger(durationMs),
      iteration: toInteger(event?.iteration),
      textChars: characterCountOf(event?.text),
      toolCallCount: Array.isArray(event?.toolCalls) ? event.toolCalls.length : 0,
      type
    };
  }

  if (type === TURN_LOG_STEP_TYPE.DISPATCH) {
    return {
      argsBytes: byteLengthOf(event?.call?.arguments),
      isError: event?.result?.isError === true,
      position: toInteger(event?.position),
      resultBytes: byteLengthOf(event?.result?.content),
      status: String(event?.outcome?.status || ""),
      tool: String(event?.call?.name || ""),
      type
    };
  }

  if (type === TURN_LOG_STEP_TYPE.TURN_ERROR) {
    return {
      iteration: toInteger(event?.iteration),
      message: truncateError(event?.error?.message || event?.error),
      type
    };
  }

  if (type === TURN_LOG_STEP_TYPE.INCOMPLETE_ARGUMENTS_REFUSED) {
    return {
      incompleteCount: toInteger(event?.incompleteCount),
      type
    };
  }

  return null;
}

// Fills the record's closing fields. `iterations` is DERIVED from the steps that were
// actually observed rather than from a counter kept beside them, so the number the
// owner reads is the number of assistant turns in the log he is looking at.
export function finalizeTurnLogRecord(record, {
  endedAt = Date.now(),
  outcome = "",
  toolCount = 0,
  turns = [],
  wireMessageCount = 0
} = {}) {
  if (!record || typeof record !== "object") {
    return record;
  }

  const startedAt = STARTED_AT.get(record);

  record.durationMs = startedAt ? Math.max(0, toInteger(endedAt) - startedAt) : 0;
  record.iterations = Array.isArray(record.steps)
    ? record.steps.filter((step) => step?.type === TURN_LOG_STEP_TYPE.ASSISTANT_TURN).length
    : 0;
  record.outcome = isTurnLogOutcome(outcome) ? String(outcome) : TURN_LOG_OUTCOME.ERROR;
  record.status = TURN_LOG_STATUS.FINISHED;
  record.toolCount = toInteger(toolCount);
  // NULL when the provider reported nothing, a number when it did. Never coerced.
  record.usage = summarizeTurnLogUsage(turns);
  record.wireMessageCount = toInteger(wireMessageCount);

  return record;
}

// Fire-and-forget delivery through the surface runtime's api client. A logging
// failure can NEVER break or delay a chat turn: every failure mode here resolves,
// and the caller additionally wraps the call.
export function emitTurnLogRecord(record, { api = null } = {}) {
  if (!record) {
    return null;
  }

  try {
    const client = api || (typeof globalThis !== "undefined" ? globalThis.space?.api : null);

    if (!client || typeof client.engineLogWrite !== "function") {
      return null;
    }

    const pending = client.engineLogWrite(record);

    if (pending && typeof pending.catch === "function") {
      return pending.catch((error) => {
        try {
          console.warn("[engine-log] turn record was not stored.", error?.message || error);
        } catch {
          // Logging must never break a turn.
        }

        return null;
      });
    }

    return pending;
  } catch (error) {
    try {
      console.warn("[engine-log] turn record was not stored.", error?.message || error);
    } catch {
      // Logging must never break a turn.
    }

    return null;
  }
}
