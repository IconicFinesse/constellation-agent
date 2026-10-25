export const ONSCREEN_AGENT_EXECUTION_SEPARATOR = "_____javascript";

// A separator-less fenced reply earns at most one protocol correction per user
// turn chain; a stubborn case then degrades to today's behavior instead of
// looping. Lives here so the pure helper file owns the whole fence contract.
export const MAX_UNEXECUTED_FENCE_RETRY_COUNT = 1;

export function hasOnscreenAgentExecutionSeparator(content) {
  return typeof content === "string" && content.includes(ONSCREEN_AGENT_EXECUTION_SEPARATOR);
}

export function resolveOnscreenAgentBoundaryAfterAssistantResponse(boundaryAction, assistantContent) {
  const action = typeof boundaryAction === "string" ? boundaryAction : "";

  if (action === "queued" && hasOnscreenAgentExecutionSeparator(assistantContent)) {
    return "";
  }

  return action;
}

// A lone closing-tag line (for example a leaked </parameter> from a foreign
// XML-envelope tool format) or a lone fence marker at the end of an execution
// block is never intended JavaScript. Only trailing lines that match exactly
// count as artifacts; anything embedded inside code is left untouched.
const TRAILING_EXECUTION_ARTIFACT_LINE_PATTERN = /^\s*(?:<\/[a-zA-Z][\w:.-]*>|```[\w-]*)\s*$/u;

export function stripTrailingExecutionArtifacts(code) {
  if (typeof code !== "string" || !code) {
    return { code: "", removed: [] };
  }

  const lines = code.split("\n");
  const removed = [];

  while (lines.length > 0) {
    const lastLine = lines[lines.length - 1];

    if (!lastLine.trim()) {
      lines.pop();
      continue;
    }

    if (TRAILING_EXECUTION_ARTIFACT_LINE_PATTERN.test(lastLine)) {
      removed.unshift(lines.pop());
      continue;
    }

    break;
  }

  return { code: lines.join("\n"), removed };
}

const RUNTIME_CODE_FENCE_PATTERN_SOURCE = "```([\\w+-]*)[^\\n]*\\n([\\s\\S]*?)```";
const RUNTIME_REFERENCE_PATTERN = /\bspace\./u;

// Detects the fenced-dump failure shape: an assistant reply that references the
// runtime inside a fenced block but carries no execution separator at all, so
// nothing would execute and the raw code would render as the chat reply.
// Returns the last runtime-referencing fence, or null when nothing matches.
export function findUnexecutedCodeFence(content) {
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }

  if (content.includes(ONSCREEN_AGENT_EXECUTION_SEPARATOR)) {
    return null;
  }

  const fencePattern = new RegExp(RUNTIME_CODE_FENCE_PATTERN_SOURCE, "g");
  let match = null;
  let found = null;

  while ((match = fencePattern.exec(content)) !== null) {
    if (RUNTIME_REFERENCE_PATTERN.test(match[2] || "")) {
      found = { code: match[2] || "", language: match[1] || "" };
    }
  }

  return found;
}

// Conversation-loop decision for the fenced-dump correction: fire only for a
// runtime-referencing fence with no separator, at most once per user turn. A
// reply that already used the separator, or fenced code that never touches
// the runtime (the user asked to see code), never earns a correction.
export function shouldRetryUnexecutedFence(assistantContent, retryCount) {
  if (!(Number(retryCount) < MAX_UNEXECUTED_FENCE_RETRY_COUNT)) {
    return false;
  }

  return Boolean(findUnexecutedCodeFence(assistantContent));
}

export function buildUnexecutedCodeFenceRetryMessage() {
  return [
    `Protocol correction: your previous response contained a fenced code block but no ${ONSCREEN_AGENT_EXECUTION_SEPARATOR} separator, so nothing executed and the code was shown to the user as chat text.`,
    `If you intended to run that code, resend it now: one short staging sentence, then ${ONSCREEN_AGENT_EXECUTION_SEPARATOR} alone on its own line, then the code.`,
    "If the user asked to see code as text, resend the same content as your answer and disregard this correction."
  ].join("\n");
}

// Tracks identical consecutive execution errors across one turn chain. A batch
// without errors resets the chain, so the count only grows on in-a-row repeats.
// Per-run sourceURL ids are normalized away so the same failure across retries
// still compares equal.
const EXECUTION_ERROR_SOURCE_URL_PATTERN = /space-onscreen-agent-execute-\d+\.js/gu;
const EXECUTION_ERROR_SOURCE_URL_STABLE_FORM = "space-onscreen-agent-execute.js";

export function trackExecutionErrorRepeat(errorTexts, previousSignature = "", previousCount = 0) {
  if (!Array.isArray(errorTexts) || !errorTexts.length) {
    return { count: 0, signature: "" };
  }

  const signature = errorTexts
    .map((text) =>
      String(text || "").replace(EXECUTION_ERROR_SOURCE_URL_PATTERN, EXECUTION_ERROR_SOURCE_URL_STABLE_FORM))
    .join("\n");

  if (signature === previousSignature && previousCount > 0) {
    return { count: previousCount + 1, signature };
  }

  return { count: 1, signature };
}

export function buildExecutionErrorRepeatNote(count) {
  const normalizedCount = Number(count) || 0;

  if (normalizedCount < 2) {
    return "";
  }

  return `note: this exact execution error has now occurred ${normalizedCount} times in a row; do not resend the same code, change something first`;
}
