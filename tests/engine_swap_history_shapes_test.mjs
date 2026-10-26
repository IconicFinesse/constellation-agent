// Focused engine-swap P2 coverage for the both-shapes history reader (plan §3.5).
//
// The contract: existing text-protocol histories are NEVER rewritten, and readers
// must accept both shapes forever. So this suite pins:
//   - a legacy-shaped history reads exactly as before (same content, same roles,
//     same render description) — no rewrite, no data loss
//   - typed tool entries read as tool calls and tool results
//   - the shared reader is the ONE branch: prompt assembly consumes it, and typed
//     entries become canonical OpenAI messages with the originating call id
//   - writers emit only the new shape
//
// Hermetic: pure functions, no network, no app-data writes, no globals.

import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_ENTRY_KIND,
  canonicalMessagesToTypedEntries,
  createToolCallEntry,
  createToolResultEntry,
  describeHistoryEntryForRender,
  historyEntriesToCanonicalMessages,
  isToolResultEntry,
  isTypedHistoryEntry,
  normalizeTypedHistoryFields,
  projectHistoryEntryForDisplay,
  projectHistoryEntryForPrompt,
  readHistoryEntries,
  readHistoryEntry,
  serializeTypedHistoryFields
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/history-shapes.js";

// A realistic v1.2.1 history: user turn, assistant reply with an execution
// separator, and the execution-output follow-up. This is what every on-disk
// `~/history/onscreen-agent.json` looks like today.
const LEGACY_HISTORY = Object.freeze([
  Object.freeze({ content: "read my notes", id: "u1", kind: "", role: "user" }),
  Object.freeze({
    content: "Checking your notes now.\n_____javascript\nreturn await space.api.fileRead('~/notes.txt')",
    id: "a1",
    kind: "",
    role: "assistant"
  }),
  Object.freeze({
    content: "result\ncontent: hello",
    id: "u2",
    kind: "execution-output",
    role: "user"
  }),
  Object.freeze({ content: "Your notes say hello.", id: "a2", kind: "", role: "assistant" })
]);

