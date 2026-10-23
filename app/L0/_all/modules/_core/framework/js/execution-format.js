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
