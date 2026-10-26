import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const previousSpace = globalThis.space;
globalThis.space = {
  extend(_meta, value) {
    return value;
  }
};

test.after(() => {
  if (previousSpace === undefined) {
    delete globalThis.space;
  } else {
    globalThis.space = previousSpace;
  }
});

const executionModule = await import("../app/L0/_all/modules/_core/onscreen_agent/execution.js");
const adminExecutionModule = await import("../app/L0/_all/modules/_core/admin/views/agent/execution.js");
const boundaryModule = await import("../app/L0/_all/modules/_core/onscreen_agent/turn-boundary.js");
const sharedModule = await import("../app/L0/_all/modules/_core/framework/js/execution-blocks.js");

const SEP = "_____javascript";
const FENCE = "```";
const MARKER = "__bug007ExecutedCount";

function createFakeTargetWindow() {
  return {
    console: {
      debug: () => {},
      dir: () => {},
      error: () => {},
      info: () => {},
      log: () => {},
      table: () => {},
      warn: () => {}
    }
  };
}

// Executed code runs inside a scoped proxy where globalThis aliases the target
// window, so execution markers land on the fake window rather than on the test
// process's own globalThis. Track the window in use and read markers from there.
let activeTargetWindow = null;

function createTrackedTargetWindow() {
  const targetWindow = createFakeTargetWindow();
  activeTargetWindow = targetWindow;
  delete targetWindow[MARKER];
  return targetWindow;
}

function createContext() {
  return executionModule.createExecutionContext({
    targetWindow: createTrackedTargetWindow()
  });
}

function createAdminContext() {
  return adminExecutionModule.createExecutionContext({
    targetWindow: createTrackedTargetWindow()
  });
}

// Every executed body increments a global counter, so "did anything run" is an
// observable fact rather than an inference from result counts.
function body(label = "hit") {
  return `globalThis.${MARKER} = (globalThis.${MARKER} || 0) + 1; return "EXECUTED:${label}"`;
}

function resetMarker() {
  delete globalThis[MARKER];

  if (activeTargetWindow) {
    delete activeTargetWindow[MARKER];
  }
}

function executions() {
  return (activeTargetWindow && activeTargetWindow[MARKER]) || globalThis[MARKER] || 0;
}

async function runLines(context, lines) {
  return context.executeFromContent(lines.join("\n"));
}

function planErrors(results) {
  return results.filter((result) => result.status === "error" && result.error?.name === "ExecutionPlanError");
}

// ---------------------------------------------------------------------------
// Parser table: the report's S-rows as the unit spec.
// S2-S6, S8, S10 must not be extracted; S1 and S9 must be unchanged.
// ---------------------------------------------------------------------------

const FENCED_DISPLAY_SHAPES = {
  "S2 fenced display, fence closes, reply ends": ["Here is the block:", `${FENCE}javascript`, SEP, "return 1", FENCE],
  "S3 fenced display, fence never closes": ["Here is the block:", `${FENCE}javascript`, SEP, "return 1"],
  "S4 fenced display plus prose after": ["Here is the block:", `${FENCE}javascript`, SEP, "return 1", FENCE, "That is what it would do."],
  "S5 fenced display with indented separator": ["Here is the block:", FENCE, `  ${SEP}`, "return 1", FENCE],
  "S6 two fenced display blocks": ["Two examples:", `${FENCE}js`, SEP, "return 1", FENCE, "", `${FENCE}js`, SEP, "return 2", FENCE],
  "S10 fence closes after a blank line": ["Here is the block:", `${FENCE}javascript`, SEP, "return 1", "", FENCE],
  "tilde fence display": ["Here is the block:", "~~~javascript", SEP, "return 1", "~~~"],
  "quoted fence in prose discussion": [
    "The display form looks like this:",
    `${FENCE}text`,
    SEP,
    "await space.api.fileWrite(\"~/notes.txt\", \"x\")",
    FENCE,
    "and it creates nothing when it is fenced."
  ]
};

for (const [name, lines] of Object.entries(FENCED_DISPLAY_SHAPES)) {
  test(`parser: ${name} is display text, not an execution block`, () => {
    const blocks = executionModule.extractExecuteBlocks(lines.join("\n"));
    assert.equal(blocks.length, 0);
  });
}

test("parser: S1 normal unfenced execution is still extracted", () => {
  const content = ["Saving now.", SEP, "return 1"].join("\n");
  const blocks = executionModule.extractExecuteBlocks(content);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].code.trim(), "return 1");
});

