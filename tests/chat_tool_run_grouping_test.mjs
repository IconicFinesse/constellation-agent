// SMART GROUPING of contiguous tool-call runs (chat-surface polish, item 1).
//
// A ten-call turn used to draw ten stacked chip rows. The grouping rule is DERIVED FROM
// THE STORED ENTRY SEQUENCE — never from narration heuristics — so these cases drive the
// REAL `buildMessageDisplayGroups` over REAL display projections produced by the shared
// history reader. Nothing here re-implements the rule it is checking.
//
// Two exclusions are load-bearing and each has its own case: a HELD call is a consent
// affordance the human must answer, and a DEFERRED call is its unanswered sibling. Both
// stay individually visible. Provisional (running) chips are excluded for the same class
// of reason: they ARE the live state.
//
// Hermetic: no disk, no network, no real DOM. The thread view only needs a document stub
// to be constructed (`buildMessageDisplayGroups` is pure).

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

globalThis.document = {
  addEventListener() {},
  createElement() {
    return { append() {}, classList: { add() {}, remove() {} }, setAttribute() {}, style: {} };
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  }
};

globalThis.window = globalThis.window || { location: { href: "http://localhost/" } };

const { createAgentThreadView } = await import("/modules/_core/visual/conversation/thread-view.js");
const { canonicalMessagesToTypedEntries, projectHistoryEntryForDisplay } = await import(
  "/modules/_core/framework/js/engine-swap/history-shapes.js"
);
const { collectToolRun, formatToolRunLabel, summarizeToolRun, createToolRunOpenState } = await import(
  "/modules/_core/visual/conversation/tool-run.js"
);

const view = createAgentThreadView({});

function project(entries) {
  return entries.map((entry) => projectHistoryEntryForDisplay(entry));
}

function typedHistory(messages) {
  return canonicalMessagesToTypedEntries(messages);
}

function layout(groups) {
  return groups.map((group) => {
    if (group.type === "tool-run") {
      return `run:${group.summary.total}`;
    }

    if (group.type === "standard") {
      return `text:${group.message.content}`;
    }

    return `chip:${group.messageId}`;
  });
}

// Baseline: WITHOUT the option nothing changes, which is what keeps the order-contract
// suites (and Tier 3) byte-identical.
test("grouping is opt-in: without it every typed entry keeps its own row", () => {
  const entries = typedHistory([
    { content: "Reading both.", role: "assistant", toolCalls: [{ arguments: {}, id: "c1", name: "file_read" }] },
    { content: 'ok: {"a":1}', role: "tool", toolCallId: "c1" },
    { content: "Writing.", role: "assistant", toolCalls: [{ arguments: {}, id: "c2", name: "file_write" }] },
    { content: "ok: true", role: "tool", toolCallId: "c2" }
  ]);

  const groups = view.buildMessageDisplayGroups(project(entries), {});

  assert.ok(!groups.some((group) => group.type === "tool-run"));
  assert.equal(groups.filter((group) => group.type === "standalone-output").length, 4);
});

// The owner's actual complaint: a run of calls within ONE announcement is one row.
test("a contiguous run of calls from one announcement becomes ONE summary group", () => {
  const entries = typedHistory([
    {
      content: "Reading all three.",
      role: "assistant",
      toolCalls: [
        { arguments: { path: "~/a" }, id: "c1", name: "file_read" },
        { arguments: { path: "~/b" }, id: "c2", name: "file_read" },
        { arguments: { path: "~/c" }, id: "c3", name: "file_read" }
      ]
    },
    { content: 'ok: "A"', role: "tool", toolCallId: "c1" },
    { content: 'ok: "B"', role: "tool", toolCallId: "c2" },
    { content: "error (execution): nope", role: "tool", isError: true, toolCallId: "c3" }
  ]);

  const groups = view.buildMessageDisplayGroups(project(entries), { groupToolRuns: true });

  assert.deepEqual(layout(groups), ["text:Reading all three.", "run:3"], "narration stays ahead, the run is ONE row");

  const run = groups.find((group) => group.type === "tool-run");

  assert.deepEqual(
    { failed: run.summary.failed, succeeded: run.summary.succeeded, total: run.summary.total },
    { failed: 1, succeeded: 2, total: 3 },
    "counts are per CALL, and each call carries its own outcome"
  );
  assert.equal(formatToolRunLabel(run.summary), "3 tool calls · 2 succeeded · 1 failed");

  // Every call stays addressable, in stored order, so the expanded card renders the
  // SAME per-call chips that existed before grouping.
  assert.deepEqual(
    run.entries.map((entry) => entry.id),
    ["tool-call-c1", "tool-call-c2", "tool-call-c3", "tool-result-c1", "tool-result-c2", "tool-result-c3"]
  );
});

