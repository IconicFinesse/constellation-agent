// One shared reader for chat history entries, in every shape the product has ever
// written (plan §3.5, plus the rename-rule discipline: reads accept both, writes
// use the new one).
//
// Shape A — legacy text protocol (every history on disk today, forever):
//
//   { id, role: "user"|"assistant", content, kind?: "execution-output"|..., attachments }
//
// Shape B — typed tool entries (new in P2):
//
//   { id, role: "assistant", kind: "tool_call",    toolCall:   { name, arguments, callId } }
//   { id, role: "user",      kind: "tool_result",  toolResult: { callId, name, payload }
//                                                   | { callId, name, error } }
//
// Existing text-protocol histories are NEVER rewritten. A reader that cannot
// handle shape A is a data-loss bug, and scattered `if (kind === ...)` branches in
// consumers are the second-copy anti-pattern. So the branch lives here once and
// everything — prompt assembly, rendering, persistence — reads through it.

import {
  createAssistantTextMessage,
  createAssistantToolCallMessage,
  createCanonicalToolCall,
  createToolResultMessage,
  createUserMessage
} from "./canonical.js";

export const HISTORY_ENTRY_KIND = Object.freeze({
  MESSAGE: "message",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result"
});

function normalizeText(value) {
  return typeof value === "string" ? value : "";
}

// True for shape B entries. Anything else is a legacy message entry.
export function isTypedHistoryEntry(entry) {
  const kind = normalizeText(entry?.kind).trim();

  return kind === HISTORY_ENTRY_KIND.TOOL_CALL || kind === HISTORY_ENTRY_KIND.TOOL_RESULT;
}

// True for a shape B tool-result entry. A consumer that needs to reason about a
// result asks HERE rather than comparing the `kind` string itself, so the branch
// keeps living once, in THE reader module (P2 audit note 6).
export function isToolResultEntry(entry) {
  return normalizeText(entry?.kind).trim() === HISTORY_ENTRY_KIND.TOOL_RESULT;
}

// THE reader. Returns one normalized view of an entry, whatever shape it arrived
// in. Never returns null for a plain message, so callers can map without filters.
export function readHistoryEntry(entry) {
  const kind = normalizeText(entry?.kind).trim();

  if (kind === HISTORY_ENTRY_KIND.TOOL_CALL) {
    const toolCall = entry?.toolCall && typeof entry.toolCall === "object" ? entry.toolCall : {};

    return Object.freeze({
      callId: normalizeText(toolCall.callId),
      content: "",
      id: normalizeText(entry?.id),
      kind: HISTORY_ENTRY_KIND.TOOL_CALL,
      name: normalizeText(toolCall.name),
      arguments: toolCall.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments : {},
      role: "assistant",
      toolResult: null
    });
  }

  if (kind === HISTORY_ENTRY_KIND.TOOL_RESULT) {
    const toolResult = entry?.toolResult && typeof entry.toolResult === "object" ? entry.toolResult : {};

    return Object.freeze({
      callId: normalizeText(toolResult.callId),
      content: "",
      error: toolResult.error && typeof toolResult.error === "object" ? toolResult.error : null,
      id: normalizeText(entry?.id),
      kind: HISTORY_ENTRY_KIND.TOOL_RESULT,
      name: normalizeText(toolResult.name),
      payload: toolResult.payload,
      role: "user",
      toolResult
    });
  }

  return Object.freeze({
    attachments: Array.isArray(entry?.attachments) ? entry.attachments : [],
    callId: "",
    content: normalizeText(entry?.content),
    id: normalizeText(entry?.id),
    kind: HISTORY_ENTRY_KIND.MESSAGE,
    messageKind: kind,
    role: entry?.role === "assistant" ? "assistant" : "user",
    toolResult: null
  });
}

export function readHistoryEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => readHistoryEntry(entry));
}

