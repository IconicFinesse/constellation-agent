// THE ONE SET OF EXECUTION DISPLAY CAPS (P4b-2a).
//
// Before this, `admin/views/agent/execution.js` kept `220 / 8 / 2` as private literals,
// `onscreen_agent/execution.js` kept only the depth one, and the typed transcript formatter
// kept NONE — so an expanded `run_code` chip rendered every log line and every byte of the
// result. The numbers live here now because this module is already the shared formatting
// layer both console formatters and the typed formatter import: one source, no second set.
//
// These are CAPS, not cosmetics. The string and collection limits are admin's existing
// console rules, unchanged; the transcript line limit is the line-oriented rule the typed
// pane needs (see `boundExecutionTranscriptEntries`).
export const EXECUTION_FORMAT_MAX_STRING_LENGTH = 220;
export const EXECUTION_FORMAT_MAX_COLLECTION_ENTRIES = 8;
export const EXECUTION_FORMAT_MAX_DEPTH = 2;

// How many TRANSCRIPT LINES a bounded pane shows before it has to say what it hid.
//
// 40 is chosen, not inherited: a pane is a scroll region roughly two screens tall at the
// shipped line height, ordinary program output (a loop's progress lines, a short stack
// trace, a command's stdout) fits inside it, and a 10,000-line dump does not. It is far
// enough above the noise floor that the marker is rare, and far enough below a real wall
// that the marker is what the owner sees instead of the wall.
export const EXECUTION_FORMAT_MAX_TRANSCRIPT_LINES = 40;

// Every bound in this family names itself with this prefix, so "was anything hidden?" has
// exactly one answer and the renderer can find the affordance's reason without re-deriving
// the arithmetic.
export const EXECUTION_BOUND_MARKER_PREFIX = "…";

const EXECUTION_BOUND_NOUN_FORMS = {
  character: ["character", "characters"],
  entry: ["entry", "entries"],
  line: ["line", "lines"]
};

