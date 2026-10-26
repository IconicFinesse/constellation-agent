// Shared execution-block extraction for first-party agent surfaces.
//
// The display/execute contract is fence-based: a code block the agent wants the
// user to *see* lives inside a fenced region, and an execution block is never
// fenced. Fence tracking applies only to the separator decision that starts a
// block. Once a separator wins, its body is the remainder of the message
// verbatim and is never fence-scanned, because executed code may legitimately
// contain fence-like text (a template literal holding ``` for example).
//
// Unterminated fences fail safe: everything from the opening fence to the end of
// the message counts as display, so a display can never become an execution
// because a closing fence was forgotten.

// CommonMark-style fence opener: up to three leading spaces, then three or more
// backticks or tildes, then an optional info string.
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

function splitLinesWithOffsets(content) {
  const lines = [];
  let index = 0;

  while (index <= content.length) {
    const newlineIndex = content.indexOf("\n", index);
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex;
    const rawText = content.slice(index, lineEnd);
    const text = rawText.endsWith("\r") ? rawText.slice(0, -1) : rawText;

    lines.push({ end: lineEnd, start: index, text });

    if (newlineIndex === -1) {
      break;
    }

    index = newlineIndex + 1;
  }

  return lines;
}

// Returns the fenced regions of a message as [start, end) index ranges. A region
// opens at the fence line and closes at the matching closing fence line. An
// unterminated fence runs to the end of the message.
export function collectExecutionFenceRegions(content) {
  if (typeof content !== "string" || !content) {
    return [];
  }

  const regions = [];
  const lines = splitLinesWithOffsets(content);
  let openFence = null;

  for (const line of lines) {
    const match = FENCE_LINE_PATTERN.exec(line.text);

    if (!openFence) {
      if (!match) {
        continue;
      }

      const marker = match[1];
      const info = match[2] || "";

      // A backtick fence's info string may not contain a backtick; that keeps
      // inline code such as ```a``` from opening a region.
      if (marker[0] === "`" && info.includes("`")) {
        continue;
      }

      openFence = { char: marker[0], length: marker.length, start: line.start };
      continue;
    }

    if (!match) {
      continue;
    }

    const marker = match[1];
    const info = match[2] || "";

    if (marker[0] !== openFence.char || marker.length < openFence.length || info.trim()) {
      continue;
    }

    regions.push({ end: line.end, start: openFence.start });
    openFence = null;
  }

  if (openFence) {
    regions.push({ end: content.length, start: openFence.start });
  }

  return regions;
}

function isIndexInsideFence(regions, index) {
  if (!regions.length) {
    return false;
  }

  for (const region of regions) {
    if (index >= region.start && index < region.end) {
      return true;
    }
  }

  return false;
}

function findLineStart(content, index) {
  let lineStart = index;

  while (lineStart > 0 && content[lineStart - 1] !== "\n" && content[lineStart - 1] !== "\r") {
    lineStart -= 1;
  }

  return lineStart;
}

function findLineEnd(content, index) {
  let lineEnd = index;

  while (lineEnd < content.length && content[lineEnd] !== "\n" && content[lineEnd] !== "\r") {
    lineEnd += 1;
  }

  return lineEnd;
}

function isSeparatorLine(content, separatorIndex, separator) {
  const lineStart = findLineStart(content, separatorIndex);
  const lineEnd = findLineEnd(content, separatorIndex + separator.length);

  return (
    !content.slice(lineStart, separatorIndex).trim() &&
    !content.slice(separatorIndex + separator.length, lineEnd).trim()
  );
}

function getCodeStart(content, separatorIndex, separator) {
  let codeStart = findLineEnd(content, separatorIndex + separator.length);

  if (content.startsWith("\r\n", codeStart)) {
    codeStart += 2;
  } else if (content[codeStart] === "\n" || content[codeStart] === "\r") {
    codeStart += 1;
  }

  return codeStart;
}

