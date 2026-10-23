import { mergePromptItemMaps } from "/modules/_core/agent_prompt/prompt-items.js";
import {
  buildPromptIncludeSystemPromptItems,
  buildPromptIncludeSystemPromptSection,
  PROMPT_INCLUDE_SYSTEM_ITEM_KEY,
  PROMPT_INCLUDE_SYSTEM_ITEM_ORDER
} from "/modules/_core/promptinclude/promptinclude.js";

export default async function injectPromptIncludeSystemPromptSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext) {
    return;
  }

  const promptIncludeSystemPromptItems = await buildPromptIncludeSystemPromptItems().catch((error) => {
    console.error("Unable to build prompt include system prompt sections.", error);
    return {
      [PROMPT_INCLUDE_SYSTEM_ITEM_KEY]: {
        order: PROMPT_INCLUDE_SYSTEM_ITEM_ORDER,
        trimAllowed: false,
        value: buildPromptIncludeSystemPromptSection()
      }
    };
  });

  if (!Object.keys(promptIncludeSystemPromptItems).length) {
    return;
  }

  promptContext.promptIncludeSystemPromptItems = {
    ...promptIncludeSystemPromptItems
  };
  promptContext.systemItems = mergePromptItemMaps(promptContext.systemItems, promptIncludeSystemPromptItems);
}