// Narration between two runs splits them: grouping never crosses prose the user read.
test("narration between runs splits groups, and each iteration is its own run", () => {
  const entries = typedHistory([
    {
      content: "First pair.",
      role: "assistant",
      toolCalls: [
        { arguments: {}, id: "a1", name: "file_read" },
        { arguments: {}, id: "a2", name: "file_read" }
      ]
    },
    { content: "ok: 1", role: "tool", toolCallId: "a1" },
    { content: "ok: 2", role: "tool", toolCallId: "a2" },
    { content: "Now the second pair.", role: "assistant" },
    {
      content: "Second pair.",
      role: "assistant",
      toolCalls: [
        { arguments: {}, id: "b1", name: "file_write" },
        { arguments: {}, id: "b2", name: "file_write" }
      ]
    },
    { content: "ok: 3", role: "tool", toolCallId: "b1" },
    { content: "ok: 4", role: "tool", toolCallId: "b2" },
    { content: "Done.", role: "assistant" }
  ]);

  const groups = view.buildMessageDisplayGroups(project(entries), { groupToolRuns: true });

  assert.deepEqual(layout(groups), [
    "text:First pair.",
    "run:2",
    "text:Now the second pair.",
    "text:Second pair.",
    "run:2",
    "text:Done."
  ]);
});

// A narration-less second announcement still starts a new run: a call AFTER a result is
// the next announcement, not a continuation.
test("a call after a result starts a new run", () => {
  const entries = typedHistory([
    {
      content: "one",
      role: "assistant",
      toolCalls: [
        { arguments: {}, id: "a1", name: "file_read" },
        { arguments: {}, id: "a2", name: "file_read" }
      ]
    },
    { content: "ok: 1", role: "tool", toolCallId: "a1" },
    { content: "ok: 2", role: "tool", toolCallId: "a2" },
    {
      role: "assistant",
      toolCalls: [
        { arguments: {}, id: "b1", name: "file_write" },
        { arguments: {}, id: "b2", name: "file_write" }
      ]
    },
    { content: "ok: 3", role: "tool", toolCallId: "b1" },
    { content: "ok: 4", role: "tool", toolCallId: "b2" }
  ]);

  const groups = view.buildMessageDisplayGroups(project(entries), { groupToolRuns: true });

  assert.deepEqual(layout(groups), ["text:one", "run:2", "run:2"]);
});

// A single call is already one row: grouping it would only add a click.
test("a single-call run is not grouped", () => {
  const entries = typedHistory([
    { content: "Just one.", role: "assistant", toolCalls: [{ arguments: {}, id: "c1", name: "file_read" }] },
    { content: "ok: 1", role: "tool", toolCallId: "c1" }
  ]);

  const groups = view.buildMessageDisplayGroups(project(entries), { groupToolRuns: true });

  assert.deepEqual(layout(groups), ["text:Just one.", "chip:tool-call-c1", "chip:tool-result-c1"]);
});

