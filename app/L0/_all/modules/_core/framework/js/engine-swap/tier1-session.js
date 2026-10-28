// The Tier 1 session (plan §3.5, §6). One object per chat session that composes
// the pieces the surface must not compose itself:
//
//   registry -> visible tool list (deterministic, half the cacheable prefix)
//   transports -> the request body that carries that list
//   gate -> the destructive hold state machine
//   pipeline -> validation / coercion / risk / execution / structured result
//   loop -> run until plain text
//
// Tool turns STREAM since P3 (plan §3.5). The surface's reader feeds raw deltas to
// `stream-assembly.js`, which accumulates argument fragments per call index and
// reports each call complete ONLY when its argument JSON is complete. This module
// consumes that verdict and nothing else: `argumentsComplete === false` is refused
// before dispatch, so a partially delivered call can never execute.
//
// A provider that ignores `stream: true` still answers with one JSON body; the same
// assembler consumes that payload, so `extractToolCallsFromCompletion` accepts both
// an assembled stream result and a raw completion payload. That keeps one code path
// for both provider behaviours instead of a second parser.
//
// Nothing here fetches. `sendCompletion` is injected, so tests drive a whole
// session deterministically and the surface owns transport (proxy, headers, key).

import { createUserMessage } from "./canonical.js";
import { computePrefixDigest, formatPrefixDigestLine } from "./prefix-digest.js";
import { formatCacheUsageLine, normalizeUsageBlock } from "./stream-assembly.js";
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

// Reads the tool calls out of a completion. Accepts BOTH shapes the transport can
// produce since P3:
//
//   assembled stream result  { text, toolCalls: [{ arguments, argumentsComplete }] }
//   raw completion payload   { choices: [{ message: { content, tool_calls } }] }
//
// The assembled shape carries the assembler's `argumentsComplete` verdict, and that
// verdict is copied through UNCHANGED — the loop refuses an incomplete call, so
// re-deriving completeness here would be a second opinion on a decision that must
// have exactly one owner. Anything unparseable keeps its raw argument string: the
// dispatch pipeline's validation stage makes the content decision, not this parser.
// Cache accounting for one completion, read from whichever shape arrived. Two
// shapes reach this parser and they carry usage differently, so one helper answers
// for both instead of each branch guessing:
//
//   assembled stream result -> an ALREADY-NORMALIZED record on `usage` (nullable
//                              counts), produced by the assembler; copy it through
//   raw completion payload  -> a provider `usage` block, normalized here
//
// Re-normalizing the assembled record would read `payload.usage.prompt_tokens_details`
// (absent), silently turn real numbers into nulls, and report a live cache hit as
// unknown. That is why the check is explicit rather than a `||` chain.
// `null` in every path means "the provider did not say", never "nothing cached".
export function usageFromCompletion(payload) {
  const usage = payload?.usage;

  if (!usage || typeof usage !== "object") {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(usage, "cachedTokens")) {
    return usage;
  }

  return normalizeUsageBlock(payload);
}

// The reported cache usage of a finished turn, read off the turn records rather
// than accumulated separately: `turns[]` is the ONE place a turn's usage is stored,
// so this cannot drift from it. `null` (no turns, or a provider that said nothing)
// means unknown.
export function usageOfLastTurn(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const last = list.length ? list[list.length - 1] : null;

  return last?.usage && typeof last.usage === "object" ? last.usage : null;
}

