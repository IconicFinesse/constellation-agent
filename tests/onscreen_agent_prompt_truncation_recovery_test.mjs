import assert from "node:assert/strict";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const MOD_ROOT_URL = pathToFileURL(path.join(ROOT_DIR, "app/L0/_all/modules")).href;

// The shared prompt runtime imports browser modules through absolute `/modules/...`
// specifiers. Plain `node --test` cannot resolve those, and this regression must
// stay self-contained so it neither depends on nor collides with any shared
// specifier loader: resolve `/modules/...` to the repo's L0 module root here only.
register(
  "data:text/javascript," +
    encodeURIComponent(
      [
        "export async function resolve(specifier, context, next) {",
        "  if (specifier.startsWith('/modules/')) {",
        `    return next(${JSON.stringify(MOD_ROOT_URL)} + specifier.slice("/modules".length), context);`,
        "  }",
        "  return next(specifier, context);",
        "}"
      ].join("\n")
    )
);

const promiseModulePath = path.join(
  ROOT_DIR,
  "app/L0/_all/modules/_core/agent_prompt/prompt-items.js"
);
const promptItems = await import(pathToFileURL(promiseModulePath).href);

const TRIMMED_PROMPT_ITEM_ID = 4;

function buildWidgetLikeSource(lineCount = 600) {
  return Array.from(
    { length: lineCount },
    (_, index) =>
      `  const handler${index} = () => { render("row-${index}", { value: ${index} }); }; // marker-line-${index}`
  ).join("\n");
}

function parsePlaceholderRange(placeholder) {
  const match = /readLongMessage\(\{id:\s*(\d+),\s*from:\s*(\d+),\s*to:\s*(\d+)\}\)/u.exec(
    placeholder
  );

  assert.ok(match, `placeholder should carry a readLongMessage range: ${placeholder}`);

  return {
    from: Number(match[2]),
    id: Number(match[1]),
    to: Number(match[3])
  };
}

function trimWidgetSource() {
  const fullText = buildWidgetLikeSource();
  const trimmed = promptItems.trimPromptLongMessage(fullText, {
    id: TRIMMED_PROMPT_ITEM_ID,
    minimumVisibleChars: 48,
    removeChars: 30_000
  });

  assert.ok(trimmed.removedChars > 0, "fixture should actually be trimmed");
  assert.ok(
    trimmed.text.includes(trimmed.placeholder),
    "trimmed text should carry the placeholder between head and tail"
  );

  return { fullText, trimmed };
}

function createChatRuntime(fullText, trimmedText) {
  const runtime = promptItems.installPromptItemAccess({});
  runtime.__setPromptItems([
    {
      content: trimmedText,
      fullText,
      id: TRIMMED_PROMPT_ITEM_ID
    }
  ]);
  return runtime;
}

test("long-message placeholder discloses the real removed range instead of a fixed head window", () => {
  const { trimmed } = trimWidgetSource();
  const range = parsePlaceholderRange(trimmed.placeholder);
  const placeholderOffset = trimmed.text.indexOf(trimmed.placeholder);

  assert.equal(range.id, TRIMMED_PROMPT_ITEM_ID);
  assert.equal(
    range.from,
    placeholderOffset,
    "placeholder should point at the character offset where the removed span starts"
  );
  assert.ok(range.from > 0, "removed span must not claim to start at the beginning of the text");
  assert.equal(
    range.to - range.from,
    trimmed.removedChars,
    "placeholder range should span exactly the removed characters"
  );
});

test("following the placeholder instruction recovers the removed middle verbatim", () => {
  const { fullText, trimmed } = trimWidgetSource();
  const runtime = createChatRuntime(fullText, trimmed.text);
  const range = parsePlaceholderRange(trimmed.placeholder);
  const recovered = runtime.readLongMessage({ from: range.from, id: range.id, to: range.to });

  assert.equal(
    recovered,
    fullText.slice(range.from, range.to),
    "documented read should return the removed span exactly"
  );
  assert.notEqual(
    recovered,
    fullText.slice(0, range.to - range.from),
    "documented read must not degrade to a plain head slice of the source"
  );
});

test("visible head plus documented recovery reconstructs each source exactly", () => {
  for (const removeChars of [4_000, 30_000, 44_000]) {
    const fullText = buildWidgetLikeSource();
    const trimmed = promptItems.trimPromptLongMessage(fullText, {
      id: TRIMMED_PROMPT_ITEM_ID,
      minimumVisibleChars: 48,
      removeChars
    });
    const runtime = createChatRuntime(fullText, trimmed.text);
    const placeholderOffset = trimmed.text.indexOf(trimmed.placeholder);
    const range = parsePlaceholderRange(trimmed.placeholder);
    const head = trimmed.text.slice(0, placeholderOffset);
    const tail = trimmed.text.slice(placeholderOffset + trimmed.placeholder.length);
    const recovered = runtime.readLongMessage({ from: range.from, id: range.id, to: range.to });

    assert.equal(head + recovered + tail, fullText, `reconstruction failed at removeChars=${removeChars}`);
  }
});

test("a from-only long-message read returns a bounded window instead of an empty string", () => {
  const { fullText, trimmed } = trimWidgetSource();
  const runtime = createChatRuntime(fullText, trimmed.text);
  const range = parsePlaceholderRange(trimmed.placeholder);
  const windowed = runtime.readLongMessage({ from: range.from, id: range.id });

  assert.equal(
    windowed,
    fullText.slice(range.from, Math.min(fullText.length, range.from + 10_000)),
    "from-only read should return a predictable window, not nothing"
  );
  assert.ok(windowed.length > 0, "from-only read should not be empty past the default cap");
});

test("placeholder output stays byte-identical when no removed offset is supplied", () => {
  assert.equal(
    promptItems.buildPromptLongMessagePlaceholder({ id: 7, removedChars: 42 }),
    "<<42 characters removed to optimize context, read with space.chat.readLongMessage({id: 7, from: 0, to:10000})>>"
  );
  assert.equal(
    promptItems.buildPromptLongMessagePlaceholder({ id: 7, removedChars: 42, removedFrom: 900 }),
    "<<42 characters removed to optimize context, read with space.chat.readLongMessage({id: 7, from: 900, to:942})>>"
  );
});
