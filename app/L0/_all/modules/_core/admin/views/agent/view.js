import * as execution from "/modules/_core/admin/views/agent/execution.js";
import { createAgentThreadView } from "/modules/_core/visual/conversation/thread-view.js";

const ADMIN_AGENT_ASTRONAUT_PATH = "/modules/_core/visual/res/chat/admin/astronaut_no_bg.webp";

function createAdminEmptyState() {
  const emptyState = document.createElement("div");
  emptyState.className = "chat-empty";

  const bounceZone = document.createElement("div");
  bounceZone.className = "chat-empty-bounce";

  const astronautWrap = document.createElement("div");
  astronautWrap.className = "chat-empty-astronaut-wrap";
  const xPhase = (Math.random() * 18).toFixed(2);
  const yPhase = (Math.random() * 13.4).toFixed(2);
  astronautWrap.style.animationDelay = `-${xPhase}s, -${yPhase}s, 0.6s`;

  const astronaut = document.createElement("img");
  astronaut.className = "chat-empty-astronaut";
  astronaut.src = ADMIN_AGENT_ASTRONAUT_PATH;
  astronaut.alt = "";
  astronaut.setAttribute("aria-hidden", "true");

  astronautWrap.append(astronaut);
  bounceZone.append(astronautWrap);

  const hint = document.createElement("div");
  hint.className = "chat-empty-hint";
  hint.textContent = "Message the Admin agent about user management, development, or other tasks.";

  emptyState.append(bounceZone, hint);
  return emptyState;
}

const threadView = createAgentThreadView({
  assistantAvatarPath: "/modules/_core/visual/res/chat/admin/helmet_no_bg_256.webp",
  autoResizeMaxHeight: 220,
  createEmptyState: createAdminEmptyState,
  execution,
  renderMarkdownWithMarked: true
});

export const autoResizeTextarea = threadView.autoResizeTextarea;
export const copyTextToClipboard = threadView.copyTextToClipboard;
export const findExecuteSection = threadView.findExecuteSection;
export const getAssistantMessageCopyText = threadView.getAssistantMessageCopyText;
export const getTerminalInputText = threadView.getTerminalInputText;
export const getTerminalOutputText = threadView.getTerminalOutputText;
export const renderMessages = threadView.renderMessages;
export const summarizeLlmConfig = threadView.summarizeLlmConfig;
export const summarizeSystemPrompt = threadView.summarizeSystemPrompt;
export const updateStreamingAssistantMessage = threadView.updateStreamingAssistantMessage;
