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
  boundExecutionStructuredValue,
  boundExecutionTranscriptChunks,
  EXECUTION_FORMAT_MAX_TRANSCRIPT_LINES,
  hasExecutionHiddenMarker,
  normalizeExecutionTextBlock
} from "/modules/_core/framework/js/execution-format.js";

export { hasExecutionHiddenMarker };

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
function labelledEntries(label, value) {
  const lines = [];

  appendExecutionTextBlock(lines, label, value);

  return lines.map(classifiedLine);
}

// THE STRUCTURED-VALUE ADAPTER (P4b-2a).
//
// A JSON value is clamped by the SHARED structured rule before it is serialized, so an
// over-deep payload cannot paint a wall either. `unbounded` is what the pane's expansion
// affordance renders, and it comes through THIS function with the clamp switched off —
// never through a second serializer, so "bounded" and "everything" cannot drift apart.
function prettyBoundedValue(value, options) {
  return prettyJson(options.unbounded ? value : boundExecutionStructuredValue(value));
}

// `run_code`'s payload shape is stable and known (established by the execution engine):
//   { error: {text} | null, logs: [{level, text}], result, resultText, runId, status }
//
// Build it as ORDERED CHUNKS, in the order the transcript has always used. A chunk is one
// labelled block plus whether it is exempt from bounding, because exemption is a property of
// a whole block: an error body must survive intact, and a flat line list would lose that the
// moment the classifier labelled its lines.
function runCodeChunks(payload, options) {
  const chunks = [];
  const logs = Array.isArray(payload?.logs) ? payload.logs : [];

  logs.forEach((entry) => {
    const level = typeof entry?.level === "string" && entry.level.trim() ? entry.level.trim() : "log";

    chunks.push({ entries: labelledEntries(level, entry?.text ?? ""), exempt: false });
  });

  const hasResult = payload?.result !== undefined || (typeof payload?.resultText === "string" && payload.resultText !== "");

  if (hasResult) {
    const resultIsText = typeof payload?.resultText === "string" && payload.resultText !== "";
    // A TEXT result is transcript text and is bounded by LINES only; a structured result is
    // a console value and takes the structured caps. Two rules, applied where each belongs.
    const resultText = resultIsText ? payload.resultText : prettyBoundedValue(payload?.result, options);

    chunks.push({ entries: labelledEntries("result", resultText), exempt: false });
  }

  const errorText = payload?.error?.text;

  if (errorText !== undefined && errorText !== null && String(errorText) !== "") {
    // EXEMPT. An error is never truncated — not by lines, not by characters, not by depth.
    // An unreadable error is a defect, so this block is exempt from every bound in this lane.
    chunks.push({ entries: labelledEntries("error", String(errorText)), exempt: true });
  }

  return chunks;
}

// Every other tool: pretty-printed JSON under a `result↓` line. Still structure, still
// classified, still no new vocabulary.
function genericChunks(payload, options) {
  return [
    {
      entries: [
        classifiedLine("result↓"),
        ...splitLines(prettyBoundedValue(payload, options)).map((line) => classifiedLine(line))
      ],
      exempt: false
    }
  ];
}

// The error face of any tool that is not `run_code`, or a `run_code` whose payload did not
// arrive. `coaching`/`message` are the two fields the history reader keeps.
function errorChunks(error) {
  const body = String(error?.coaching || error?.message || error?.text || "").trim();

  // EXEMPT for the same reason as the payload's error block: an error body is never cut.
  return [{ entries: labelledEntries("error", body || "The tool reported an error."), exempt: true }];
}

// The last-resort face: no payload object and no error, only the committed text.
//
// This is the shape every row committed BEFORE this lane has (there is no object to render
// on disk), and the shape a caller gets when it only knows the projected string. It is run
// through the SAME classifier line by line, so it is honest classified output rather than a
// raw dump — and never a second rendering vocabulary.
function textChunks(outputText) {
  const text = String(outputText ?? "").trim();

  if (!text) {
    return [];
  }

  return [{ entries: splitLines(text).map((line) => classifiedLine(line)), exempt: false }];
}

// CHUNKS IN, PAINTED LINES OUT.
//
// The cap, the arithmetic and the marker WORDING all come from the shared module; this
// function only decides where the marker lands in the entry sequence, and it does that from
// the chunks the shared rule KEPT rather than by re-counting lines.
function paintChunks(chunks, options) {
  const list = Array.isArray(chunks) ? chunks : [];

  if (options.unbounded) {
    return list.flatMap((chunk) => chunk.entries);
  }

  const bounded = boundExecutionTranscriptChunks(list, { maxLines: options.maxLines });
  const entries = [];

  bounded.chunks.forEach((chunk) => entries.push(...chunk.entries));

  if (bounded.markerText) {
    const markerIndex = bounded.chunks
      .slice(0, bounded.cutIndex)
      .reduce((total, chunk) => total + chunk.entries.length, 0);

    // `is-muted` is the vocabulary a blank line already wears: the marker is transcript
    // furniture, not program output, and it must not read as a line the program printed.
    entries.splice(markerIndex, 0, { modifier: "is-muted", text: bounded.markerText });
  }

  return entries;
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
//
// BOUNDING (P4b-2a). By default the painted transcript is bounded by LINE COUNT, with an
// explicit marker naming exactly how many lines were hidden, and structured values are
// clamped by admin's console caps. `unbounded: true` renders the complete content through
// the SAME builder — that is what the pane's `Show all` control paints, so the expanded and
// collapsed forms are one derivation and cannot disagree.
export function formatTypedToolResult({ error = null, name = "", outputText = "", payload, unbounded = false } = {}) {
  const options = { maxLines: EXECUTION_FORMAT_MAX_TRANSCRIPT_LINES, unbounded };

  try {
    const normalized = normalizeTypedPayload(payload);
    const hasPayload = normalized !== undefined && normalized !== null;

    if (hasPayload && isRunCode(name) && typeof normalized === "object") {
      const chunks = runCodeChunks(normalized, options);

      if (chunks.length) {
        return Object.freeze(paintChunks(chunks, options));
      }
    }

    // An ARRAY payload is structure too (`file_list` answers with a list), so it takes the
    // same generic path.
    if (hasPayload && (typeof normalized === "object" || Array.isArray(normalized))) {
      return Object.freeze(paintChunks(genericChunks(normalized, options), options));
    }

    if (error) {
      return Object.freeze(paintChunks(errorChunks(error), options));
    }

    if (hasPayload && typeof normalized === "string") {
      const chunks = textChunks(normalized);

      if (chunks.length) {
        return Object.freeze(paintChunks(chunks, options));
      }
    }

    return Object.freeze(paintChunks(textChunks(outputText), options));
  } catch {
    let fallback = [];

    try {
      fallback = paintChunks(textChunks(outputText), { ...options, unbounded: true });
    } catch {
      fallback = [];
    }

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