// Writer: shape B tool call. Writes ONLY the new shape.
export function createToolCallEntry({ arguments: args = {}, callId = "", id = "", name = "" } = {}) {
  return Object.freeze({
    id: normalizeText(id) || `tool-call-${String(callId || name || Date.now())}`,
    kind: HISTORY_ENTRY_KIND.TOOL_CALL,
    role: "assistant",
    toolCall: Object.freeze({
      arguments: Object.freeze({ ...(args || {}) }),
      callId: normalizeText(callId),
      name: normalizeText(name)
    })
  });
}

// Writer: shape B tool result. Exactly one of `payload` / `error` is meaningful.
export function createToolResultEntry({ callId = "", error = null, id = "", name = "", payload } = {}) {
  const result = { callId: normalizeText(callId), name: normalizeText(name) };

  if (error && typeof error === "object") {
    result.error = Object.freeze({
      class: normalizeText(error.class),
      coaching: normalizeText(error.coaching),
      message: normalizeText(error.message)
    });
  } else {
    result.payload = payload === undefined ? null : payload;
  }

  return Object.freeze({
    id: normalizeText(id) || `tool-result-${String(callId || name || Date.now())}`,
    kind: HISTORY_ENTRY_KIND.TOOL_RESULT,
    role: "user",
    toolResult: Object.freeze(result)
  });
}

// History -> canonical OpenAI-shaped messages for a Tier 1 request.
//
// Legacy message entries become ordinary user/assistant text. Typed entries become
// assistant tool_calls and tool results with the originating call id. Consecutive
// tool results after one assistant tool-call message are grouped exactly as the
// wire contract expects.
//
export function historyEntriesToCanonicalMessages(entries) {
  const messages = [];

  readHistoryEntries(entries).forEach((entry) => {
    if (entry.kind === HISTORY_ENTRY_KIND.TOOL_CALL) {
      messages.push(
        createAssistantToolCallMessage({
          toolCalls: [{ arguments: entry.arguments, id: entry.callId, name: entry.name }]
        })
      );
      return;
    }

    if (entry.kind === HISTORY_ENTRY_KIND.TOOL_RESULT) {
      const content = entry.error
        ? `error (${entry.error.class || "execution"}): ${entry.error.coaching || entry.error.message || "failed"}`
        : JSON.stringify(entry.payload ?? null);

      messages.push(
        createToolResultMessage({
          content,
          isError: Boolean(entry.error),
          toolCallId: entry.callId
        })
      );
      return;
    }

    if (!entry.content.trim()) {
      return;
    }

    messages.push(
      entry.role === "assistant" ? createAssistantTextMessage(entry.content) : createUserMessage(entry.content)
    );
  });

  return Object.freeze(messages);
}

