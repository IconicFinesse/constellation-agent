import { setPromptItem } from "/modules/_core/agent_prompt/prompt-items.js";
import { getStore } from "/modules/_core/framework/js/AlpineStore.js";

const COMPACT_DISPLAY_MODE = "compact";
const DISPLAY_MODE_TRANSIENT_HEADING = "chat display mode";
const DISPLAY_MODE_TRANSIENT_KEY = "chat-display-mode";

function buildCompactDisplayModeTransientSection() {
  return {
    heading: DISPLAY_MODE_TRANSIENT_HEADING,
    key: DISPLAY_MODE_TRANSIENT_KEY,
    order: 0,
    value: [
      "chat is in compact mode",
      "keep replies short unless more detail is needed for correctness or the user asks for it"
    ].join("\n")
  };
}

export default async function injectDisplayModeTransientSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext) {
    return;
  }

  const onscreenAgentStore = getStore("onscreenAgent");
  const displayMode = typeof onscreenAgentStore?.displayMode === "string"
    ? onscreenAgentStore.displayMode.trim()
    : "";

  if (displayMode !== COMPACT_DISPLAY_MODE) {
    return;
  }

  promptContext.transientItems = setPromptItem(
    promptContext.transientItems,
    DISPLAY_MODE_TRANSIENT_KEY,
    buildCompactDisplayModeTransientSection()
  );
}
