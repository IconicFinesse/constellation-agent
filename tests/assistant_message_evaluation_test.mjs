import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAssistantMessageRepeatLog,
  normalizeAssistantMessageContent,
  prependAssistantEvaluationLogs
} from "../app/L0/_all/modules/_core/agent-chat/assistant-message-evaluation.js";

test("normalizeAssistantMessageContent trims line endings and trailing whitespace", () => {
  assert.equal(
    normalizeAssistantMessageContent("Checking now...  \r\n_____javascript\r\nreturn 1\r\n"),
    "Checking now...\n_____javascript\nreturn 1"
  );
});

test("buildAssistantMessageRepeatLog returns info on the first repeat", () => {
  const repeatLog = buildAssistantMessageRepeatLog({
    assistantContent: "Checking now...\n_____javascript\nreturn 1",
    history: [
      {
        content: "Checking now...  \r\n_____javascript\r\nreturn 1\r\n",
        id: "assistant-1",
        role: "assistant"
      },
      {
        content: "execution success",
        id: "framework-1",
        role: "user"
      },
      {
        content: "Checking now...\n_____javascript\nreturn 1",
        id: "assistant-2",
        role: "assistant"
      }
    ],
    messageId: "assistant-2"
  });

  assert.equal(repeatLog?.level, "info");
  assert.match(repeatLog?.text || "", /2nd time/u);
});

test("buildAssistantMessageRepeatLog escalates to warn after the second repeat", () => {
  const repeatLog = buildAssistantMessageRepeatLog({
    assistantContent: "Checking now...\n_____javascript\nreturn 1",
    history: [
      {
        content: "Checking now...\n_____javascript\nreturn 1",
        id: "assistant-1",
        role: "assistant"
      },
      {
        content: "Checking now...\n_____javascript\nreturn 1",
        id: "assistant-2",
        role: "assistant"
      },
      {
        content: "Checking now...\n_____javascript\nreturn 1",
        id: "assistant-3",
        role: "assistant"
      }
    ],
    messageId: "assistant-3"
  });

  assert.equal(repeatLog?.level, "warn");
  assert.match(repeatLog?.text || "", /3rd time/u);
});

test("buildAssistantMessageRepeatLog escalates to error on the fourth exact send", () => {
  const repeatLog = buildAssistantMessageRepeatLog({
    assistantContent: "Checking now...\n_____javascript\nreturn 1",
    history: [
      {
        content: "Checking now...\n_____javascript\nreturn 1",
        id: "assistant-1",
        role: "assistant"
      },
      {
        content: "Checking now...\n_____javascript\nreturn 1",
        id: "assistant-2",
        role: "assistant"
      },
      {
        content: "Checking now...\n_____javascript\nreturn 1",
        id: "assistant-3",
        role: "assistant"
      },
      {
        content: "Checking now...\n_____javascript\nreturn 1",
        id: "assistant-4",
        role: "assistant"
      }
    ],
    messageId: "assistant-4"
  });

  assert.equal(repeatLog?.level, "error");
  assert.match(repeatLog?.text || "", /4th time/u);
});

test("prependAssistantEvaluationLogs prepends synthetic logs without rewriting existing console output", () => {
  const results = [
    {
      logs: [
        {
          level: "log",
          text: "  keep surrounding whitespace  "
        }
      ],
      status: "success"
    }
  ];

  prependAssistantEvaluationLogs(results, [
    {
      level: "warn",
      text: "loop warning"
    }
  ]);

  assert.deepEqual(results[0].logs, [
    {
      level: "warn",
      text: "loop warning"
    },
    {
      level: "log",
      text: "  keep surrounding whitespace  "
    }
  ]);
});