test("parser: S9 real execution whose body contains a fence inside a string is unchanged", () => {
  const content = ["Running now.", SEP, `const fence = "${FENCE}"`, "return fence"].join("\n");
  const blocks = executionModule.extractExecuteBlocks(content);

  assert.equal(blocks.length, 1);
  assert.match(blocks[0].code, /const fence = "```"/u);
});

test("parser: a fenced display followed by a real unfenced execution still runs the real one", () => {
  const content = [
    "Here is the display:",
    `${FENCE}js`,
    SEP,
    "return 1",
    FENCE,
    "Now the real one:",
    SEP,
    "return 2"
  ].join("\n");
  const blocks = executionModule.extractExecuteBlocks(content);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].code.trim(), "return 2");
});

test("parser: separator accounting ignores fenced occurrences", () => {
  const twoFenced = ["Two examples:", `${FENCE}js`, SEP, "return 1", FENCE, `${FENCE}js`, SEP, "return 2", FENCE].join("\n");
  const fencedAndReal = ["Here is the display:", `${FENCE}js`, SEP, "return 1", FENCE, "Now the real one:", SEP, "return 2"].join("\n");

  assert.equal(sharedModule.countExecutionSeparators(twoFenced, SEP), 0);
  assert.equal(sharedModule.countExecutionSeparators(fencedAndReal, SEP), 1);
  assert.equal(sharedModule.hasExecutableExecutionSeparator(twoFenced, SEP), false);
  assert.equal(sharedModule.hasExecutableExecutionSeparator(fencedAndReal, SEP), true);
});

test("parser: inline separator detection ignores fenced occurrences", () => {
  const fencedInline = ["Example:", `${FENCE}text`, `staging ${SEP}`, FENCE].join("\n");
  const realInline = `Saving now ${SEP}\nreturn 1`;

  assert.equal(sharedModule.hasInlineExecutionSeparator(fencedInline, SEP), false);
  assert.equal(sharedModule.hasInlineExecutionSeparator(realInline, SEP), true);
});

// ---------------------------------------------------------------------------
// Execution level: acceptance fixtures a-f. Nothing in a fence may execute.
// ---------------------------------------------------------------------------

for (const [name, lines] of Object.entries(FENCED_DISPLAY_SHAPES)) {
  test(`acceptance: ${name} executes nothing and produces no plan error`, async () => {
    resetMarker();
    const results = await runLines(createContext(), [...lines]);

    assert.equal(results.length, 0);
    assert.equal(executions(), 0);
    assert.equal(planErrors(results).length, 0);
  });
}

test("acceptance (a): a fenced show-me-code of a write block neither runs nor plans", async () => {
  resetMarker();
  const results = await runLines(createContext(), [
    "Showing you the block, not running it:",
    `${FENCE}javascript`,
    SEP,
    body("write"),
    FENCE
  ]);

  assert.equal(results.length, 0);
  assert.equal(executions(), 0);
});

test("acceptance (b): a fenced show-me-code of a delete block leaves the target untouched", async () => {
  resetMarker();
  const results = await runLines(createContext(), [
    "This is what a delete would look like:",
    `${FENCE}javascript`,
    SEP,
    `globalThis.${MARKER} = -1; return "DELETED"`,
    FENCE
  ]);

  assert.equal(results.length, 0);
  assert.equal(globalThis[MARKER], undefined);
});

test("acceptance (c): an unterminated fence is display, fail safe", async () => {
  resetMarker();
  const results = await runLines(createContext(), [
    "Here is the block:",
    `${FENCE}javascript`,
    SEP,
    body("unterminated")
  ]);

  assert.equal(results.length, 0);
  assert.equal(executions(), 0);
});

test("acceptance (d): a separator inside a quoted fence in prose attempts no execution and no plan error", async () => {
  resetMarker();
  const results = await runLines(createContext(), [
    "The token is written like this:",
    `${FENCE}text`,
    SEP,
    FENCE,
    "and everything after it would be the body."
  ]);

  assert.equal(results.length, 0);
  assert.equal(executions(), 0);
  assert.equal(planErrors(results).length, 0);
});

