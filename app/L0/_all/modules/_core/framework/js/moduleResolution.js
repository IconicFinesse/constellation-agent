const MODULE_MAX_LAYER_META_NAME = "space-max-layer";
const MODULE_PATH_PREFIX = "/modules/";

let cachedModuleMaxLayer;

function parseOptionalMaxLayer(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numericValue = Number(value);

  if (!Number.isInteger(numericValue)) {
    return null;
  }

  return Math.min(2, Math.max(0, numericValue));
}

export function getConfiguredModuleMaxLayer() {
  if (cachedModuleMaxLayer !== undefined) {
    return cachedModuleMaxLayer;
  }

  const metaTag = document.querySelector(`meta[name="${MODULE_MAX_LAYER_META_NAME}"]`);
  cachedModuleMaxLayer = parseOptionalMaxLayer(metaTag?.content);
  return cachedModuleMaxLayer;
}

export function applyModuleResolution(value) {
  const originalValue = String(value || "");
  const maxLayer = getConfiguredModuleMaxLayer();

  if (!originalValue || maxLayer === null) {
    return originalValue;
  }

  let resolvedUrl;

  try {
    resolvedUrl = new URL(originalValue, globalThis.location.origin);
  } catch {
    return originalValue;
  }

  if (
    resolvedUrl.origin !== globalThis.location.origin ||
    !resolvedUrl.pathname.startsWith(MODULE_PATH_PREFIX)
  ) {
    return originalValue;
  }

  resolvedUrl.searchParams.set("maxLayer", String(maxLayer));

  if (originalValue.startsWith("/")) {
    return `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
  }

  return resolvedUrl.toString();
}

export function applyModuleResolutionToElementAttributes(root) {
  if (!root || typeof root.querySelectorAll !== "function") {
    return;
  }

  const candidates = root.matches?.("[href],[src],[path]")
    ? [root, ...root.querySelectorAll("[href],[src],[path]")]
    : root.querySelectorAll("[href],[src],[path]");

  for (const element of candidates) {
    for (const attributeName of ["href", "path", "src"]) {
      if (!element.hasAttribute?.(attributeName)) {
        continue;
      }

      element.setAttribute(
        attributeName,
        applyModuleResolution(element.getAttribute(attributeName))
      );
    }
  }
}
