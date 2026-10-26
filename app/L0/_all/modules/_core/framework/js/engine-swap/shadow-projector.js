// Shadow projection: what Tier 1 would have called, derived from what Tier 3
// actually executed (contract: ca.shadow-diff/1).
//
// P1 has no dispatch and no live Tier 1 turn, so the build side must assemble
// the Tier 1 call list deterministically from the executed block bodies. That
// projection is the machinery this phase exists to prove.
//
// The projection is deliberately bounded and honest:
//
//   - a direct `<space.api>.<method>(<object literal>)` call maps to its typed
//     tool when the method is in the launch inventory
//   - a method that is not a launch tool still produces a call, marked
//     unregistered, which the classifier buckets as `unmapped`
//   - anything the projector cannot read with certainty (computed arguments,
//     string concatenation, spread, function calls, several statements whose
//     shape it does not recognize) becomes ONE `run_code` call. That is the
//     expected `fallback-run-code` class, never a failure
//
// The projector never evaluates the code it reads. Arguments are read with a
// small literal parser for JSON-shaped values only; an unparsable argument list
// falls back to `run_code` instead of guessing.

import { createToolRegistry } from "./tool-registry.js";
import { firstLineOfCode } from "./shadow-normalize.js";

const API_CALL_PATTERN = /\bspace\s*\.\s*api\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/gu;

// Launch inventory method map. Anything not listed here is projected as an
// unregistered call so drift between a new API method and the registry is
// visible as `unmapped` rather than silently absorbed.
export const API_METHOD_TO_TOOL = Object.freeze({
  fileDelete: "file_delete",
  fileList: "file_list",
  fileRead: "file_read",
  fileWrite: "file_write"
});

function createLiteralParser(text) {
  const input = String(text ?? "");
  let index = 0;

  function fail() {
    throw new Error("unsupported literal");
  }

  function skipWhitespace() {
    while (index < input.length && /\s/u.test(input[index])) {
      index += 1;
    }
  }

  function parseString() {
    const quote = input[index];
    index += 1;

    let value = "";

    while (index < input.length) {
      const char = input[index];

      if (char === "\\") {
        const next = input[index + 1];
        const escapes = { n: "\n", r: "\r", t: "\t" };

        value += escapes[next] ?? next ?? "";
        index += 2;
        continue;
      }

      if (char === quote) {
        index += 1;
        return value;
      }

      value += char;
      index += 1;
    }

    return fail();
  }

  function parseNumber() {
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(input.slice(index));

    if (!match) {
      return fail();
    }

    index += match[0].length;
    return Number(match[0]);
  }

  function parseIdentifier() {
    const match = /^[A-Za-z_$][\w$]*/u.exec(input.slice(index));

    if (!match) {
      return fail();
    }

    index += match[0].length;
    return match[0];
  }

  function parseArray() {
    index += 1;

    const values = [];

    skipWhitespace();

    if (input[index] === "]") {
      index += 1;
      return values;
    }

    for (;;) {
      values.push(parseValue());
      skipWhitespace();

      if (input[index] === ",") {
        index += 1;
        skipWhitespace();

        if (input[index] === "]") {
          index += 1;
          return values;
        }

        continue;
      }

      if (input[index] === "]") {
        index += 1;
        return values;
      }

      return fail();
    }
  }

  function parseObject() {
    index += 1;

    const value = {};

    skipWhitespace();

    if (input[index] === "}") {
      index += 1;
      return value;
    }

    for (;;) {
      skipWhitespace();

      const key = input[index] === '"' || input[index] === "'" ? parseString() : parseIdentifier();

      skipWhitespace();

      if (input[index] !== ":") {
        return fail();
      }

      index += 1;
      value[key] = parseValue();
      skipWhitespace();

      if (input[index] === ",") {
        index += 1;
        skipWhitespace();

        if (input[index] === "}") {
          index += 1;
          return value;
        }

        continue;
      }

      if (input[index] === "}") {
        index += 1;
        return value;
      }

      return fail();
    }
  }

  function parseValue() {
    skipWhitespace();

    const char = input[index];

    if (char === "{") {
      return parseObject();
    }

    if (char === "[") {
      return parseArray();
    }

    if (char === '"' || char === "'") {
      return parseString();
    }

    if (char === "-" || (char >= "0" && char <= "9")) {
      return parseNumber();
    }

    if (input.startsWith("true", index)) {
      index += 4;
      return true;
    }

    if (input.startsWith("false", index)) {
      index += 5;
      return false;
    }

    if (input.startsWith("null", index)) {
      index += 4;
      return null;
    }

    return fail();
  }

  const parsed = parseValue();

  skipWhitespace();

  if (index !== input.length) {
    fail();
  }

  return parsed;
}

