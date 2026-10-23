export const CONTEXT_SELECTOR = "x-context";
export const CONTEXT_TAGS_ATTRIBUTE = "data-tags";
export const CONTEXT_RUNTIME_ATTRIBUTE = "data-runtime";
export const RUNTIME_CONTEXT = Object.freeze({
  APP: "app",
  BROWSER: "browser"
});

const RUNTIME_CONTEXT_SELECTOR = `${CONTEXT_SELECTOR}[${CONTEXT_RUNTIME_ATTRIBUTE}]`;

function normalizeTextValue(value) {
  return String(value ?? "").trim();
}

function parseTokenListValue(value) {
  const rawValue = normalizeTextValue(value);

  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(/[\s,]+/u)
    .map((entry) => normalizeTextValue(entry))
    .filter(Boolean);
}

function isContextElement(node) {
  return Boolean(node?.matches?.(CONTEXT_SELECTOR));
}

function isBundledAppRuntime(runtimeInfo) {
  return Boolean(runtimeInfo && runtimeInfo.isBundledApp === true);
}

function isSingleUserAppConfig(frontendConfig) {
  if (!frontendConfig || typeof frontendConfig !== "object") {
    return false;
  }

  if (typeof frontendConfig.get === "function") {
    return frontendConfig.get("SINGLE_USER_APP", false) === true;
  }

  if (frontendConfig.values && typeof frontendConfig.values === "object") {
    return frontendConfig.values.SINGLE_USER_APP === true;
  }

  return frontendConfig.SINGLE_USER_APP === true;
}

function hasDesktopBrowserBridge(desktopBrowserApi) {
  return Boolean(desktopBrowserApi?.available === true);
}

function toRuntimeTag(runtime) {
  const normalizedRuntime = normalizeTextValue(runtime);
  return normalizedRuntime ? `runtime-${normalizedRuntime}` : "";
}

export function getContexts(root = globalThis.document) {
  const contexts = [];

  if (isContextElement(root)) {
    contexts.push(root);
  }

  if (root?.querySelectorAll) {
    contexts.push(...root.querySelectorAll(CONTEXT_SELECTOR));
  }

  return [...new Set(contexts)];
}

export function getAttributeValues(attributeName, root = globalThis.document) {
  const normalizedName = normalizeTextValue(attributeName);

  if (!normalizedName) {
    return [];
  }

  return getContexts(root)
    .map((element) => normalizeTextValue(element?.getAttribute?.(normalizedName)))
    .filter(Boolean);
}

export function getContents(root = globalThis.document) {
  return getContexts(root)
    .map((element) => normalizeTextValue(element?.textContent))
    .filter(Boolean);
}

export function getTags(root = globalThis.document) {
  const uniqueTags = new Set();

  getAttributeValues(CONTEXT_TAGS_ATTRIBUTE, root).forEach((value) => {
    parseTokenListValue(value).forEach((tag) => uniqueTags.add(tag));
  });

  return [...uniqueTags].sort();
}

export async function resolveRuntimeContext(options = {}) {
  const desktopApi = options.desktopApi ?? globalThis.space;
  const desktopBrowserApi = options.desktopBrowserApi ?? globalThis.spaceDesktop?.browser;
  const frontendConfig = options.frontendConfig ?? globalThis.space?.config;
  const packagedFallback = isSingleUserAppConfig(frontendConfig);

  if (hasDesktopBrowserBridge(desktopBrowserApi)) {
    return RUNTIME_CONTEXT.APP;
  }

  if (!desktopApi || typeof desktopApi.getRuntimeInfo !== "function") {
    return packagedFallback ? RUNTIME_CONTEXT.APP : RUNTIME_CONTEXT.BROWSER;
  }

  try {
    const runtimeInfo = await desktopApi.getRuntimeInfo();
    return isBundledAppRuntime(runtimeInfo)
      ? RUNTIME_CONTEXT.APP
      : RUNTIME_CONTEXT.BROWSER;
  } catch (error) {
    console.warn("[space-framework] Failed to resolve runtime context.", error);
    return packagedFallback ? RUNTIME_CONTEXT.APP : RUNTIME_CONTEXT.BROWSER;
  }
}

function findRuntimeContextElement(root) {
  if (!root?.querySelector) {
    return null;
  }

  return root.querySelector(RUNTIME_CONTEXT_SELECTOR);
}

export async function syncRuntimeContext(options = {}) {
  const root = options.root ?? globalThis.document;
  const runtime = await resolveRuntimeContext(options);
  const parent = root?.body || root?.documentElement;

  if (!root?.createElement || !parent?.appendChild) {
    return runtime;
  }

  let element = findRuntimeContextElement(root);

  if (!element || typeof element.setAttribute !== "function") {
    element = root.createElement(CONTEXT_SELECTOR);
    element.setAttribute("hidden", "");
    parent.appendChild(element);
  }

  element.setAttribute(CONTEXT_RUNTIME_ATTRIBUTE, runtime);
  element.setAttribute(CONTEXT_TAGS_ATTRIBUTE, toRuntimeTag(runtime));
  return runtime;
}
