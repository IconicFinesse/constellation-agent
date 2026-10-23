const NUMBER_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u;
const YAML_DIRECTIVE_START_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

export class SimpleYamlError extends Error {
  constructor(reason, lineNumber) {
    super(lineNumber ? `Invalid YAML on line ${lineNumber}: ${reason}` : `Invalid YAML: ${reason}`);
    this.name = "SimpleYamlError";
    this.reason = reason;
    this.lineNumber = lineNumber ?? null;
  }
}

function createYamlError(reason, lineNumber) {
  return new SimpleYamlError(reason, lineNumber);
}

function normalizeYamlSource(sourceText) {
  return String(sourceText ?? "").replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

function normalizeMultilineString(value) {
  return String(value ?? "").replace(/\r\n?/gu, "\n");
}

function getLeadingWhitespace(value) {
  const match = String(value || "").match(/^\s*/u);
  return match ? match[0] : "";
}

function createSourceLines(sourceText) {
  return normalizeYamlSource(sourceText).split("\n").map((rawLine, index) => {
    const lineNumber = index + 1;
    const leadingWhitespace = getLeadingWhitespace(rawLine);

    if (leadingWhitespace.includes("\t")) {
      throw createYamlError("tabs are not supported; use spaces for indentation", lineNumber);
    }

    return {
      content: rawLine.slice(leadingWhitespace.length),
      indent: leadingWhitespace.length,
      lineNumber,
      rawLine,
      trimmed: rawLine.trim()
    };
  });
}

function isIgnorableLine(line) {
  return !line || !line.trimmed || line.trimmed.startsWith("#") || line.trimmed === "---" || line.trimmed === "...";
}

function nextMeaningfulIndex(lines, index) {
  let nextIndex = index;

  while (nextIndex < lines.length && isIgnorableLine(lines[nextIndex])) {
    nextIndex += 1;
  }

  return nextIndex;
}

function withTopLevelTracking(text, onCharacter) {
  let quote = "";
  let depth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const previousCharacter = text[index - 1] || "";

    if (quote) {
      if (character === quote && previousCharacter !== "\\") {
        quote = "";
      }

      onCharacter({
        character,
        depth,
        inQuote: true,
        index
      });
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      onCharacter({
        character,
        depth,
        inQuote: true,
        index
      });
      continue;
    }

    if (character === "[" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth = Math.max(depth - 1, 0);
    }

    onCharacter({
      character,
      depth,
      inQuote: false,
      index
    });
  }
}

function findTopLevelColon(text) {
  let separatorIndex = -1;

  withTopLevelTracking(text, ({ character, depth, inQuote, index }) => {
    if (separatorIndex !== -1 || inQuote || depth !== 0 || character !== ":") {
      return;
    }

    separatorIndex = index;
  });

  return separatorIndex;
}

function splitTopLevel(text, separator, lineNumber) {
  const parts = [];
  let partStart = 0;

  withTopLevelTracking(text, ({ character, depth, inQuote, index }) => {
    if (inQuote || depth !== 0 || character !== separator) {
      return;
    }

    parts.push(text.slice(partStart, index).trim());
    partStart = index + 1;
  });

  const trailingPart = text.slice(partStart).trim();

  if (trailingPart) {
    parts.push(trailingPart);
  }

  if (!parts.length && text.trim()) {
    parts.push(text.trim());
  }

  if (parts.some((part) => !part)) {
    throw createYamlError(`unexpected "${separator}" separator`, lineNumber);
  }

  return parts;
}

function stripInlineComment(value) {
  let commentIndex = -1;

  withTopLevelTracking(value, ({ character, depth, inQuote, index }) => {
    if (commentIndex !== -1 || inQuote || depth !== 0 || character !== "#") {
      return;
    }

    const previousCharacter = value[index - 1] || "";

    if (!previousCharacter || /\s/u.test(previousCharacter)) {
      commentIndex = index;
    }
  });

  return commentIndex === -1 ? value : value.slice(0, commentIndex);
}

function parseQuotedString(value, lineNumber) {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw createYamlError("invalid double-quoted string", lineNumber);
    }
  }

  if (!value.endsWith("'")) {
    throw createYamlError("invalid single-quoted string", lineNumber);
  }

  return value.slice(1, -1).replace(/''/gu, "'");
}