test("a legacy history reads exactly as before", () => {
  const read = readHistoryEntries(LEGACY_HISTORY);

  assert.equal(read.length, 4);
  assert.deepEqual(read.map((entry) => entry.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(read.map((entry) => entry.content), LEGACY_HISTORY.map((entry) => entry.content));
  // The execution-output kind survives as message metadata, not as a tool entry.
  assert.equal(read[2].kind, HISTORY_ENTRY_KIND.MESSAGE);
  assert.equal(read[2].messageKind, "execution-output");
  assert.equal(isTypedHistoryEntry(LEGACY_HISTORY[2]), false);
});

test("a legacy history renders with the same message descriptions as before", () => {
  const descriptions = LEGACY_HISTORY.map((entry) => describeHistoryEntryForRender(entry));

  assert.deepEqual(descriptions.map((entry) => entry.type), ["message", "message", "message", "message"]);
  assert.deepEqual(descriptions.map((entry) => entry.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(descriptions[2].messageKind, "execution-output");
  assert.deepEqual(descriptions.map((entry) => entry.id), ["u1", "a1", "u2", "a2"]);
});

test("a legacy history becomes canonical text messages with no tool machinery", () => {
  const messages = historyEntriesToCanonicalMessages(LEGACY_HISTORY);

  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(messages.map((message) => message.content), LEGACY_HISTORY.map((entry) => entry.content));
  // No tool_calls and no tool-role messages: the text protocol produced none.
  assert.ok(messages.every((message) => !("toolCalls" in message)));
  assert.ok(messages.every((message) => message.role !== "tool"));
});

test("a typed tool call reads as a tool call and renders as one", () => {
  const entry = createToolCallEntry({ arguments: { path: "~/notes.txt" }, callId: "call_7", name: "file_read" });

  assert.equal(entry.kind, "tool_call");
  assert.equal(entry.role, "assistant");
  assert.equal(isTypedHistoryEntry(entry), true);

  const read = readHistoryEntry(entry);

  assert.equal(read.kind, HISTORY_ENTRY_KIND.TOOL_CALL);
  assert.equal(read.name, "file_read");
  assert.equal(read.callId, "call_7");
  assert.deepEqual(read.arguments, { path: "~/notes.txt" });

  const description = describeHistoryEntryForRender(entry);

  assert.equal(description.type, "tool");
  assert.equal(description.phase, "call");
  assert.equal(description.name, "file_read");
});

test("a typed tool result carries either a payload or an error, never both", () => {
  const okEntry = createToolResultEntry({ callId: "call_7", name: "file_read", payload: { content: "hi" } });
  const errorEntry = createToolResultEntry({
    callId: "call_8",
    error: { class: "validation", coaching: "fix it", message: "bad args" },
    name: "file_write"
  });

  assert.equal(okEntry.toolResult.payload.content, "hi");
  assert.equal("error" in okEntry.toolResult, false);
  assert.equal(errorEntry.toolResult.error.class, "validation");
  assert.equal("payload" in errorEntry.toolResult, false);

  const okDescription = describeHistoryEntryForRender(okEntry);
  const errorDescription = describeHistoryEntryForRender(errorEntry);

  assert.equal(okDescription.phase, "result");
  assert.equal(okDescription.failed, false);
  assert.equal(errorDescription.failed, true);
});

test("a mixed history turns typed entries into canonical tool messages", () => {
  const history = [
    { content: "delete the draft", id: "u1", kind: "", role: "user" },
    createToolCallEntry({ arguments: { path: "~/draft.md" }, callId: "call_9", name: "file_delete" }),
    createToolResultEntry({ callId: "call_9", name: "file_delete", payload: { deleted: true } }),
    { content: "Deleted it.", id: "a1", kind: "", role: "assistant" }
  ];
  const messages = historyEntriesToCanonicalMessages(history);

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(messages[1].toolCalls[0].name, "file_delete");
  assert.equal(messages[1].toolCalls[0].id, "call_9");
  assert.equal(messages[2].toolCallId, "call_9");
  assert.deepEqual(JSON.parse(messages[2].content), { deleted: true });
});

test("a failed tool result reaches the model as class plus coaching", () => {
  const history = [
    { content: "write it", id: "u1", kind: "", role: "user" },
    createToolCallEntry({ arguments: { path: "~/a" }, callId: "call_1", name: "file_write" }),
    createToolResultEntry({
      callId: "call_1",
      error: { class: "coercion", coaching: "send content as a string", message: "bad shape" },
      name: "file_write"
    })
  ];
  const messages = historyEntriesToCanonicalMessages(history);
  const toolMessage = messages.find((message) => message.role === "tool");

  assert.match(toolMessage.content, /^error \(coercion\): /u);
  assert.match(toolMessage.content, /send content as a string/u);
  assert.equal(toolMessage.isError, true);
});

test("empty legacy messages are skipped when building canonical messages", () => {
  const messages = historyEntriesToCanonicalMessages([
    { content: "", id: "u1", kind: "", role: "user" },
    { content: "answer", id: "a1", kind: "", role: "assistant" }
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "answer");
});

test("the reader never mutates the entry it reads", () => {
  const entry = { content: "hi", id: "u1", kind: "", role: "user" };
  const before = JSON.stringify(entry);

  readHistoryEntry(entry);
  describeHistoryEntryForRender(entry);
  historyEntriesToCanonicalMessages([entry]);

  assert.equal(JSON.stringify(entry), before);
});

// --- persistence round trip (the surface's write/read pair) ----------------

test("a typed entry survives the serializer/reader round trip", () => {
  const call = createToolCallEntry({ arguments: { path: "~/a.txt" }, callId: "c1", name: "file_read" });
  const okResult = createToolResultEntry({ callId: "c1", name: "file_read", payload: { content: "hi" } });
  const errResult = createToolResultEntry({
    callId: "c2",
    error: { class: "validation", coaching: "fix the args", message: "bad args" },
    name: "file_write"
  });

  for (const entry of [call, okResult, errResult]) {
    const stored = serializeTypedHistoryFields(entry);
    const restored = normalizeTypedHistoryFields({ ...entry, ...stored });

    if (entry.toolCall) {
      assert.deepEqual(restored.toolCall, entry.toolCall);
    } else {
      assert.equal(restored.toolResult.callId, entry.toolResult.callId);
      assert.deepEqual(restored.toolResult.error ?? restored.toolResult.payload, entry.toolResult.error ?? entry.toolResult.payload);
    }
  }
});

test("a legacy message writes no typed fields at all", () => {
  const legacy = { content: "hi", id: "u1", kind: "execution-output", role: "user" };

  assert.deepEqual({ ...serializeTypedHistoryFields(legacy) }, {});
  assert.deepEqual({ ...normalizeTypedHistoryFields(legacy) }, {});
});

// --- canonical -> typed (what the surface stores after a Tier 1 turn) ------

test("a canonical turn maps to typed entries without inventing legacy blocks", () => {
  const messages = [
    { content: "be useful", role: "system" },
    {
      content: "",
      role: "assistant",
      toolCalls: [{ arguments: { path: "~/a.txt" }, id: "c1", name: "file_read" }]
    },
    { content: "ok: {}", role: "tool", toolCallId: "c1" },
    { content: "Here is your answer.", role: "assistant" }
  ];
  const entries = canonicalMessagesToTypedEntries(messages);

  assert.deepEqual(entries.map((entry) => entry.kind), ["tool_call", "tool_result", ""]);
  assert.equal(entries[0].toolCall.name, "file_read");
  assert.equal(entries[1].toolResult.callId, "c1");
  assert.equal(entries[2].role, "assistant");
  // The system message is transport scaffolding, never history.
  assert.ok(entries.every((entry) => entry.content !== "be useful"));
});

test("fromIndex maps only the tail a turn produced", () => {
  const messages = [
    { content: "earlier", role: "user" },
    { content: "earlier answer", role: "assistant" },
    {
      content: "",
      role: "assistant",
      toolCalls: [{ arguments: {}, id: "c9", name: "file_list" }]
    }
  ];
  const entries = canonicalMessagesToTypedEntries(messages, { fromIndex: 2 });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolCall.callId, "c9");
});

// --- projection helpers ----------------------------------------------------

// P2 audit note 6: the one surface-side shape branch moved here, so the branch
// lives once, in THE reader. The helper must agree with the reader's own view.
test("isToolResultEntry identifies results and nothing else", () => {
  const call = createToolCallEntry({ arguments: {}, callId: "c1", name: "file_list" });
  const result = createToolResultEntry({ callId: "c1", name: "file_list", payload: [] });

  assert.equal(isToolResultEntry(result), true);
  assert.equal(isToolResultEntry(call), false);
  // Legacy message shapes are not results, whatever their role or kind.
  assert.equal(isToolResultEntry({ content: "hi", id: "u1", kind: "", role: "user" }), false);
  assert.equal(isToolResultEntry({ content: "x", kind: "execution-output", role: "user" }), false);
  assert.equal(isToolResultEntry(null), false);
  // It agrees with the reader on a stored (un-normalized) result entry.
  assert.equal(isToolResultEntry({ kind: "tool_result", role: "user", toolResult: { callId: "c1" } }), true);
});

test("typed entries project onto the existing execution chip for render", () => {
  const call = createToolCallEntry({ arguments: { path: "~/a.txt" }, callId: "c1", name: "file_read" });
  const projected = projectHistoryEntryForDisplay(call);

  assert.equal(projected.kind, "execution-output");
  assert.equal(projected.role, "user");
  assert.match(projected.content, /^execution file_read call/u);
  // The legacy entry is returned untouched, byte for byte.
  const legacy = { content: "hi", id: "u1", kind: "", role: "user" };

  assert.equal(projectHistoryEntryForDisplay(legacy), legacy);
});

test("typed entries project onto plain text for the text protocol", () => {
  const result = createToolResultEntry({ callId: "c1", name: "file_read", payload: { content: "hi" } });
  const projected = projectHistoryEntryForPrompt(result);

  assert.equal(projected.role, "user");
  assert.match(projected.content, /^file_read result: /u);
  // Legacy entries answer null so the caller keeps its own normalization path.
  assert.equal(projectHistoryEntryForPrompt({ content: "hi", role: "user" }), null);
});

// --- writers use the new shape only ---------------------------------------

test("writers emit typed entries and never a legacy execution-output text block", () => {
  const call = createToolCallEntry({ arguments: {}, callId: "c1", name: "file_list" });
  const result = createToolResultEntry({ callId: "c1", name: "file_list", payload: [] });

  assert.equal(call.kind, "tool_call");
  assert.equal(result.kind, "tool_result");
  // The legacy marker never appears on a newly written entry.
  assert.notEqual(call.kind, "execution-output");
  assert.notEqual(result.kind, "execution-output");
  assert.equal("content" in call, false);
  assert.equal("content" in result, false);
});
