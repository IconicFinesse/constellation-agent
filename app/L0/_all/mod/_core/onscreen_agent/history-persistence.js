// Incremental history checkpoints for the overlay send loop.
//
// The browser owns the agent loop, so any full-page navigation (for example
// opening /admin in the same tab) tears the running turn down. Conversation
// history used to be written only at turn boundaries, which lost an in-flight
// prompt entirely. These helpers keep a settled, reload-safe snapshot on disk
// while a reply is still streaming.

export const ONSCREEN_AGENT_HISTORY_CHECKPOINT_INTERVAL_MS = 1000;

export const ONSCREEN_AGENT_HISTORY_INTERRUPTED_SUFFIX =
  "\n\n[reply interrupted — the page was closed or reloaded before this turn finished]";

function normalizeAssistantContent(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Decide whether the send loop should write another mid-stream snapshot.
 * Throttled because each checkpoint is a real app-file write.
 */
export function shouldCheckpointOnscreenAgentHistory(options = {}) {
  const isStreaming = options.isStreaming === true;
  const lastCheckpointAt = Number(options.lastCheckpointAt) || 0;
  const now = Number(options.now) || 0;

  if (!isStreaming) {
    return false;
  }

  if (!normalizeAssistantContent(options.assistantContent)) {
    return false;
  }

  return now - lastCheckpointAt >= ONSCREEN_AGENT_HISTORY_CHECKPOINT_INTERVAL_MS;
}

function serializeStoredMessage(message) {
  return {
    attachments: Array.isArray(message?.attachments) ? message.attachments : [],
    content: typeof message?.content === "string" ? message.content : "",
    id: typeof message?.id === "string" ? message.id : "",
    kind: typeof message?.kind === "string" ? message.kind : "",
    role: message?.role === "assistant" ? "assistant" : "user"
  };
}

/**
 * Build the on-disk snapshot for an in-flight turn: the pending user turn plus
 * the partial assistant reply, settled and marked as interrupted so a reload
 * restores readable history instead of a stuck streaming bubble.
 */
export function buildOnscreenAgentHistoryCheckpoint(pendingMessages, assistantMessage) {
  const content = normalizeAssistantContent(assistantMessage?.content);

  if (!content) {
    return null;
  }

  const pending = Array.isArray(pendingMessages) ? pendingMessages : [];
  const definition = {
    ...serializeStoredMessage({
      ...assistantMessage,
      content: `${content}${ONSCREEN_AGENT_HISTORY_INTERRUPTED_SUFFIX}`
    }),
    streaming: false
  };

  return [...pending, definition];
}