test("acceptance (e): S9 regression, a real execution with a fence inside a string still runs", async () => {
  resetMarker();
  const results = await runLines(createContext(), [
    "Running now.",
    SEP,
    `const fence = "${FENCE}"`,
    `globalThis.${MARKER} = (globalThis.${MARKER} || 0) + 1; return "EXECUTED:" + fence`
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "success");
  assert.equal(results[0].result, "EXECUTED:```");
  assert.equal(executions(), 1);
});

test("acceptance (f): normal unfenced executions are unchanged", async () => {
  resetMarker();
  const results = await runLines(createContext(), ["Saving now.", SEP, body("normal")]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "success");
  assert.equal(results[0].result, "EXECUTED:normal");
  assert.equal(executions(), 1);
});

// ---------------------------------------------------------------------------
// BUG-006 regression shapes: the shipped fixes must keep their behavior.
// ---------------------------------------------------------------------------

test("BUG-006: a leaked closing-tag trailer is still stripped and noted", async () => {
  const results = await runLines(createContext(), [
    "Saving the file now...",
    SEP,
    "return \"saved\"",
    "</parameter>"
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "success");
  assert.equal(results[0].result, "saved");
  assert.deepEqual(results[0].removedArtifactLines, ["</parameter>"]);
});

test("BUG-006: a trailing fence-marker line inside a real execution is still stripped", async () => {
  const results = await runLines(createContext(), [
    "Saving the file now...",
    SEP,
    "return \"fenced\"",
    "```js"
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "success");
  assert.deepEqual(results[0].removedArtifactLines, ["```js"]);
});

test("BUG-006: two unfenced separators still produce the at-most-once plan correction", async () => {
  const results = await runLines(createContext(), [
    "Saving now...",
    SEP,
    "return 1",
    SEP,
    "return 2"
  ]);

  assert.equal(results.length, 1);
  assert.equal(planErrors(results).length, 1);
  assert.match(results[0].error.message, /at most once/u);
});

test("BUG-006: an unfenced inline separator still produces the own-line plan correction", async () => {
  resetMarker();
  const results = await runLines(createContext(), ["Saving the file now..." + SEP, body("inline")]);

  assert.equal(results.length, 1);
  assert.equal(planErrors(results).length, 1);
  assert.match(results[0].error.message, /on its own line/u);
  assert.equal(executions(), 0);
});

test("BUG-006: a fenced dump with no separator still produces no execution results", async () => {
  const results = await runLines(createContext(), [
    "Here is the code:",
    "```js",
    "return await space.api.fileList(\"~/\")",
    "```"
  ]);

  assert.equal(results.length, 0);
});

// ---------------------------------------------------------------------------
// Queued-boundary helper: a fenced display is not pending execution output.
// ---------------------------------------------------------------------------

test("boundary: a fenced display does not clear a queued follow-up", () => {
  const display =
    "Here is the block:\n```javascript\n" +
    SEP +
    "\nreturn await space.api.userSelfInfo()\n```";

  assert.equal(boundaryModule.hasOnscreenAgentExecutionSeparator(display), false);
  assert.equal(boundaryModule.resolveOnscreenAgentBoundaryAfterAssistantResponse("queued", display), "queued");
});

test("boundary: a real unfenced execution still clears a queued follow-up", () => {
  const execution = "Checking the current state now...\n" + SEP + "\nreturn await space.api.userSelfInfo()";

  assert.equal(boundaryModule.hasOnscreenAgentExecutionSeparator(execution), true);
  assert.equal(boundaryModule.resolveOnscreenAgentBoundaryAfterAssistantResponse("queued", execution), "");
});

// ---------------------------------------------------------------------------
// Admin surface: the second implementation carries the same contract.
// ---------------------------------------------------------------------------

test("admin: a fenced display executes nothing", async () => {
  resetMarker();
  const results = await runLines(createAdminContext(), [
    "Here is the block:",
    `${FENCE}javascript`,
    SEP,
    body("admin-display"),
    FENCE
  ]);

  assert.equal(results.length, 0);
  assert.equal(executions(), 0);
});

test("admin: a normal unfenced execution still runs", async () => {
  resetMarker();
  const results = await runLines(createAdminContext(), ["Saving now.", SEP, body("admin-real")]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "success");
  assert.equal(executions(), 1);
});

test("admin: two unfenced separators produce the at-most-once plan correction instead of running", async () => {
  resetMarker();
  const results = await runLines(createAdminContext(), ["Two:", SEP, body("one"), SEP, body("two")]);

  assert.equal(results.length, 1);
  assert.equal(planErrors(results).length, 1);
  assert.match(results[0].error.message, /at most once/u);
  assert.equal(executions(), 0);
});

test("admin: an inline separator produces the own-line plan correction instead of a silent no-op", async () => {
  resetMarker();
  const results = await runLines(createAdminContext(), ["Staging..." + SEP, body("admin-inline")]);

  assert.equal(results.length, 1);
  assert.equal(planErrors(results).length, 1);
  assert.match(results[0].error.message, /on its own line/u);
  assert.equal(executions(), 0);
});