function normalizeObjectKey(keyText, lineNumber) {
  const normalizedKey = keyText.trim();

  if (!normalizedKey) {
    throw createYamlError("missing key before ':'", lineNumber);
  }

  if (
    (normalizedKey.startsWith('"') && normalizedKey.endsWith('"')) ||
    (normalizedKey.startsWith("'") && normalizedKey.endsWith("'"))
  ) {
    return parseQuotedString(normalizedKey, lineNumber);
  }

  return normalizedKey;
}

function parseInlineArray(value, lineNumber, parseValueToken) {
  const inner = value.slice(1, -1).trim();

  if (!inner) {
    return [];
  }

  return splitTopLevel(inner, ",", lineNumber).map((part) => parseValueToken(part, lineNumber));
}

function parseInlineObject(value, lineNumber, parseValueToken) {
  const inner = value.slice(1, -1).trim();

  if (!inner) {
    return {};
  }

  return splitTopLevel(inner, ",", lineNumber).reduce((result, entry) => {
    const separatorIndex = findTopLevelColon(entry);

    if (separatorIndex === -1) {
      throw createYamlError("inline objects must use key: value pairs", lineNumber);
    }

    const key = normalizeObjectKey(entry.slice(0, separatorIndex), lineNumber);
    const rawValue = entry.slice(separatorIndex + 1).trim();
    result[key] = parseValueToken(rawValue, lineNumber);
    return result;
  }, {});
}

function parseValueToken(rawValue, lineNumber) {
  const value = stripInlineComment(String(rawValue || "")).trim();

  if (!value.length) {
    return null;
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return parseQuotedString(value, lineNumber);
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    return parseInlineArray(value, lineNumber, parseValueToken);
  }

  if (value.startsWith("{") && value.endsWith("}")) {
    return parseInlineObject(value, lineNumber, parseValueToken);
  }

  if (/^(?:true|false)$/iu.test(value)) {
    return value.toLowerCase() === "true";
  }

  if (/^(?:null|~)$/iu.test(value)) {
    return null;
  }

  if (NUMBER_PATTERN.test(value)) {
    return Number(value);
  }

  return value;
}

function matchBlockScalarHeader(rawValue) {
  return stripInlineComment(String(rawValue || "").trim()).match(/^([|>])([+-]?)$/u);
}

function isListItemContent(text) {
  return text === "-" || text.startsWith("- ");
}

function isCompactMapContent(text) {
  if (!text || text.startsWith("[") || text.startsWith("{") || text.startsWith('"') || text.startsWith("'")) {
    return false;
  }

  if (YAML_DIRECTIVE_START_PATTERN.test(text)) {
    return false;
  }

  return findTopLevelColon(text) !== -1;
}

function detectChildIndent(lines, index, parentIndent) {
  const nextIndex = nextMeaningfulIndex(lines, index);

  if (nextIndex < lines.length && lines[nextIndex].indent > parentIndent) {
    return lines[nextIndex].indent;
  }

  return parentIndent + 2;
}

function applyBlockChomp(value, chompMode) {
  if (chompMode === "-") {
    return value.replace(/\n+$/u, "");
  }

  if (chompMode === "+") {
    return value;
  }

  if (!value) {
    return "";
  }

  return value.replace(/\n+$/u, "\n");
}

function foldBlockLines(lines) {
  if (!lines.length) {
    return "";
  }

  let folded = "";

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index];
    const nextLine = lines[index + 1];

    folded += currentLine;

    if (nextLine === undefined) {
      continue;
    }

    if (!currentLine || !nextLine || currentLine.startsWith(" ") || nextLine.startsWith(" ")) {
      folded += "\n";
      continue;
    }

    folded += " ";
  }

  return folded;
}