export function extractToolCallsFromCompletion(payload) {
  if (Array.isArray(payload?.toolCalls)) {
    return Object.freeze({
      finishReason: String(payload?.finishReason || ""),
      text: typeof payload?.text === "string" ? payload.text : "",
      usage: usageFromCompletion(payload),
      toolCalls: Object.freeze(
        payload.toolCalls.map((call, index) =>
          Object.freeze({
            arguments: typeof call?.arguments === "string" ? call.arguments : "",
            argumentsComplete: call?.argumentsComplete !== false,
            id: String(call?.id || `call_${index}`),
            // The assembler's call index travels with the call (P3 audit N2):
            // ordering currently survives on array order alone, which is fragile for
            // any later consumer that sorts or regroups calls.
            index: Number.isFinite(call?.index) ? Number(call.index) : index,
            name: String(call?.name || "")
          })
        )
      )
    });
  }

  const message = payload?.choices?.[0]?.message || {};
  const text = typeof message.content === "string" ? message.content : "";
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  return Object.freeze({
    finishReason: String(payload?.choices?.[0]?.finish_reason || ""),
    text,
    // The non-streamed body reports usage on the same standard block; the helper
    // normalizes it, and a body with no usage stays null (unknown, not a miss).
    usage: usageFromCompletion(payload),
    toolCalls: Object.freeze(
      rawCalls.map((call, index) =>
        Object.freeze({
          arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : "",
          // A non-streamed payload is complete by definition: the provider sent one
          // whole body. The completeness refusal exists for fragment assembly.
          argumentsComplete: true,
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
  isStopRequested = null,
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
  let lastPrefixDigest = null;

  // The visible list is the assembled tools; the transport accepts both shapes
  // since P2 carryover 1b, so this composes end to end.
  function buildTurnRequest(messages) {
    const request = buildRequest({
      endpoint: apiEndpoint,
      messages,
      model,
      params,
      providerKey,
      // P3: tool turns stream. Fragment assembly happens in the surface reader, and
      // a provider that answers one whole JSON body is handled by the same
      // assembler, so streaming is the default here rather than a special case.
      stream: true,
      tools: assembled.tools
    });

    lastRequest = request;
    // THE DIGEST DESCRIBES THE BODY ACTUALLY SENT, because it is computed from the
    // same `messages` and `tools` this request carries -- there is no second path
    // that could describe a body we did not send. `headLength` is the session's
    // OPENING message count: the loop only ever appends, so everything past that
    // bound is the growing tail, not the shared prefix the provider can reuse.
    lastPrefixDigest = computePrefixDigest({
      headLength: PREFIX_HEAD_LENGTH,
      messages,
      tools: assembled.tools
    });

    return request;
  }

  // ONE line per turn, not once per config: a dead cache is a change over time, and
  // a deduped line would hide exactly the regression this exists to show. The
  // prefix digest rides on the same line so a miss can be read as "digest moved"
  // (our fault) or "digest stable, provider still missed" (not our fault).
  function logTurnCacheLine(payloadResponse) {
    const sink = logger && typeof logger.info === "function" ? logger : null;

    if (!sink) {
      return;
    }

    try {
      sink.info(formatPrefixDigestLine(lastPrefixDigest));
      sink.info(formatCacheUsageLine(usageFromCompletion(payloadResponse)));
    } catch {
      // Logging must never break a turn.
    }
  }

  async function sendTurn({ messages }) {
    const request = buildTurnRequest(messages);
    const payload = await sendCompletion({ request });

    logTurnCacheLine(payload);

    return extractToolCallsFromCompletion(payload);
  }

  const initialHistory = Array.isArray(initialMessages) && initialMessages.length
    ? Object.freeze([...initialMessages])
    : buildTier1History({ history, systemPrompt, userContent });

  // The shared prefix is the conversation this session STARTED with, captured once
  // before the loop appends anything, so a later append cannot widen its own bound.
  // Declared AFTER `initialHistory` on purpose: reading it earlier is a TDZ
  // ReferenceError, and a `sendTurn`-time read is the only place it is needed.
  const PREFIX_HEAD_LENGTH = initialHistory.length;

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

    // The digest of the LAST request built, i.e. of the body actually sent. A test
    // (or the report) compares consecutive turns through this, so "the prefix is
    // stable" is a measurement of real outbound bytes rather than of intent.
    get lastPrefixDigest() {
      return lastPrefixDigest;
    },

    // Runs the whole turn. Returns a normalized result the surface renders; every
    // reason maps to a surface action and none of them can spin.
    // `isStopRequested` may be supplied per run (the surface's live stop flag) or
    // once at construction; per-run wins, and the default still guarantees an exit.
    async run({ isStopRequested: runStopRequested = null } = {}) {
      const stopRequested =
        typeof runStopRequested === "function"
          ? runStopRequested
          : typeof isStopRequested === "function"
            ? isStopRequested
            : () => false;
      const outcome = await runToolTurn({
        dispatch: pipeline,
        history: initialHistory,
        isStopRequested: stopRequested,
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
        turns: outcome.turns,
        // Cache accounting for the settled turn, DERIVED from the turn records rather
        // than accumulated a second time: `turns[]` is the one place a turn's usage is
        // recorded, so the two can never disagree. Report-only -- no control flow
        // reads it. `null` means the provider said nothing (unknown, not a miss).
        usage: usageOfLastTurn(outcome.turns)
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
        isStopRequested: typeof isStopRequested === "function" ? isStopRequested : () => false,
        // The post-hold continuation is still a turn of the SAME session, so it
        // reports through the same observer. Nulling it here silently dropped every
        // `dispatch` event of a continuation (the confirmed call's own execution and
        // anything after it), which is exactly the class of hole this seam exists to
        // close: the surface cannot settle a chip from an event it never receives.
        onEvent,
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
    // the surface loads no dispatch machinery when the flag is off).
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


