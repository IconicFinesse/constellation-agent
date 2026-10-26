// Focused engine-swap P1 coverage for the shadow projector.
//
// The projector is how P1 produces "what Tier 1 would have called" without any
// dispatch: it reads executed block bodies. Its honesty rules are the contract:
//
//   - a direct space.api call with a readable object literal maps to its tool
//   - several such calls in one block project in source order
//   - an unregistered method projects as an unregistered call (-> unmapped)
//   - unreadable arguments or no recognizable call project ONE run_code call
//   - the projector never evaluates code, so a block full of side effects
//     leaves no trace beyond the projected record
//
// Hermetic: pure functions, no execution, no network, no filesystem.

import assert from "node:assert/strict";
import test from "node:test";

import {
  API_METHOD_TO_TOOL,
  collectApiCalls,
  parseLiteralArguments,
  projectBlockToCalls,
  projectTurnToCalls
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/shadow-projector.js";

test("the api-method map covers exactly the four typed file tools", () => {
  assert.deepEqual(Object.keys(API_METHOD_TO_TOOL).sort(), ["fileDelete", "fileList", "fileRead", "fileWrite"]);
  assert.deepEqual(Object.values(API_METHOD_TO_TOOL).sort(), ["file_delete", "file_list", "file_read", "file_write"]);
});

test("a direct fileWrite call projects to a file_write call with parsed args", () => {
  const calls = projectBlockToCalls({
    code: "return await space.api.fileWrite({ path: '~/notes.txt', content: 'hi', operation: 'append' });",
    seq: 0
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "file_write");
  assert.equal(calls[0].registered, true);
  assert.equal(calls[0].sourceBlockSeq, 0);
  assert.deepEqual(calls[0].arguments, { content: "hi", operation: "append", path: "~/notes.txt" });
});

test("several api calls in one block project in source order", () => {
  const calls = projectBlockToCalls({
    code: [
      "const a = await space.api.fileRead({ path: '~/a.txt' });",
      "await space.api.fileDelete({ path: '~/b.txt' });",
      "return a;"
    ].join("\n"),
    seq: 3
  });

  assert.deepEqual(calls.map((call) => call.tool), ["file_read", "file_delete"]);
  assert.deepEqual(calls.map((call) => call.seq), [0, 1]);
  assert.ok(calls.every((call) => call.sourceBlockSeq === 3));
});

test("an unregistered api method projects as an unregistered call", () => {
  const calls = projectBlockToCalls({ code: "await space.api.fileCopy({ from: '~/a', to: '~/b' });", seq: 0 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].registered, false);
  assert.equal(calls[0].tool, "space.api.fileCopy");
  assert.deepEqual(calls[0].arguments, { method: "fileCopy" });
});

test("unreadable arguments fall back to one run_code call instead of guessing", () => {
  const calls = projectBlockToCalls({
    code: "await space.api.fileWrite(buildPayload(user), encoding);",
    seq: 0
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "run_code");
  assert.equal(calls[0].arguments.intent, "await space.api.fileWrite(buildPayload(user), encoding);");
});

test("code with no api call at all projects exactly one run_code call", () => {
  const calls = projectBlockToCalls({ code: "const rows = [...document.querySelectorAll('li')];\nreturn rows.length;", seq: 0 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "run_code");
  assert.equal(calls[0].arguments.code.includes("querySelectorAll"), true);
});

test("the projector never evaluates the code it reads", () => {
  globalThis.__engineSwapProjectorProbe = 0;

  try {
    projectBlockToCalls({
      code: "globalThis.__engineSwapProjectorProbe = 1; return globalThis.__engineSwapProjectorProbe;",
      seq: 0
    });

    assert.equal(globalThis.__engineSwapProjectorProbe, 0, "projection must not run the block");
  } finally {
    delete globalThis.__engineSwapProjectorProbe;
  }
});

test("parseLiteralArguments reads JSON-shaped literals and rejects the rest", () => {
  assert.deepEqual(parseLiteralArguments("{ path: '~/a', line: 3, flag: true, nested: { a: [1, 2] } }"), {
    flag: true,
    line: 3,
    nested: { a: [1, 2] },
    path: "~/a"
  });
  assert.equal(parseLiteralArguments("someVariable"), null);
  assert.equal(parseLiteralArguments("{ path: 'a' } + extra"), null);
  assert.equal(parseLiteralArguments("[1, 2]"), null);
  assert.equal(parseLiteralArguments("{ fn: () => 1 }"), null);
});

test("collectApiCalls reports every occurrence with its method", () => {
  const found = collectApiCalls("a(); space.api.fileRead({ path: 'x' }); space . api . fileList({ path: 'y' });");

  assert.deepEqual(found.map((entry) => entry.method), ["fileRead", "fileList"]);
});

test("a whole turn projects blocks in execution order with contiguous call seqs", () => {
  const calls = projectTurnToCalls([
    { code: "await space.api.fileRead({ path: '~/a' });", seq: 0 },
    { code: "return 42;", seq: 1 },
    { code: "await space.api.fileWrite({ path: '~/b', content: 'x' });", seq: 2 }
  ]);

  assert.deepEqual(calls.map((call) => call.tool), ["file_read", "run_code", "file_write"]);
  assert.deepEqual(calls.map((call) => call.seq), [0, 1, 2]);
  assert.deepEqual(calls.map((call) => call.sourceBlockSeq), [0, 1, 2]);
});

test("a projected typed call matches the registry, so classification can pass", async () => {
  const { classifyShadowTurn } = await import("../app/L0/_all/modules/_core/framework/js/engine-swap/shadow-classifier.js");
  const blocks = [{ code: "await space.api.fileDelete({ path: '~/doomed.txt' });", seq: 0 }];
  const calls = projectTurnToCalls(blocks);
  const result = classifyShadowTurn({ tier1Calls: calls, tier3Blocks: blocks });

  assert.deepEqual(result.diffs.map((diff) => diff.class), ["match"]);
});
