(() => {
  const RUNTIME_KEY = "__spaceBrowserFrameInjectRuntime__";
  const INSTALL_FLAG = "__spaceBrowserFrameCoreHandlersInstalled__";
  const META_KEY = "__spaceBrowserFrameInjectMeta__";

  const runtime = globalThis[RUNTIME_KEY];
  const meta = globalThis[META_KEY] || {};
  if (!runtime || globalThis[INSTALL_FLAG]) {
    if (!runtime) {
      console.error("[space-browser/frame] Core guest handler install skipped because the bridge runtime is unavailable.", {
        location: String(globalThis.location?.href || "")
      });
    }
    return;
  }

  runtime.installOpenWindowHooks();
  runtime.installNavigationEvents();

  runtime.registerMessageHandler("ping", (payload) => `received:${String(payload ?? "")}`);
  runtime.registerMessageHandler("dom", (payload) => runtime.collectDomSnapshot(payload));
  runtime.registerMessageHandler("content", (payload) => runtime.collectSemanticContent(payload));
  runtime.registerMessageHandler("detail", (payload) => runtime.collectReferenceDetail(payload));
  runtime.registerMessageHandler("evaluate", (payload) => runtime.evaluateScript(payload));
  runtime.registerMessageHandler("click", (payload) => runtime.clickReference(payload));
  runtime.registerMessageHandler("type", (payload) => runtime.typeReference(payload));
  runtime.registerMessageHandler("submit", (payload) => runtime.submitReference(payload));
  runtime.registerMessageHandler("type_submit", (payload) => runtime.typeSubmitReference(payload));
  runtime.registerMessageHandler("scroll", (payload) => runtime.scrollReference(payload));
  runtime.registerMessageHandler("navigation_state_get", () => runtime.collectNavigationState());
  runtime.registerMessageHandler("location_navigate", (payload) => runtime.scheduleNavigate(payload));
  runtime.registerMessageHandler("history_back", () => runtime.scheduleHistoryAction("back"));
  runtime.registerMessageHandler("history_forward", () => runtime.scheduleHistoryAction("forward"));
  runtime.registerMessageHandler("location_reload", () => runtime.scheduleReload());

  console.info("[space-browser/frame] Core guest handlers installed.", {
    browserId: String(meta.browserId || ""),
    iframeId: String(meta.iframeId || ""),
    location: String(globalThis.location?.href || ""),
    scriptUrl: String(meta.scriptUrl || "")
  });

  try {
    runtime.sendEvent("__core_handlers_ready__", {
      browserId: String(meta.browserId || ""),
      iframeId: String(meta.iframeId || ""),
      location: String(globalThis.location?.href || "")
    });
  } catch (error) {
    console.error("[space-browser/frame] Failed to emit core-handlers-ready event.", error);
  }

  globalThis[INSTALL_FLAG] = true;
})();