// Thousands separators without depending on the runtime's ICU data being what a test
// expects: the count is part of an honesty claim, so it is formatted deterministically.
export function formatExecutionCount(value) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;

  return String(Math.max(0, number)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

// THE marker text. `… 2,431 more lines` — what was hidden, and how much, computed from the
// real total by the caller. Never an unqualified ellipsis.
export function formatExecutionHiddenMarker(count, noun = "line") {
  const safeCount = Math.max(0, Math.trunc(Number(count) || 0));
  const [singular, plural] = EXECUTION_BOUND_NOUN_FORMS[noun] || EXECUTION_BOUND_NOUN_FORMS.line;

  return `${EXECUTION_BOUND_MARKER_PREFIX} ${formatExecutionCount(safeCount)} more ${safeCount === 1 ? singular : plural}`;
}

// One predicate for "this line IS a bound marker", so a consumer never string-matches the
// marker shape on its own.
export function isExecutionBoundMarkerText(text) {
  return typeof text === "string" && text.startsWith(`${EXECUTION_BOUND_MARKER_PREFIX} `);
}

// One predicate for "this painted line reports hidden content". A transcript bound paints the
// marker as its own line; a structured clamp embeds it inside the serialized value, so the
// question "did anything get hidden here?" is a containment test, not a prefix test. A caller
// that offers an expansion affordance asks THIS, never its own string comparison.
export function hasExecutionHiddenMarker(text) {
  return typeof text === "string" && text.includes(`${EXECUTION_BOUND_MARKER_PREFIX} `);
}

// RULE 1 — STRUCTURED JSON VALUES.
//
// Admin's console rules applied to a JSON-able value before it is serialized: strings clamp
// at the shared limit, collections at the shared entry limit, nesting at the shared depth.
// This is a CONSOLE-value rule and it is honest for console values, which are noise at
// excessive depth.
//
// Every clamp carries a marker naming the hidden count, which is where this deliberately
// differs from admin's bare `...`: a silent ellipsis is an affordance that pretends.
function boundExecutionString(value, maxStringLength) {
  if (typeof value !== "string" || value.length <= maxStringLength) {
    return value;
  }

  return `${value.slice(0, maxStringLength)} ${formatExecutionHiddenMarker(
    value.length - maxStringLength,
    "character"
  )}`;
}

function boundExecutionCollectionEntries(entries, options) {
  const { maxEntries } = options;
  const entries_ = entries.slice(0, maxEntries);
  const hiddenCount = entries.length - entries_.length;

  return { entries: entries_, hiddenCount };
}

export function boundExecutionStructuredValue(value, options = {}) {
  const {
    depth = 0,
    maxDepth = EXECUTION_FORMAT_MAX_DEPTH,
    maxEntries = EXECUTION_FORMAT_MAX_COLLECTION_ENTRIES,
    maxStringLength = EXECUTION_FORMAT_MAX_STRING_LENGTH,
    seen = new WeakSet()
  } = options;

  if (typeof value === "string") {
    return boundExecutionString(value, maxStringLength);
  }

  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  const options_ = { depth: depth + 1, maxDepth, maxEntries, maxStringLength, seen };

  if (Array.isArray(value)) {
    if (depth >= maxDepth) {
      return `Array(${formatExecutionCount(value.length)})`;
    }

    const { entries, hiddenCount } = boundExecutionCollectionEntries(value, { maxEntries });
    const bounded = entries.map((entry) => boundExecutionStructuredValue(entry, options_));

    if (hiddenCount > 0) {
      bounded.push(formatExecutionHiddenMarker(hiddenCount, "entry"));
    }

    return bounded;
  }

  if (value instanceof Map) {
    if (depth >= maxDepth) {
      return `Map(${formatExecutionCount(value.size)})`;
    }

    const pairs = Array.from(value.entries()).map(([key, entryValue]) => [String(key), entryValue]);
    const { entries, hiddenCount } = boundExecutionCollectionEntries(pairs, { maxEntries });
    const bounded = Object.fromEntries(
      entries.map(([key, entryValue]) => [key, boundExecutionStructuredValue(entryValue, options_)])
    );

    if (hiddenCount > 0) {
      bounded[EXECUTION_BOUND_MARKER_PREFIX] = formatExecutionHiddenMarker(hiddenCount, "entry");
    }

    return bounded;
  }

  if (value instanceof Set) {
    return boundExecutionStructuredValue(Array.from(value.values()), options);
  }

  if (value instanceof Error) {
    return {
      message: boundExecutionString(value.message || String(value), maxStringLength),
      name: value.name || "Error"
    };
  }

  // Only PLAIN objects (and null-prototype ones) get structural caps. A `Date`, a `RegExp`,
  // a typed array or a class instance carries its meaning in the serializer (`toJSON`), and
  // enumerating it would replace the value with an empty object — a silent content change
  // rather than a bound. Those pass through untouched, exactly as they did before.
  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  const entries_ = Object.entries(value);

  if (depth >= maxDepth) {
    // Admin's shape here is a bare `[Object]`, which names nothing; the count is what makes
    // the depth bound honest, so it is carried.
    return `[${value.constructor?.name || "Object"} ${EXECUTION_BOUND_MARKER_PREFIX} ${formatExecutionCount(
      entries_.length
    )} more ${entries_.length === 1 ? "entry" : "entries"}]`;
  }

  const { entries, hiddenCount } = boundExecutionCollectionEntries(entries_, { maxEntries });
  const bounded = Object.fromEntries(
    entries.map(([key, entryValue]) => [key, boundExecutionStructuredValue(entryValue, options_)])
  );

  if (hiddenCount > 0) {
    bounded[EXECUTION_BOUND_MARKER_PREFIX] = formatExecutionHiddenMarker(hiddenCount, "entry");
  }

  return bounded;
}

// RULE 2 — LINE-ORIENTED TRANSCRIPT TEXT.
//
// Bounded by LINE COUNT and nothing else. A program's stdout is the thing the owner opened
// the pane to read, so clamping a line mid-word at 220 characters would mangle exactly the
// output that matters; a line that is long is kept whole and only the NUMBER of lines is
// bounded.
//
// The transcript is fed as ordered CHUNKS (`{ entries, exempt }`), not as a flat line list,
// because exemption is a property of a BLOCK — a whole error body — and a flat list loses it
// the moment the classifier labels the body's lines. A chunk carries its own entry count so
// the rule never has to assume what an entry is: this module owns the cap, the marker and
// the arithmetic, and the caller owns only the entry shape it paints.
export function boundExecutionTranscriptChunks(chunks, options = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  const { maxLines = EXECUTION_FORMAT_MAX_TRANSCRIPT_LINES } = options;

  if (!Number.isFinite(maxLines) || maxLines <= 0) {
    return { chunks: list, cutIndex: -1, hiddenLineCount: 0, markerText: "" };
  }

  const kept = [];
  let admitted = 0;
  let hidden = 0;
  let cutIndex = -1;

  list.forEach((chunk) => {
    const entries = Array.isArray(chunk?.entries) ? chunk.entries : [];
    const lineCount = entries.length;

    // EXEMPT chunks are never cut and never consume budget: an error you cannot fully read
    // is a defect, and it keeps its place so the transcript's order stays truthful.
    if (chunk?.exempt) {
      kept.push(chunk);

      return;
    }

    if (admitted + lineCount <= maxLines) {
      admitted += lineCount;
      kept.push(chunk);

      return;
    }

    // A chunk that only PARTIALLY fits is admitted head-first: a 300-line block that starts
    // inside the budget must show what fits rather than vanishing whole.
    const room = Math.max(0, maxLines - admitted);

    if (room > 0) {
      kept.push({ ...chunk, entries: entries.slice(0, room) });
      admitted += room;
    }

    if (cutIndex === -1) {
      cutIndex = kept.length;
    }

    hidden += lineCount - room;
  });

  if (hidden === 0) {
    return { chunks: kept, cutIndex: -1, hiddenLineCount: 0, markerText: "" };
  }

  // The marker TEXT is produced here too, so a consumer never re-derives either the count or
  // the wording — the two halves of "never truncate silently" that must not drift apart.
  return {
    chunks: kept,
    cutIndex: cutIndex === -1 ? kept.length : cutIndex,
    hiddenLineCount: hidden,
    markerText: formatExecutionHiddenMarker(hidden, "line")
  };
}

function isNodeLike(targetWindow, value) {
  return Boolean(targetWindow?.Node && value instanceof targetWindow.Node);
}

function isElementLike(targetWindow, value) {
  return Boolean(targetWindow?.Element && value instanceof targetWindow.Element);
}

function summarizeElement(element) {
  const tagName = element.tagName ? element.tagName.toLowerCase() : "element";
  const id = element.id ? `#${element.id}` : "";
  const classNames =
    typeof element.className === "string" && element.className.trim()
      ? `.${element.className.trim().split(/\s+/u).join(".")}`
      : "";

  return `<${tagName}${id}${classNames}>`;
}

function summarizeNode(targetWindow, value) {
  if (isElementLike(targetWindow, value)) {
    return summarizeElement(value);
  }

  if (value.nodeType === targetWindow?.Node?.TEXT_NODE) {
    return `#text(${JSON.stringify((value.textContent || "").trim())})`;
  }

  return `[Node type=${value.nodeType}]`;
}

function resolveSpecialExecutionValue(value, options = {}) {
  return typeof options.normalizeSpecialValue === "function"
    ? options.normalizeSpecialValue(value)
    : undefined;
}

export function normalizeExecutionTextBlock(value) {
  return String(value ?? "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n");
}

export function appendExecutionTextBlock(lines, label, value) {
  const normalizedValue = normalizeExecutionTextBlock(value);
  const valueLines = normalizedValue.split("\n");

  lines.push(`${label}↓`);
  lines.push(...valueLines);
}

export function createExecutionJsonReplacer(targetWindow, options = {}) {
  const seen = new WeakSet();

  return function executionJsonReplacer(_key, value) {
    const specialValue = resolveSpecialExecutionValue(value, options);

    if (specialValue !== undefined) {
      return specialValue;
    }

    if (typeof value === "bigint") {
      return String(value);
    }

    if (typeof value === "symbol") {
      return value.toString();
    }

    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }

    if (value instanceof Error) {
      return {
        message: value.message || String(value),
        name: value.name || "Error",
        stack: value.stack || undefined
      };
    }

    if (value === targetWindow) {
      return `[Window ${targetWindow.location?.href || ""}]`;
    }

    if (targetWindow?.Document && value instanceof targetWindow.Document) {
      return `[Document ${value.URL || ""}]`;
    }

    if (targetWindow?.Location && value instanceof targetWindow.Location) {
      return `[Location ${value.href || ""}]`;
    }

    if (isNodeLike(targetWindow, value)) {
      return summarizeNode(targetWindow, value);
    }

    if (targetWindow?.NodeList && value instanceof targetWindow.NodeList) {
      return Array.from(value);
    }

    if (targetWindow?.HTMLCollection && value instanceof targetWindow.HTMLCollection) {
      return Array.from(value);
    }

    if (value instanceof Map) {
      return Array.from(value.entries());
    }

    if (value instanceof Set) {
      return Array.from(value.values());
    }

    if (value && typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);
    }

    return value;
  };
}

