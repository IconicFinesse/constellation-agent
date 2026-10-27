// Tier 1 wire hygiene (P2 live hotfix 2).
//
// THE finding from the owner's devtools capture: the conversation handed to a Tier 1
// model carried the PROTOCOL ENVELOPE as message content and a separator-form
// assistant turn as an example. With the exact same tools, endpoint, model and
// stream flag, that shape made the model answer `Reading notes.txt now...` +
// `_____javascript` + `return await space.api.fileRead(...)` — the old text protocol —
// while the same conversation stripped to plain user text produced a typed
// `file_read`. The model imitates what it is SHOWN; the wire was showing it the
// retired idiom.
//
// Two rules, no more:
//
//   1. Envelope markers (`_____framework`, `_____transient`, `_____user`, ...) are
//      transport scaffolding for the Tier 3 reader. A model that receives them as
//      content learns a format nothing on Tier 1 ever consumes.
//   2. An assistant turn that carries an EXECUTABLE separator teaches that
//      separator is how you act. On Tier 1 it is only a display form, and a display
//      that re-teaches the retired channel is a demonstration, not context.
//
// The marker list and the fence-aware separator test are INJECTED, never copied:
// `_core/onscreen_agent/llm.js` owns `ONSCREEN_AGENT_PREPARED_MESSAGE_BLOCK` and the
// shared `execution-blocks.js` owns fence classification. A second copy of either is
// the BUG-007 anti-pattern.
//
// Tier 3 never calls this, so the text-protocol wire stays byte-identical.

export const WIRE_HYGIENE_REASON = Object.freeze({
  ENVELOPE_MARKERS_STRIPPED: "envelope-markers-stripped",
  SEPARATOR_ASSISTANT_PROJECTED: "separator-assistant-projected",
  SEPARATOR_ASSISTANT_DROPPED: "separator-assistant-dropped"
});

// Shown in place of the executable form. It is a FACT, not an instruction: it says
// what happened to the code, and it names no channel.
export const WIRE_HYGIENE_DISPLAY_NOTE = "(code shown, not executed)";

function normalizeMarkers(envelopeMarkers) {
  const values = Array.isArray(envelopeMarkers)
    ? envelopeMarkers
    : Object.values(envelopeMarkers && typeof envelopeMarkers === "object" ? envelopeMarkers : {});

  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    // Longest first so a marker that prefixes another cannot half-strip it.
    .sort((left, right) => right.length - left.length);
}

// Removes envelope marker lines and leading marker prefixes. Everything else is
// preserved byte for byte, including blank lines and indentation, so a sanitized
// message differs from the original ONLY where the scaffolding was.
export function stripEnvelopeMarkers(content, envelopeMarkers) {
  const text = typeof content === "string" ? content : "";

  if (!text) {
    return { changed: false, text };
  }

  const markers = normalizeMarkers(envelopeMarkers);

  if (!markers.length) {
    return { changed: false, text };
  }

  const lines = text.split("\n");
  const kept = [];
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (markers.includes(trimmed)) {
      changed = true;
      continue;
    }

    // `_____framework check user detail` may also arrive on ONE line. Drop only
    // the marker token and keep the text that follows it: that text is the real
    // content, and discarding it would lose the user's actual request.
    const prefixed = markers.find(
      (marker) => trimmed.startsWith(`${marker} `) || trimmed.startsWith(`${marker}\t`)
    );

    if (prefixed) {
      const remainder = trimmed.slice(prefixed.length).trimStart();

      changed = true;

      if (remainder) {
        kept.push(remainder);
      }

      continue;
    }

    kept.push(line);
  }

  if (!changed) {
    return { changed: false, text };
  }

  return { changed: true, text: kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim() };
}

