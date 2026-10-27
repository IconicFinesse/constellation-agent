// Streaming tool-call assembly (plan §3.5, §7 P3).
//
// The P2 boundary was "tool turns are non-streamed because the reader drops
// tool_calls". This module is the missing half of the streaming reader: it
// accumulates argument FRAGMENTS per call index and only reports a call as
// dispatchable when its arguments are complete.
//
// Load-bearing rules (plan §3.5):
//   - fragments are strings until complete; nothing is parsed mid-flight, so a
//     partially delivered JSON object can never be validated, coerced or executed
//   - a call dispatches only when it is complete AND its argument JSON parses as
//     an object; a malformed COMPLETE payload is left to the dispatch pipeline's
//     validation stage (existing taxonomy), never repaired by guessing
//   - providers differ on whether `index` is present, so an id change starts a new
//     call when `index` is absent, and a bare fragment continues the current one
//
// Pure by construction: no I/O, no config, no clock. The surface's SSE reader
// feeds it deltas; the Tier 1 loop consumes `finish()`.

export const STREAM_ASSEMBLY_PROBLEM = Object.freeze({
  EMPTY_NAME: "empty-name",
  MALFORMED_ARGUMENTS: "malformed-arguments",
  TRUNCATED: "truncated-stream"
});

function normalizeFragment(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  // Some providers deliver a partial object instead of a string fragment. It is
  // stringified so the completeness rule stays one rule (JSON text), not two.
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

// True only for a complete, dispatchable argument payload. Empty text is complete
// (a no-argument call) because that is how providers spell one.
export function isCompleteToolArguments(text) {
  const raw = typeof text === "string" ? text : "";

  if (!raw.trim()) {
    return true;
  }

  try {
    const parsed = JSON.parse(raw);

    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

// One assembler per streamed turn. `applyPayload` is the convenient entry point
// for an OpenAI-shape SSE payload; `applyDelta` is the primitive.
export function createStreamingToolCallAssembler() {
  const calls = [];
  const byIndex = new Map();
  let text = "";
  let finishReason = "";
  let sawFinish = false;
  let sawAnyPayload = false;

  function recordFor(index, id) {
    const key = Number.isFinite(index) ? Number(index) : null;

    if (key !== null && byIndex.has(key)) {
      const existing = byIndex.get(key);

      if (id && !existing.id) {
        existing.id = id;
      }

      return existing;
    }

    // No usable index: a new id starts a new call, a bare fragment continues the
    // most recent one. This is what keeps interleaved parallel calls apart without
    // inventing an index the provider never sent.
    if (key === null) {
      const last = calls[calls.length - 1];

      if (last && (!id || id === last.id)) {
        if (id && !last.id) {
          last.id = id;
        }

        return last;
      }
    }

    const record = {
      argumentsText: "",
      id: id || "",
      index: key === null ? calls.length : key,
      name: ""
    };

    calls.push(record);
    byIndex.set(record.index, record);

    return record;
  }

  function applyToolCallDelta(delta) {
    if (!delta || typeof delta !== "object") {
      return;
    }

    const index = Number.isFinite(delta.index) ? Number(delta.index) : null;
    const id = typeof delta.id === "string" ? delta.id.trim() : "";
    const record = recordFor(index, id);
    const name = normalizeFragment(delta?.function?.name);

    if (name) {
      record.name += name;
    }

    record.argumentsText += normalizeFragment(delta?.function?.arguments);
  }

  return Object.freeze({
    // OpenAI-shape delta: `{ content, tool_calls: [{ index, id, function }] }`.
    applyDelta(delta) {
      if (!delta || typeof delta !== "object") {
        return;
      }

      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
      }

      (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).forEach(applyToolCallDelta);
    },

    // One SSE payload. Text and tool-call fragments are handled together because
    // providers interleave them in a single choice delta.
    applyPayload(payload) {
      const choice = payload?.choices?.[0];

      if (!choice) {
        return;
      }

      sawAnyPayload = true;

      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        finishReason = choice.finish_reason;
        sawFinish = true;
      }

      this.applyDelta(choice.delta || choice.message || {});
    },

    // The assembled result. Only `finish()` decides completeness; a caller cannot
    // accidentally ask mid-stream.
    //
    // Truncation is decided from POSITIVE evidence only, never from a missing end
    // marker: providers differ on whether they emit `finish_reason` or `[DONE]`,
    // and a normally-finished body is not a cut stream. The two signals that do
    // prove a cut are an abort the transport reports and `finish_reason: "length"`
    // (the provider itself saying it stopped mid-output). Everything else is
    // judged by the argument text itself, which is the actual dispatch criterion.
    finish({ truncated = false } = {}) {
      const cutShort = truncated === true || finishReason === "length";

      return Object.freeze({
        finishReason,
        text,
        truncated: cutShort,
        toolCalls: Object.freeze(
          calls.map((call, position) =>
            Object.freeze({
              arguments: call.argumentsText,
              argumentsComplete:
                !cutShort && isCompleteToolArguments(call.argumentsText) && Boolean(call.name.trim()),
              id: call.id || `call_${position}`,
              index: call.index,
              name: call.name.trim(),
              problem: cutShort
                ? STREAM_ASSEMBLY_PROBLEM.TRUNCATED
                : !call.name.trim()
                  ? STREAM_ASSEMBLY_PROBLEM.EMPTY_NAME
                  : isCompleteToolArguments(call.argumentsText)
                    ? ""
                    : STREAM_ASSEMBLY_PROBLEM.MALFORMED_ARGUMENTS
            })
          )
        )
      });
    },

    get sawAnyPayload() {
      return sawAnyPayload;
    },

    get text() {
      return text;
    }
  });
}

// Convenience for tests and for a caller that already has the whole delta list.
export function assembleToolCallsFromDeltas(deltas, options = {}) {
  const assembler = createStreamingToolCallAssembler();

  (Array.isArray(deltas) ? deltas : []).forEach((delta) => assembler.applyDelta(delta));

  return assembler.finish(options);
}
