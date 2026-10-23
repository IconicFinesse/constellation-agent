import {
  CONTEXT_RUNTIME_ATTRIBUTE,
  CONTEXT_SELECTOR,
  RUNTIME_CONTEXT
} from "../framework/js/context.js";

const AGENT_FUNCTION_REQUIREMENT = Object.freeze({
  NATIVE_APP_ONLY: "native_app_only"
});

const AGENT_FUNCTION_REQUIREMENTS = Object.freeze({
  [AGENT_FUNCTION_REQUIREMENT.NATIVE_APP_ONLY]: Object.freeze({
    code: "browser_native_app_only",
    message: "Browser functionality is currently only implemented in native apps.",
    test() {
      return resolveAgentFunctionRuntimeContext() === RUNTIME_CONTEXT.APP;
    }
  })
});

const RUNTIME_CONTEXT_SELECTOR = `${CONTEXT_SELECTOR}[${CONTEXT_RUNTIME_ATTRIBUTE}]`;

let cachedRuntimeContext = "";

function emitAgentFunctionBlockNotice(result) {
  const message = String(result?.message || result?.warning || "").trim();
  if (!message) {
    return;
  }

  try {
    globalThis.console?.log?.(message);
  } catch {
    // Ignore console availability issues in nonstandard runtimes.
  }
}

function normalizeRuntimeContext(value) {
  const normalizedValue = String(value || "").trim();
  return normalizedValue === RUNTIME_CONTEXT.APP || normalizedValue === RUNTIME_CONTEXT.BROWSER
    ? normalizedValue
    : "";
}

function readRuntimeContextFromDocument(root = globalThis.document) {
  const contextElement = root?.querySelector?.(RUNTIME_CONTEXT_SELECTOR);
  return normalizeRuntimeContext(
    contextElement?.getAttribute?.(CONTEXT_RUNTIME_ATTRIBUTE)
  );
}

function readRuntimeContextFromDesktopBridge() {
  return globalThis.spaceDesktop?.browser?.available === true ? RUNTIME_CONTEXT.APP : "";
}

export function resolveAgentFunctionRuntimeContext(root = globalThis.document) {
  const desktopBridgeRuntime = readRuntimeContextFromDesktopBridge();
  if (desktopBridgeRuntime) {
    cachedRuntimeContext = desktopBridgeRuntime;
    return desktopBridgeRuntime;
  }

  const documentRuntime = readRuntimeContextFromDocument(root);
  if (documentRuntime) {
    cachedRuntimeContext = documentRuntime;
    return documentRuntime;
  }

  if (cachedRuntimeContext) {
    return cachedRuntimeContext;
  }

  cachedRuntimeContext = RUNTIME_CONTEXT.BROWSER;
  return cachedRuntimeContext;
}

export function getAgentFunctionBlockResult(requirementName, details = {}) {
  const requirement = AGENT_FUNCTION_REQUIREMENTS[requirementName];
  if (!requirement) {
    return null;
  }

  if (requirement.test()) {
    return null;
  }

  const runtime = resolveAgentFunctionRuntimeContext();
  const message = String(requirement.message || "This functionality is currently unavailable.");

  return {
    available: false,
    code: String(requirement.code || "agent_function_unavailable"),
    message,
    requirement: requirementName,
    runtime,
    warning: message,
    ...details
  };
}

export function guardAgentFunction(requirementName, handler, details = {}) {
  if (typeof handler !== "function") {
    throw new Error("guardAgentFunction requires a function handler.");
  }

  return function guardedAgentFunction(...args) {
    const blockedResult = getAgentFunctionBlockResult(requirementName, details);
    if (blockedResult) {
      emitAgentFunctionBlockNotice(blockedResult);
      return blockedResult;
    }

    return handler.apply(this, args);
  };
}

export {
  AGENT_FUNCTION_REQUIREMENT
};
