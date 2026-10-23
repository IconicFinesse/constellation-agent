import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOnscreenAgentHistoryCheckpoint,
  ONSCREEN_AGENT_HISTORY_CHECKPOINT_INTERVAL_MS,
  ONSCREEN_AGENT_HISTORY_INTERRUPTED_SUFFIX,
  shouldCheckpointOnscreenAgentHistory
} from "../app/L0/_all/modules/_core/onscreen_agent/history-persistence.js";

test("history checkpoint gate waits for the throttle interval", () => {
  assert.equal(ONSCREEN_AGENT_HISTORY_CHECKPOINT_INTERVAL_MS, 1000);
  assert.equal(
    shouldCheckpointOnscreenAgentHistory({
      assistantContent: "Working on it",
      isStreaming: true,
      lastCheckpointAt: 1000,
      now: 1999
    }),
    false
  );
  assert.equal(
    shouldCheckpointOnscreenAgentHistory({
      assistantContent: "Working on it",
      isStreaming: true,
      lastCheckpointAt: 1000,
      now: 2000
    }),
    true
  );
});

test("history checkpoint gate skips idle streams and empty content", () => {
  assert.equal(
    shouldCheckpointOnscreenAgentHistory({
      assistantContent: "Working on it",
      isStreaming: false,
      lastCheckpointAt: 0,
      now: 5000
    }),
    false
  );
  assert.equal(
    shouldCheckpointOnscreenAgentHistory({
      assistantContent: "  \n  ",
      isStreaming: true,
      lastCheckpointAt: 0,
      now: 5000
    }),
    false
  );
});

test("history checkpoint snapshot keeps the pending user turn and settles the partial reply", () => {
  const userMessage = {
    attachments: [],
    content: "create a note taker",
    id: "user-1",
    kind: "",
    role: "user"
  };
  const assistantMessage = {
    attachments: [],
    content: "Starting on the note taker",
    id: "assistant-1",
    kind: "",
    role: "assistant",
    streaming: true
  };

  const checkpoint = buildOnscreenAgentHistoryCheckpoint([userMessage], assistantMessage);

  assert.deepEqual(checkpoint, [
    userMessage,
    {
      attachments: [],
      content: `Starting on the note taker${ONSCREEN_AGENT_HISTORY_INTERRUPTED_SUFFIX}`,
      id: "assistant-1",
      kind: "",
      role: "assistant",
      streaming: false
    }
  ]);
  assert.equal(assistantMessage.streaming, true);
  assert.equal(assistantMessage.content, "Starting on the note taker");
});

test("history checkpoint snapshot is skipped for an empty partial reply", () => {
  assert.equal(
    buildOnscreenAgentHistoryCheckpoint([], {
      attachments: [],
      content: "   ",
      id: "assistant-1",
      kind: "",
      role: "assistant",
      streaming: true
    }),
    null
  );
});
