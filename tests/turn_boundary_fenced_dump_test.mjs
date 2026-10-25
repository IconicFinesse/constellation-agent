import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExecutionErrorRepeatNote,
  buildUnexecutedCodeFenceRetryMessage,
  findUnexecutedCodeFence,
  MAX_UNEXECUTED_FENCE_RETRY_COUNT,
  shouldRetryUnexecutedFence,
  stripTrailingExecutionArtifacts,
  trackExecutionErrorRepeat
} from "../app/L0/_all/modules/_core/onscreen_agent/turn-boundary.js";

test("stripTrailingExecutionArtifacts removes a leaked closing-tag trailer and records it", () => {
  const source = "const text = await space.api.fileRead(\"~/example.txt\")\n</parameter>";
  const stripped = stripTrailingExecutionArtifacts(source);
  assert.equal(stripped.code, "const text = await space.api.fileRead(\"~/example.txt\")");
  assert.deepEqual(stripped.removed, ["</parameter>"]);
});

test("stripTrailingExecutionArtifacts removes a trailing fence marker line", () => {
  const stripped = stripTrailingExecutionArtifacts("return `done`\n```js");
  assert.equal(stripped.code, "return `done`");
  assert.deepEqual(stripped.removed, ["```js"]);
});

test("stripTrailingExecutionArtifacts never touches leading or embedded tag text", () => {
  const leadingTag = stripTrailingExecutionArtifacts(
    "</parameter>\nconst text = await space.api.fileRead(\"~/example.txt\")"
  );
  assert.deepEqual(leadingTag.removed, []);
  assert.match(leadingTag.code, /^<\/parameter>/u);

  const embeddedTag = stripTrailingExecutionArtifacts("return `</parameter>`");
  assert.equal(embeddedTag.code, "return `</parameter>`");
  assert.deepEqual(embeddedTag.removed, []);
});

test("stripTrailingExecutionArtifacts removes multiple stacked trailers and blank lines", () => {
  const stripped = stripTrailingExecutionArtifacts("return 1\n\n</parameter>\n</invoke>\n");
  assert.equal(stripped.code, "return 1");
  assert.equal(stripped.removed.length, 2);
  assert.deepEqual(stripped.removed, ["</parameter>", "</invoke>"]);
});

test("stripTrailingExecutionArtifacts returns an empty result for empty input", () => {
  assert.deepEqual(stripTrailingExecutionArtifacts(""), { code: "", removed: [] });
});

test("findUnexecutedCodeFence finds a runtime-referencing fence in a separator-less reply", () => {
  const found = findUnexecutedCodeFence(
    "I will save that file now.\n```javascript\nreturn await space.api.fileWrite(\"~/notes.txt\", \"pan\")\n```"
  );
  assert.ok(found);
  assert.match(found.code, /space\.api\.fileWrite/u);
});

test("findUnexecutedCodeFence returns null when a separator is present", () => {
  const found = findUnexecutedCodeFence(
    "Staging line\n_____javascript\nreturn await space.api.fileRead(\"~/example.txt\")"
  );
  assert.equal(found, null);
});

test("findUnexecutedCodeFence ignores code fences that never touch the runtime", () => {
  const found = findUnexecutedCodeFence(
    "Sure, here is a plain snippet for you:\n```python\nprint(\"hello world\")\n```"
  );
  assert.equal(found, null);
});

test("shouldRetryUnexecutedFence fires once per budget and exempts plain code displays", () => {
  const fencedDump = "Here is the code:\n```js\nreturn await space.api.fileList(\"~/\")\n```";
  assert.equal(shouldRetryUnexecutedFence(fencedDump, 0), true);
  assert.equal(shouldRetryUnexecutedFence(fencedDump, 1), false);
  assert.equal(shouldRetryUnexecutedFence(fencedDump, MAX_UNEXECUTED_FENCE_RETRY_COUNT), false);

  const plainCodeDisplay = "Example snippet:\n```python\nprint(\"x\")\n```";
  assert.equal(shouldRetryUnexecutedFence(plainCodeDisplay, 0), false);

  const separatorReply = "Doing it now\n_____javascript\nreturn await space.api.userSelfInfo()";
  assert.equal(shouldRetryUnexecutedFence(separatorReply, 0), false);

  assert.equal(shouldRetryUnexecutedFence("", 0), false);
  assert.equal(shouldRetryUnexecutedFence(null, 0), false);
});

test("buildUnexecutedCodeFenceRetryMessage names the separator, the resend shape, and the exemption", () => {
  const message = buildUnexecutedCodeFenceRetryMessage();
  assert.match(message, /Protocol correction: your previous response contained a fenced code block/u);
  assert.match(message, /_____javascript alone on its own line/u);
  assert.match(message, /If the user asked to see code as text/u);
});

test("trackExecutionErrorRepeat counts identical errors after normalizing per-run ids", () => {
  const first = trackExecutionErrorRepeat([
    "SyntaxError: Invalid regular expression: missing / (space-onscreen-agent-execute-3.js:1:1)"
  ]);
  assert.equal(first.count, 1);

  const second = trackExecutionErrorRepeat(
    ["SyntaxError: Invalid regular expression: missing / (space-onscreen-agent-execute-7.js:1:1)"],
    first.signature,
    first.count
  );
  assert.equal(second.count, 2);

  const third = trackExecutionErrorRepeat(
    ["SyntaxError: Invalid regular expression: missing / (space-onscreen-agent-execute-12.js:1:1)"],
    second.signature,
    second.count
  );
  assert.equal(third.count, 3);
});

test("trackExecutionErrorRepeat resets when a batch has no errors or the error changes", () => {
  const first = trackExecutionErrorRepeat(["TypeError: back.split is not a function"]);
  assert.equal(first.count, 1);

  const cleared = trackExecutionErrorRepeat([], first.signature, first.count);
  assert.equal(cleared.count, 0);
  assert.equal(cleared.signature, "");

  const changed = trackExecutionErrorRepeat(
    ["SyntaxError: unexpected token"],
    first.signature,
    first.count
  );
  assert.equal(changed.count, 1);
});

test("buildExecutionErrorRepeatNote stays empty until the second occurrence", () => {
  assert.equal(buildExecutionErrorRepeatNote(0), "");
  assert.equal(buildExecutionErrorRepeatNote(1), "");
  assert.match(buildExecutionErrorRepeatNote(2), /occurred 2 times in a row/u);
  assert.match(buildExecutionErrorRepeatNote(3), /do not resend the same code/u);
});