// Reads a JSON-shaped object literal, or null when the text is not one.
export function parseLiteralArguments(text) {
  try {
    const value = createLiteralParser(text);

    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function extractArgumentText(code, openParenIndex) {
  let depth = 0;
  let quote = "";

  for (let index = openParenIndex; index < code.length; index += 1) {
    const char = code[index];

    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }

      if (char === quote) {
        quote = "";
      }

      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;

      if (depth === 0) {
        return code.slice(openParenIndex + 1, index);
      }
    }
  }

  return null;
}

// Every `<space.api>.<method>(...)` occurrence, in source order.
export function collectApiCalls(code) {
  const text = String(code ?? "");
  const calls = [];

  API_CALL_PATTERN.lastIndex = 0;

  let match = API_CALL_PATTERN.exec(text);

  while (match) {
    const openParenIndex = match.index + match[0].length - 1;
    const argumentText = extractArgumentText(text, openParenIndex);

    calls.push({
      argumentText,
      method: match[1],
      start: match.index
    });

    match = API_CALL_PATTERN.exec(text);
  }

  return calls;
}

function runCodeCall(block, seq) {
  return {
    arguments: {
      code: String(block?.code ?? ""),
      intent: firstLineOfCode(block?.code)
    },
    registered: true,
    seq,
    sourceBlockSeq: block.seq,
    tool: "run_code"
  };
}

// Projects one executed block into zero-or-more Tier 1 calls. Never throws on
// unrecognized code: that is what the fallback class is for.
export function projectBlockToCalls(block, { registry = null, startSeq = 0 } = {}) {
  const activeRegistry = registry || createToolRegistry();
  const apiCalls = collectApiCalls(block?.code);

  if (!apiCalls.length) {
    return [runCodeCall(block, startSeq)];
  }

  const projected = [];

  for (const apiCall of apiCalls) {
    const toolName = API_METHOD_TO_TOOL[apiCall.method];

    if (!toolName) {
      projected.push({
        arguments: { method: apiCall.method },
        registered: false,
        seq: startSeq + projected.length,
        sourceBlockSeq: block.seq,
        tool: `space.api.${apiCall.method}`
      });
      continue;
    }

    const parsedArguments = parseLiteralArguments(apiCall.argumentText);

    if (!parsedArguments) {
      // A recognized method with arguments the projector cannot read safely:
      // fall back to run_code for this call rather than inventing an args object.
      projected.push(runCodeCall(block, startSeq + projected.length));
      continue;
    }

    projected.push({
      arguments: parsedArguments,
      registered: activeRegistry.get(toolName) !== null,
      seq: startSeq + projected.length,
      sourceBlockSeq: block.seq,
      tool: toolName
    });
  }

  return projected;
}

// Projects a whole turn: blocks in execution order, calls in source order.
export function projectTurnToCalls(tier3Blocks, { registry = null } = {}) {
  const calls = [];

  (Array.isArray(tier3Blocks) ? tier3Blocks : []).forEach((block) => {
    calls.push(...projectBlockToCalls(block, { registry, startSeq: calls.length }));
  });

  return calls;
}
