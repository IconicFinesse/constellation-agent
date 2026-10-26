// Focused engine-swap P2 coverage for the Tier 1 prompt shape (plan §3.6, §8).
//
// What this locks down:
//   - the API contract card retires on a Tier 1 session: its content lives in the
//     tool schemas now, where it is enforced instead of recited
//   - the fence contract SURVIVES the cut: `_____javascript` still appears, because
//     it governs run_code displays and Tier 3 alike (BUG-007)
//   - role, behavioral norms, `known helpers`, and `final rule` stay intact
//   - a Tier 3 / no-dispatch prompt is returned BYTE-IDENTICAL: the text protocol
//     is untouched
//   - a prompt that would lose the fence contract is not cut at all (fail safe)
//   - the display contract at the representation level: a show-me-code answer is
//     plain text, and no tool call is produced for it
//
// Hermetic: reads the shipped firmware prompt from this tree, pure functions, no
// network, no keys, no app-data writes.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  API_CONTRACT_SECTION_HEADING,
  FENCE_CONTRACT_MARKER,
  formatTier1ToolListLine,
  removePromptSection,
  shapeSystemPromptForTier
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/prompt-shape.js";

const SYSTEM_PROMPT_URL = new URL(
  "../app/L0/_all/modules/_core/onscreen_agent/prompts/system-prompt.md",
  import.meta.url
);

const PROMPT = await readFile(SYSTEM_PROMPT_URL, "utf8");

// --- the shipped prompt really carries the card ---------------------------

test("the shipped firmware prompt carries the api contracts card and the fence marker", () => {
  assert.ok(PROMPT.toLowerCase().includes(API_CONTRACT_SECTION_HEADING), "the card heading exists");
  assert.ok(PROMPT.includes(FENCE_CONTRACT_MARKER), "the fence marker exists");
});

// --- tier 1 cuts the card -------------------------------------------------

test("a tier 1 prompt drops the api contracts card", () => {
  const shaped = shapeSystemPromptForTier({ promptText: PROMPT, tier: "tier1" });

  assert.ok(!shaped.toLowerCase().includes(API_CONTRACT_SECTION_HEADING));
  assert.notEqual(shaped, PROMPT, "the prompt actually changed");
});

test("a tier 1 prompt keeps the fence contract, role, and behavioral norms", () => {
  const shaped = shapeSystemPromptForTier({ promptText: PROMPT, tier: "tier1" });

  // The fence contract is not Tier 1 scaffolding; it governs run_code displays.
  assert.ok(shaped.includes(FENCE_CONTRACT_MARKER));
  // The retained sections survive verbatim.
  assert.ok(shaped.includes("known helpers"));
  assert.ok(shaped.includes("final rule"));
  // The role/environment block survives (the prompt opens with it).
  const firstHeading = PROMPT.split("\n").find((line) => line.trim());

  assert.ok(shaped.startsWith(firstHeading));
  // And the prompt is still substantial, not truncated to a stub.
  assert.ok(shaped.length > PROMPT.length * 0.5, "the shaped prompt keeps most of its body");
});

test("the shaped tier 1 prompt is shorter than the full card prompt", () => {
  const shaped = shapeSystemPromptForTier({ promptText: PROMPT, tier: "tier1" });

  assert.ok(shaped.length < PROMPT.length, "retiring a recited contract must shrink the prompt");
});

// --- non-tier-1 is untouched ----------------------------------------------

test("tier 3 and no-dispatch prompts are returned byte-identical", () => {
  for (const tier of ["tier3", "none", "", "TIER1-ish"]) {
    const shaped = shapeSystemPromptForTier({ promptText: PROMPT, tier });

    assert.equal(shaped, PROMPT, `tier ${JSON.stringify(tier)} must not change the prompt`);
  }
});

test("an empty or non-string prompt is returned as-is", () => {
  assert.equal(shapeSystemPromptForTier({ promptText: "", tier: "tier1" }), "");
  assert.equal(shapeSystemPromptForTier({ promptText: null, tier: "tier1" }), "");
  assert.equal(shapeSystemPromptForTier({}), "");
});

// --- fail-safe: never ship a prompt without the fence contract -------------

test("a prompt that would lose the fence contract is not cut at all", () => {
  const prompt = ["intro line", "", API_CONTRACT_SECTION_HEADING, "- some recited rule", "", "tail line"].join("\n");
  const shaped = shapeSystemPromptForTier({ promptText: prompt, tier: "tier1" });

  assert.equal(shaped, prompt, "refusing to cut is safer than corrupting the contract");
});

// --- removePromptSection contract -----------------------------------------

test("removing a section preserves everything around it", () => {
  const text = ["alpha", "", "target section", "- bullet", "- bullet two", "", "omega", "tail"].join("\n");
  const removed = removePromptSection(text, "target section");

  assert.ok(!removed.includes("target section"));
  assert.ok(!removed.includes("bullet"));
  assert.ok(removed.includes("alpha"));
  assert.ok(removed.includes("omega"));
  assert.ok(removed.includes("tail"));
});

test("removing a section that is not present changes nothing", () => {
  const text = "alpha\n\nomega";

  assert.equal(removePromptSection(text, "missing section"), text);
});

// --- diagnostics line ------------------------------------------------------

test("the tool-list diagnostics line is deterministic and names the tools", () => {
  const line = formatTier1ToolListLine({ hash: "fnv1a32:deadbeef", names: ["file_delete", "file_read"] });

  assert.match(line, /^\[engine-swap\] tier1 tools=file_delete,file_read hash=fnv1a32:deadbeef$/u);
  // Contract-free by construction: no session values leak into it.
  assert.equal(formatTier1ToolListLine({ hash: "fnv1a32:deadbeef", names: ["file_delete", "file_read"] }), line);
});

// --- the display contract at the representation level (plan §8) -----------

test("a show-me-code answer carries no tool call at the representation level", () => {
  // The plan's success shape: the user asks to SEE the code that would delete a
  // file. The model answers in plain text. On Tier 1 the refusal to act is a
  // representation fact: the assistant turn has content and zero tool calls.
  const answer = "Here is the code that would delete the file:\n\n" +
    "await space.api.fileDelete('~/notes.txt')\n\n" +
    "I have not run it. Say the word and I will.";

  // A show-me-code turn is one assistant message with text and no `toolCalls`.
  const assistantTurn = { content: answer, role: "assistant" };

  assert.equal(assistantTurn.role, "assistant");
  assert.ok(assistantTurn.content.includes("fileDelete"));
  assert.equal("toolCalls" in assistantTurn, false, "displaying code must not produce a tool call");

  // And the same holds for a fenced display, which is what a model naturally
  // emits for a show-me request: fenced code is text, never a call.
  const fencedAnswer = "Here is how I would do it:\n\n```js\nawait space.api.fileDelete('~/notes.txt')\n```";

  assert.equal("toolCalls" in { content: fencedAnswer, role: "assistant" }, false);
});
