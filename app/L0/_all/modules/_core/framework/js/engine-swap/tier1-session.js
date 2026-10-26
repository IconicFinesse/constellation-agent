// The Tier 1 session (plan §3.5, §6). One object per chat session that composes
// the pieces the surface must not compose itself:
//
//   registry -> visible tool list (deterministic, half the cacheable prefix)
//   transports -> the request body that carries that list
//   gate -> the destructive hold state machine
//   pipeline -> validation / coercion / risk / execution / structured result
//   loop -> run until plain text
//
// Boundary with P3 (streaming assembly), decided deliberately and recorded in the
// lane report: P2 consumes ONLY complete, parseable tool calls. The surface's
// streaming reader (`api.js`) extracts text deltas and drops `tool_calls`
// entirely, so a streamed tool turn cannot be assembled honestly yet. Tier 1
// therefore sends a non-streamed completion for tool turns: `stream: false`,
// one JSON body back, complete `tool_calls`, no fragments to reassemble. P3
// replaces this with real streaming assembly; until then this is the minimal
// honest route rather than a fragment reassembler written twice.
//
// Nothing here fetches. `sendCompletion` is injected, so tests drive a whole
// session deterministically and the surface owns transport (proxy, headers, key).

import { createUserMessage } from "./canonical.js";
import { buildRequest } from "./transports.js";
import { assembleVisibleToolList, createToolRegistry, createToolStats } from "./tool-registry.js";
import { createDestructiveGate, formatDeniedToolResult } from "./destructive-gate.js";
import { createDispatchPipeline, formatToolResultForModel } from "./dispatch-pipeline.js";
import { historyEntriesToCanonicalMessages } from "./history-shapes.js";
import { TOOL_TURN_STOP_REASON, runToolTurn } from "./tool-turn-loop.js";

export const TIER1_TURN_STATUS = Object.freeze({
  ANSWERED: "answered",
  ERROR: "error",
  HELD: "held",
  ITERATION_CAP: "iteration-cap",
  STOPPED: "stopped"
});

// Reads the tool calls out of one non-streamed OpenAI-shape completion. Anything
// unparseable is reported, not guessed: `arguments` stays the raw string and the
// pipeline makes the validation decision.
export function extractToolCallsFromCompletion(payload) {
  const message = payload?.choices?.[0]?.message || {};
  const text = typeof message.content === "string" ? message.content : "";
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  return Object.freeze({
    finishReason: String(payload?.choices?.[0]?.finish_reason || ""),
    text,
    toolCalls: Object.freeze(
      rawCalls.map((call, index) =>
        Object.freeze({
          arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : "",
          id: String(call?.id || `call_${index}`),
          name: String(call?.function?.name || "")
        })
      )
    )
  });
}

// Builds the canonical message list for a Tier 1 session from the surface's
// history. Legacy text-protocol entries pass through unchanged (they are the
// conversation); typed tool entries become assistant tool calls and tool results.
// The current user turn is appended as one user message.
export function buildTier1History({ history = [], userContent = "", systemPrompt = "" } = {}) {
  const messages = [];

  if (String(systemPrompt || "").trim()) {
    messages.push({ content: String(systemPrompt), role: "system" });
  }

  historyEntriesToCanonicalMessages(history).forEach((message) => messages.push(message));

  if (String(userContent || "").trim()) {
    messages.push(createUserMessage(String(userContent)));
  }

  return Object.freeze(messages);
}

