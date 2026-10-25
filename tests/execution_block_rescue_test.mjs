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

function createContext() {
  return executionModule.createExecutionContext({
    targetWindow: createFakeTargetWindow()
  });
}

function runContent(context, lines) {
  return context.executeFromContent(lines.join("\n"));
}

test("a leaked closing-tag trailer is stripped at compile time, executes, and the removal is noted", async () => {
  const context = createContext();
  const results = await runContent(context, [
    "Saving the file now...",
    "_____javascript",
    "return \"saved\"",
    "</parameter>"
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "success");
  assert.equal(results[0].result, "saved");
  assert.deepEqual(results[0].removedArtifactLines, ["</parameter>"]);

  const formatted = executionModule.formatExecutionResultsMessage(results);
  assert.match(formatted, /execution success/u);
  assert.match(formatted, /note: removed trailing non-JavaScript line: <\/parameter>/u);
});

test("a trailing fence marker line is stripped and noted too", async () => {
  const context = createContext();
  const results = await runContent(context, [
    "Saving the file now...",
    "_____javascript",
    "return \"fenced\"",
    "```js"
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "success");
  assert.deepEqual(results[0].removedArtifactLines, ["```js"]);
});

test("stacked trailers are all stripped and recorded", async () => {
  const context = createContext();
  const results = await runContent(context, [
    "Saving the file now...",
    "_____javascript",
    "return \"stacked\"",
    "",
    "</invoke>",
    "</parameter>"
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "success");
  assert.deepEqual(results[0].removedArtifactLines, ["</invoke>", "</parameter>"]);
});

test("valid code with embedded tag text is never stripped or altered", async () => {
  const context = createContext();
  const results = await runContent(context, [
    "Saving the file now...",
    "_____javascript",
    "return \"kept </parameter> inline\""
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "success");
  assert.deepEqual(results[0].removedArtifactLines, []);
});

test("a compile error the strip cannot fix still surfaces as an error with no removal", async () => {
  const context = createContext();
  const results = await runContent(context, [
    "Saving the file now...",
    "_____javascript",
    "return {",
    "</parameter>"
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "error");
  assert.match(results[0].error.message, /Unexpected/u);
  assert.deepEqual(results[0].removedArtifactLines, []);
});

test("separator used twice still produces the at-most-once plan correction", async () => {
  const context = createContext();
  const results = await runContent(context, [
    "Saving the file now...",
    "_____javascript",
    "return \"first\"",
    "_____javascript",
    "return \"second\""
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "error");
  assert.match(results[0].error.message, /at most once/u);
});

test("an inline separator still produces the own-line plan correction", async () => {
  const context = createContext();
  const results = await runContent(context, [
    "Saving the file now..._____javascript",
    "return \"inline\""
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "error");
  assert.match(results[0].error.message, /on its own line/u);
});

test("a fenced dump with no separator produces no execution results", async () => {
  const context = createContext();
  const results = await runContent(context, [
    "Here is the code:",
    "```js",
    "return await space.api.fileList(\"~/\")",
    "```"
  ]);

  assert.deepEqual(results, []);
});
