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
import {
  canonicalMessagesToOpenAi,
  createUserMessage
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/canonical.js";
import {
  TOOL_TURN_STOP_REASON,
  runToolTurn
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/tool-turn-loop.js";
import { extractToolCallsFromCompletion } from "../app/L0/_all/modules/_core/framework/js/engine-swap/tier1-session.js";

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
//
// P2 audit note 4: the previous version of this test asserted on a literal object
// it had just constructed two lines above, so it could never fail. It now drives
// the REAL loop with a scripted text-only completion and inspects the assembled
// message tail, which is what would have to change for display text to manufacture
// a call.

// The display turn is driven through the REAL chain the product uses: a provider
// completion payload goes through `extractToolCallsFromCompletion`, then the loop,
// then the canonical->wire transform. Anything that fabricates a call from display
// text — extraction included — shows up in the assembled tail.
async function runFencedDisplayTurn(displayText) {
  const requests = [];
  const payload = {
    choices: [
      {
        finish_reason: "stop",
        message: { content: displayText, tool_calls: [] }
      }
    ]
  };
  const extracted = extractToolCallsFromCompletion(payload);
  const result = await runToolTurn({
    dispatch: {
      async dispatchToolCall() {
        throw new Error("a display turn must never dispatch");
      }
    },
    history: [createUserMessage("show me the code that would delete my notes file")],
    sendTurn: async ({ messages }) => {
      requests.push(messages);
      // The loop receives exactly what extraction produced, as in the live path.
      return extracted;
    },
    tools: [{ name: "file_delete" }]
  });

  return { extracted, requests, result };
}

for (const [label, displayText] of [
  [
    "an unfenced show-me-code answer",
    "Here is the code that would delete the file:\n\n" +
      "await space.api.fileDelete('~/notes.txt')\n\n" +
      "I have not run it. Say the word and I will."
  ],
  [
    "a fenced show-me-code answer",
    "Here is how I would do it:\n\n```js\nawait space.api.fileDelete('~/notes.txt')\n```"
  ]
]) {
  test(`${label} carries no tool call at the representation level`, async () => {
    const { extracted, requests, result } = await runFencedDisplayTurn(displayText);

    assert.equal(result.reason, TOOL_TURN_STOP_REASON.ANSWERED);
    assert.equal(requests.length, 1, "a display turn is one request and one answer");

    // (0) The extraction step itself must not read fenced display text as a call.
    assert.equal(
      extracted.toolCalls.length,
      0,
      "extraction must not manufacture a tool call from display text"
    );

    // (a) The assembled tail: no assistant message may carry calls.
    const withCalls = result.messages.filter(
      (message) => Array.isArray(message.toolCalls) && message.toolCalls.length
    );

    assert.deepEqual(withCalls, [], "displaying code must never produce a tool call message");

    // (b) ...and nothing manufactures a `tool_calls` key on the WIRE either.
    const wire = canonicalMessagesToOpenAi(result.messages);

    assert.equal(
      wire.some((message) => "tool_calls" in message),
      false,
      "no assistant wire message may carry tool_calls for a display turn"
    );

    // The display text itself survives verbatim — this is a representation test,
    // not a content filter.
    const final = result.messages[result.messages.length - 1];

    assert.equal(final.role, "assistant");
    assert.equal(final.content, displayText);
  });
}