// Projects a separator-bearing assistant reply to display-safe plain text: the
// narration the model wrote BEFORE the separator, kept because it is real context,
// plus an honest note. Returns null when nothing but code remains — such a turn has
// no content to show and nothing to learn from.
export function projectSeparatorAssistantContent(content, options = {}) {
  const text = typeof content === "string" ? content : "";
  const separatorIndex = Number(options.separatorIndex);

  if (!text || !Number.isFinite(separatorIndex) || separatorIndex < 0) {
    return null;
  }

  // `separatorIndex` is a CHARACTER offset (that is what the shared fence-aware
  // finder returns), not a line number. Slicing by line here silently kept the
  // whole code block — the projected message still carried the separator, which is
  // precisely what this function exists to remove.
  const narration = text.slice(0, separatorIndex).trim();

  if (!narration) {
    return null;
  }

  return `${narration}\n\n${String(options.note || WIRE_HYGIENE_DISPLAY_NOTE)}`;
}

// THE seam. `messages` are canonical OpenAI-shape messages; the result is the list
// a Tier 1 session may send. Pure: same input, same output, no config reads.
//
// `findSeparatorIndex` is the shared fence-aware classifier, injected so a fenced
// separator (display text) is never treated as an execution. `dropped` is reported
// so the caller can record WHY the wire is shorter than the history, and so a
// baseline computed from the wire can never be mistaken for one computed from the
// history.
export function sanitizeTier1WireMessages({ messages = [], envelopeMarkers = [], findSeparatorIndex = null, note = WIRE_HYGIENE_DISPLAY_NOTE } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const separatorFinder = typeof findSeparatorIndex === "function" ? findSeparatorIndex : null;
  const reasons = Object.create(null);
  const sanitized = [];
  let dropped = 0;
  let changed = false;

  for (const message of list) {
    const role = message?.role;
    const rawContent = typeof message?.content === "string" ? message.content : "";
    const stripped = stripEnvelopeMarkers(rawContent, envelopeMarkers);
    let content = stripped.text;

    if (stripped.changed) {
      changed = true;
      reasons[WIRE_HYGIENE_REASON.ENVELOPE_MARKERS_STRIPPED] =
        (reasons[WIRE_HYGIENE_REASON.ENVELOPE_MARKERS_STRIPPED] || 0) + 1;
    }

    if (role === "assistant" && separatorFinder) {
      const separatorIndex = Number(separatorFinder(content));

      if (separatorIndex >= 0) {
        const projected = projectSeparatorAssistantContent(content, { note, separatorIndex });

        changed = true;

        if (projected === null) {
          dropped += 1;
          reasons[WIRE_HYGIENE_REASON.SEPARATOR_ASSISTANT_DROPPED] =
            (reasons[WIRE_HYGIENE_REASON.SEPARATOR_ASSISTANT_DROPPED] || 0) + 1;
          continue;
        }

        content = projected;
        reasons[WIRE_HYGIENE_REASON.SEPARATOR_ASSISTANT_PROJECTED] =
          (reasons[WIRE_HYGIENE_REASON.SEPARATOR_ASSISTANT_PROJECTED] || 0) + 1;
      }
    }

    sanitized.push({
      ...message,
      content
    });
  }

  return Object.freeze({
    changed,
    dropped,
    messages: Object.freeze(sanitized),
    reasons: Object.freeze({ ...reasons })
  });
}

// How many corrective re-prompts a single Tier 1 turn may earn. ONE: the wire is
// already sanitized, so a second failure means the model will not take the tool
// channel for this turn, and repeating the demand would loop instead of answering.
export const TIER1_CORRECTIVE_RETRY_LIMIT = 1;

// The coaching turn sent after a Tier-1 answer that acted through the separator
// instead of a tool. It names the channel once and forbids nothing: showing code the
// user asked to see stays legitimate (BUG-007).
export const TIER1_CORRECTIVE_PROMPT =
  "That reply only showed code; nothing ran. Call the matching tool for this request instead of writing separator code.";

