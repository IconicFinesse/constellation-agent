// Focused engine-swap P1 coverage for shadow classification.
//
// Fixture matrix from the plan and the addendum:
//   1 block -> 1 call            match
//   1 block -> n calls           split
//   n blocks -> 1 call           merge
//   block -> run_code            fallback-run-code
//   fenced display, no exec      suppressed-display
//   plus one fixture per failing class: unmapped, order-divergence,
//   extra-call, missing-call
//
// The display fixtures deliberately include the BUG-007 shapes so a second copy
// of fence logic can never creep in: an unterminated fence stays display, a
// tilde fence counts, and a fenced block plus a real execution is not display.
//
// Hermetic: pure functions only.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_DIFF_CLASSES,
  DIFF_CLASS,
  FAILING_DIFF_CLASSES,
  NON_FAILING_DIFF_CLASSES,
  classifyShadowTurn,
  countDiffsByClass,
  countFailingDiffs,
  createEmptyClassCounts,
  decideShadowVerdict,
  isDisplayOnlyReply
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/shadow-classifier.js";

function block(seq, code = "return 1;") {
  return { code, fenced: false, seq };
}

function call(seq, tool, sourceBlockSeq, extras = {}) {
  return { arguments: {}, registered: true, seq, sourceBlockSeq, tool, ...extras };
}

function classesOf(diffs) {
  return diffs.map((diff) => diff.class);
}

test("the diff-class enum is the closed nine-class set", () => {
  assert.deepEqual([...ALL_DIFF_CLASSES].sort(), [
    "extra-call",
    "fallback-run-code",
    "match",
    "merge",
    "missing-call",
    "order-divergence",
    "split",
    "suppressed-display",
    "unmapped"
  ]);
  assert.deepEqual([...NON_FAILING_DIFF_CLASSES].sort(), [
    "fallback-run-code",
    "match",
    "merge",
    "split",
    "suppressed-display"
  ]);
  assert.deepEqual([...FAILING_DIFF_CLASSES].sort(), [
    "extra-call",
    "missing-call",
    "order-divergence",
    "unmapped"
  ]);
});

test("1 block -> 1 call classifies as match", () => {
  const result = classifyShadowTurn({
    tier1Calls: [call(0, "file_write", 0)],
    tier3Blocks: [block(0)]
  });

  assert.deepEqual(classesOf(result.diffs), [DIFF_CLASS.MATCH]);
  assert.equal(result.diffs[0].tier3_seq, 0);
  assert.equal(result.diffs[0].tier1_seq, 0);
  assert.equal(result.displayOnly, false);
});

test("1 block -> n calls classifies as split and counts every call", () => {
  const result = classifyShadowTurn({
    tier1Calls: [call(0, "file_read", 0), call(1, "file_read", 0)],
    tier3Blocks: [block(0)]
  });

  assert.deepEqual(classesOf(result.diffs), [DIFF_CLASS.SPLIT, DIFF_CLASS.SPLIT]);
  assert.equal(result.diffs[0].note, "1 block -> 2 calls");
});

test("n blocks -> 1 merged call classifies as merge, not extra+missing", () => {
  const result = classifyShadowTurn({
    tier1Calls: [call(0, "file_write", 0, { mergedFromBlockSeqs: [0, 1] })],
    tier3Blocks: [block(0), block(1)]
  });

  assert.deepEqual(classesOf(result.diffs), [DIFF_CLASS.MERGE]);
  assert.equal(result.diffs[0].note, "2 blocks -> 1 call");
});

test("a block that maps only to run_code classifies as fallback-run-code", () => {
  const result = classifyShadowTurn({
    tier1Calls: [call(0, "run_code", 0)],
    tier3Blocks: [block(0, "const x = 1; return x;")]
  });

  assert.deepEqual(classesOf(result.diffs), [DIFF_CLASS.FALLBACK_RUN_CODE]);
});

test("a fenced display with no execution classifies as suppressed-display", () => {
  const result = classifyShadowTurn({
    replyContent: "Here is the code that would delete it:\n\n```js\nawait space.api.fileDelete({ path: '~/x.txt' });\n```",
    tier1Calls: [],
    tier3Blocks: []
  });

  assert.deepEqual(classesOf(result.diffs), [DIFF_CLASS.SUPPRESSED_DISPLAY]);
  assert.equal(result.displayOnly, true);
});

