const ENTER_TAB_ACCESS_KEY = "space.enter.tab-access";
const INSTALL_KEY = Symbol.for("space.framework.newWindowAccessInstalled");
const LOCATION_PATCH_INSTALL_KEY = Symbol.for("space.framework.locationNavigationPatchInstalled");
const ORIGINAL_LOCATION_ASSIGN_KEY = Symbol.for("space.framework.originalLocationAssign");
const ORIGINAL_LOCATION_REPLACE_KEY = Symbol.for("space.framework.originalLocationReplace");
const ORIGINAL_LOCATION_HREF_DESCRIPTOR_KEY = Symbol.for("space.framework.originalLocationHrefDescriptor");
const ORIGINAL_OPEN_KEY = Symbol.for("space.framework.originalWindowOpen");
const CURRENT_TAB_TARGETS = new Set(["", "_self", "_top", "_parent"]);
const GUARDED_PAGE_PATHS = new Set(["/", "/admin"]);
const HTTP_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);

function hasCurrentTabAccess() {
  try {
    return window.sessionStorage.getItem(ENTER_TAB_ACCESS_KEY) === "1";
  } catch {
    return false;
  }
}

function isPackagedDesktopRuntime() {
  return Boolean(globalThis.spaceDesktop?.browser?.available);
}

function getNavigationApi() {
  const navigationApi = globalThis.navigation;
  return navigationApi && typeof navigationApi.addEventListener === "function"
    ? navigationApi
    : null;
}

function resolveNavigationUrl(candidate) {
  if (typeof candidate !== "string" && !(candidate instanceof URL)) {
    return null;
  }

  const rawValue = String(candidate || "").trim();

  if (!rawValue || rawValue.startsWith("//")) {
    return null;
  }

  let resolvedUrl;

  try {
    resolvedUrl = new URL(rawValue, window.location.href);
  } catch {
    return null;
  }

  return resolvedUrl;
}

function isGuardedLocalUrl(targetUrl) {
  return Boolean(
    targetUrl
      && targetUrl.origin === window.location.origin
      && GUARDED_PAGE_PATHS.has(targetUrl.pathname)
  );
}

function isCrossOriginHttpUrl(targetUrl) {
  return Boolean(
    targetUrl
      && HTTP_NAVIGATION_PROTOCOLS.has(targetUrl.protocol)
      && targetUrl.origin !== window.location.origin
  );
}

function normalizeTarget(target, fallback = "") {
  return String(target ?? fallback).trim().toLowerCase();
}

function isBlankTarget(target) {
  return normalizeTarget(target, "_blank") === "_blank";
}

function isCurrentTabTarget(target) {
  return CURRENT_TAB_TARGETS.has(normalizeTarget(target));
}

function mergeNoopenerFeatures(features) {
  if (typeof features !== "string" || !features.trim()) {
    return "noopener,noreferrer";
  }

  const featureMap = new Map();

  features
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean)
    .forEach((feature) => {
      const featureName = feature.split("=", 1)[0].trim().toLowerCase();
      if (!featureName) {
        return;
      }

      featureMap.set(featureName, feature);
    });

  if (!featureMap.has("noopener")) {
    featureMap.set("noopener", "noopener");
  }

  if (!featureMap.has("noreferrer")) {
    featureMap.set("noreferrer", "noreferrer");
  }

  return [...featureMap.values()].join(",");
}

function grantChildTabAccess(childWindow) {
  try {
    childWindow.sessionStorage.setItem(ENTER_TAB_ACCESS_KEY, "1");
  } catch {
    // If the browser blocks child storage access, the page-shell guard remains the fallback.
  }
}

function detachChildOpener(childWindow) {
  try {
    childWindow.opener = null;
  } catch {
    // Some browsers expose opener as read-only. The opened URL is same-origin app chrome.
  }
}

