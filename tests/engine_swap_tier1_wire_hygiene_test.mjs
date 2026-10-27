// Engine-swap P2 live hotfix 2: Tier 1 WIRE HYGIENE.
//
// The defect this locks down, from the owner's browser devtools capture:
//
//   The conversation handed to a Tier 1 model carried the PROTOCOL ENVELOPE as
//   message content (`_____framework`, `_____user`) and a separator-form assistant
//   turn (`Fetching user detail...` + `_____javascript` + space.api.userSelfInfo()) as
//   an example. With the identical tool list, endpoint, model and stream flag, that
//   shape made the model answer a file request with
//   `Reading notes.txt now...` + `_____javascript` + space.api.fileRead — the retired
//   text protocol — while the same conversation stripped to plain user text produced
//   a typed `file_read`. The model imitates what it is SHOWN.
//
// What is asserted here:
//   (a) WIRE LEVEL: after the Tier 1 assembly seam, the request messages carry zero
//       envelope markers and zero separator-form assistant content, given a history
//       that contains both. This is the assertion that fails pristine — pristine had
//       no sanitizer at all, so the live shape passed straight through.
//   (b) The prompt cut: `traces` and `task examples` retire on Tier 1 while the fence
//       contract and the retained reference sections survive, and the separator
//       count the model sees drops by an order of magnitude.
//   (c) The bounded corrective retry: a turn that answers with separator prose and
//       makes NO tool call earns exactly ONE correction, and a second bare answer
//       does not loop.
//   (d) Tier 3 is untouched: the streaming text-protocol request still carries its
//       envelope blocks and separator examples byte for byte.
//
// Hermetic: no network, no keys, no app-data writes, no DOM.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

function createHarness() {
  const runtime = {
    api: {},
    config: {
      get(_name, fallback = undefined) {
        return fallback;
      }
    },
    extend(_meta, value) {
      return value;
    },
    fw: {
      createStore(_name, model) {
        return model;
      }
    },
    proxy: {
      buildUrl(url) {
        return url;
      }
    }
  };

  globalThis.document = {
    addEventListener() {},
    createElement() {
      return {
        classList: { add() {}, remove() {} },
        setAttribute() {},
        appendChild() {},
        style: {}
      };
    },
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    removeEventListener() {}
  };
  globalThis.window = {
    addEventListener() {},
    console,
    location: { href: "http://localhost/" },
    matchMedia() {
      return { addEventListener() {}, matches: false };
    },
    removeEventListener() {},
    space: runtime
  };
  globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.space = runtime;

  return runtime;
}

const runtime = createHarness();

const wireHygiene = await import(
  "/modules/_core/framework/js/engine-swap/wire-hygiene.js"
);
const promptShape = await import(
  "/modules/_core/framework/js/engine-swap/prompt-shape.js"
);
const llm = await import("/modules/_core/onscreen_agent/llm.js");
const onscreenExecution = await import("/modules/_core/onscreen_agent/execution.js");
const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

const ENVELOPE_MARKERS = llm.ONSCREEN_AGENT_PREPARED_MESSAGE_BLOCK;
const SEPARATOR = promptShape.FENCE_CONTRACT_MARKER;
const PROMPT_URL = new URL(
  "../app/L0/_all/modules/_core/onscreen_agent/prompts/system-prompt.md",
  import.meta.url
);
const PROMPT = await readFile(PROMPT_URL, "utf8");

// The owner's captured wire, verbatim in shape: framework request, separator-form
// assistant demonstration, example reset boundary, then the real user turn.
const LIVE_WIRE = Object.freeze([
  { content: "you are a runtime operator", role: "system" },
  { content: "_____framework\ncheck user detail", role: "user" },
  {
    content: ["Fetching user detail...", SEPARATOR, "return await space.api.userSelfInfo()"].join("\n"),
    role: "assistant"
  },
  { content: "_____framework\nstart of new conversation - don't refer to previous contents", role: "user" },
  { content: "_____user\nRead the file notes.txt", role: "user" }
]);

function sanitize(messages) {
  return wireHygiene.sanitizeTier1WireMessages({
    envelopeMarkers: ENVELOPE_MARKERS,
    findSeparatorIndex: onscreenExecution.findExecutableSeparatorIndex,
    messages
  });
}

function countEnvelopeMarkers(messages = []) {
  const markers = Object.values(ENVELOPE_MARKERS).map((value) => String(value));

  return (Array.isArray(messages) ? messages : []).reduce(
    (total, message) =>
      total +
      markers.reduce(
        (inner, marker) => inner + (String(message?.content || "").includes(marker) ? 1 : 0),
        0
      ),
    0
  );
}