export function normalizeExecutionStructuredValue(value, options = {}) {
  const { targetWindow, seen = new WeakSet() } = options;
  const specialValue = resolveSpecialExecutionValue(value, options);

  if (specialValue !== undefined) {
    return specialValue;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (value instanceof Error) {
    return {
      message: value.message || String(value),
      name: value.name || "Error",
      stack: value.stack || undefined
    };
  }

  if (value === targetWindow) {
    return `[Window ${targetWindow.location?.href || ""}]`;
  }

  if (targetWindow?.Document && value instanceof targetWindow.Document) {
    return `[Document ${value.URL || ""}]`;
  }

  if (targetWindow?.Location && value instanceof targetWindow.Location) {
    return `[Location ${value.href || ""}]`;
  }

  if (isNodeLike(targetWindow, value)) {
    return summarizeNode(targetWindow, value);
  }

  if (targetWindow?.NodeList && value instanceof targetWindow.NodeList) {
    return Array.from(value, (entry) =>
      normalizeExecutionStructuredValue(entry, {
        ...options,
        seen,
        targetWindow
      })
    );
  }

  if (targetWindow?.HTMLCollection && value instanceof targetWindow.HTMLCollection) {
    return Array.from(value, (entry) =>
      normalizeExecutionStructuredValue(entry, {
        ...options,
        seen,
        targetWindow
      })
    );
  }

  if (Array.isArray(value)) {
    return value.map((entry) =>
      normalizeExecutionStructuredValue(entry, {
        ...options,
        seen,
        targetWindow
      })
    );
  }

  if (value instanceof Map) {
    return Array.from(value.entries(), ([key, entryValue]) => ({
      key: normalizeExecutionStructuredValue(key, {
        ...options,
        seen,
        targetWindow
      }),
      value: normalizeExecutionStructuredValue(entryValue, {
        ...options,
        seen,
        targetWindow
      })
    }));
  }

  if (value instanceof Set) {
    return Array.from(value.values(), (entry) =>
      normalizeExecutionStructuredValue(entry, {
        ...options,
        seen,
        targetWindow
      })
    );
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);

    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        normalizeExecutionStructuredValue(entryValue, {
          ...options,
          seen,
          targetWindow
        })
      ])
    );
  }

  return String(value);
}