function navigateChildWindow(childWindow, targetUrl) {
  try {
    childWindow.location.replace(targetUrl.href);
  } catch {
    childWindow.location.href = targetUrl.href;
  }
}

function openGuardedBlankWindow(originalOpen, targetUrl, target, features) {
  const childWindow = originalOpen.call(window, "about:blank", target || "_blank", mergeNoopenerFeatures(features));

  if (!childWindow) {
    return childWindow;
  }

  grantChildTabAccess(childWindow);
  detachChildOpener(childWindow);
  navigateChildWindow(childWindow, targetUrl);
  return childWindow;
}

function openExternalNavigationTarget(originalOpen, targetUrl, features = undefined) {
  if (!targetUrl) {
    return null;
  }

  if (isPackagedDesktopRuntime()) {
    return null;
  }

  return originalOpen.call(window, targetUrl.href, "_blank", mergeNoopenerFeatures(features));
}

function shouldHandleNavigationClick(event, anchor, targetUrl) {
  return Boolean(
    anchor
      && targetUrl
      && !anchor.hasAttribute("download")
      && !event.defaultPrevented
      && event.button === 0
      && !event.metaKey
      && !event.ctrlKey
      && !event.shiftKey
      && !event.altKey
  );
}

function findClickedAnchor(event) {
  const target = event.target;

  if (!(target instanceof Element)) {
    return null;
  }

  return target.closest("a[href]");
}

function shouldHandleGuardedBlankAnchorClick(event, anchor, targetUrl) {
  return Boolean(
    shouldHandleNavigationClick(event, anchor, targetUrl)
      && hasCurrentTabAccess()
      && isBlankTarget(anchor.target)
      && isGuardedLocalUrl(targetUrl)
  );
}

function shouldHandleExternalSameTabAnchorClick(event, anchor, targetUrl) {
  return Boolean(
    shouldHandleNavigationClick(event, anchor, targetUrl)
      && isCurrentTabTarget(anchor.target)
      && isCrossOriginHttpUrl(targetUrl)
  );
}

function installAnchorNavigationHandler(originalOpen) {
  document.addEventListener(
    "click",
    (event) => {
      const anchor = findClickedAnchor(event);
      const targetUrl = anchor ? resolveNavigationUrl(anchor.href) : null;

      if (shouldHandleGuardedBlankAnchorClick(event, anchor, targetUrl)) {
        event.preventDefault();
        openGuardedBlankWindow(originalOpen, targetUrl, "_blank");
        return;
      }

      if (!shouldHandleExternalSameTabAnchorClick(event, anchor, targetUrl)) {
        return;
      }

      event.preventDefault();
      openExternalNavigationTarget(originalOpen, targetUrl);
    },
    true
  );
}

function shouldInterceptLocationNavigation(locationObject, candidate) {
  return Boolean(
    locationObject === window.location
      && isCrossOriginHttpUrl(resolveNavigationUrl(candidate))
  );
}

function shouldHandleCrossOriginCurrentTabNavigation(targetUrl) {
  return isCrossOriginHttpUrl(targetUrl);
}

function findPropertyDescriptorOwner(target, propertyName) {
  let current = target;

  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, propertyName);
    if (descriptor) {
      return {
        descriptor,
        owner: current
      };
    }

    current = Object.getPrototypeOf(current);
  }

  return null;
}

function installLocationMethodPatch(originalOpen, propertyName, originalKey) {
  const locationPrototype = globalThis.Location?.prototype;
  if (!locationPrototype) {
    return;
  }

  const entry = findPropertyDescriptorOwner(locationPrototype, propertyName);
  if (!entry || typeof entry.descriptor.value !== "function") {
    return;
  }

  const originalMethod = typeof window[originalKey] === "function"
    ? window[originalKey]
    : entry.descriptor.value;

  window[originalKey] = originalMethod;

  try {
    Object.defineProperty(entry.owner, propertyName, {
      ...entry.descriptor,
      value: function patchedLocationNavigation(value) {
        const targetUrl = resolveNavigationUrl(value);
        if (shouldInterceptLocationNavigation(this, targetUrl)) {
          openExternalNavigationTarget(originalOpen, targetUrl);
          return undefined;
        }

        return originalMethod.call(this, value);
      }
    });
  } catch {
    // Some browser engines keep Location methods non-configurable.
  }
}