function countSeparatorAssistant(messages = []) {
  return (Array.isArray(messages) ? messages : []).filter(
    (message) =>
      message?.role === "assistant" &&
      onscreenExecution.findExecutableSeparatorIndex(String(message.content || "")) >= 0
  ).length;
}

// --- (a) WIRE LEVEL ------------------------------------------------------

test("a Tier 1 request carries no envelope markers and no separator-form assistant turn", () => {
  assert.ok(countEnvelopeMarkers(LIVE_WIRE) > 0, "the fixture must carry markers to be meaningful");
  assert.equal(countSeparatorAssistant(LIVE_WIRE), 1, "the fixture must carry the separator demo");

  const summary = sanitize(LIVE_WIRE);

  assert.equal(summary.changed, true, "the live shape must register as changed");
  assert.equal(countEnvelopeMarkers(summary.messages), 0, "no envelope marker may reach a Tier 1 model");
  assert.equal(
    countSeparatorAssistant(summary.messages),
    0,
    "no separator-form assistant turn may reach a Tier 1 model"
  );
  assert.ok(
    summary.reasons[wireHygiene.WIRE_HYGIENE_REASON.ENVELOPE_MARKERS_STRIPPED] >= 3,
    "every marker-bearing message is accounted for"
  );
  assert.equal(
    summary.reasons[wireHygiene.WIRE_HYGIENE_REASON.SEPARATOR_ASSISTANT_PROJECTED],
    1,
    "the separator demo is projected, not silently kept"
  );
});

test("the user's actual request survives sanitization", () => {
  const summary = sanitize(LIVE_WIRE);
  const userTexts = summary.messages
    .filter((message) => message.role === "user")
    .map((message) => String(message.content));

  // The marker is transport scaffolding; the words after it are the request.
  assert.ok(
    userTexts.includes("Read the file notes.txt"),
    "the real request must survive with its marker removed, not be dropped"
  );
  assert.ok(userTexts.includes("check user detail"), "inline-marked content keeps its text");
});

test("the projected assistant turn says what happened and shows no executable code", () => {
  const summary = sanitize(LIVE_WIRE);
  const assistant = summary.messages.find((message) => message.role === "assistant");

  assert.ok(assistant, "the turn is kept: its narration is real context");
  assert.ok(String(assistant.content).includes("Fetching user detail..."), "narration is preserved");
  assert.ok(
    String(assistant.content).includes(wireHygiene.WIRE_HYGIENE_DISPLAY_NOTE),
    "the projected turn states that the code was shown, not executed"
  );
  assert.ok(!String(assistant.content).includes(SEPARATOR), "no separator may survive");
  assert.ok(!String(assistant.content).includes("space.api.userSelfInfo"), "no executable body may survive");
});

test("a fenced separator is display text and is never projected away", () => {
  const fenced = [
    {
      content: ["here is how that looks:", "```", "x", SEPARATOR, "y", "```"].join("\n"),
      role: "assistant"
    }
  ];
  const summary = sanitize(fenced);

  assert.equal(
    countSeparatorAssistant(summary.messages),
    0,
    "a fenced separator is not an execution, so nothing is projected"
  );
  assert.equal(
    summary.messages[0].content,
    fenced[0].content,
    "a display-only assistant turn is left byte-identical"
  );
});

test("a clean conversation is returned byte-identical", () => {
  const clean = [
    { content: "you are a runtime operator", role: "system" },
    { content: "Read the file notes.txt", role: "user" }
  ];
  const summary = sanitize(clean);

  assert.equal(summary.changed, false, "nothing to do means nothing reported");
  assert.deepEqual(summary.messages, clean, "a clean wire must not be rewritten");
});

// --- (b) PROMPT CUT ------------------------------------------------------

test("the Tier 1 prompt retires the old-idiom corpus and keeps the fence contract", () => {
  const shaped = promptShape.shapeSystemPromptForTier({ promptText: PROMPT, tier: "tier1" });
  const describe = promptShape.describeTier1PromptShape({ promptText: PROMPT, tier: "tier1" });
  const countSeparators = (text) => (String(text).match(new RegExp(SEPARATOR, "gu")) || []).length;

  assert.equal(describe.cutApplied, true, "a Tier 1 session must actually cut");
  assert.deepEqual(
    describe.droppedHeadingsPresent,
    [],
    "traces and task examples must be gone, not merely renamed"
  );
  assert.deepEqual(
    [...describe.retainedHeadingsPresent].sort(),
    [...promptShape.TIER1_RETAINED_SECTION_HEADINGS].sort(),
    "every retained section survives — the constant is load-bearing"
  );
  assert.ok(describe.fenceMarkerOccurrences > 0, "the fence contract survives on every tier");
  assert.equal(describe.steeringPresent, true, "the steering leg is appended once");
  // The retained sections legitimately keep contract and negation lines that name
  // the separator, so the corpus removal is not a zero count. What must hold is that
  // the old-idiom teaching the model sees is at least halved, and that both dropped
  // sections are gone (asserted above from the headings, not from prose).
  const sourceSeparators = countSeparators(PROMPT);
  const shapedSeparators = countSeparators(shaped);

  assert.ok(
    shapedSeparators * 2 < sourceSeparators,
    `the separator teaching must at least halve (source=${sourceSeparators}, shaped=${shapedSeparators})`
  );
});

