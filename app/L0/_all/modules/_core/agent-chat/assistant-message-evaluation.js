const EXECUTION_LOG_LEVELS = new Set([
  "assert",
  "debug",
  "dir",
  "error",
  "info",
  "log",
  "table",
  "warn"
]);

const WARNING_OCCURRENCE_THRESHOLD = 3;
const ERROR_OCCURRENCE_THRESHOLD = 4;

export function normalizeAssistantMessageContent(content) {
  return String(content ?? "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function toOrdinal(value) {
  const normalizedValue = Math.max(0, Number(value) || 0);
  const tens = normalizedValue % 100;

  if (tens >= 11 && tens <= 13) {
    return `${normalizedValue}th`;
  }

  switch (normalizedValue % 10) {
    case 1:
      return `${normalizedValue}st`;
    case 2:
      return `${normalizedValue}nd`;
    case 3:
      return `${normalizedValue}rd`;
    default:
      return `${normalizedValue}th`;
  }
}

export function inspectAssistantMessageRepeat(options = {}) {
  const assistantContent = normalizeAssistantMessageContent(options?.assistantContent);

  if (!assistantContent) {
    return {
      assistantContent,
      occurrenceCount: 0,
      repeatCount: 0
    };
  }

  const history = Array.isArray(options?.history) ? options.history : [];
  const messageId = typeof options?.messageId === "string" ? options.messageId : "";
  let previousMatchCount = 0;

  history.forEach((message) => {
    if (message?.role !== "assistant") {
      return;
    }

    if (messageId && message?.id === messageId) {
      return;
    }

    if (normalizeAssistantMessageContent(message?.content) === assistantContent) {
      previousMatchCount += 1;
    }
  });

  return {
    assistantContent,
    occurrenceCount: previousMatchCount + 1,
    repeatCount: previousMatchCount
  };
}

export function buildAssistantMessageRepeatLog(options = {}) {
  const repeatInfo = inspectAssistantMessageRepeat(options);

  if (repeatInfo.repeatCount < 1) {
    return null;
  }

  const occurrenceLabel = toOrdinal(repeatInfo.occurrenceCount);
  let level = "info";
  let text = [
    "loop notice:",
    `you have sent this exact assistant message for the ${occurrenceLabel} time.`,
    "That repeats the previous step once; if it did not help, better try something else."
  ].join(" ");

  if (repeatInfo.occurrenceCount >= WARNING_OCCURRENCE_THRESHOLD) {
    level = "warn";
    text = [
      "loop warning:",
      `you have sent this exact assistant message for the ${occurrenceLabel} time.`,
      "Repeating the same step is becoming a loop; inspect the latest framework output and try something else."
    ].join(" ");
  }

  if (repeatInfo.occurrenceCount >= ERROR_OCCURRENCE_THRESHOLD) {
    level = "error";
    text = [
      "loop error:",
      `you have sent this exact assistant message for the ${occurrenceLabel} time.`,
      "Stop repeating it. Read the latest framework output and take a materially different next step."
    ].join(" ");
  }

  return {
    ...repeatInfo,
    level,
    text
  };
}

export function normalizeAssistantEvaluationLogEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const text = typeof entry?.text === "string" ? entry.text : "";

  if (!text.trim()) {
    return null;
  }

  const normalizedLevel = typeof entry?.level === "string" ? entry.level.trim().toLowerCase() : "";
  const level = EXECUTION_LOG_LEVELS.has(normalizedLevel) ? normalizedLevel : "log";

  return {
    level,
    text
  };
}

export function prependAssistantEvaluationLogs(results, logs) {
  if (!Array.isArray(results) || !results.length || !Array.isArray(logs) || !logs.length) {
    return results;
  }

  const normalizedLogs = logs.map((entry) => normalizeAssistantEvaluationLogEntry(entry)).filter(Boolean);

  if (!normalizedLogs.length) {
    return results;
  }

  const firstResult = results[0];

  if (!firstResult || typeof firstResult !== "object") {
    return results;
  }

  const existingLogs = Array.isArray(firstResult.logs) ? [...firstResult.logs] : [];
  firstResult.logs = [...normalizedLogs, ...existingLogs];
  return results;
}