function parseBlockScalar(lines, index, parentIndent, rawValue, lineNumber) {
  const headerMatch = matchBlockScalarHeader(rawValue);

  if (!headerMatch) {
    throw createYamlError("invalid block scalar header", lineNumber);
  }

  const blockStyle = headerMatch[1];
  const chompMode = headerMatch[2] || "";
  const collectedLines = [];
  let workingIndex = index;
  let blockIndent = null;

  while (workingIndex < lines.length) {
    const line = lines[workingIndex];

    if (!line.trimmed) {
      collectedLines.push({
        blank: true,
        rawLine: line.rawLine
      });
      workingIndex += 1;
      continue;
    }

    if (line.indent <= parentIndent) {
      break;
    }

    blockIndent = blockIndent == null ? line.indent : Math.min(blockIndent, line.indent);
    collectedLines.push({
      blank: false,
      indent: line.indent,
      rawLine: line.rawLine
    });
    workingIndex += 1;
  }

  const normalizedLines = collectedLines.map((entry) => {
    if (entry.blank) {
      return "";
    }

    const stripLength = Math.min(blockIndent ?? 0, entry.rawLine.length);
    return entry.rawLine.slice(stripLength);
  });

  let value = "";

  if (normalizedLines.length) {
    const body = blockStyle === ">" ? foldBlockLines(normalizedLines) : normalizedLines.join("\n");
    value = `${body}\n`;
  }

  return {
    nextIndex: workingIndex,
    value: applyBlockChomp(value, chompMode)
  };
}

function parseMapEntry(lines, logicalIndent, content, lineNumber, nextIndex, parseNode) {
  const separatorIndex = findTopLevelColon(content);

  if (separatorIndex === -1) {
    throw createYamlError("expected a key: value pair", lineNumber);
  }

  const key = normalizeObjectKey(content.slice(0, separatorIndex), lineNumber);
  const rawValue = content.slice(separatorIndex + 1).trim();

  if (!rawValue.length) {
    const nestedIndex = nextMeaningfulIndex(lines, nextIndex);

    if (nestedIndex < lines.length && lines[nestedIndex].indent > logicalIndent) {
      const nested = parseNode(nestedIndex, lines[nestedIndex].indent);
      return {
        key,
        nextIndex: nested.nextIndex,
        value: nested.value
      };
    }

    return {
      key,
      nextIndex,
      value: null
    };
  }

  const blockScalar = matchBlockScalarHeader(rawValue);

  if (blockScalar) {
    const parsedBlock = parseBlockScalar(lines, nextIndex, logicalIndent, rawValue, lineNumber);
    return {
      key,
      nextIndex: parsedBlock.nextIndex,
      value: parsedBlock.value
    };
  }

  return {
    key,
    nextIndex,
    value: parseValueToken(rawValue, lineNumber)
  };
}