function installLocationHrefPatch(originalOpen) {
  const locationPrototype = globalThis.Location?.prototype;
  if (!locationPrototype) {
    return;
  }

  const entry = findPropertyDescriptorOwner(locationPrototype, "href");
  if (
    !entry
    || typeof entry.descriptor.get !== "function"
    || typeof entry.descriptor.set !== "function"
    || entry.descriptor.configurable === false
  ) {
    return;
  }

  const originalDescriptor = window[ORIGINAL_LOCATION_HREF_DESCRIPTOR_KEY] || entry.descriptor;
  window[ORIGINAL_LOCATION_HREF_DESCRIPTOR_KEY] = originalDescriptor;

  try {
    Object.defineProperty(entry.owner, "href", {
      ...entry.descriptor,
      get() {
        return originalDescriptor.get.call(this);
      },
      set(value) {
        const targetUrl = resolveNavigationUrl(value);
        if (shouldInterceptLocationNavigation(this, targetUrl)) {
          openExternalNavigationTarget(originalOpen, targetUrl);
          return;
        }

        return originalDescriptor.set.call(this, value);
      }
    });
  } catch {
    // Some browser engines keep Location.href non-configurable.
  }
}

function installLocationNavigationPatches(originalOpen) {
  if (window[LOCATION_PATCH_INSTALL_KEY]) {
    return;
  }

  window[LOCATION_PATCH_INSTALL_KEY] = true;
  installLocationMethodPatch(originalOpen, "assign", ORIGINAL_LOCATION_ASSIGN_KEY);
  installLocationMethodPatch(originalOpen, "replace", ORIGINAL_LOCATION_REPLACE_KEY);
  installLocationHrefPatch(originalOpen);
}

function installNavigationApiGuard(originalOpen) {
  const navigationApi = getNavigationApi();
  if (!navigationApi) {
    return;
  }

  navigationApi.addEventListener("navigate", (event) => {
    const targetUrl = resolveNavigationUrl(event?.destination?.url);
    if (!shouldHandleCrossOriginCurrentTabNavigation(targetUrl)) {
      return;
    }

    if (!event?.cancelable) {
      return;
    }

    event.preventDefault();
    openExternalNavigationTarget(originalOpen, targetUrl);
  });
}

function installWindowOpenPatch(originalOpen) {
  window.open = function openWithFrameworkTabAccess(url = "", target = "_blank", features = undefined) {
    const targetUrl = resolveNavigationUrl(url);

    if (hasCurrentTabAccess() && isBlankTarget(target) && isGuardedLocalUrl(targetUrl)) {
      return openGuardedBlankWindow(originalOpen, targetUrl, target, features);
    }

    if (isCurrentTabTarget(target) && isCrossOriginHttpUrl(targetUrl)) {
      return openExternalNavigationTarget(originalOpen, targetUrl, features);
    }

    return originalOpen.call(window, url, target, features);
  };
}

export function installFrameworkNewWindowAccess() {
  if (window[INSTALL_KEY]) {
    return;
  }

  const originalOpen = typeof window[ORIGINAL_OPEN_KEY] === "function"
    ? window[ORIGINAL_OPEN_KEY]
    : window.open;

  if (typeof originalOpen !== "function") {
    return;
  }

  window[INSTALL_KEY] = true;
  window[ORIGINAL_OPEN_KEY] = originalOpen;

  installWindowOpenPatch(originalOpen);
  installAnchorNavigationHandler(originalOpen);
  installNavigationApiGuard(originalOpen);
  installLocationNavigationPatches(originalOpen);
}