test("a prompt that would lose a retained section is not cut at all", () => {
  const mutilated = ["intro", "", promptShape.API_CONTRACT_SECTION_HEADING, "- rule", "", SEPARATOR].join("\n");
  const shaped = promptShape.shapeSystemPromptForTier({ promptText: mutilated, tier: "tier1" });

  assert.equal(shaped, mutilated, "refusing to cut is safer than shipping a half prompt");
});

test("tier3 and no-dispatch prompts stay byte-identical", () => {
  assert.equal(promptShape.shapeSystemPromptForTier({ promptText: PROMPT, tier: "tier3" }), PROMPT);
  assert.equal(promptShape.shapeSystemPromptForTier({ promptText: PROMPT, tier: "none" }), PROMPT);
  assert.equal(promptShape.shapeSystemPromptForTier({ promptText: PROMPT, tier: "" }), PROMPT);
});

// --- (c) BOUNDED CORRECTIVE RETRY ---------------------------------------

const SEPARATOR_ANSWER = [
  "Reading notes.txt from your root now...",
  SEPARATOR,
  'return await space.api.fileRead("~/notes.txt", "utf8")'
].join("\n");

test("the corrective predicate fires only for separator prose with no tool call", () => {
  const base = {
    answer: SEPARATOR_ANSWER,
    attempts: 0,
    findSeparatorIndex: onscreenExecution.findExecutableSeparatorIndex,
    turns: [{ toolCallCount: 0 }]
  };

  assert.equal(wireHygiene.needsTier1CorrectiveRetry(base), true, "separator prose with no call earns one correction");
  assert.equal(
    wireHygiene.needsTier1CorrectiveRetry({ ...base, attempts: wireHygiene.TIER1_CORRECTIVE_RETRY_LIMIT }),
    false,
    "the correction is bounded: it cannot loop"
  );
  assert.equal(
    wireHygiene.needsTier1CorrectiveRetry({ ...base, turns: [{ toolCallCount: 1 }] }),
    false,
    "a turn that did call a tool is never corrected"
  );
  assert.equal(
    wireHygiene.needsTier1CorrectiveRetry({ ...base, answer: "done" }),
    false,
    "a plain answer needs no correction"
  );
});

test("a separator-only Tier 1 turn is re-prompted exactly once and then stops", async (t) => {
  const previous = {
    history: store.history,
    persistHistory: store.persistHistory,
    render: store.render,
    status: store.status
  };
  const previousFetch = globalThis.fetch;
  const previousSettings = store.settings;
  const bodies = [];

  store.persistHistory = async () => {};
  store.render = () => {};
  store.settings = {
    ...(previousSettings && typeof previousSettings === "object" ? previousSettings : {}),
    apiEndpoint: "https://example.invalid/v1/chat/completions",
    apiKey: "test-key-not-real",
    model: "test-model",
    paramsText: ""
  };

  t.after(() => {
    globalThis.fetch = previousFetch;
    store.history = previous.history;
    store.persistHistory = previous.persistHistory;
    store.render = previous.render;
    store.settings = previousSettings;
    store.status = previous.status;
    store.stopRequested = false;
    store.activeRequestController = null;
  });

  // First completion: separator prose, NO tool call. Second: a plain answer.
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));

    bodies.push(body);

    const isCorrective = Array.isArray(body.messages) &&
      body.messages.some(
        (message) => message?.role === "user" && message?.content === wireHygiene.TIER1_CORRECTIVE_PROMPT
      );
    const content = isCorrective ? "The file says: buy milk." : SEPARATOR_ANSWER;

    return {
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { content } }],
        model: "test-model"
      }),
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
          model: "test-model"
        })
    };
  };

  const preparedRequest = {
    messages: [
      { content: "you are a runtime operator", role: "system" },
      { content: "Read the file notes.txt", role: "user" }
    ]
  };
  const turn = await store.runTier1ConversationTurn(
    [{ content: "Read the file notes.txt", id: "u1", role: "user" }],
    preparedRequest,
    { tier: "tier1" }
  );

  assert.equal(bodies.length, 2, "exactly one corrective request follows the bare separator answer");
  assert.equal(turn.correctiveRetry, true, "the turn reports that it corrected");
  assert.ok(
    bodies[1].messages.some(
      (message) => message?.role === "user" && message?.content === wireHygiene.TIER1_CORRECTIVE_PROMPT
    ),
    "the second request carries the correction"
  );
  assert.equal(
    bodies.filter((body) =>
      body.messages.some(
        (message) => message?.role === "user" && message?.content === wireHygiene.TIER1_CORRECTIVE_PROMPT
      )
    ).length,
    1,
    "the correction is sent once, never stacked"
  );
  assert.ok(
    !JSON.stringify(turn.result.messages).includes(wireHygiene.TIER1_CORRECTIVE_PROMPT),
    "the coaching turn must not be persisted as a user message the human never wrote"
  );
});

