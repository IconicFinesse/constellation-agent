// The Tier 1 turn loop (plan §3.5): the model is offered typed tools, its calls
// flow through the shared dispatch pipeline, results return as structured tool
// messages, and the loop runs until the model answers in plain text.
//
// What this module owns:
//   - the loop shape and its termination conditions
//   - the iteration cap and repeat-error surfacing carried over from v1.2
//   - the P2 policy that several calls in one turn are refused with coaching
//     (sequential dispatch arrives in P3; the refusal is honest, not a crash)
//   - assembling the next request's message list from canonical messages
//
// What it deliberately does NOT own:
//   - the HTTP call. `sendTurn` is injected, so the shared layer stays free of
//     fetches, keys, and surface transport decisions, and tests drive the loop
//     with a scripted sender.
//   - rendering. The surface observes the loop through `onEvent`.
//
// Every exit is guaranteed: plain-text answer, iteration cap, stop request,
// transport failure, or a held destructive call waiting for consent. There is no
// path that spins.

import {
  createAssistantTextMessage,
  createAssistantToolCallMessage,
  createToolResultMessage
} from "./canonical.js";
import { DISPATCH_OUTCOME, formatToolResultForModel } from "./dispatch-pipeline.js";
import { formatHeldToolResult } from "./destructive-gate.js";

export const TOOL_TURN_MAX_ITERATIONS = 12;

export const TOOL_TURN_STOP_REASON = Object.freeze({
  ANSWERED: "answered",
  ERROR: "error",
  HELD: "held",
  ITERATION_CAP: "iteration-cap",
  STOPPED: "stopped"
});

// Multiple calls in one turn are refused in P2: dispatch is strictly sequential
// and P3 owns assembling several complete calls safely. The coaching text tells
// the model exactly what to do instead.
export function formatParallelCallsPolicyHint(count) {
  return [
    `policy: ${count} tool calls arrived in one turn; this session dispatches exactly one call per turn.`,
    "Retry with the first call alone. When its result arrives, send the next call in the following turn."
  ].join("\n");
}

// Repeat-error surfacing, re-expressed over tool results instead of text blocks.
// Same intent as v1.2: the model must see that it is looping.
export function buildRepeatErrorNote(count) {
  if (!Number.isFinite(count) || count < 2) {
    return "";
  }

  return `note: this exact tool error has now occurred ${count} times in a row. Change approach instead of repeating the call.`;
}

// Tracks identical consecutive tool-error texts. Returns the new signature and
// count; any clean turn or changed error resets the count to 1.
export function trackToolErrorRepeat(errorTexts, previousSignature = "", previousCount = 0) {
  const list = (Array.isArray(errorTexts) ? errorTexts : []).map((text) => String(text || "").trim()).filter(Boolean);

  if (!list.length) {
    return Object.freeze({ count: 0, signature: "" });
  }

  const signature = list.join("\n").slice(0, 400);

  if (signature === previousSignature) {
    return Object.freeze({ count: previousCount + 1, signature });
  }

  return Object.freeze({ count: 1, signature });
}

