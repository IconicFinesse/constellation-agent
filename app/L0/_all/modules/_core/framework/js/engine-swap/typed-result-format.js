// THE ONE typed-result formatter (P4b-1).
//
// A typed tool call holds a real object: arguments arrive as a JSON string and a result
// arrives as a payload with structure (`logs`, `result`, `resultText`, `error` for
// `run_code`; anything at all for every other tool). Before this module the render layer
// pasted `String(argumentsText)` into a `<pre>` and `String(outputText)` into ONE
// undifferentiated `terminal-line`, so a `run_code` call — a whole program plus a
// structured payload — read as a wall of escaped text.
//
// Two things live here, and they live here together deliberately:
//
//   1. THE LINE CLASSIFIER, moved verbatim from `thread-view.js`. It is what turns a
//      `result↓` line into the `is-result` modifier, which is what draws the arrow. It is
//      MOVED, not copied, so there is exactly one vocabulary for what a line means. It
//      closes over nothing but `EXECUTION_PRINT_LINE_PATTERN` (verified before the move),
//      so it needs no parameters and behaves identically out of the factory closure.
//
//   2. THE ARGUMENTS AND RESULT FORMATTERS, which emit `{text, modifier}` entries. Every
//      emitted line is classified by (1), so the surfaces draw them with the CSS that
//      already exists (`agent-thread.css` `.terminal-line.is-result/.is-error/...`). This
//      lane adds no CSS class and no second vocabulary.
//
// TOTality is a requirement, not a nicety: these run on every paint and must never throw
// on any input. Every entry point returns a usable shape for `null`, `undefined`, a
// string, an array, a number, a malformed JSON string, and a payload that is itself a
// JSON string.

import {
  appendExecutionTextBlock,
  normalizeExecutionTextBlock
} from "/modules/_core/framework/js/execution-format.js";

// The print-level prefix vocabulary, unchanged from the render layer it came from.
export const EXECUTION_PRINT_LINE_PATTERN = /^(log|info|warn|error|debug|dir|table|assert)(:\s*|↓)$/iu;

// Classifies ONE line into the modifier the existing CSS understands.
//
// This is a verbatim move of `getExecutionOutputLineModifier` from
// `visual/conversation/thread-view.js`; the differential test in
// `tests/p4b1_typed_chip_content_test.mjs` drives this against a transcription of the
// `abef323` body over an adversarial line corpus instead of trusting the copy.
export function getExecutionOutputLineModifier(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";

  if (!trimmed) {
    return "is-muted";
  }

  if (/^execution\s+/iu.test(trimmed)) {
    return "is-meta";
  }

  if (/^result(?::\s*|↓)$/iu.test(trimmed)) {
    return "is-result";
  }

  if (/^warn(?::\s*|↓)$/iu.test(trimmed)) {
    return "is-warn";
  }

  if (/^error(?::\s*|↓)$/iu.test(trimmed)) {
    return "is-error";
  }

  if (EXECUTION_PRINT_LINE_PATTERN.test(trimmed)) {
    return "is-print";
  }

  return "";
}

// A line, wearing the modifier the classifier gives it. The one shape both surfaces emit.
function classifiedLine(text) {
  const value = String(text ?? "");

  return {
    modifier: getExecutionOutputLineModifier(value),
    text: value
  };
}

// Split text into lines, always producing at least one (empty input is one blank line,
// exactly as `countCodeLines` treats it).
function splitLines(value) {
  const normalized = normalizeExecutionTextBlock(value);

  return normalized.split("\n");
}

function countLines(text) {
  if (typeof text !== "string" || !text.length) {
    return 0;
  }

  return text.split("\n").length;
}