// THE DISPLAY-FORM SHAPES (chat-polish-3 item 3).
//
// The owner's live turn ended with `tool call: run_code {...}` written as CHAT PROSE and
// nothing executed. The Tier-1 steering already says, verbatim, that a tool call is the
// only thing that runs — the model was told plainly and wrote display text anyway. More
// prompt text is therefore not the lever; DETECTION plus a correction that names the
// specific mistake is.
//
// Only SHAPES are recognised here. Intent is not measured and cannot be: a fenced block
// of code is legitimate display (BUG-007 — showing the user code they asked to see is
// not a fault), so a catch is a counted observation that the turn produced call-shaped
// display text AND dispatched nothing, never a claim about what the model meant.
export const TIER1_DISPLAY_FORM_SHAPE = Object.freeze({
  // `_____javascript` outside any fence: the retired protocol's own act form.
  BARE_SEPARATOR: "bare-separator",
  // A FENCE that contains the separator: the call was written where code is shown.
  FENCED_SEPARATOR: "fenced-separator",
  // A fence whose body is a call: `space.api.x(...)`, or a JSON object carrying a name
  // plus arguments (the wire shape of a typed call, pasted as text).
  FENCED_CALL_BODY: "fenced-call-body",
  // `tool call:`/`tool_call:` (or `call:`) followed by a JSON object, unfenced.
  PROSE_TOOL_CALL: "prose-tool-call"
});

