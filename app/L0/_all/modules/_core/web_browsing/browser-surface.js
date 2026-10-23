import {
  getDesktopBrowserHostApi,
  hasDesktopBrowserBridge
} from "./browser-native-bridge.js";

export const BROWSER_INJECT_PATH = "/modules/_core/web_browsing/browser-frame-inject.js";

const surfaceControllers = new Map();

function normalizeBrowserId(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    throw new Error("Browser surface requires a non-empty browser id.");
  }

  return normalizedValue;
}

function getDesktopBrowserApi() {
  return getDesktopBrowserHostApi();
}

function usesDesktopBrowserWebviewSurface(browserApi = getDesktopBrowserApi()) {
  return Boolean(browserApi?.webviewPreloadURL);
}

function createVisibilityState(element) {
  if (!element?.isConnected) {
    return {
      height: 0,
      visible: false,
      width: 0,
      x: 0,
      y: 0
    };
  }

  const rect = element.getBoundingClientRect();
  const width = Math.max(0, Math.round(rect.width));
  const height = Math.max(0, Math.round(rect.height));

  return {
    height,
    visible: width > 0 && height > 0,
    width,
    x: Math.round(rect.left),
    y: Math.round(rect.top)
  };
}

function scheduleControllerSync(controller) {
  if (!controller || controller.rafId != null) {
    return;
  }

  controller.rafId = globalThis.requestAnimationFrame(() => {
    controller.rafId = null;

    const browserApi = getDesktopBrowserApi();
    if (!browserApi || !controller.element?.isConnected) {
      return;
    }

    const nextState = createVisibilityState(controller.element);
    controller.lastState = nextState;
    browserApi.update({
      browserId: controller.browserId,
      bounds: {
        height: nextState.height,
        width: nextState.width,
        x: nextState.x,
        y: nextState.y
      },
      visible: nextState.visible
    });
  });
}

function disconnectController(controller, { destroyView = true } = {}) {
  if (!controller) {
    return;
  }

  if (controller.rafId != null) {
    globalThis.cancelAnimationFrame(controller.rafId);
    controller.rafId = null;
  }

  controller.resizeObserver?.disconnect?.();

  if (destroyView) {
    getDesktopBrowserApi()?.destroy(controller.browserId);
  }
}

export function usesNativeDesktopBrowser() {
  const browserApi = getDesktopBrowserApi();
  return hasDesktopBrowserBridge() && !usesDesktopBrowserWebviewSurface(browserApi);
}

export function bindDesktopBrowserHostEvents(handlers = {}) {
  const browserApi = getDesktopBrowserApi();
  if (!browserApi || typeof browserApi.onHostEvent !== "function") {
    return () => {};
  }

  const onFocus = typeof handlers.onFocus === "function"
    ? handlers.onFocus
    : null;
  const onOpenWindow = typeof handlers.onOpenWindow === "function"
    ? handlers.onOpenWindow
    : null;

  return browserApi.onHostEvent((event) => {
    if (!event || typeof event !== "object") {
      return;
    }

    if (event.type === "focus" && onFocus) {
      onFocus(String(event.browserId || "").trim());
      return;
    }

    if (event.type === "open_window" && onOpenWindow) {
      onOpenWindow(event);
    }
  });
}

export function registerBrowserSurface(browserId, element, options = {}) {
  const normalizedBrowserId = normalizeBrowserId(browserId);
  const browserApi = getDesktopBrowserApi();
  if (!browserApi || !element) {
    return false;
  }

  let controller = surfaceControllers.get(normalizedBrowserId);
  if (controller) {
    if (controller.element !== element) {
      controller.resizeObserver?.disconnect?.();
      if (controller.resizeObserver) {
        controller.resizeObserver.observe(element);
      }
    }

    controller.element = element;
    scheduleControllerSync(controller);
    return true;
  }

  controller = {
    browserId: normalizedBrowserId,
    element,
    lastState: null,
    rafId: null,
    resizeObserver: null
  };

  browserApi.create({
    browserId: normalizedBrowserId,
    injectPath: String(options.injectPath || BROWSER_INJECT_PATH).trim() || BROWSER_INJECT_PATH,
    url: String(options.url || "").trim()
  });

  if (typeof globalThis.ResizeObserver === "function") {
    controller.resizeObserver = new globalThis.ResizeObserver(() => {
      scheduleControllerSync(controller);
    });
    controller.resizeObserver.observe(element);
  }

  surfaceControllers.set(normalizedBrowserId, controller);
  scheduleControllerSync(controller);
  return true;
}

export function unregisterBrowserSurface(browserId, element = null) {
  const normalizedBrowserId = String(browserId || "").trim();
  const controller = surfaceControllers.get(normalizedBrowserId);
  if (!controller) {
    return;
  }

  if (element && controller.element && controller.element !== element) {
    return;
  }

  surfaceControllers.delete(normalizedBrowserId);
  disconnectController(controller, {
    destroyView: true
  });
}

export function syncBrowserSurface(browserId) {
  const normalizedBrowserId = String(browserId || "").trim();
  const controller = surfaceControllers.get(normalizedBrowserId);
  if (!controller) {
    return;
  }

  scheduleControllerSync(controller);
}

export function syncAllBrowserSurfaces() {
  surfaceControllers.forEach((controller) => {
    scheduleControllerSync(controller);
  });
}

export function focusBrowserSurface(browserId) {
  getDesktopBrowserApi()?.focus(String(browserId || "").trim());
}

export function navigateBrowserSurface(browserId, url) {
  getDesktopBrowserApi()?.navigate(String(browserId || "").trim(), String(url || "").trim());
}

export function goBackBrowserSurface(browserId) {
  getDesktopBrowserApi()?.goBack(String(browserId || "").trim());
}

export function goForwardBrowserSurface(browserId) {
  getDesktopBrowserApi()?.goForward(String(browserId || "").trim());
}

export function reloadBrowserSurface(browserId) {
  getDesktopBrowserApi()?.reload(String(browserId || "").trim());
}
