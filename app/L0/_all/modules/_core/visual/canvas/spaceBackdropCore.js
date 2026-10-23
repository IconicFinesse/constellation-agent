export const SPACE_BACKDROP_RUNTIME_KEY = "__spaceBackdropRuntime";
const SPACE_BACKDROP_SELECTOR = "[data-space-backdrop]";

export function addMediaChangeListener(mediaQuery, handler) {
  if (typeof mediaQuery?.addEventListener === "function") {
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }

  if (typeof mediaQuery?.addListener === "function") {
    mediaQuery.addListener(handler);
    return () => mediaQuery.removeListener(handler);
  }

  return () => {};
}

export function createSpaceBackdropRuntime(
  root = document.querySelector(SPACE_BACKDROP_SELECTOR),
  {
    canvas = document.body,
    variantClassName = ""
  } = {}
) {
  if (!root) {
    return null;
  }

  if (root[SPACE_BACKDROP_RUNTIME_KEY]) {
    return root[SPACE_BACKDROP_RUNTIME_KEY];
  }

  const cleanupFns = [];
  let zoomFrame = 0;

  const addCleanup = (cleanupFn) => {
    if (typeof cleanupFn === "function") {
      cleanupFns.push(cleanupFn);
    }
  };

  const syncScale = () => {
    zoomFrame = 0;

    if (!canvas) {
      return;
    }

    canvas.style.setProperty("--space-backdrop-scale", "1");
  };

  const requestScaleSync = () => {
    if (zoomFrame) {
      return;
    }

    zoomFrame = window.requestAnimationFrame(syncScale);
  };

  if (variantClassName) {
    root.classList.add(variantClassName);
    addCleanup(() => root.classList.remove(variantClassName));
  }

  addCleanup(() => canvas?.style.removeProperty("--space-backdrop-scale"));

  window.addEventListener("resize", requestScaleSync, { passive: true });
  addCleanup(() => window.removeEventListener("resize", requestScaleSync));

  window.visualViewport?.addEventListener("resize", requestScaleSync, { passive: true });
  addCleanup(() => window.visualViewport?.removeEventListener("resize", requestScaleSync));

  window.visualViewport?.addEventListener("scroll", requestScaleSync, { passive: true });
  addCleanup(() => window.visualViewport?.removeEventListener("scroll", requestScaleSync));

  const runtime = {
    addCleanup,
    destroy() {
      if (zoomFrame) {
        window.cancelAnimationFrame(zoomFrame);
        zoomFrame = 0;
      }

      cleanupFns.splice(0).reverse().forEach((cleanupFn) => cleanupFn());
      delete root[SPACE_BACKDROP_RUNTIME_KEY];
    },
    root,
    syncScale: requestScaleSync
  };

  root[SPACE_BACKDROP_RUNTIME_KEY] = runtime;
  requestScaleSync();
  return runtime;
}

export function destroySpaceBackdrop(root = document.querySelector(SPACE_BACKDROP_SELECTOR)) {
  root?.[SPACE_BACKDROP_RUNTIME_KEY]?.destroy();
}
