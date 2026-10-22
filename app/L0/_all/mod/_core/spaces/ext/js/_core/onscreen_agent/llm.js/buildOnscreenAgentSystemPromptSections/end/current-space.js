import { setPromptItem } from "/mod/_core/agent_prompt/prompt-items.js";
import { SPACES_ROUTE_PATH } from "/mod/_core/spaces/constants.js";

const CURRENT_SPACE_SYSTEM_KEY = "current-constellation-agent-instructions";
const CURRENT_SPACE_SYSTEM_ORDER = 190;

function buildCurrentSpaceAgentInstructionsPromptSection(currentSpace) {
  const normalizedAgentInstructions = String(
    currentSpace?.agentInstructions ?? currentSpace?.specialInstructions ?? ""
  ).trim();

  if (!normalizedAgentInstructions) {
    return "";
  }

  return [
    "## Current Constellation Agent Instructions",
    "",
    normalizedAgentInstructions
  ].join("\n");
}

export default function injectCurrentSpacePromptSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext) {
    return;
  }

  if (globalThis.space?.router?.current?.path !== SPACES_ROUTE_PATH) {
    return;
  }

  const currentSpace = globalThis.space?.current;

  if (!currentSpace?.id) {
    return;
  }

  const currentSpaceAgentInstructionsPromptSection = buildCurrentSpaceAgentInstructionsPromptSection(currentSpace);

  if (!currentSpaceAgentInstructionsPromptSection) {
    return;
  }

  promptContext.currentSpaceAgentInstructionsPromptSection = currentSpaceAgentInstructionsPromptSection;
  promptContext.currentSpacePromptSection = "";
  promptContext.systemItems = setPromptItem(promptContext.systemItems, CURRENT_SPACE_SYSTEM_KEY, {
    order: CURRENT_SPACE_SYSTEM_ORDER,
    value: currentSpaceAgentInstructionsPromptSection
  });
}
