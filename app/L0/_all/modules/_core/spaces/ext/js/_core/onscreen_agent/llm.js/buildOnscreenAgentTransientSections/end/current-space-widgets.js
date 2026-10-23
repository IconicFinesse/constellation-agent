import { setPromptItem } from "/modules/_core/agent_prompt/prompt-items.js";
import { getStore } from "/modules/_core/framework/js/AlpineStore.js";
import {
  buildCurrentSpaceWidgetsTransientSection,
  CURRENT_SPACE_WIDGETS_TRANSIENT_KEY
} from "/modules/_core/spaces/prompt-context.js";

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

export default async function injectCurrentSpaceWidgetsTransientSection(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext) {
    return;
  }

  const spacesStore = getStore("spacesPage");
  const currentSpaceWidgetsTransientSection = buildCurrentSpaceWidgetsTransientSection({
    currentSpaceId: spacesStore?.currentSpaceId,
    currentSpaceTitle: spacesStore?.currentSpaceDisplayTitle,
    routePath: globalThis.space?.router?.current?.path,
    widgets: globalThis.space?.current?.widgets
  });

  if (!currentSpaceWidgetsTransientSection) {
    return;
  }

  promptContext.transientItems = setPromptItem(
    promptContext.transientItems,
    CURRENT_SPACE_WIDGETS_TRANSIENT_KEY,
    normalizeTransientItem(currentSpaceWidgetsTransientSection)
  );
}
