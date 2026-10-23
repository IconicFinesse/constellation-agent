import { buildAssistantMessageRepeatLog } from "/modules/_core/agent-chat/assistant-message-evaluation.js";

export default async function appendOnscreenAssistantRepeatWarning(hookContext) {
  const evaluation = hookContext?.result;

  if (!evaluation || typeof evaluation !== "object") {
    return;
  }

  const repeatLog = buildAssistantMessageRepeatLog({
    assistantContent: evaluation.assistantContent,
    history: evaluation.history,
    messageId: evaluation.messageId
  });

  if (!repeatLog) {
    return;
  }

  const existingLogs = Array.isArray(evaluation.logs) ? evaluation.logs : [];
  evaluation.logs = [
    ...existingLogs,
    {
      level: repeatLog.level,
      text: repeatLog.text
    }
  ];
}