// One Tier 1 conversation turn. `sendTurn` is the surface's non-streamed
// completion call: it receives canonical messages + the visible tool list and
// resolves `{ text, toolCalls }` where each tool call carries the provider's raw
// arguments string.
//
export async function runToolTurn({
  dispatch, // { dispatchToolCall, executeConfirmedHold }
  history = [], // canonical messages already prepared for the first request
  isStopRequested = () => false,
  maxIterations = TOOL_TURN_MAX_ITERATIONS,
  onEvent = null,
  sendTurn,
  tools = []
} = {}) {
  if (typeof sendTurn !== "function") {
    throw new Error("runToolTurn requires a sendTurn function.");
  }

  if (!dispatch || typeof dispatch.dispatchToolCall !== "function") {
    throw new Error("runToolTurn requires the dispatch pipeline.");
  }

  const messages = [...(Array.isArray(history) ? history : [])];
  let lastErrorSignature = "";
  let lastErrorCount = 0;
  const turns = [];

  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {
      // Observation must never break the loop.
    }
  };

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (isStopRequested()) {
      return Object.freeze({ messages: Object.freeze(messages), reason: TOOL_TURN_STOP_REASON.STOPPED, turns: Object.freeze(turns) });
    }

    let response;

    try {
      response = await sendTurn({
        iteration,
        messages: Object.freeze([...messages]),
        tools
      });
    } catch (error) {
      emit({ error, iteration, type: "turn-error" });

      return Object.freeze({
        error: String(error?.message || error),
        messages: Object.freeze(messages),
        reason: TOOL_TURN_STOP_REASON.ERROR,
        turns: Object.freeze(turns)
      });
    }

    const text = typeof response?.text === "string" ? response.text : "";
    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];

    turns.push(Object.freeze({ iteration, text, toolCallCount: toolCalls.length }));
    emit({ iteration, text, toolCalls, type: "assistant-turn" });

    // No calls: this is the plain-text answer, and the loop is done.
    if (!toolCalls.length) {
      if (text.trim()) {
        messages.push(createAssistantTextMessage(text));
      }

      return Object.freeze({
        answer: text,
        messages: Object.freeze(messages),
        reason: TOOL_TURN_STOP_REASON.ANSWERED,
        turns: Object.freeze(turns)
      });
    }

    // Several calls in one turn: P2 refuses with coaching. Nothing executes.
    if (toolCalls.length > 1) {
      const coaching = formatParallelCallsPolicyHint(toolCalls.length);
      const syntheticCall = { arguments: {}, callId: toolCalls[0]?.id || "", name: toolCalls[0]?.name || "" };

      messages.push(
        createAssistantToolCallMessage({
          content: text,
          toolCalls: toolCalls.map((call) => ({
            arguments: typeof call.arguments === "string" && call.arguments.trim() ? call.arguments : "{}",
            id: call.id,
            name: call.name
          }))
        })
      );
      messages.push(
        createToolResultMessage({
          content: coaching,
          isError: true,
          toolCallId: syntheticCall.callId || toolCalls[0]?.id || "call_parallel"
        })
      );
      emit({ coaching, toolCalls, type: "parallel-refused" });

      const repeat = trackToolErrorRepeat([coaching], lastErrorSignature, lastErrorCount);
      lastErrorSignature = repeat.signature;
      lastErrorCount = repeat.count;

      continue;
    }

    const call = toolCalls[0];
    const argumentsJson = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});

    messages.push(
      createAssistantToolCallMessage({
        content: text,
        toolCalls: [{ arguments: argumentsJson, id: call.id, name: call.name }]
      })
    );

    const outcome = await dispatch.dispatchToolCall({
      argumentsJson,
      callId: call.id,
      name: call.name
    });

    emit({ call, outcome, type: "dispatch" });

    // Held by the destructive gate: the result says HELD and the loop ends here.
    // Execution happens only after the human confirms, from the surface.
    if (outcome.status === DISPATCH_OUTCOME.HELD) {
      const heldText = formatHeldToolResult({ description: outcome.hold?.description, tool: outcome.hold?.tool });

      messages.push(
        createToolResultMessage({
          content: heldText,
          isError: false,
          toolCallId: call.id
        })
      );

      return Object.freeze({
        answer: "",
        hold: outcome.hold,
        messages: Object.freeze(messages),
        reason: TOOL_TURN_STOP_REASON.HELD,
        turns: Object.freeze(turns)
      });
    }

    const resultText = formatToolResultForModel(outcome);

    if (outcome.status === DISPATCH_OUTCOME.ERROR) {
      const repeat = trackToolErrorRepeat([resultText], lastErrorSignature, lastErrorCount);
      lastErrorSignature = repeat.signature;
      lastErrorCount = repeat.count;

      const note = buildRepeatErrorNote(repeat.count);

      messages.push(
        createToolResultMessage({
          content: note ? `${resultText}\n${note}` : resultText,
          isError: true,
          toolCallId: call.id
        })
      );
      continue;
    }

    lastErrorSignature = "";
    lastErrorCount = 0;
    messages.push(
      createToolResultMessage({
        content: resultText,
        toolCallId: call.id
      })
    );
  }

  return Object.freeze({
    answer: "",
    messages: Object.freeze(messages),
    reason: TOOL_TURN_STOP_REASON.ITERATION_CAP,
    turns: Object.freeze(turns)
  });
}