// THE consent rule: a held call must never be swallowed into a summary row.
test("a held call stays individually visible instead of joining the group", () => {
  const entries = typedHistory([
    {
      content: "Two reads and a delete.",
      role: "assistant",
      toolCalls: [
        { arguments: {}, id: "c1", name: "file_read" },
        { arguments: {}, id: "c2", name: "file_read" },
        { arguments: {}, id: "c3", name: "file_delete" }
      ]
    },
    { content: "ok: 1", role: "tool", toolCallId: "c1" },
    { content: "ok: 2", role: "tool", toolCallId: "c2" },
    { content: "held: delete is waiting for your confirmation in the chat.", role: "tool", toolCallId: "c3" }
  ]);

  const projected = project(entries);
  const groups = view.buildMessageDisplayGroups(projected, { groupToolRuns: true });

  // A block containing a consented-withheld call is NOT grouped at all: its calls and
  // their results are contiguous, so grouping only the pre-hold calls would leave them
  // summarizing as `running` forever, and splitting the block would reorder rows the
  // user watched. Every row stays individual and in stored order.
  assert.deepEqual(layout(groups), [
    "text:Two reads and a delete.",
    "chip:tool-call-c1",
    "chip:tool-call-c2",
    "chip:tool-call-c3",
    "chip:tool-result-c1",
    "chip:tool-result-c2",
    "chip:tool-result-c3"
  ]);
  assert.ok(
    groups.some((group) => group.type === "standalone-output" && group.messageId === "tool-result-c3"),
    "the consent affordance is still its own clickable row"
  );
});

// Deferred siblings belong to the same consent episode: they stay visible too.
test("a deferred sibling stays individually visible", () => {
  const entries = typedHistory([
    {
      content: "Delete then read.",
      role: "assistant",
      toolCalls: [
        { arguments: {}, id: "d1", name: "file_delete" },
        { arguments: {}, id: "d2", name: "file_read" }
      ]
    },
    { content: "held: delete is waiting for your confirmation in the chat.", role: "tool", toolCallId: "d1" },
    { content: "deferred: an earlier call in this turn is waiting for the user's confirmation.", role: "tool", toolCallId: "d2" }
  ]);

  const groups = view.buildMessageDisplayGroups(project(entries), { groupToolRuns: true });

  assert.ok(!groups.some((group) => group.type === "tool-run"), "nothing is grouped across a consent episode");
  assert.deepEqual(layout(groups), ["text:Delete then read.", "chip:tool-call-d1", "chip:tool-call-d2", "chip:tool-result-d1", "chip:tool-result-d2"]);
});

// Provisional (live running) chips are excluded: they ARE the running state.
test("a provisional chip is never swallowed into a group", () => {
  const entries = [
    {
      content: "Two reads.",
      role: "assistant",
      toolCalls: [
        { arguments: {}, id: "p1", name: "file_read" },
        { arguments: {}, id: "p2", name: "file_read" }
      ]
    }
  ].flatMap((message) => canonicalMessagesToTypedEntries([message]));

  const projected = project(entries);

  projected.push({
    content: "execution file_write call\nrunning",
    id: "provisional-call-x1",
    kind: "execution-output",
    provisional: true,
    role: "user",
    typedTool: "call",
    typedToolCallId: "x1",
    typedToolName: "file_write",
    typedToolOutcome: "running"
  });

  const groups = view.buildMessageDisplayGroups(projected, { groupToolRuns: true });

  assert.deepEqual(layout(groups), ["text:Two reads.", "run:2", "chip:provisional-call-x1"]);
});