function normalizeSeparator(separator) {
  return typeof separator === "string" ? separator : "";
}

// Finds the first separator that is outside every fence and alone on its line.
// A separator inside a fence is display text and never starts an execution.
export function findExecutionBlock(content, separator) {
  const normalizedSeparator = normalizeSeparator(separator);

  if (typeof content !== "string" || !content.trim() || !normalizedSeparator) {
    return null;
  }

  const regions = collectExecutionFenceRegions(content);
  let searchIndex = 0;

  while (searchIndex < content.length) {
    const separatorIndex = content.indexOf(normalizedSeparator, searchIndex);

    if (separatorIndex === -1) {
      return null;
    }

    if (
      !isIndexInsideFence(regions, separatorIndex) &&
      isSeparatorLine(content, separatorIndex, normalizedSeparator)
    ) {
      const index = findLineStart(content, separatorIndex);
      const codeStart = getCodeStart(content, separatorIndex, normalizedSeparator);

      return {
        code: content.slice(codeStart),
        codeStart,
        index,
        leadingText: content.slice(0, index).trim(),
        raw: content.slice(index)
      };
    }

    searchIndex = separatorIndex + normalizedSeparator.length;
  }

  return null;
}

export function extractExecuteBlocks(content, separator) {
  const block = findExecutionBlock(content, separator);
  return block ? [block] : [];
}

// Counts only separators that could start an execution. Fenced separators are
// display text, so a reply may both show a block and run one.
export function countExecutionSeparators(content, separator) {
  const normalizedSeparator = normalizeSeparator(separator);

  if (typeof content !== "string" || !content || !normalizedSeparator) {
    return 0;
  }

  const regions = collectExecutionFenceRegions(content);
  let count = 0;
  let searchIndex = 0;

  while (searchIndex < content.length) {
    const separatorIndex = content.indexOf(normalizedSeparator, searchIndex);

    if (separatorIndex === -1) {
      break;
    }

    if (!isIndexInsideFence(regions, separatorIndex)) {
      count += 1;
    }

    searchIndex = separatorIndex + normalizedSeparator.length;
  }

  return count;
}

// True when an executable separator appears with other text on its line.
export function hasInlineExecutionSeparator(content, separator) {
  const normalizedSeparator = normalizeSeparator(separator);

  if (typeof content !== "string" || !content || !normalizedSeparator) {
    return false;
  }

  const regions = collectExecutionFenceRegions(content);
  let searchIndex = 0;

  while (searchIndex < content.length) {
    const separatorIndex = content.indexOf(normalizedSeparator, searchIndex);

    if (separatorIndex === -1) {
      return false;
    }

    if (
      !isIndexInsideFence(regions, separatorIndex) &&
      !isSeparatorLine(content, separatorIndex, normalizedSeparator)
    ) {
      return true;
    }

    searchIndex = separatorIndex + normalizedSeparator.length;
  }

  return false;
}

// Index of the first separator outside every fence, or -1. UI helpers that
// split a reply at the separator use this so a fenced display is never cut in
// half at a token that was only being shown.
export function findExecutableSeparatorIndex(content, separator) {
  const normalizedSeparator = normalizeSeparator(separator);

  if (typeof content !== "string" || !content || !normalizedSeparator) {
    return -1;
  }

  const regions = collectExecutionFenceRegions(content);
  let searchIndex = 0;

  while (searchIndex < content.length) {
    const separatorIndex = content.indexOf(normalizedSeparator, searchIndex);

    if (separatorIndex === -1) {
      return -1;
    }

    if (!isIndexInsideFence(regions, separatorIndex)) {
      return separatorIndex;
    }

    searchIndex = separatorIndex + normalizedSeparator.length;
  }

  return -1;
}

// True when the message carries a separator that can start an execution. This is
// the display-aware replacement for a bare substring test.
export function hasExecutableExecutionSeparator(content, separator) {
  return findExecutableSeparatorIndex(content, separator) !== -1;
}