function createParser(lines) {
  function parseNode(index, indent) {
    const nextIndex = nextMeaningfulIndex(lines, index);
    const currentLine = lines[nextIndex];

    if (!currentLine) {
      return {
        nextIndex,
        value: null
      };
    }

    if (currentLine.indent < indent) {
      return {
        nextIndex,
        value: null
      };
    }

    if (isListItemContent(currentLine.content)) {
      return parseList(nextIndex, indent);
    }

    if (findTopLevelColon(currentLine.content) !== -1) {
      return parseMap(nextIndex, indent);
    }

    return {
      nextIndex: nextIndex + 1,
      value: parseValueToken(currentLine.content, currentLine.lineNumber)
    };
  }

  function parseMap(index, indent, options = {}) {
    const result = {};
    const firstEntryContent = options.firstEntryContent ?? null;
    const firstLineNumber = options.firstLineNumber ?? null;
    let workingIndex = index;

    if (firstEntryContent != null) {
      const firstEntry = parseMapEntry(lines, indent, firstEntryContent, firstLineNumber, workingIndex, parseNode);
      result[firstEntry.key] = firstEntry.value;
      workingIndex = firstEntry.nextIndex;
    }

    while (true) {
      workingIndex = nextMeaningfulIndex(lines, workingIndex);

      if (workingIndex >= lines.length) {
        break;
      }

      const line = lines[workingIndex];

      if (line.indent < indent) {
        break;
      }

      if (line.indent > indent) {
        throw createYamlError("unexpected indentation", line.lineNumber);
      }

      if (isListItemContent(line.content)) {
        throw createYamlError("list item found where a key: value pair was expected", line.lineNumber);
      }

      const entry = parseMapEntry(lines, indent, line.content, line.lineNumber, workingIndex + 1, parseNode);
      result[entry.key] = entry.value;
      workingIndex = entry.nextIndex;
    }

    return {
      nextIndex: workingIndex,
      value: result
    };
  }

  function parseListItem(logicalIndent, content, lineNumber, nextIndex) {
    const rawValue = content === "-" ? "" : content.slice(1).trimStart();

    if (!rawValue.length) {
      const nestedIndex = nextMeaningfulIndex(lines, nextIndex);

      if (nestedIndex < lines.length && lines[nestedIndex].indent > logicalIndent) {
        const nested = parseNode(nestedIndex, lines[nestedIndex].indent);
        return {
          nextIndex: nested.nextIndex,
          value: nested.value
        };
      }

      return {
        nextIndex,
        value: null
      };
    }

    const blockScalar = matchBlockScalarHeader(rawValue);

    if (blockScalar) {
      return parseBlockScalar(lines, nextIndex, logicalIndent, rawValue, lineNumber);
    }

    if (isListItemContent(rawValue)) {
      const childIndent = detectChildIndent(lines, nextIndex, logicalIndent);
      return parseList(nextIndex, childIndent, {
        firstItemContent: rawValue,
        firstLineNumber: lineNumber
      });
    }

    if (isCompactMapContent(rawValue)) {
      const childIndent = detectChildIndent(lines, nextIndex, logicalIndent);
      return parseMap(nextIndex, childIndent, {
        firstEntryContent: rawValue,
        firstLineNumber: lineNumber
      });
    }

    return {
      nextIndex,
      value: parseValueToken(rawValue, lineNumber)
    };
  }

  function parseList(index, indent, options = {}) {
    const result = [];
    const firstItemContent = options.firstItemContent ?? null;
    const firstLineNumber = options.firstLineNumber ?? null;
    let workingIndex = index;

    if (firstItemContent != null) {
      const firstItem = parseListItem(indent, firstItemContent, firstLineNumber, workingIndex);
      result.push(firstItem.value);
      workingIndex = firstItem.nextIndex;
    }

    while (true) {
      workingIndex = nextMeaningfulIndex(lines, workingIndex);

      if (workingIndex >= lines.length) {
        break;
      }

      const line = lines[workingIndex];

      if (line.indent < indent) {
        break;
      }

      if (line.indent > indent) {
        throw createYamlError("unexpected indentation", line.lineNumber);
      }

      if (!isListItemContent(line.content)) {
        throw createYamlError("expected a list item beginning with '- '", line.lineNumber);
      }

      const item = parseListItem(indent, line.content, line.lineNumber, workingIndex + 1);
      result.push(item.value);
      workingIndex = item.nextIndex;
    }

    return {
      nextIndex: workingIndex,
      value: result
    };
  }

  return {
    parseNode
  };
}

export function parseYamlDocument(sourceText) {
  const lines = createSourceLines(sourceText);
  const startIndex = nextMeaningfulIndex(lines, 0);

  if (startIndex >= lines.length) {
    return null;
  }

  const parser = createParser(lines);
  const firstLine = lines[startIndex];
  let parsed;

  if (isListItemContent(firstLine.content)) {
    parsed = parser.parseNode(startIndex, firstLine.indent);
  } else if (findTopLevelColon(firstLine.content) !== -1) {
    parsed = parser.parseNode(startIndex, firstLine.indent);
  } else {
    parsed = {
      nextIndex: startIndex + 1,
      value: parseValueToken(firstLine.content, firstLine.lineNumber)
    };
  }

  const trailingIndex = nextMeaningfulIndex(lines, parsed.nextIndex);

  if (trailingIndex < lines.length) {
    throw createYamlError("unexpected extra content", lines[trailingIndex].lineNumber);
  }

  return parsed.value;
}

