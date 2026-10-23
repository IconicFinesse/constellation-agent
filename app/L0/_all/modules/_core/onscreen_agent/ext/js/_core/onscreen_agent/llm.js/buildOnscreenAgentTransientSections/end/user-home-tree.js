import { setPromptItem } from "/modules/_core/agent_prompt/prompt-items.js";
import {
  buildUserHomeFileTreeTransientSectionFromRuntime,
  USER_HOME_FILE_TREE_TRANSIENT_KEY
} from "/modules/_core/onscreen_agent/prompt-context.js";

function normalizeTransientItem(section) {
  if (!section || typeof section !== "object") {
    return null;
  }

  return {
    heading: section.heading,
    key: section.key,
    order: section.order,
    value: section.content
  };
}

export default async function injectUserHomeFileTreeTransientSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext) {
    return;
  }

  const userHomeFileTreeTransientSection = await buildUserHomeFileTreeTransientSectionFromRuntime().catch((error) => {
    console.error("Unable to build the user home file tree transient section.", error);
    return null;
  });

  if (!userHomeFileTreeTransientSection) {
    return;
  }

  promptContext.transientItems = setPromptItem(
    promptContext.transientItems,
    USER_HOME_FILE_TREE_TRANSIENT_KEY,
    normalizeTransientItem(userHomeFileTreeTransientSection)
  );
}