// One session. `createTier1Session` is called once per chat send and never held
// across sends, so a config change takes effect on the next turn and a session's
// tier cannot silently change mid-loop.
// `initialMessages` wins over (history + systemPrompt + userContent) when supplied.
// The surface already assembles one prepared conversation for the streaming path;
// a Tier 1 turn must start from THAT list rather than re-deriving a second one, or
// the two tiers would diverge in prompt content (the BUG-007 anti-pattern one
// layer up).
export function createTier1Session({
  api = null,
  executionContext = null,
  history = [],
  initialMessages = null,
  logger = null,
  model = "",
  onEvent = null,
  params = {},
  providerKey = "",
  apiEndpoint = "",
  sendCompletion,
  systemPrompt = "",
  userContent = ""
} = {}) {
  if (typeof sendCompletion !== "function") {
    throw new Error("createTier1Session requires a sendCompletion function.");
  }

  const registry = createToolRegistry();
  const stats = createToolStats();
  const gate = createDestructiveGate();
  const assembled = assembleVisibleToolList({
    config: { apiEndpoint, provider: providerKey },
    model,
    registry
  });
  const pipeline = createDispatchPipeline({
    api,
    executionContext,
    gate,
    logger,
    registry,
    stats
  });
  let lastRequest = null;

  // The visible list is the assembled tools; the transport accepts both shapes
  // since P2 carryover 1b, so this composes end to end.
  function buildTurnRequest(messages) {
    const request = buildRequest({
      endpoint: apiEndpoint,
      messages,
      model,
      params,
      providerKey,
      // P2 boundary: tool turns are non-streamed so `tool_calls` arrive complete.
      stream: false,
      tools: assembled.tools
    });

    lastRequest = request;
    return request;
  }

  async function sendTurn({ messages }) {
    const request = buildTurnRequest(messages);
    const payload = await sendCompletion({ request });

    return extractToolCallsFromCompletion(payload);
  }

  const initialHistory = Array.isArray(initialMessages) && initialMessages.length
    ? Object.freeze([...initialMessages])
    : buildTier1History({ history, systemPrompt, userContent });

  return Object.freeze({
    assembled,
    capabilities: assembled.capabilities,
    gate,
    pipeline,
    registry,
    stats,
    // Observability for the lane report and for tests: what the last transport
    // request actually carried.
    get lastRequest() {
      return lastRequest;
    },

    // Runs the whole turn. Returns a normalized result the surface renders; every
    // reason maps to a surface action and none of them can spin.
    async run({ isStopRequested = () => false } = {}) {
      const outcome = await runToolTurn({
        dispatch: pipeline,
        history: initialHistory,
        isStopRequested,
        onEvent,
        sendTurn,
        tools: assembled.tools
      });

      let status = TIER1_TURN_STATUS.ANSWERED;

      switch (outcome.reason) {
        case TOOL_TURN_STOP_REASON.HELD:
          status = TIER1_TURN_STATUS.HELD;
          break;
        case TOOL_TURN_STOP_REASON.ERROR:
          status = TIER1_TURN_STATUS.ERROR;
          break;
        case TOOL_TURN_STOP_REASON.ITERATION_CAP:
          status = TIER1_TURN_STATUS.ITERATION_CAP;
          break;
        case TOOL_TURN_STOP_REASON.STOPPED:
          status = TIER1_TURN_STATUS.STOPPED;
          break;
        default:
          status = TIER1_TURN_STATUS.ANSWERED;
      }

      return Object.freeze({
        answer: outcome.answer || "",
        capabilities: assembled.capabilities,
        error: outcome.error || "",
        hold: outcome.hold || null,
        messages: outcome.messages,
        status,
        turns: outcome.turns
      });
    },

    // Confirming a held destructive call: run exactly once, through the pipeline's
    // execution-only stage, then hand the result back for one follow-up turn.
    async confirmHeld() {
      const settled = gate.confirm();

      if (!settled) {
        return null;
      }

      return pipeline.executeConfirmedHold(settled);
    },

    // Resumes the loop after a hold was settled. `messages` is the message list the
    // held turn ended on (assistant tool call + held tool result); `toolResultText`
    // replaces the held text with the real outcome so the model continues with the
    // truth rather than the placeholder.
    //
    // The loop restarts from these messages and can end only through the same
    // guaranteed exits as `run()`.
    async runContinuation({ messages = [], toolResultText = "" } = {}) {
      const base = Array.isArray(messages) && messages.length ? [...messages] : [];

      if (String(toolResultText || "").trim()) {
        const last = base[base.length - 1];

        if (last && last.role === "tool") {
          base[base.length - 1] = Object.freeze({
            ...last,
            content: String(toolResultText)
          });
        } else {
          return Object.freeze({
            answer: "",
            messages: Object.freeze(base),
            reason: TOOL_TURN_STOP_REASON.ERROR,
            status: TIER1_TURN_STATUS.ERROR,
            turns: Object.freeze([])
          });
        }
      }

      const outcome = await runToolTurn({
        dispatch: pipeline,
        history: base,
        onEvent: null,
        sendTurn: async ({ messages: turnMessages }) => {
          const request = buildTurnRequest(turnMessages);
          const payload = await sendCompletion({ request });

          return extractToolCallsFromCompletion(payload);
        },
        tools: assembled.tools
      });

      return Object.freeze({
        answer: outcome.answer || "",
        messages: outcome.messages,
        reason: outcome.reason,
        status: outcome.reason === TOOL_TURN_STOP_REASON.ANSWERED ? TIER1_TURN_STATUS.ANSWERED : TIER1_TURN_STATUS.HELD,
        turns: outcome.turns
      });
    },

    // Text formatting for a settled outcome. Lives here so a surface can render a
    // tool result without importing the pipeline (the OFF path must stay inert:
    // store.js imports nothing from the dispatch layer).
    formatOutcome(outcome) {
      return formatToolResultForModel(outcome);
    },

    // Denying: no execution, structured policy result.
    denyHeld() {
      return gate.deny();
    },

    // Session end / chat clear / stop: guaranteed exit from the hold state.
    cancelHeld() {
      return gate.cancelHeld();
    }
  });
}


