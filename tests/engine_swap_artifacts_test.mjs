// Focused engine-swap P1 coverage for ca.shadow-diff/1 artifact shapes and the
// shared normalization rules.
//
// Artifact contract (addendum Q1a) is validated field by field:
//   manifest.json  format/run_id/app_commit/app_version/surface/config_id/
//                  started_at/suite
//   sessions.jsonl one JSON object per line with session_id, turn_index,
//                  tier3_blocks[{seq,fenced,code_sha,first_line}],
//                  tier1_calls[{seq,tool,args_sha,args_normalized}],
//                  mapping[{tier3_seq,tier1_seqs}], diffs[{class,...}]
//   summary.json   format/run_id/turns/blocks/calls/by_class/verdict
//
// Normalization rules (addendum, both sides identical): own-user path collapse,
// recursive key sorting, code compared by hash + first line and never embedded
// whole.
//
// Hermetic: a deterministic injected digest replaces SHA-256, no filesystem and
// no network access, tmp dirs unused.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_PAYLOAD_STRING_LIMIT,
  collapseOwnUserPath,
  firstLineOfCode,
  normalizeJsonValue,
  normalizeToolArguments,
  redactArtifactArguments,
  stableStringify
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/shadow-normalize.js";
import {
  SHADOW_ARTIFACT_FILES,
  createShadowSession
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/shadow-session.js";
import { ALL_DIFF_CLASSES, DIFF_CLASS } from "../app/L0/_all/modules/_core/framework/js/engine-swap/shadow-classifier.js";

const FIXED_NOW = () => new Date("2026-10-26T10:00:00.000Z");

// Deterministic 64-hex digest so artifact bytes are stable in tests.
async function fakeDigest(text) {
  let hash = 0x811c9dc5;

  for (const char of String(text)) {
    hash ^= char.charCodeAt(0) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0").repeat(8);
}

function createSession(overrides = {}) {
  return createShadowSession({
    appCommit: "2768a97",
    appVersion: "1.2.1",
    configId: "neuralwatt/deepseek-v4.1-flash",
    digest: fakeDigest,
    now: FIXED_NOW,
    runId: "p1-test-run",
    suite: "fixture:artifacts",
    surface: "onscreen",
    ...overrides
  });
}

const SAMPLE_CODE = [
  "return await space.api.fileWrite({",
  "  path: '~/notes.txt',",
  "  content: 'hi',",
  "  operation: 'append'",
  "});"
].join("\n");

function sampleTurn() {
  return {
    replyContent: `Writing it now.\n_____javascript\n${SAMPLE_CODE}`,
    sessionId: "s-test",
    tier3Blocks: [{ code: SAMPLE_CODE, fenced: false, seq: 0 }],
    tier1Calls: [
      {
        arguments: { content: "hi", operation: "append", path: "L2/alice/notes.txt" },
        registered: true,
        seq: 0,
        sourceBlockSeq: 0,
        tool: "file_write"
      }
    ],
    turnIndex: 0,
    username: "alice"
  };
}

test("manifest.json carries exactly the contract fields", async () => {
  const session = createSession();
  const manifest = session.buildManifest();

  assert.deepEqual(Object.keys(manifest).sort(), [
    "app_commit",
    "app_version",
    "config_id",
    "format",
    "run_id",
    "started_at",
    "suite",
    "surface"
  ]);
  assert.equal(manifest.format, "ca.shadow-diff/1");
  assert.equal(manifest.run_id, "p1-test-run");
  assert.equal(manifest.started_at, "2026-10-26T10:00:00.000Z");
  assert.equal(manifest.surface, "onscreen");
});

test("manifest.surface is restricted to the two named surfaces", async () => {
  assert.equal(createSession({ surface: "admin" }).buildManifest().surface, "admin");
  assert.equal(createSession({ surface: "something-else" }).buildManifest().surface, "onscreen");
});

test("a session line has the contract shape and no embedded code", async () => {
  const session = createSession();
  const line = await session.recordTurn(sampleTurn());

  assert.deepEqual(Object.keys(line).sort(), [
    "diffs",
    "mapping",
    "session_id",
    "tier1_calls",
    "tier3_blocks",
    "turn_index"
  ]);

  assert.deepEqual(Object.keys(line.tier3_blocks[0]).sort(), ["code_sha", "fenced", "first_line", "seq"]);
  assert.match(line.tier3_blocks[0].code_sha, /^sha256:[0-9a-f]{12}$/u);

  // Contract: code is compared by hash + FIRST LINE. The first line is present
  // on purpose; the rest of the block must never be embedded.
  assert.equal(line.tier3_blocks[0].first_line, "return await space.api.fileWrite({");
  assert.equal(JSON.stringify(line).includes(SAMPLE_CODE), false, "the full code body must never be embedded");
  assert.equal(JSON.stringify(line).includes("content: 'hi'"), false, "no body line beyond the first may be embedded");

  assert.deepEqual(Object.keys(line.tier1_calls[0]).sort(), ["args_normalized", "args_sha", "seq", "tool"]);
  assert.match(line.tier1_calls[0].args_sha, /^sha256:[0-9a-f]{12}$/u);
});

test("payload-bearing arguments are redacted to a digest marker", async () => {
  const session = createSession();
  const line = await session.recordTurn(sampleTurn());
  const normalized = line.tier1_calls[0].args_normalized;

  assert.equal(normalized.path, "L2/alice/notes.txt");
  assert.equal(normalized.operation, "append");
  assert.deepEqual(Object.keys(normalized.content).sort(), ["bytes", "omitted", "sha256"]);
  assert.equal(normalized.content.omitted, "payload");
  assert.equal(normalized.content.bytes, 2);
  assert.match(normalized.content.sha256, /^sha256:[0-9a-f]{12}$/u);
});

test("an over-long string under an unknown key is payload too", async () => {
  const longText = "x".repeat(ARTIFACT_PAYLOAD_STRING_LIMIT + 1);
  const redacted = await redactArtifactArguments({ note: longText, short: "ok" }, { digest: fakeDigest });

  assert.equal(redacted.short, "ok");
  assert.equal(redacted.note.omitted, "payload");
  assert.equal(redacted.note.bytes, ARTIFACT_PAYLOAD_STRING_LIMIT + 1);
});

test("mapping links tier3 block sequences to tier1 call sequences", async () => {
  const session = createSession();
  const line = await session.recordTurn(sampleTurn());

  assert.deepEqual(line.mapping, [{ tier1_seqs: [0], tier3_seq: 0 }]);
  assert.deepEqual(line.diffs.map((diff) => diff.class), [DIFF_CLASS.MATCH]);
});

test("summary.json counts turns, blocks, calls and every class", async () => {
  const session = createSession();

  await session.recordTurn(sampleTurn());
  await session.recordTurn({
    replyContent: "```js\nawait space.api.fileDelete({ path: '~/x' });\n```",
    sessionId: "s-test",
    tier1Calls: [],
    tier3Blocks: [],
    turnIndex: 1
  });

  const summary = session.buildSummary();

  assert.deepEqual(Object.keys(summary).sort(), ["blocks", "by_class", "calls", "format", "run_id", "turns", "verdict"]);
  assert.equal(summary.format, "ca.shadow-diff/1");
  assert.equal(summary.turns, 2);
  assert.equal(summary.blocks, 1);
  assert.equal(summary.calls, 1);
  assert.deepEqual(Object.keys(summary.by_class).sort(), [...ALL_DIFF_CLASSES].sort());
  assert.equal(summary.by_class.match, 1);
  assert.equal(summary.by_class["suppressed-display"], 1);
  assert.equal(summary.verdict, "pass");
});

test("the gate fails when any failing class is non-zero", async () => {
  const session = createSession();

  await session.recordTurn({ ...sampleTurn(), tier1Calls: [] });

  const summary = session.buildSummary();

  assert.equal(summary.by_class["missing-call"], 1);
  assert.equal(summary.verdict, "fail");
});

test("emit delivers exactly the three contract files", async () => {
  const session = createSession();
  const emitted = [];

  await session.recordTurn(sampleTurn());
  const result = await session.emit(async ({ name, text }) => {
    emitted.push({ name, text });
  });

  assert.deepEqual(emitted.map((entry) => entry.name), [
    SHADOW_ARTIFACT_FILES.MANIFEST,
    SHADOW_ARTIFACT_FILES.SESSIONS,
    SHADOW_ARTIFACT_FILES.SUMMARY
  ]);

  const manifest = JSON.parse(emitted[0].text);
  const summary = JSON.parse(emitted[2].text);
  const sessionLines = emitted[1].text.trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(manifest.format, "ca.shadow-diff/1");
  assert.equal(summary.format, "ca.shadow-diff/1");
  assert.equal(sessionLines.length, 1);
  assert.equal(sessionLines[0].session_id, "s-test");
  assert.equal(emitted[1].text.endsWith("\n"), true);
  assert.equal(result.summary.verdict, "pass");
});

test("emit refuses to run without a sink", async () => {
  await assert.rejects(() => createSession().emit(null), /emit handler is required/u);
});

test("own-user shorthand collapses to the canonical own root", () => {
  assert.equal(collapseOwnUserPath("~/notes.txt", "alice"), "L2/alice/notes.txt");
  assert.equal(collapseOwnUserPath("~", "alice"), "L2/alice");
  assert.equal(collapseOwnUserPath("L2/alice/notes.txt", "alice"), "L2/alice/notes.txt");
  assert.equal(collapseOwnUserPath("~/L2/alice/notes.txt", "alice"), "L2/alice/notes.txt");
  assert.equal(collapseOwnUserPath("L2/alice/L2/alice/notes.txt", "alice"), "L2/alice/notes.txt");
  assert.equal(collapseOwnUserPath("/app/L2/alice/notes.txt", "alice"), "L2/alice/notes.txt");
});

test("another user's name inside a doubled shorthand never collapses", () => {
  assert.equal(collapseOwnUserPath("~/L2/bob/notes.txt", "alice"), "L2/alice/L2/bob/notes.txt");
  assert.equal(collapseOwnUserPath("L2/bob/notes.txt", "alice"), "L2/bob/notes.txt");
  assert.equal(collapseOwnUserPath("~/L1/team/file.txt", "alice"), "L2/alice/L1/team/file.txt");
});

test("non-path arguments are untouched and empty input stays empty", () => {
  assert.deepEqual(normalizeToolArguments({ content: "a", operation: "append", path: "~/x" }, { username: "alice" }), {
    content: "a",
    operation: "append",
    path: "L2/alice/x"
  });
  assert.equal(collapseOwnUserPath("", "alice"), "");
  assert.equal(collapseOwnUserPath("   ", "alice"), "");
});

test("json keys are sorted recursively, so equal values stringify equally", () => {
  const left = { b: [{ z: 1, a: 2 }], a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: [{ a: 2, z: 1 }] };

  assert.equal(stableStringify(left), stableStringify(right));
  assert.deepEqual(Object.keys(normalizeJsonValue(left)), ["a", "b"]);
});

test("first line of code skips blank lines and truncates honestly", () => {
  assert.equal(firstLineOfCode("\n\n   return 1;\nreturn 2;"), "return 1;");
  assert.equal(firstLineOfCode("    \n\t\n"), "");
  assert.equal(firstLineOfCode(`${"y".repeat(200)}`).endsWith("…"), true);
});
