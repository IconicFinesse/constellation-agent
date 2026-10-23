import { setPromptItem } from "/modules/_core/agent_prompt/prompt-items.js";
import {
  AVAILABLE_SPACES_TRANSIENT_KEY,
  buildAvailableSpacesTransientSection
} from "/modules/_core/spaces/prompt-context.js";
import { listSpaces as listSpacesFromStorage } from "/modules/_core/spaces/storage.js";

function logAvailableSpacesPromptError(error) {
  console.error("[spaces] available spaces transient failed", error);
}

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

async function listAvailableSpacesForPrompt() {
  const runtimeListSpaces = globalThis.space?.spaces?.listSpaces;

  if (typeof runtimeListSpaces === "function") {
    return await runtimeListSpaces();
  }

  return await listSpacesFromStorage();
}

export default async function injectAvailableSpacesTransientSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext) {
    return;
  }

  let spaceList;

  try {
    spaceList = await listAvailableSpacesForPrompt();
  } catch (error) {
    logAvailableSpacesPromptError(error);
    return;
  }

  const availableSpacesTransientSection = buildAvailableSpacesTransientSection({
    spaceList
  });

  if (!availableSpacesTransientSection) {
    return;
  }

  promptContext.transientItems = setPromptItem(
    promptContext.transientItems,
    AVAILABLE_SPACES_TRANSIENT_KEY,
    normalizeTransientItem(availableSpacesTransientSection)
  );
}
