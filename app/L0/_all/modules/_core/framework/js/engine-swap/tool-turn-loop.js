// The Tier 1 turn loop (plan §3.5): the model is offered typed tools, its calls
// flow through the shared dispatch pipeline, results return as structured tool
// messages, and the loop runs until the model answers in plain text.
//
// What this module owns:
//   - the loop shape and its termination conditions
//   - the iteration cap and repeat-error surfacing carried over from v1.2
//   - SEQUENTIAL parallel dispatch (P3): several calls in one turn are announced
//     in ONE assistant message and executed one after another in the order the
//     provider returned them, never concurrently. Every announced `tool_call_id`
//     is answered exactly once, because an unanswered id poisons every later turn
//   - refusing to dispatch a call whose arguments never finished streaming: a
//     partial argument payload is never executed, ever
//   - assembling the next request's message list from canonical messages
//
// What it deliberately does NOT own:
//   - the HTTP call. `sendTurn` is injected, so the shared layer stays free of
//     fetches, keys, and surface transport decisions, and tests drive the loop
//     with a scripted sender.
//   - fragment assembly. `stream-assembly.js` owns that; the loop only reads the
//     `argumentsComplete` verdict it produces.
//   - rendering. The surface observes the loop through `onEvent`.
//
// Every exit is guaranteed: plain-text answer, iteration cap, stop request,
// transport failure, or a held destructive call waiting for consent. There is no
// path that spins.

