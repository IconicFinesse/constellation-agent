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

    if (executionIsNodeLike(targetWindow, value)) {
      return summarizeExecutionNode(targetWindow, value);
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

  if (executionIsNodeLike(targetWindow, value)) {
    return summarizeExecutionNode(targetWindow, value);
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

// ── THE ONE CONSOLE-VALUE FORMATTER FAMILY (P4b-2c) ────────────────────────────────
//
// Both agent surfaces render the values an executed block logs or returns, and before this
// they each carried their own copy of that family — sixteen bodies that agreed on most
// inputs and disagreed on the ones that matter (stack filtering, skill labels, and whether
// the 220 / 8 / 2 caps were applied at all). One surface was reading a filtered stack and
// the other was painting framework frames into the transcript.
//
// The family is a FACTORY because exactly one thing in it is surface-specific: the
// `//# sourceURL` prefix that identifies agent-generated stack frames. Admin's copy hardcoded
// `/space-admin-agent-execute/`; promoting that verbatim would have made every onscreen
// error arrive with an empty frame list (its frames say `space-onscreen-agent-execute`) and
// silently strip the stack the owner uses to debug. The prefix is therefore an ARGUMENT —
// used to BUILD the source url and to RECOGNISE agent frames — and no surface identity is
// spelled inside this module.
//
// The skill label is the other injected difference: the two surfaces mark a loaded skill with
// different flags and display different fields, so they pass their own predicate.

export const EXECUTION_WINDOW_ALIAS_KEYS = new Set(["page", "window", "globalThis", "self"]);

export function normalizeExecutionSource(code) {
  return typeof code === "string" ? code.replace(/\r\n/gu, "\n") : "";
}

export function flattenExecutionMessageValue(value) {
  return String(value ?? "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .split("\n")
    .join("\\n");
}

// The executable block's `sourceURL` is the ONE identity both the runtime and the stack
// filter agree on, so it is derived from the injected prefix in one place.
export function buildExecutionSourceUrl(sourceUrlPrefix, runId) {
  return `${sourceUrlPrefix}-${runId}.js`;
}

function executionIsNodeLike(targetWindow, value) {
  return Boolean(targetWindow?.Node && value instanceof targetWindow.Node);
}

function executionIsElementLike(targetWindow, value) {
  return Boolean(targetWindow?.Element && value instanceof targetWindow.Element);
}

export function summarizeExecutionElement(element) {
  const tagName = element.tagName ? element.tagName.toLowerCase() : "element";
  const id = element.id ? `#${element.id}` : "";
  const classNames =
    typeof element.className === "string" && element.className.trim()
      ? `.${element.className.trim().split(/\s+/u).join(".")}`
      : "";

  return `<${tagName}${id}${classNames}>`;
}

export function summarizeExecutionNode(targetWindow, value) {
  if (executionIsElementLike(targetWindow, value)) {
    return summarizeExecutionElement(value);
  }

  if (value.nodeType === targetWindow?.Node?.TEXT_NODE) {
    return `#text(${JSON.stringify((value.textContent || "").trim())})`;
  }

  return `[Node type=${value.nodeType}]`;
}

export function isConstructable(value) {
  if (typeof value !== "function") {
    return false;
  }

  try {
    Reflect.construct(String, [], value);
    return true;
  } catch {
    return false;
  }
}

// Returns the value-rendering family for ONE surface. Everything the renderer needs that
// differs between surfaces arrives as an argument; everything that does not is closed over
// here so both surfaces run the same arithmetic.
export function createExecutionValueFormatters(options = {}) {
  const sourceUrlPrefix = typeof options.sourceUrlPrefix === "string" ? options.sourceUrlPrefix : "";
  const isLoadedSkill = typeof options.isLoadedSkill === "function" ? options.isLoadedSkill : () => false;

  function formatString(value) {
    if (value.length <= EXECUTION_FORMAT_MAX_STRING_LENGTH) {
      return value;
    }

    return `${value.slice(0, EXECUTION_FORMAT_MAX_STRING_LENGTH - 3)}...`;
  }

  function formatEntries(entries, opener, closer, entryOptions) {
    const { depth, seen, targetWindow } = entryOptions;
    const renderedEntries = entries.slice(0, EXECUTION_FORMAT_MAX_COLLECTION_ENTRIES).map(([key, value]) => {
      return `${key}: ${formatExecutionValue(value, {
        depth: depth + 1,
        seen,
        targetWindow
      })}`;
    });

    if (entries.length > EXECUTION_FORMAT_MAX_COLLECTION_ENTRIES) {
      renderedEntries.push("...");
    }

    return `${opener}${renderedEntries.join(", ")}${closer}`;
  }

  function formatArrayLike(values, label, entryOptions) {
    const { depth, seen, targetWindow } = entryOptions;
    const renderedValues = Array.from(values)
      .slice(0, EXECUTION_FORMAT_MAX_COLLECTION_ENTRIES)
      .map((value) =>
        formatExecutionValue(value, {
          depth: depth + 1,
          seen,
          targetWindow
        })
      );

    if (values.length > EXECUTION_FORMAT_MAX_COLLECTION_ENTRIES) {
      renderedValues.push("...");
    }

    return `${label}(${values.length}) [${renderedValues.join(", ")}]`;
  }

  // The stack filter is the ONE place the injected prefix does work beyond naming the
  // source url. A frame belongs to the agent when it carries this surface's prefix; every
  // framework frame is noise the owner never asked to read mid-execution.
  function formatError(error) {
    if (!error) {
      return "";
    }

    const message = `${error.name || "Error"}: ${error.message || String(error)}`;

    if (!error.stack) {
      return message;
    }

    const userFrames = error.stack
      .split("\n")
      .filter((line) => (sourceUrlPrefix ? line.includes(sourceUrlPrefix) : true));

    if (!userFrames.length) {
      return message;
    }

    return [message, ...userFrames].join("\n");
  }

  function formatExecutionValue(value, valueOptions = {}) {
    const { targetWindow, depth = 0, seen = new WeakSet() } = valueOptions;

    if (value === undefined) {
      return "undefined";
    }

    if (value === null) {
      return "null";
    }

    if (typeof value === "string") {
      return formatString(value);
    }

    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }

    if (typeof value === "symbol") {
      return value.toString();
    }

    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }

    if (value instanceof Error) {
      return formatError(value);
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

    if (executionIsNodeLike(targetWindow, value)) {
      return summarizeExecutionNode(targetWindow, value);
    }

    if (Array.isArray(value)) {
      if (depth >= EXECUTION_FORMAT_MAX_DEPTH) {
        return `Array(${value.length})`;
      }

      return formatArrayLike(value, "Array", { depth, seen, targetWindow });
    }

    if (targetWindow?.NodeList && value instanceof targetWindow.NodeList) {
      return formatArrayLike(Array.from(value), "NodeList", { depth, seen, targetWindow });
    }

    if (targetWindow?.HTMLCollection && value instanceof targetWindow.HTMLCollection) {
      return formatArrayLike(Array.from(value), "HTMLCollection", { depth, seen, targetWindow });
    }

    if (value instanceof Map) {
      if (depth >= EXECUTION_FORMAT_MAX_DEPTH) {
        return `Map(${value.size})`;
      }

      return formatEntries(Array.from(value.entries()), "Map { ", " }", { depth, seen, targetWindow });
    }

    if (value instanceof Set) {
      if (depth >= EXECUTION_FORMAT_MAX_DEPTH) {
        return `Set(${value.size})`;
      }

      return formatArrayLike(Array.from(value.values()), "Set", { depth, seen, targetWindow });
    }

    if (typeof value === "object") {
      if (isLoadedSkill(value)) {
        return `[Loaded skill ${value.skillName || value.path}]`;
      }

      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);

      if (depth >= EXECUTION_FORMAT_MAX_DEPTH) {
        return `[${value.constructor?.name || "Object"}]`;
      }

      return formatEntries(Object.entries(value), "{ ", " }", { depth, seen, targetWindow });
    }

    try {
      return String(value);
    } catch (error) {
      return `[Unprintable value: ${error.message}]`;
    }
  }

  function formatExecutionResultValue(value, resultOptions = {}) {
    const { targetWindow } = resultOptions;

    return formatExecutionTranscriptValue(value, {
      formatFallback: (fallbackValue, formatterOptions = {}) =>
        formatExecutionValue(fallbackValue, {
          targetWindow: formatterOptions.targetWindow || targetWindow
        }),
      normalizeSpecialValue: (specialValue) => {
        if (isLoadedSkill(specialValue)) {
          return `[Loaded skill ${specialValue.skillName || specialValue.path}]`;
        }

        return undefined;
      },
      targetWindow
    });
  }

  return {
    formatArrayLike,
    formatEntries,
    formatError,
    formatExecutionResultValue,
    formatExecutionValue,
    formatString,
    isLoadedSkill
  };
}

// ── THE ONE TRANSCRIPT-LINE BUILDER (P4b-2c) ────────────────────────────────────────
//
// Both surfaces turn an execution result into the ordered lines the transcript paints, and
// the skeleton was duplicated: the status line, the console-block loop, the result block,
// the "returned nothing" notice, the error line. What genuinely differs is surface FEATURE,
// so each difference is an injected hook rather than a second body:
//
//   resolveSkills(result)         called ONCE per render; its value is handed to both
//                                 predicates below, so a surface never derives the same
//                                 skill list twice and the two cannot disagree.
//   appendSkillLines(l, r, s)     true means "a skill result is terminal here" — admin
//                                 paints the skill and stops; onscreen paints then keeps
//                                 going.
//   suppressResultBlock(r, s)     a skill return value is not ALSO painted as plain text.
//   suppressEmptyNotice(r, s)     something was painted, so "returned nothing" would lie.
//   appendExtraLines(l, r)        onscreen's stripped-artifact note.
//
// The two suppression questions are SEPARATE on purpose and must not be folded into one.
// Onscreen suppresses its result block only when the RETURNED value is a skill, while it
// suppresses the empty notice whenever ANY skill was collected — including one that arrived
// outside the return value. Collapsing them makes one surface print "returned no result"
// directly under a skill block it has just painted.
export function createExecutionResultLinesFormatter(options = {}) {
  const resolveSkills = typeof options.resolveSkills === "function" ? options.resolveSkills : null;
  const appendSkillLines =
    typeof options.appendSkillLines === "function" ? options.appendSkillLines : null;
  const suppressResultBlock =
    typeof options.suppressResultBlock === "function" ? options.suppressResultBlock : () => false;
  const suppressEmptyNotice =
    typeof options.suppressEmptyNotice === "function" ? options.suppressEmptyNotice : () => false;
  const appendExtraLines = typeof options.appendExtraLines === "function" ? options.appendExtraLines : null;

  return function formatExecutionResultLines(result) {
    const status =
      typeof result?.status === "string" && result.status.trim() ? result.status.trim() : "done";
    const lines = [`execution ${status}`];
    const prints = Array.isArray(result?.logs) ? result.logs : [];
    const skills = resolveSkills ? resolveSkills(result) : null;

    prints.forEach((entry) => {
      const level = typeof entry?.level === "string" && entry.level.trim() ? entry.level.trim() : "log";
      appendExecutionTextBlock(lines, level, entry?.text ?? "");
    });

    if (appendSkillLines && appendSkillLines(lines, result, skills)) {
      return lines;
    }

    if (result?.result !== undefined && !suppressResultBlock(result, skills)) {
      appendExecutionTextBlock(lines, "result", result.resultText);
    }

    if (
      !result?.error?.text &&
      result?.result === undefined &&
      !prints.length &&
      !suppressEmptyNotice(result, skills)
    ) {
      lines.push("execution returned no result and no console logs were printed");
    }

    if (result?.error?.text) {
      lines.push(`error: ${flattenExecutionMessageValue(result.error.text)}`);
    }

    if (appendExtraLines) {
      appendExtraLines(lines, result);
    }

    return lines;
  };
}