// Canonical message list -> typed history entries, starting at `fromIndex`.
//
// A Tier 1 session works in canonical messages (system / user / assistant-with-
// toolCalls / tool). The surface stores history entries. This is the one mapping
// between them: an assistant message with calls becomes its NARRATION as a plain
// message entry followed by one `tool_call` entry per call, a `tool` message
// becomes a `tool_result`, and assistant text alone stays a plain message. Legacy
// entries already in history are never touched — only the tail the turn produced is
// mapped.
//
// NARRATION IS NOT OPTIONAL (owner-reported transcript defect, 2026-10-27): the loop
// announces ONE assistant message carrying both `content` and `toolCalls`
// (`tool-turn-loop.js`), and an earlier version of this function dropped the
// content, so a narrated tool turn persisted as calls only. The prose the user
// watched stream then vanished at commit, and because the thread renderer draws
// stored order faithfully, the calls of every iteration stacked at the top of the
// turn with no assistant anchor between them. Emitting the narration entry first
// restores the per-iteration order assistant text -> tool_call(s) -> tool_result(s).
//
// The reader needs no new branch for this: a narration entry IS the plain assistant
// message shape it already reads (`readHistoryEntry`, `historyEntriesToCanonicalMessages`),
// so this adds a writer path only. Stored histories are never rewritten.
export function canonicalMessagesToTypedEntries(messages, { fromIndex = 0 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const start = Number.isFinite(fromIndex) ? Math.max(0, Math.floor(fromIndex)) : 0;
  const entries = [];

  list.slice(start).forEach((message, offset) => {
    const index = start + offset;

    if (message?.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      // The narration FIRST, so stored order is the order the user watched:
      // assistant text -> tool_call(s) -> tool_result(s) -> next assistant text. The
      // id keeps the `assistant-<index>` convention the plain-assistant branch below
      // uses, so one id scheme covers both paths and nothing new has to be learned.
      if (normalizeText(message.content).trim()) {
        entries.push(
          Object.freeze({
            content: normalizeText(message.content),
            id: `assistant-${index}`,
            kind: "",
            role: "assistant"
          })
        );
      }

      message.toolCalls.forEach((call) => {
        entries.push(
          createToolCallEntry({
            arguments: call.arguments || {},
            callId: call.id,
            id: `tool-call-${call.id || index}`,
            name: call.name
          })
        );
      });
      return;
    }

    if (message?.role === "tool") {
      const content = normalizeText(message.content);
      const isError = message.isError === true || content.startsWith("error (") || content.startsWith("policy:");

      if (isError) {
        // Preserve the two faces: class from the coaching prefix, coaching body.
        const classMatch = /^error \(([a-z]+)\): /u.exec(content);

        entries.push(
          createToolResultEntry({
            callId: message.toolCallId,
            error: {
              class: classMatch ? classMatch[1] : "policy",
              coaching: classMatch ? content.slice(classMatch[0].length) : content,
              message: content.split("\n")[0]
            },
            id: `tool-result-${message.toolCallId || index}`,
            name: ""
          })
        );
        return;
      }

      let payload = content;

      if (content.startsWith("ok: ")) {
        try {
          payload = JSON.parse(content.slice(4));
        } catch {
          payload = content.slice(4);
        }
      }

      entries.push(
        createToolResultEntry({
          callId: message.toolCallId,
          id: `tool-result-${message.toolCallId || index}`,
          payload
        })
      );
      return;
    }

    if (message?.role === "assistant" && normalizeText(message.content).trim()) {
      entries.push(
        Object.freeze({
          content: normalizeText(message.content),
          id: `assistant-${index}`,
          kind: "",
          role: "assistant"
        })
      );
    }
  });

  return Object.freeze(entries);
}

// Replaces a HELD tool result with its settled one, on a COPIED history.
//
// A destructive call that was held leaves a placeholder result row standing in for the
// action the user is deciding about. Confirming or denying settles exactly that call, so
// the transcript has to carry the real outcome in the row the user was looking at.
//
// EXACTLY ONE RESULT PER CALL ID. Appending a second result would make the next Tier 1
// request invalid on the wire (one `tool_call_id` answered twice) and would also leave
// the placeholder claiming something that never happened. So this replaces and never
// appends — and it only replaces the LAST entry, because a settled result belongs to the
// call the turn ended on; rewriting an older row deeper in the transcript would silently
// edit history the user already watched.
//
// HISTORY IS A PARAMETER, not a receiver. This lives in the shared module so both
// surfaces reach ONE implementation: an admin-local copy would be a third copy of one
// behaviour, which is the defect class this module exists to remove.
//
// Returns a NEW array in every case, including when nothing matched, so a caller can
// assign the result unconditionally and array identity never silently means "no change".
export function replaceHeldToolResult(history, { content = "", isError = false, toolCallId = "" } = {}) {
  const entries = canonicalMessagesToTypedEntries([
    {
      content,
      isError: isError === true,
      role: "tool",
      toolCallId: String(toolCallId || "")
    }
  ]);
  const next = Array.isArray(history) ? [...history] : [];
  const index = next.findIndex(
    (entry, position) =>
      isToolResultEntry(entry) &&
      String(entry?.toolResult?.callId || "") === String(toolCallId || "") &&
      position === next.length - 1
  );

  if (index === -1 || !entries.length) {
    return next;
  }

  next[index] = entries[entries.length - 1];
  return next;
}

// THE PLAIN ASSISTANT MESSAGE SHAPE, written by the shared layer (BUG-009).
//
// A gate outcome needs a real committed assistant row, and every surface already writes
// exactly this shape for a normal reply (`createMessage("assistant", content)` in
// `onscreen_agent/store.js` and `admin/views/agent/store.js`, and the plain-assistant
// branch of `canonicalMessagesToTypedEntries`). This is that shape and nothing else —
// `{ attachments, content, id, kind, role }` — so the persistence writer, the reader, the
// render projection and the prompt projection all handle it through the paths they
// already have. No bespoke rendering, no second message type.
//
// `kind` is a plain tag (`execution-output` and `queued` are the same idea) and it is
// what lets a settle find and retire the *pending* sentence it is superseding. It is
// plainly a message to every reader: the only `kind` branches in the renderer are for
// `execution-output` and `queued`.
export const GATE_OUTCOME_MESSAGE_KIND = "gate-outcome";

// BUG-013: the tag for "the engine itself ended this turn and is telling the reader".
// A second `kind` rather than a second SHAPE: the entry below is the same plain
// assistant message a gate outcome writes, and the renderer's only `kind` branches stay
// the pre-existing `execution-output` / `queued` ones, so a turn notice paints through
// the ordinary assistant path exactly like a normal reply.
//
// It is deliberately NOT `GATE_OUTCOME_MESSAGE_KIND`: a gate sentence describes a
// consent question and is RETIRED when that question settles. A stall notice describes
// something that already happened and must survive, so giving it the gate tag would let
// a later `settleGateOutcome` delete the only explanation the user has.
export const TURN_NOTICE_MESSAGE_KIND = "turn-notice";

// THE ONE plain-assistant entry constructor. Both the gate layer and the turn-notice
// layer build their rows through it, so 'a committed notice' has exactly one shape
// (`{ attachments, content, id, kind, role }`) and one id convention -- the same one the
// surfaces' own `createMessage("assistant", content)` uses.
function createAssistantNoticeEntry({ content = "", id = "", kind = "" } = {}) {
  return Object.freeze({
    attachments: [],
    content: normalizeText(content),
    // Same id convention the surfaces' own `createMessage("assistant", ...)` uses.
    id: normalizeText(id) || `assistant-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    kind: normalizeText(kind),
    role: "assistant"
  });
}

export function createGateOutcomeMessageEntry({ content = "", id = "" } = {}) {
  return createAssistantNoticeEntry({ content, id, kind: GATE_OUTCOME_MESSAGE_KIND });
}

// BUG-013: commits the sentence that explains why a turn ended itself, and keeps it.
//
// No retire rule, unlike its gate sibling: a stall is not a pending question, so there is
// nothing later that supersedes it. Appending is the whole operation, and a caller that
// fires twice (a race between two exits) gets one row per fire rather than one row
// silently deleting another.
export function appendTurnNoticeMessage(history, { content = "", id = "" } = {}) {
  const base = Array.isArray(history) ? [...history] : [];

  return [...base, createAssistantNoticeEntry({ content, id, kind: TURN_NOTICE_MESSAGE_KIND })];
}

// Drops the trailing gate rows of the CURRENT episode. Only a trailing run is removed:
// a gate sentence from an earlier turn is history the user already read, and rewriting it
// would edit the transcript behind them. Returns a new array either way.
function withoutTrailingGateMessages(history) {
  const next = Array.isArray(history) ? [...history] : [];

  while (next.length) {
    const last = next[next.length - 1];

    if (normalizeText(last?.kind).trim() !== GATE_OUTCOME_MESSAGE_KIND) {
      break;
    }

    next.pop();
  }

  return next;
}

// Commits the USER-FACING sentence for a gate outcome, keeping exactly one per episode.
//
// Used by the turn driver for HELD, so the pending decision is visible to a reader of the
// saved transcript; both surfaces use `settleGateOutcome` to retire it again.
export function appendGateOutcomeMessage(history, { content = "", id = "" } = {}) {
  return [...withoutTrailingGateMessages(history), createGateOutcomeMessageEntry({ content, id })];
}

// Settles a held call AND commits the sentence describing the outcome, as one operation.
//
// The order is load-bearing. `replaceHeldToolResult` only rewrites the LAST entry, because
// that is the call the turn ended on; the pending gate sentence now sits after that row,
// so it is retired FIRST and only then is the held result replaced. Doing it the other way
// round would find the gate sentence in the last position, match nothing, and leave the
// placeholder claiming a decision that has been made.
export function settleGateOutcome(
  history,
  { content = "", isError = false, message = "", toolCallId = "" } = {}
) {
  const base = withoutTrailingGateMessages(history);
  const replaced = replaceHeldToolResult(base, { content, isError, toolCallId });

  // NOTHING TO SETTLE, NOTHING TO SAY. Clearing the chat empties the history and then
  // ends the hold, so a call can arrive with no row left to replace and no sentence left
  // to retire. Appending there would write a gate sentence into a chat the user just
  // cleared. Acknowledge only when this call actually changed something.
  const settledARow = replaced.length === base.length && replaced.some((entry, index) => entry !== base[index]);
  const retiredASentence = base.length !== (Array.isArray(history) ? history.length : 0);

  if (!settledARow && !retiredASentence) {
    return replaced;
  }

  return [...replaced, createGateOutcomeMessageEntry({ content: message })];
}

// Persistence mapping, used by BOTH the writer and the reader so they cannot
// drift. Returns `{}` for a legacy message: its stored shape stays byte-identical
// to before, with no new keys.
export function serializeTypedHistoryFields(entry) {
  const read = readHistoryEntry(entry);

  if (read.kind === HISTORY_ENTRY_KIND.TOOL_CALL) {
    return Object.freeze({
      toolCall: Object.freeze({
        arguments: { ...(read.arguments || {}) },
        callId: read.callId,
        name: read.name
      })
    });
  }

  if (read.kind === HISTORY_ENTRY_KIND.TOOL_RESULT) {
    const toolResult = { callId: read.callId, name: read.name };

    if (read.error) {
      toolResult.error = {
        class: normalizeText(read.error.class),
        coaching: normalizeText(read.error.coaching),
        message: normalizeText(read.error.message)
      };
    } else {
      toolResult.payload = read.payload === undefined ? null : read.payload;
    }

    return Object.freeze({ toolResult: Object.freeze(toolResult) });
  }

  return Object.freeze({});
}

// Inverse of the mapping above, applied when a stored entry is read back. A legacy
// stored message has neither field, so this answers `{}` and its normalized shape
// is unchanged.
export function normalizeTypedHistoryFields(stored) {
  const fields = {};

  if (stored?.toolCall && typeof stored.toolCall === "object") {
    fields.toolCall = Object.freeze({
      arguments:
        stored.toolCall.arguments && typeof stored.toolCall.arguments === "object"
          ? { ...stored.toolCall.arguments }
          : {},
      callId: normalizeText(stored.toolCall.callId),
      name: normalizeText(stored.toolCall.name)
    });
  }

  if (stored?.toolResult && typeof stored.toolResult === "object") {
    const toolResult = {
      callId: normalizeText(stored.toolResult.callId),
      name: normalizeText(stored.toolResult.name)
    };

    if (stored.toolResult.error && typeof stored.toolResult.error === "object") {
      toolResult.error = {
        class: normalizeText(stored.toolResult.error.class),
        coaching: normalizeText(stored.toolResult.error.coaching),
        message: normalizeText(stored.toolResult.error.message)
      };
    } else if ("payload" in stored.toolResult) {
      toolResult.payload = stored.toolResult.payload;
    }

    fields.toolResult = Object.freeze(toolResult);
  }

  return Object.freeze(fields);
}

// Render projection for the existing chip renderer.
//
// The thread renderer already knows how to draw an execution chip: a user-role
// message with `kind: "execution-output"` whose content starts with an
// `execution ...` line. Typed entries are a different shape, so the surface must
// NOT branch on them itself — it maps history through this function, which returns
// legacy entries untouched and projects typed entries onto that chip shape for
// RENDER ONLY. Nothing here is persisted; on disk the entry stays typed.
export function projectHistoryEntryForDisplay(entry) {
  const read = readHistoryEntry(entry);

  // `typedTool` marks a projection as a TYPED entry wearing the chip shape. It exists
  // for ONE reason: the chip shape is also what the text protocol's execution follow-up
  // wears, and the thread renderer's execute-section branch is allowed to CONSUME such a
  // follow-up as its own output pane. A typed chip is a row of its own, never a pane
  // belonging to the message above it, so the renderer must be able to tell the two
  // apart. Without this mark a narration containing an execution separator swallowed the
  // tool-call chip that followed it and then claimed the swallowed output as a real
  // execution result (P3 transcript-fidelity audit, 2026-10-27).
  if (read.kind === HISTORY_ENTRY_KIND.TOOL_CALL) {
    const args = JSON.stringify(read.arguments || {});

    return Object.freeze({
      content: `execution ${read.name || "tool"} call\n${args}`,
      id: read.id || `tool-call-${read.callId}`,
      kind: "execution-output",
      role: "user",
      typedTool: "call",
      // Identity and outcome travel WITH the projection so the chat surface can
      // derive grouping from the stored entry sequence instead of re-reading the
      // typed shapes itself (the second-reader anti-pattern).
      typedToolCallId: read.callId,
      typedToolName: read.name,
      typedToolOutcome: TOOL_RESULT_OUTCOME.PENDING
    });
  }

  if (read.kind === HISTORY_ENTRY_KIND.TOOL_RESULT) {
    const detail = read.error
      ? `error (${read.error.class || "execution"}): ${read.error.message || ""}`
      : JSON.stringify(read.payload ?? null);

    return withDisplayOnlyResultFields(
      {
        content: `execution ${read.name || "tool"} result\n${detail}`,
        id: read.id || `tool-result-${read.callId}`,
        kind: "execution-output",
        role: "user",
        typedTool: "result",
        typedToolCallId: read.callId,
        typedToolName: read.name,
        typedToolOutcome: classifyToolResultOutcome(entry)
      },
      read
    );
  }

  return entry;
}

// THE PAYLOAD OBJECT, carried alongside the projected text (P4b-1).
//
// The render layer draws STRUCTURE now: a `run_code` result is `logs` / `result` /
// `resultText` / `error`, and recovering that shape by re-parsing the projected JSON text
// would be a second derivation of a fact this module already holds as an object. So the
// object travels with the projection.
//
// These fields are DISPLAY-ONLY, and non-enumerable on purpose: `JSON.stringify(projected)`
// — the persistence and comparison face — is byte-identical to what it was before they
// existed. They are never persisted, never serialized, and never fed back into a prompt
// projection (the prompt projection above reads the stored entry, not this).
export function withDisplayOnlyResultFields(projection, read) {
  Object.defineProperty(projection, "typedToolResultError", {
    configurable: false,
    enumerable: false,
    value: read.error,
    writable: false
  });
  Object.defineProperty(projection, "typedToolResultPayload", {
    configurable: false,
    enumerable: false,
    value: read.payload,
    writable: false
  });

  return Object.freeze(projection);
}

// Outcome of a typed tool RESULT, in the closed vocabulary the CHAT SURFACE needs to
// group a run of calls and to keep consent affordances individually visible.
//
// The two non-terminal words are not decoration: a `held` call is waiting for the
// human's confirmation, and a `deferred` call was never executed because a sibling was
// held. Both are things the user must still SEE and act on, so the renderer is told
// about them here rather than re-deriving them by string-matching prose somewhere else.
// This reader is the one place that knows how the loop spells those outcomes.
export const TOOL_RESULT_OUTCOME = Object.freeze({
  SUCCESS: "success",
  ERROR: "error",
  HELD: "held",
  DEFERRED: "deferred",
  PENDING: "pending"
});

export function classifyToolResultOutcome(entry) {
  const read = readHistoryEntry(entry);

  if (read.kind !== HISTORY_ENTRY_KIND.TOOL_RESULT) {
    return TOOL_RESULT_OUTCOME.PENDING;
  }

  if (read.error) {
    return TOOL_RESULT_OUTCOME.ERROR;
  }

  const text = typeof read.payload === "string" ? read.payload.trim() : "";

  // `held:` is the reachable non-terminal word: the loop reports a held call as a
  // normal (non-error) tool message, so it lands here as a payload. The consent
  // affordance the comment above describes is therefore real.
  //
  // `policy:` is deliberately NOT matched here. `canonicalMessagesToTypedEntries`
  // classifies any `policy:` tool message as an ERROR result before it reaches this
  // reader (`history-shapes.js:247`), so a payload can never begin with it and a check
  // for it would be dead code that implies a consent affordance this branch cannot
  // produce (chat-polish audit non-blocker a, 2026-10-27).
  if (text.startsWith("held:")) {
    return TOOL_RESULT_OUTCOME.HELD;
  }

  if (text.startsWith("deferred:")) {
    return TOOL_RESULT_OUTCOME.DEFERRED;
  }

  return TOOL_RESULT_OUTCOME.SUCCESS;
}

// ONE BODY READER for the chip shape this module projects.
//
// `projectHistoryEntryForDisplay` writes `execution <name> call|result` followed by a
// newline and the body; every reader of that shape takes everything after the first
// newline. It lives here, beside the writer, because the mid-turn chip and the
// committed row must slice the SAME string the SAME way or they cannot be byte-equal.
//
// This is a reader of the projected format, not a second formatter: the act of
// formatting is `projectHistoryEntryForDisplay` below, and both paths call it.
export function readProjectedChipBody(entry) {
  const content = String(entry?.content || "");
  const newlineIndex = content.indexOf("\n");

  return newlineIndex === -1 ? "" : content.slice(newlineIndex + 1).trim();
}

// THE ONE ARGUMENTS FORMATTER, shared by the mid-turn provisional chip and the
// committed call row.
//
// Parity is a construction property here, not a comparison of two hopeful
// implementations: a provisional chip and a committed call entry are formatted by the
// SAME functions in the SAME order — `createCanonicalToolCall` (the one argument
// parser, so a raw JSON string and an object agree) then `createToolCallEntry` then
// `projectHistoryEntryForDisplay` then `readProjectedChipBody`. If the committed row
// ever changes its argument rendering, this helper changes with it, because there is
// only one rendering.
//
export function projectToolCallForChip({ arguments: rawArguments, name = "" } = {}) {
  const callName = normalizeText(name).trim() || "tool";

  // A nameless call is not dispatchable, but the formatter must never throw: the chip
  // is presentation. `createCanonicalToolCall` is given a name so it cannot reject.
  const canonical = createCanonicalToolCall({ arguments: rawArguments, id: "projected-call", name: callName });
  const entry = createToolCallEntry({
    arguments: canonical.arguments,
    callId: canonical.id,
    name: canonical.name
  });
  const projected = projectHistoryEntryForDisplay(entry);

  // The whole projected CONTENT is returned, not just the body: the chip shape is
  // `execution <name> call` + newline + body, and letting a caller re-type that prefix
  // would be a second copy of the format waiting to drift.
  return Object.freeze({
    argumentsText: readProjectedChipBody(projected),
    content: String(projected.content || ""),
    name: canonical.name
  });
}

// THE ONE RESULT FORMATTER, with the same shared-by-construction property.
//
// The input is the LITERAL tool-message content the loop is about to commit
// (`formatToolResultForModel` / `formatHeldToolResult` output), so this function never
// re-derives a payload from a dispatch outcome: it projects the very string history
// will hold, through the very reader history uses. That is what makes a settled chip's
// output pane byte-identical to the committed row's — including the shapes that would
// drift if this were written by hand (an `undefined` result commits as the quoted
// `"the tool returned no value."` string, not as `undefined`).
//
// THE ONE RESULT DERIVATION (P4b-1): projected text AND the payload object it came from,
// from a single read.
//
// The chip has to carry the same object the committed row carries, or the two surfaces
// would each have to recover the structure for themselves — one of them by re-parsing text,
// which is the second derivation this lane exists to delete. So the derivation returns all
// three faces at once: the projected body (`text`), the payload object, and the error face.
//
// `projectToolResultText` below is a THIN reader of this function, not a parallel
// implementation: delete the delegation and its answer has no source.
export function projectToolResultDetail({ content = "", isError = false } = {}) {
  const message = createToolResultMessage({
    content: String(content ?? ""),
    isError: isError === true,
    toolCallId: "projected-result"
  });
  const entries = canonicalMessagesToTypedEntries([message], { fromIndex: 0 });
  const resultEntry = entries.find((entry) => entry?.kind === HISTORY_ENTRY_KIND.TOOL_RESULT);

  if (!resultEntry) {
    return Object.freeze({ error: null, payload: undefined, text: "" });
  }

  const projected = projectHistoryEntryForDisplay(resultEntry);

  return Object.freeze({
    error: projected.typedToolResultError ?? null,
    payload: projected.typedToolResultPayload,
    text: readProjectedChipBody(projected)
  });
}

// The text face alone, for every caller that only draws text. One derivation: this asks
// `projectToolResultDetail`, so it can never disagree with the payload the chip carries.
export function projectToolResultText(options = {}) {
  return projectToolResultDetail(options).text;
}

// Prompt projection for the text-protocol (Tier 3) path.
//
// A Tier 1 session writes typed entries. If the config later resolves Tier 3 (the
// flag is per config, and a user can switch models), the Tier 3 prompt must still
// SEE that history rather than silently dropping it. This projects one typed entry
// onto the plain text the text protocol can carry. Legacy entries answer `null` so
// the caller keeps its existing normalization path untouched.
export function projectHistoryEntryForPrompt(entry) {
  const read = readHistoryEntry(entry);

  if (read.kind === HISTORY_ENTRY_KIND.TOOL_CALL) {
    return Object.freeze({
      content: `tool call: ${read.name} ${JSON.stringify(read.arguments || {})}`,
      id: read.id,
      kind: "",
      role: "assistant"
    });
  }

  if (read.kind === HISTORY_ENTRY_KIND.TOOL_RESULT) {
    const detail = read.error
      ? `error (${read.error.class || "execution"}): ${read.error.coaching || read.error.message || "failed"}`
      : `result: ${JSON.stringify(read.payload ?? null)}`;

    return Object.freeze({
      content: `${read.name || "tool"} ${detail}`,
      id: read.id,
      kind: "",
      role: "user"
    });
  }

  return null;
}

// Rendering view: what a reader needs to draw one row without re-deriving shape.
// Legacy entries answer `{ type: "message" }` and render exactly as before; typed
// entries answer `{ type: "tool", phase: "call"|"result" }` and render through the
// existing execution chip.
export function describeHistoryEntryForRender(entry) {
  const read = readHistoryEntry(entry);

  if (read.kind === HISTORY_ENTRY_KIND.TOOL_CALL) {
    return Object.freeze({
      callId: read.callId,
      id: read.id,
      name: read.name,
      phase: "call",
      type: "tool"
    });
  }

  if (read.kind === HISTORY_ENTRY_KIND.TOOL_RESULT) {
    return Object.freeze({
      callId: read.callId,
      failed: Boolean(read.error),
      id: read.id,
      name: read.name,
      phase: "result",
      type: "tool"
    });
  }

  return Object.freeze({
    id: read.id,
    messageKind: read.messageKind,
    role: read.role,
    type: "message"
  });
}