// A fence body that is unmistakably a CALL rather than incidental code.
const FENCED_CALL_BODY_PATTERN = /(?:\bspace\s*\.\s*api\s*\.\s*[a-z_$][\w$]*\s*\(|\{\s*"(?:tool|name|tool_name)"\s*:\s*"[^"]+"[\s\S]{0,240}?"arguments"\s*:)/iu;

// `tool call:` and friends, unfenced, introducing a JSON body on this or the next lines.
const PROSE_TOOL_CALL_PATTERN = /^[ \t]*(?:tool[ \t]*call|tool_call|call)[ \t]*[:\-][\s\S]{0,240}?\{/iu;

function fenceRegionTexts(content, fenceRegions) {
  const regions = Array.isArray(fenceRegions) ? fenceRegions : [];

  return regions
    .map((region) => {
      const start = Number(region?.start);
      const end = Number(region?.end);

      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return "";
      }

      return content.slice(Math.max(0, start), Math.min(content.length, end));
    })
    .filter(Boolean);
}

// The prose outside every fence: what the model wrote as CHAT rather than as code.
function unfolderedText(content, fenceRegions) {
  const regions = Array.isArray(fenceRegions) ? fenceRegions : [];

  if (!regions.length) {
    return content;
  }

  let text = "";
  let cursor = 0;

  regions.forEach((region) => {
    const start = Math.max(cursor, Number(region?.start) || 0);

    if (start > cursor) {
      text += `${content.slice(cursor, start)}\n`;
    }

    cursor = Math.max(cursor, Number(region?.end) || 0);
  });

  if (cursor < content.length) {
    text += content.slice(cursor);
  }

  return text;
}

// WHICH display-form mistake this reply made, or "" for none. Pure, and seam-injected:
// the fence classifier and the separator test both come from their owning modules, so no
// second copy of fence logic exists (BUG-007 anti-pattern).
//
// Precedence runs most-specific first, so the correction can name the exact mistake: a
// fenced call, then prose `tool call:`, then an uncontained separator.
//
// `separator` is optional and only used for the FENCE test: a fence is examined for the
// literal token, because "is this separator inside a fence" is exactly the question the
// shared executable-index finder answers the other way round.
export function detectTier1DisplayFormToolCall({
  answer = "",
  fenceRegions = null,
  findSeparatorIndex = null,
  separator = ""
} = {}) {
  const text = typeof answer === "string" ? answer : "";

  if (!text.trim()) {
    return "";
  }

  const regions = Array.isArray(fenceRegions) ? fenceRegions : [];
  const regionTexts = fenceRegionTexts(text, regions);
  const separatorToken = typeof separator === "string" ? separator : "";

  if (regionTexts.some((regionText) => FENCED_CALL_BODY_PATTERN.test(regionText))) {
    return TIER1_DISPLAY_FORM_SHAPE.FENCED_CALL_BODY;
  }

  if (separatorToken && regionTexts.some((regionText) => regionText.includes(separatorToken))) {
    return TIER1_DISPLAY_FORM_SHAPE.FENCED_SEPARATOR;
  }

  if (PROSE_TOOL_CALL_PATTERN.test(unfolderedText(text, regions))) {
    return TIER1_DISPLAY_FORM_SHAPE.PROSE_TOOL_CALL;
  }

  if (typeof findSeparatorIndex === "function" && Number(findSeparatorIndex(text)) >= 0) {
    return TIER1_DISPLAY_FORM_SHAPE.BARE_SEPARATOR;
  }

  return "";
}

// The coaching turn for a SPECIFIC shape (item 3). Naming the mistake is the whole point:
// a generic "use tools" nudge is what the steering leg already says, and repeating it
// louder is superstition. Each line states what happened, that it cannot execute, and the
// one action to take instead — and none of them forbids showing code (BUG-007).
const TIER1_SHAPE_PROMPTS = Object.freeze({
  [TIER1_DISPLAY_FORM_SHAPE.BARE_SEPARATOR]: TIER1_CORRECTIVE_PROMPT,
  [TIER1_DISPLAY_FORM_SHAPE.FENCED_CALL_BODY]:
    "That reply put the tool call inside a fenced code block, which is display only on this tier and never executes. Re-issue it as an actual tool call.",
  [TIER1_DISPLAY_FORM_SHAPE.FENCED_SEPARATOR]:
    "That reply put the execution separator inside a fenced code block, which is display only on this tier and never executes. If you meant to act, re-issue it as an actual tool call.",
  [TIER1_DISPLAY_FORM_SHAPE.PROSE_TOOL_CALL]:
    "That reply wrote `tool call:` as chat prose, which is display only on this tier and never executes. Re-issue it as an actual tool call."
});

export function resolveTier1CorrectivePrompt(shape = "") {
  return TIER1_SHAPE_PROMPTS[String(shape || "")] || TIER1_CORRECTIVE_PROMPT;
}

// ONE decision function for the bounded correction. It answers `{ retry, shape }` so the
// caller can send a correction that names the SHAPE, and it is the only place the cap is
// applied.
//
// `turns` is the loop's own per-iteration record, so "did this turn dispatch anything"
// comes from what actually happened on the wire, never from parsing prose.
//
export function resolveTier1CorrectiveRetry({
  answer = "",
  attempts = 0,
  findSeparatorIndex = null,
  fenceRegions = null,
  separator = "",
  turns = []
} = {}) {
  if (Number(attempts) >= TIER1_CORRECTIVE_RETRY_LIMIT) {
    return Object.freeze({ retry: false, shape: "" });
  }

  const iterations = Array.isArray(turns) ? turns : [];
  const toolCallCount = iterations.reduce(
    (total, turn) => total + (Number(turn?.toolCallCount) || 0),
    0
  );

  // A turn that dispatched a call is never corrected, whatever its prose looked like:
  // the action happened, so display text alongside it is honest display.
  if (toolCallCount !== 0) {
    return Object.freeze({ retry: false, shape: "" });
  }

  const shape = detectTier1DisplayFormToolCall({ answer, fenceRegions, findSeparatorIndex, separator });

  return Object.freeze({ retry: Boolean(shape), shape });
}

// Compatibility predicate over the same ONE decision: a Tier-1 turn needs a correction
// when it answered with call-shaped display content and made no typed call.
export function needsTier1CorrectiveRetry({ answer = "", findSeparatorIndex = null, attempts = 0, turns = [] } = {}) {
  return resolveTier1CorrectiveRetry({ answer, attempts, findSeparatorIndex, turns }).retry;
}

// One line for the diagnostics channel. Counts the SHAPE, never message content, so the
// owner can tell rare drift from a habitual pattern without the log carrying replies.
export function formatDisplayFormToolCallLine(shape = "") {
  return `[engine-swap] display-form-tool-call detected=1 shape=${String(shape || "unknown")}`;
}

// One line for the diagnostics log. Never includes message content.
export function formatWireHygieneLine(summary = {}) {
  const dropped = Number(summary?.dropped) || 0;
  const reasons = summary?.reasons && typeof summary.reasons === "object" ? summary.reasons : {};
  const parts = Object.keys(reasons)
    .sort()
    .map((key) => `${key}=${Number(reasons[key]) || 0}`);

  return `[engine-swap] tier1 wire-hygiene dropped=${dropped}${parts.length ? ` ${parts.join(" ")}` : ""}`;
}