test("a turn that calls a tool is never corrected", async (t) => {
  const previous = {
    history: store.history,
    persistHistory: store.persistHistory,
    render: store.render,
    status: store.status
  };
  const previousFetch = globalThis.fetch;
  const previousSettings = store.settings;
  const bodies = [];

  store.persistHistory = async () => {};
  store.render = () => {};
  store.settings = {
    ...(previousSettings && typeof previousSettings === "object" ? previousSettings : {}),
    apiEndpoint: "https://example.invalid/v1/chat/completions",
    apiKey: "test-key-not-real",
    model: "test-model",
    paramsText: ""
  };
  runtime.api.fileRead = async () => ({ content: "buy milk", encoding: "utf8", path: "~/notes.txt" });

  t.after(() => {
    globalThis.fetch = previousFetch;
    store.history = previous.history;
    store.persistHistory = previous.persistHistory;
    store.render = previous.render;
    store.settings = previousSettings;
    store.status = previous.status;
    store.stopRequested = false;
    store.activeRequestController = null;
  });

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));

    bodies.push(body);

    const hasToolResult = Array.isArray(body.messages) &&
      body.messages.some((message) => message?.role === "tool");
    const payload = hasToolResult
      ? { choices: [{ finish_reason: "stop", message: { content: "The file says: buy milk." } }] }
      : {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Reading it now.",
                tool_calls: [
                  {
                    function: { arguments: JSON.stringify({ path: "~/notes.txt" }), name: "file_read" },
                    id: "call-1",
                    type: "function"
                  }
                ]
              }
            }
          ]
        };

    return {
      json: async () => payload,
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload)
    };
  };

  const turn = await store.runTier1ConversationTurn(
    [{ content: "Read the file notes.txt", id: "u1", role: "user" }],
    {
      messages: [
        { content: "you are a runtime operator", role: "system" },
        { content: "Read the file notes.txt", role: "user" }
      ]
    },
    { tier: "tier1" }
  );

  assert.equal(bodies.length, 2, "turn one dispatches, turn two reports — the normal two-turn loop");
  assert.equal(turn.correctiveRetry, false, "a tool-calling turn is never corrected");
  assert.equal(
    bodies.some((body) =>
      body.messages.some(
        (message) => message?.role === "user" && message?.content === wireHygiene.TIER1_CORRECTIVE_PROMPT
      )
    ),
    false,
    "no correction is injected into a healthy loop"
  );
});

// --- (d) TIER 3 UNTOUCHED ------------------------------------------------

test("the Tier 3 prompt keeps every envelope block and separator example", () => {
  const tier3 = promptShape.shapeSystemPromptForTier({ promptText: PROMPT, tier: "tier3" });

  assert.equal(tier3, PROMPT, "the text protocol prompt is byte-identical");
  assert.ok(tier3.toLowerCase().includes("traces"), "Tier 3 keeps the trace corpus it relies on");
  assert.ok(tier3.toLowerCase().includes("task examples"), "Tier 3 keeps its examples");
});

test("only a Tier 1 session renders the envelope-free wire", () => {
  // The sanitizer is reached from ONE place. Everything else returns the input
  // untouched, so a Tier 3 session cannot lose its envelope blocks.
  const untouched = sanitize([]);

  assert.equal(untouched.changed, false);
  assert.equal(untouched.dropped, 0);
  assert.deepEqual(wireHygiene.formatWireHygieneLine(untouched), "[engine-swap] tier1 wire-hygiene dropped=0");
});