// Parsed JSON *structure*, or nothing. A scalar or a broken string is not structure: the
// caller renders those verbatim rather than mangling them.
function parseJsonStructure(raw) {
  const text = typeof raw === "string" ? raw : "";

  if (!text.trim()) {
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  return parsed;
}

// Pretty-print a JSON *value*; a value that cannot be stringified degrades to verbatim.
function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

// THE ARGUMENTS FORMATTER.
//
// `run_code` arguments are whole programs, so the raw JSON string is a single line full of
// escaped `\n` — the wall the owner reported. Parsing and re-serializing with indentation
// costs nothing and makes the program readable. Anything that is not JSON structure is
// returned VERBATIM: a non-JSON payload must never be mangled into something else.
//
// `raw` is the untouched original, which is what the `{ } Raw` toggle shows.
export function formatTypedToolArguments({ argumentsText = "" } = {}) {
  const raw = String(argumentsText ?? "");
  const structure = parseJsonStructure(raw);
  const text = structure === null ? raw : prettyJson(structure);

  return Object.freeze({
    lineCount: countLines(text),
    raw,
    text
  });
}

// One labelled block in the legacy transcript shape: `label↓` then the value's own lines.
//
// `appendExecutionTextBlock` is the SAME writer admin's transcript uses for a console log,
// a result and an error, so a typed payload reads the way an executed one always has —
// same `↓` arrow, same indentation, same modifier vocabulary.
function appendLabelledBlock(entries, label, value) {
  const lines = [];

  appendExecutionTextBlock(lines, label, value);
  lines.forEach((line) => entries.push(classifiedLine(line)));
}

// `run_code`'s payload shape is stable and known (established by the execution engine):
//   { error: {text} | null, logs: [{level, text}], result, resultText, runId, status }
// Render it structurally, in the order the transcript has always used.
function formatRunCodePayload(payload, entries) {
  const logs = Array.isArray(payload?.logs) ? payload.logs : [];

  logs.forEach((entry) => {
    const level = typeof entry?.level === "string" && entry.level.trim() ? entry.level.trim() : "log";

    appendLabelledBlock(entries, level, entry?.text ?? "");
  });

  const hasResult = payload?.result !== undefined || (typeof payload?.resultText === "string" && payload.resultText !== "");

  if (hasResult) {
    const resultText =
      typeof payload?.resultText === "string" && payload.resultText !== ""
        ? payload.resultText
        : prettyJson(payload?.result);

    appendLabelledBlock(entries, "result", resultText);
  }

  const errorText = payload?.error?.text;

  if (errorText !== undefined && errorText !== null && String(errorText) !== "") {
    appendLabelledBlock(entries, "error", String(errorText));
  }

  return entries.length > 0;
}

// Every other tool: pretty-printed JSON under a `result↓` line. Still structure, still
// classified, still no new vocabulary.
function formatGenericPayload(payload, entries) {
  entries.push(classifiedLine("result↓"));
  splitLines(prettyJson(payload)).forEach((line) => entries.push(classifiedLine(line)));

  return true;
}

// The error face of any tool that is not `run_code`, or a `run_code` whose payload did not
// arrive. `coaching`/`message` are the two fields the history reader keeps.
function formatErrorResult(error, entries) {
  const body = String(error?.coaching || error?.message || error?.text || "").trim();

  appendLabelledBlock(entries, "error", body || "The tool reported an error.");

  return true;
}

// The last-resort face: no payload object and no error, only the committed text.
//
// This is the shape every row committed BEFORE this lane has (there is no object to render
// on disk), and the shape a caller gets when it only knows the projected string. It is run
// through the SAME classifier line by line, so it is honest classified output rather than a
// raw dump — and never a second rendering vocabulary.
function formatTextFallback(outputText, entries) {
  const text = String(outputText ?? "").trim();

  if (!text) {
    return false;
  }

  splitLines(text).forEach((line) => entries.push(classifiedLine(line)));

  return true;
}

function isRunCode(name) {
  return String(name || "").trim() === "run_code";
}

// A payload that is itself a JSON string is still structure: parse it once here so every
// downstream renderer sees an object. A string that does not parse stays a string and
// falls through to the text face.
export function normalizeTypedPayload(payload) {
  if (typeof payload !== "string") {
    return payload;
  }

  return parseJsonStructure(payload) ?? payload;
}

// THE RESULT FORMATTER: payload object in, `{text, modifier}` lines out.
//
// Total by construction. The `try` wraps the whole body because this runs on every paint,
// and a throw here would blank the thread; the catch degrades to the text face, which is
// the honest description of what we have.
export function formatTypedToolResult({ error = null, name = "", outputText = "", payload } = {}) {
  const entries = [];

  try {
    const normalized = normalizeTypedPayload(payload);
    const hasPayload = normalized !== undefined && normalized !== null;

    if (hasPayload && isRunCode(name) && typeof normalized === "object" && formatRunCodePayload(normalized, entries)) {
      return Object.freeze(entries);
    }

    // An ARRAY payload is structure too (`file_list` answers with a list), so it takes the
    // same generic path. `formatGenericPayload` fills `entries` and answers a success flag;
    // the entries are what the caller gets, never the flag.
    if (hasPayload && (typeof normalized === "object" || Array.isArray(normalized))) {
      formatGenericPayload(normalized, entries);
      return Object.freeze(entries);
    }

    if (error) {
      formatErrorResult(error, entries);
      return Object.freeze(entries);
    }

    if (hasPayload && typeof normalized === "string" && formatTextFallback(normalized, entries)) {
      return Object.freeze(entries);
    }

    formatTextFallback(outputText, entries);

    return Object.freeze(entries);
  } catch {
    const fallback = [];

    formatTextFallback(outputText, fallback);

    return Object.freeze(fallback);
  }
}

// The plain-text rendering of the same entries, for copy-to-clipboard and for tests that
// compare a painted pane with a copied body. One derivation: it formats, then joins.
export function formatTypedToolResultText(options = {}) {
  return formatTypedToolResult(options)
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}