import {
  createAssistantTextMessage,
  createAssistantToolCallMessage,
  createToolResultMessage,
  createUserMessage
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

// A call whose argument fragments never completed. This is NOT a validation
// error about content: the call never existed in a dispatchable form, so it is
// refused BEFORE it enters the message list (the same shape the P2 parallel
// refusal used, and for the same reason: an announced id with no valid arguments
// cannot be answered honestly).
export function formatIncompleteArgumentsHint(count) {
  return [
    `policy: ${count} tool call${count === 1 ? "" : "s"} arrived with incomplete arguments (the stream ended mid-JSON).`,
    "Nothing was executed. Send one complete tool call with the full JSON arguments, or answer in plain text."
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

// One provider call's arguments as the wire wants them: a JSON string. Kept in
// one place so the assistant message and the dispatch pipeline can never see two
// different serializations of the same call.
function argumentsJsonFor(call) {
  return typeof call?.arguments === "string" ? call.arguments : JSON.stringify(call?.arguments ?? {});
}

// The result for a call that was announced but deliberately not executed because
// an earlier call in the same turn is waiting for the user. It still answers its
// `tool_call_id`, which is what keeps the replay valid.
function formatDeferredToolResult() {
  return "deferred: an earlier call in this turn is waiting for the user's confirmation, so this call was not executed. Send it again after the confirmation settles.";
}

// One Tier 1 conversation turn. `sendTurn` is the surface's completion call: it
// receives canonical messages + the visible tool list and resolves
// `{ text, toolCalls }` where each tool call carries the provider's raw arguments
// string and, for a streamed turn, the assembler's `argumentsComplete` verdict.
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

  // Applies the repeat counter to one failure text and returns the text plus the
  // escalation note. P2 computed the count but only surfaced the note on the
  // dispatch-error branch (audit-2 note N2); every failure path uses this now, so
  // a model that keeps making the same mistake sees it escalate.
  const withRepeatNote = (text) => {
    const repeat = trackToolErrorRepeat([text], lastErrorSignature, lastErrorCount);

    lastErrorSignature = repeat.signature;
    lastErrorCount = repeat.count;

    const note = buildRepeatErrorNote(repeat.count);

    return note ? `${text}\n${note}` : text;
  };

  const resetRepeat = () => {
    lastErrorSignature = "";
    lastErrorCount = 0;
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

      // A transport that failed because the user pressed stop is a STOP, not a
      // fault to report. `isStopRequested` is the only signal consulted, so a real
      // failure while the user did not ask to stop still surfaces as an error.
      if (isStopRequested()) {
        return Object.freeze({
          messages: Object.freeze(messages),
          reason: TOOL_TURN_STOP_REASON.STOPPED,
          turns: Object.freeze(turns)
        });
      }

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

    // A call whose arguments never finished arriving is NEVER dispatched, not even
    // partially. It also never enters the message list: announcing an id we cannot
    // answer with a real result would leave an unanswered `tool_call_id`, which is
    // invalid on the wire and in persisted replay. The model is coached instead.
    const incompleteCount = toolCalls.filter((call) => call?.argumentsComplete === false).length;

    if (incompleteCount) {
      const coaching = withRepeatNote(formatIncompleteArgumentsHint(incompleteCount));

      messages.push(createUserMessage(coaching));
      emit({ coaching, incompleteCount, type: "incomplete-arguments-refused" });
      continue;
    }

    // Several calls in one turn are DISPATCHED, strictly sequentially, in the order
    // the provider returned them (plan §3.5, rev 2). They are announced together in
    // ONE assistant message so the wire stays valid: every id below is answered
    // exactly once by the results that follow. No handler runs concurrently.
    const announced = toolCalls.map((call) => ({
      arguments: argumentsJsonFor(call),
      id: call.id,
      name: call.name
    }));

    messages.push(
      createAssistantToolCallMessage({
        content: text,
        toolCalls: announced
      })
    );

    let heldOutcome = null;

    // Stop is honoured between ITERATIONS, not between the calls of one turn — the
    // same contract P2 shipped and P2 audit note N1 pinned (the status line reads
    // "Stopping after the current step..."). Dropping a returned call unexecuted
    // would create exactly the unanswered-`tool_call_id` shape this loop exists to
    // prevent, so a batch that started finishes its calls and the top-of-loop check
    // ends the turn.
    for (let position = 0; position < toolCalls.length; position += 1) {
      const call = toolCalls[position];

      // Everything still announced below gets a result: an announcement without a
      // result is the one shape that breaks every later turn.
      if (heldOutcome) {
        messages.push(
          createToolResultMessage({
            content: formatDeferredToolResult(),
            isError: false,
            toolCallId: call.id
          })
        );
        continue;
      }

      const outcome = await dispatch.dispatchToolCall({
        argumentsJson: announced[position].arguments,
        callId: call.id,
        name: call.name
      });

      // THE COMMITTED RESULT TEXT IS DECIDED ONCE, HERE.
      //
      // It is then used TWICE: for the tool message this loop commits, and for the
      // `result` carried on the dispatch event the surface paints its provisional chip
      // from. One string, one formatter, two readers — which is what makes the mid-turn
      // output pane byte-identical to the committed row instead of a lookalike. Rebuilding
      // the pane from `outcome.result` on the surface side would drift on exactly the
      // shapes that need care (`undefined` commits as the quoted
      // `"the tool returned no value."` string, an error commits with the coaching prefix
      // repeated, a held call commits its consent sentence).
      let resultContent = "";
      let resultIsError = false;

      if (outcome.status === DISPATCH_OUTCOME.HELD) {
        resultContent = formatHeldToolResult({
          description: outcome.hold?.description,
          tool: outcome.hold?.tool
        });
      } else if (outcome.status === DISPATCH_OUTCOME.ERROR) {
        // A failure answers its own call and the turn goes on: the remaining calls still
        // run, in order. That is the difference between "this call failed" and "the turn
        // failed".
        resultContent = withRepeatNote(formatToolResultForModel(outcome));
        resultIsError = true;
      } else {
        resetRepeat();
        resultContent = formatToolResultForModel(outcome);
      }

      emit({
        call,
        outcome,
        position,
        // The exact text (and error flag) this loop is about to commit. Display-only:
        // the surface paints it, nothing reads it back into dispatch.
        result: { content: resultContent, isError: resultIsError },
        type: "dispatch"
      });

      // Held by the destructive gate. Execution happens only after the human
      // confirms, from the surface, so the loop ends here. Any later call in the
      // same turn is answered as deferred rather than left hanging.
      if (outcome.status === DISPATCH_OUTCOME.HELD) {
        heldOutcome = outcome;
        messages.push(
          createToolResultMessage({
            content: resultContent,
            isError: false,
            toolCallId: call.id
          })
        );
        continue;
      }

      if (outcome.status === DISPATCH_OUTCOME.ERROR) {
        messages.push(
          createToolResultMessage({
            content: resultContent,
            isError: true,
            toolCallId: call.id
          })
        );
        continue;
      }

      messages.push(
        createToolResultMessage({
          content: resultContent,
          toolCallId: call.id
        })
      );
    }

    if (heldOutcome) {
      return Object.freeze({
        answer: "",
        hold: heldOutcome.hold,
        messages: Object.freeze(messages),
        reason: TOOL_TURN_STOP_REASON.HELD,
        turns: Object.freeze(turns)
      });
    }

  }

  return Object.freeze({
    answer: "",
    messages: Object.freeze(messages),
    reason: TOOL_TURN_STOP_REASON.ITERATION_CAP,
    turns: Object.freeze(turns)
  });
}
