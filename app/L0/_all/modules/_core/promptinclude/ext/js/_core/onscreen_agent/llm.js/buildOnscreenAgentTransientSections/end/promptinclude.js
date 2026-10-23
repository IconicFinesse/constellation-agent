import { mergePromptItemMaps } from "/modules/_core/agent_prompt/prompt-items.js";
import { buildPromptIncludeTransientItems } from "/modules/_core/promptinclude/promptinclude.js";

export default async function injectPromptIncludeTransientSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext) {
    return;
  }

  const promptIncludeTransientItems = await buildPromptIncludeTransientItems().catch((error) => {
    console.error("Unable to build prompt include transient items.", error);
    return {};
  });

  if (!Object.keys(promptIncludeTransientItems).length) {
    return;
  }

  promptContext.promptIncludeTransientItems = {
    ...promptIncludeTransientItems
  };
  promptContext.transientItems = mergePromptItemMaps(promptContext.transientItems, promptIncludeTransientItems);
}