export function parseYamlScalarValue(sourceText) {
  const normalized = normalizeYamlSource(sourceText).trim();

  if (!normalized) {
    return "";
  }

  return parseValueToken(normalized, 1);
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function needsQuotedString(value) {
  if (!value.length) {
    return true;
  }

  if (value !== value.trim()) {
    return true;
  }

  if (/^(?:true|false|null|~)$/iu.test(value)) {
    return true;
  }

  if (NUMBER_PATTERN.test(value)) {
    return true;
  }

  if (value.startsWith("- ") || value === "-" || value.startsWith("? ") || value.startsWith(": ")) {
    return true;
  }

  if (value.startsWith("[") || value.startsWith("{") || value.startsWith("]") || value.startsWith("}")) {
    return true;
  }

  if (/[#:,\[\]\{\}]/u.test(value)) {
    return true;
  }

  return false;
}

function serializeObjectKey(key) {
  const normalizedKey = String(key);
  return needsQuotedString(normalizedKey) ? JSON.stringify(normalizedKey) : normalizedKey;
}

function serializeScalar(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot serialize non-finite numbers as YAML");
    }

    return String(value);
  }

  if (typeof value === "bigint") {
    return String(value);
  }

  const normalized = String(value);
  return needsQuotedString(normalized) ? JSON.stringify(normalized) : normalized;
}

function createBlockScalarSerialization(value, indent) {
  const normalized = normalizeMultilineString(value);
  const trailingNewlineMatch = normalized.match(/\n*$/u);
  const trailingNewlines = trailingNewlineMatch ? trailingNewlineMatch[0].length : 0;
  const chompMode = trailingNewlines === 0 ? "-" : trailingNewlines === 1 ? "" : "+";
  const header = `|${chompMode}`;
  const bodyLines = trailingNewlines > 0 ? normalized.split("\n").slice(0, -1) : normalized.split("\n");
  const bodyIndent = " ".repeat(indent + 2);
  const body = bodyLines.map((line) => `${bodyIndent}${line}`).join("\n");

  return {
    body,
    header
  };
}

function serializeNode(value, indent) {
  if (Array.isArray(value)) {
    return serializeArray(value, indent);
  }

  if (isPlainObject(value)) {
    return serializeObject(value, indent);
  }

  if (typeof value === "string" && value.includes("\n")) {
    const block = createBlockScalarSerialization(value, indent);
    return block.body ? `${block.header}\n${block.body}` : block.header;
  }

  return serializeScalar(value);
}

function serializeObject(source, indent) {
  const entries = Object.entries(source);

  if (!entries.length) {
    return "{}";
  }

  return entries.map(([key, value]) => serializeObjectEntry(key, value, indent)).join("\n");
}

function serializeObjectEntry(key, value, indent) {
  const prefix = `${" ".repeat(indent)}${serializeObjectKey(key)}:`;

  if (value === null || value === undefined) {
    return prefix;
  }

  if (typeof value === "string" && value.includes("\n")) {
    const block = createBlockScalarSerialization(value, indent);
    return block.body ? `${prefix} ${block.header}\n${block.body}` : `${prefix} ${block.header}`;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return `${prefix} []`;
    }

    return `${prefix}\n${serializeArray(value, indent + 2)}`;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);

    if (!entries.length) {
      return `${prefix} {}`;
    }

    return `${prefix}\n${serializeObject(value, indent + 2)}`;
  }

  return `${prefix} ${serializeScalar(value)}`;
}

function serializeArray(source, indent) {
  if (!source.length) {
    return "[]";
  }

  return source.map((value) => serializeArrayItem(value, indent)).join("\n");
}

function serializeArrayItem(value, indent) {
  const prefix = `${" ".repeat(indent)}-`;

  if (value === null || value === undefined) {
    return prefix;
  }

  if (typeof value === "string" && value.includes("\n")) {
    const block = createBlockScalarSerialization(value, indent);
    return block.body ? `${prefix} ${block.header}\n${block.body}` : `${prefix} ${block.header}`;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return `${prefix} []`;
    }

    return `${prefix}\n${serializeArray(value, indent + 2)}`;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);

    if (!entries.length) {
      return `${prefix} {}`;
    }

    return `${prefix}\n${serializeObject(value, indent + 2)}`;
  }

  return `${prefix} ${serializeScalar(value)}`;
}

export function serializeYamlDocument(source) {
  const serialized = serializeNode(source ?? {}, 0);

  if (!serialized) {
    return "\n";
  }

  return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}

export function parseYamlScalar(value) {
  return parseYamlScalarValue(value);
}

export function parseSimpleYaml(sourceText) {
  const parsed = parseYamlDocument(sourceText);

  return parsed === null || parsed === undefined ? {} : parsed;
}

export function serializeSimpleYaml(source) {
  return serializeYamlDocument(source ?? {});
}
