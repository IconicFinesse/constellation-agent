import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const {
  installPromptItemAccess,
  normalizePromptItemDefinition,
  stringifyPromptItemValue
} = await import("../app/L0/_all/mod/_core/agent_prompt/prompt-items.js");
const { countTextTokens } = await import("../app/L0/_all/mod/_core/framework/js/token-count.js");

test("stringifyPromptItemValue joins array entries with blank lines", () => {
  assert.equal(
    stringifyPromptItemValue([
      "alpha",
      "beta\nline",
      "",
      null
    ]),
    [
      "alpha",
      "beta\nline"
    ].join("\n\n")
  );
});

test("normalizePromptItemDefinition caches value token counts on prompt items", () => {
  const item = normalizePromptItemDefinition("demo:item", {
    heading: "Demo",
    value: "alpha beta gamma"
  });

  assert.equal(item?.valueTokenCount, countTextTokens("alpha beta gamma"));
});

test("installPromptItemAccess keeps full prompt text private and exposes long-message reads", () => {
  const chatRuntime = {};

  installPromptItemAccess(chatRuntime);
  chatRuntime.__setPromptItems([
    {
      content: "abc<<3 characters removed to optimize context>>xyz",
      fullText: "abcdefghijklmnopqrstuvwxyz",
      heading: "demo",
      id: 7,
      key: "demo:item",
      tokens: 12
    }
  ]);

  assert.equal(Array.isArray(chatRuntime.promptItems), true);
  assert.equal(chatRuntime.promptItems.length, 1);
  assert.equal(Object.hasOwn(chatRuntime.promptItems[0], "fullText"), false);
  assert.equal(chatRuntime.promptItems[0].id, 7);
  assert.equal(chatRuntime.readLongMessage({ id: 7, from: 2, to: 7 }), "cdefg");
});