export function formatExecutionStructuredValueAsYaml(value, options = {}) {
  const { targetWindow } = options;
  const yaml = targetWindow?.space?.utils?.yaml;

  if (!yaml || typeof yaml.stringify !== "function") {
    return "";
  }

  const normalizedValue = normalizeExecutionStructuredValue(value, options);

  try {
    if (Array.isArray(normalizedValue)) {
      const wrappedYaml = normalizeExecutionTextBlock(
        yaml.stringify({
          items: normalizedValue
        })
      );

      if (wrappedYaml.startsWith("items:\n")) {
        return wrappedYaml
          .slice("items:\n".length)
          .replace(/^  /gmu, "")
          .trimEnd();
      }

      if (wrappedYaml.startsWith("items: ")) {
        return wrappedYaml.slice("items: ".length).trimEnd();
      }

      return wrappedYaml.trimEnd();
    }

    if (normalizedValue && typeof normalizedValue === "object") {
      return normalizeExecutionTextBlock(yaml.stringify(normalizedValue)).trimEnd();
    }
  } catch (error) {
    // Fall back to JSON below when the lightweight YAML helper cannot serialize the shape.
  }

  return "";
}

export function formatExecutionTranscriptValue(value, options = {}) {
  const { formatFallback, targetWindow } = options;

  if (value === undefined) {
    return "";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return normalizeExecutionTextBlock(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (typeof value === "function" || value instanceof Error) {
    return typeof formatFallback === "function"
      ? formatFallback(value, options)
      : String(value);
  }

  if (typeof value === "object") {
    const yamlResult = formatExecutionStructuredValueAsYaml(value, options);

    if (yamlResult) {
      return yamlResult;
    }

    try {
      return normalizeExecutionTextBlock(
        JSON.stringify(value, createExecutionJsonReplacer(targetWindow, options), 2)
      );
    } catch (error) {
      // Fall back below when JSON serialization cannot handle the shape.
    }
  }

  return typeof formatFallback === "function"
    ? formatFallback(value, options)
    : String(value);
}

export function formatExecutionLogArgs(args, options = {}) {
  const normalizedArgs = Array.isArray(args) ? args : [];

  if (!normalizedArgs.length) {
    return "(no output)";
  }

  if (normalizedArgs.length === 1) {
    return formatExecutionTranscriptValue(normalizedArgs[0], options);
  }

  return formatExecutionTranscriptValue(normalizedArgs, options);
}