test("an unregistered assembled tool classifies as unmapped", () => {
  const result = classifyShadowTurn({
    tier1Calls: [call(0, "space.api.fileCopy", null, { registered: false })],
    tier3Blocks: [block(0)]
  });

  assert.equal(classesOf(result.diffs).includes(DIFF_CLASS.UNMAPPED), true);
  assert.equal(countFailingDiffs(countDiffsByClass(result.diffs)) > 0, true);
});

test("an unregistered call that maps to a block is unmapped, not a match", () => {
  const result = classifyShadowTurn({
    tier1Calls: [call(0, "space.api.fileCopy", 0, { registered: false })],
    tier3Blocks: [block(0)]
  });

  assert.deepEqual(classesOf(result.diffs), [DIFF_CLASS.UNMAPPED]);
  assert.equal(decideShadowVerdict(countDiffsByClass(result.diffs)), "fail");
});

test("an executed block with no assembled call is missing-call even beside a fence", () => {
  // A reply can carry a fence and still have executed a block; the block level
  // stays a real gap rather than being excused by the fence.
  const result = classifyShadowTurn({
    replyContent: "```js\nreturn 1;\n```\n_____javascript\nreturn 2;",
    tier1Calls: [],
    tier3Blocks: [block(0, "return 2;")]
  });

  assert.deepEqual(classesOf(result.diffs), [DIFF_CLASS.MISSING_CALL]);
});

test("an executed block with no assembled call classifies as missing-call", () => {
  const result = classifyShadowTurn({
    tier1Calls: [],
    tier3Blocks: [block(0)]
  });

  assert.deepEqual(classesOf(result.diffs), [DIFF_CLASS.MISSING_CALL]);
  assert.equal(result.displayOnly, false);
});

test("an assembled call with no source block classifies as extra-call", () => {
  const result = classifyShadowTurn({
    tier1Calls: [call(0, "file_read", 7)],
    tier3Blocks: [block(0)]
  });

  assert.equal(classesOf(result.diffs).includes(DIFF_CLASS.EXTRA_CALL), true);
});

test("a call positioned before the previous block's calls classifies as order-divergence", () => {
  const result = classifyShadowTurn({
    tier1Calls: [call(1, "file_read", 0), call(0, "file_write", 1)],
    tier3Blocks: [block(0), block(1)]
  });

  assert.equal(classesOf(result.diffs).includes(DIFF_CLASS.ORDER_DIVERGENCE), true);
});

test("display detection reuses the shared fence contract and fails safe", () => {
  // Unterminated fence: everything after it is display.
  assert.equal(isDisplayOnlyReply("```js\nawait space.api.fileWrite({ path: '~/a', content: '' });"), true);
  // Tilde fence counts as a fence.
  assert.equal(isDisplayOnlyReply("~~~js\nawait space.api.fileRead({ path: '~/a' });\n~~~"), true);
  // An executable separator outside every fence is not display.
  assert.equal(isDisplayOnlyReply("Here goes.\n_____javascript\nreturn 1;"), false);
  // A reply that executed something is never display.
  assert.equal(isDisplayOnlyReply("```js\nreturn 1;\n```", { executedBlockCount: 1 }), false);
  // Plain prose with no fence is not display evidence either.
  assert.equal(isDisplayOnlyReply("Nothing to run here."), false);
});

test("fenced display beside a real execution is not suppressed", () => {
  const content = "Showing the shape:\n\n```js\nreturn 'shown';\n```\n_____javascript\nreturn 'ran';";
  const result = classifyShadowTurn({
    replyContent: content,
    tier1Calls: [call(0, "run_code", 0)],
    tier3Blocks: [block(0, "return 'ran';")]
  });

  assert.equal(result.displayOnly, false);
  assert.deepEqual(classesOf(result.diffs), [DIFF_CLASS.FALLBACK_RUN_CODE]);
});

test("counts always report every class, including zeros", () => {
  const counts = createEmptyClassCounts();

  assert.deepEqual(Object.keys(counts).sort(), [...ALL_DIFF_CLASSES].sort());
  assert.ok(Object.values(counts).every((value) => value === 0));
});

test("verdict is pass only when all four failing classes are zero", () => {
  const clean = { ...createEmptyClassCounts(), [DIFF_CLASS.MATCH]: 3, [DIFF_CLASS.SPLIT]: 1 };
  const dirty = { ...clean, [DIFF_CLASS.MISSING_CALL]: 1 };

  assert.equal(decideShadowVerdict(clean), "pass");
  assert.equal(decideShadowVerdict(dirty), "fail");
  assert.equal(countFailingDiffs(clean), 0);
  assert.equal(countFailingDiffs(dirty), 1);
});
