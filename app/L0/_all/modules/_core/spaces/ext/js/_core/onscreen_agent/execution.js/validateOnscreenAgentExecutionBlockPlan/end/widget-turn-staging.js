import { createExecutionPlanError } from "/modules/_core/onscreen_agent/execution.js";

function hasWidgetDiscoveryHelper(code = "") {
  return /\bspace\.current\.(?:listWidgets|readWidget|seeWidget)\s*\(/u.test(code);
}

function hasWidgetMutationHelper(code = "") {
  return /\bspace\.(?:current|spaces)\.(?:patchWidget|renderWidget|upsertWidget)\s*\(/u.test(code);
}

export default function validateSpacesWidgetTurnStaging(hookContext) {
  const validationResult = hookContext?.result;

  if (!validationResult || typeof validationResult !== "object") {
    return;
  }

  const code = typeof validationResult.code === "string" ? validationResult.code : "";

  if (!Array.isArray(validationResult.errors)) {
    validationResult.errors = [];
  }

  if (hasWidgetDiscoveryHelper(code) && hasWidgetMutationHelper(code)) {
    validationResult.errors.push(
      createExecutionPlanError(
        "Widget discovery and dependent widget mutation must be separate turns. End after listWidgets(...), readWidget(...), or seeWidget(...), wait for the next turn, then patch or render."
      )
    );
  }

  if (/\bspace\.current\.(?:readWidget|seeWidget)\s*\(/u.test(code) && /\bspace\.chat\.transient\b/u.test(code)) {
    validationResult.errors.push(
      createExecutionPlanError(
        "Do not mix readWidget(...) or seeWidget(...) with TRANSIENT in the same execution block. End after the inspection call, then use the visible framework result or post-write TRANSIENT on the next turn."
      )
    );
  }
}