// EXPANDED STATE must survive a re-render: rows are rebuilt as results land, so the
// open flag lives outside the DOM and participates in the row signature.
test("expanded state survives a re-render and changes the row signature", () => {
  const openState = createToolRunOpenState();
  const entries = project(
    typedHistory([
      {
        content: "Two.",
        role: "assistant",
        toolCalls: [
          { arguments: {}, id: "c1", name: "file_read" },
          { arguments: {}, id: "c2", name: "file_read" }
        ]
      },
      { content: "ok: 1", role: "tool", toolCallId: "c1" },
      { content: "ok: 2", role: "tool", toolCallId: "c2" }
    ])
  );
  const group = view.buildMessageDisplayGroups(entries, { groupToolRuns: true }).find(
    (candidate) => candidate.type === "tool-run"
  );

  const collapsed = view.getGroupRenderSignature(group, { toolRunOpenState: openState });

  openState.setOpen(group.key, true);

  const expanded = view.getGroupRenderSignature(group, { toolRunOpenState: openState });

  assert.notEqual(expanded, collapsed, "the open flag is part of the signature, so a rebuild keeps it");
  assert.ok(openState.isOpen(group.key), "the key still identifies the same run after a rebuild");
  assert.ok(expanded.includes("open"));

  // FIRST id only: expansion is per run, not global, and the key does not carry the
  // last id (which changes exactly when a result lands).
  assert.equal(group.key, "tool-run:tool-call-c1");
});

// EXPANSION DURING SETTLE. This is the reason the key cannot carry the last id: as a
// result lands the run gains an entry, so a first|last key would change under the user
// and collapse a card they had opened (chat-polish audit non-blocker c, 2026-10-27).
test("expanded state survives a result landing mid-run", () => {
  const openState = createToolRunOpenState();
  const callEntries = project(
    typedHistory([
      {
        content: "Reading both.",
        role: "assistant",
        toolCalls: [
          { arguments: {}, id: "c1", name: "file_read" },
          { arguments: {}, id: "c2", name: "file_read" }
        ]
      }
    ])
  );
  const beforeResults = view
    .buildMessageDisplayGroups(callEntries, { groupToolRuns: true })
    .find((group) => group.type === "tool-run");

  assert.ok(beforeResults, "a run forms while the calls are still pending");

  openState.setOpen(beforeResults.key, true);

  // The FIRST result lands: the run now contains the same two calls plus one result.
  const settledEntries = project(
    typedHistory([
      {
        content: "Reading both.",
        role: "assistant",
        toolCalls: [
          { arguments: {}, id: "c1", name: "file_read" },
          { arguments: {}, id: "c2", name: "file_read" }
        ]
      },
      { content: "ok: 1", role: "tool", toolCallId: "c1" }
    ])
  );
  const afterResult = view
    .buildMessageDisplayGroups(settledEntries, { groupToolRuns: true })
    .find((group) => group.type === "tool-run");

  assert.equal(afterResult.key, beforeResults.key, "the run keeps ONE key as results land");
  assert.equal(afterResult.entries.length, beforeResults.entries.length + 1, "the result really joined the run");
  assert.ok(
    openState.isOpen(afterResult.key),
    "the card the user opened is still expanded after the result landed"
  );

  const signature = view.getGroupRenderSignature(afterResult, { toolRunOpenState: openState });

  assert.ok(signature.includes("open"), "and the rebuilt row renders open, not collapsed");
});

// The pure run collector is the single derivation; assert its boundary directly.
test("collectToolRun reports the run boundary from the stored sequence", () => {
  const entries = project(
    typedHistory([
      {
        content: "Two.",
        role: "assistant",
        toolCalls: [
          { arguments: {}, id: "c1", name: "file_read" },
          { arguments: {}, id: "c2", name: "file_read" }
        ]
      },
      { content: "ok: 1", role: "tool", toolCallId: "c1" },
      { content: "ok: 2", role: "tool", toolCallId: "c2" },
      { content: "After.", role: "assistant" }
    ])
  );

  // Index 0 is the narration; the run starts at the first call (index 1) and must end
  // before the following narration rather than absorbing it.
  assert.equal(collectToolRun(entries, 0), null, "a plain message cannot start a run");

  const run = collectToolRun(entries, 1);

  assert.equal(run.endIndex, 4, "the run ends before the following narration");
  assert.equal(summarizeToolRun(run.entries).total, 2);
  assert.equal(collectToolRun(entries, 4), null, "a plain message cannot start a run");
});
