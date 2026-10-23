(() => {
  const BRIDGE_CHANNEL = "space.web_browsing.browser_frame";
  const BRIDGE_PHASE = Object.freeze({
    EVENT: "event",
    REQUEST: "request",
    RESPONSE: "response"
  });
  const BRIDGE_BOOTSTRAP_KEY = "__spaceBrowserInjectBootstrap__";
  const BRIDGE_DESKTOP_TRANSPORT_KEY = "__spaceBrowserEmbedTransport__";
  const BRIDGE_GLOBAL_KEY = "__spaceBrowserFrameInjectBridge__";
  const BRIDGE_META_KEY = "__spaceBrowserFrameInjectMeta__";
  const BRIDGE_RUNTIME_KEY = "__spaceBrowserFrameInjectRuntime__";
  const BRIDGE_NAVIGATION_EVENTS_FLAG = "__spaceBrowserFrameInjectNavigationEventsReady__";
  const BRIDGE_OPEN_WINDOW_FLAG = "__spaceBrowserFrameInjectOpenWindowReady__";
  const HISTORY_PATCH_FLAG = "__spaceBrowserFrameInjectHistoryPatchReady__";
  const PAGE_CONTENT_HELPER_KEY = "__spaceBrowserPageContent__";
  const DOM_HELPER_KEY = "__spaceBrowserDomHelper__";

  function isPlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") {
      return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return (
      prototype === Object.prototype
      || prototype === null
      || prototype?.constructor?.name === "Object"
    );
  }

  function createNamedError(name, message, details = {}) {
    const error = new Error(message);
    error.name = name;
    Object.assign(error, details);
    return error;
  }

  function createDeferred() {
    let resolve = null;
    let reject = null;
    const promise = new Promise((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });

    return {
      promise,
      reject,
      resolve
    };
  }

  function createRequestId() {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }

    return `browser-frame-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function normalizeType(type) {
    const normalizedType = String(type || "").trim();
    if (!normalizedType) {
      throw new Error("Browser frame bridge messages require a non-empty type.");
    }

    return normalizedType;
  }

  function cloneValue(value, seen = new WeakMap()) {
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (typeof value === "bigint") {
      return Number(value);
    }

    if (typeof value === "function" || typeof value === "symbol") {
      return undefined;
    }

    if (value instanceof Error) {
      return {
        message: value.message,
        name: value.name || "Error",
        stack: value.stack || ""
      };
    }

    if (typeof globalThis.URL === "function" && value instanceof globalThis.URL) {
      return value.href;
    }

    if (value instanceof Date) {
      return new Date(value.getTime()).toISOString();
    }

    if (value instanceof RegExp) {
      return String(value);
    }

    if (typeof globalThis.Window === "function" && value instanceof globalThis.Window) {
      return null;
    }

    if (typeof globalThis.Element === "function" && value instanceof globalThis.Element) {
      return null;
    }

    if (seen.has(value)) {
      return seen.get(value);
    }

    if (Array.isArray(value)) {
      const clonedArray = [];
      seen.set(value, clonedArray);

      value.forEach((entry) => {
        const clonedEntry = cloneValue(entry, seen);
        clonedArray.push(clonedEntry === undefined ? null : clonedEntry);
      });

      return clonedArray;
    }

    if (value instanceof Map) {
      const clonedEntries = [];
      seen.set(value, clonedEntries);

      value.forEach((entryValue, entryKey) => {
        clonedEntries.push([
          cloneValue(entryKey, seen),
          cloneValue(entryValue, seen)
        ]);
      });

      return clonedEntries;
    }

    if (value instanceof Set) {
      const clonedEntries = [];
      seen.set(value, clonedEntries);

      value.forEach((entryValue) => {
        clonedEntries.push(cloneValue(entryValue, seen));
      });

      return clonedEntries;
    }

    if (value instanceof ArrayBuffer) {
      return value.slice(0);
    }

    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
      return Array.from(value);
    }

    if (isPlainObject(value)) {
      const clonedObject = {};
      seen.set(value, clonedObject);

      Object.entries(value).forEach(([key, entryValue]) => {
        const clonedEntry = cloneValue(entryValue, seen);

        if (clonedEntry !== undefined) {
          clonedObject[key] = clonedEntry;
        }
      });

      return clonedObject;
    }

    try {
      return String(value);
    } catch {
      return null;
    }
  }

  function normalizePayload(payload) {
    const normalizedPayload = cloneValue(payload);
    return normalizedPayload === undefined ? null : normalizedPayload;
  }

  function serializeError(error, fallbackMessage = "Browser frame bridge request failed.") {
    const fallback = String(fallbackMessage || "Browser frame bridge request failed.");

    if (error instanceof Error) {
      return {
        code: error.code ?? null,
        details: normalizePayload(error.details || {}),
        message: error.message || fallback,
        name: error.name || "Error",
        stack: error.stack || ""
      };
    }

    if (isPlainObject(error)) {
      return {
        code: error.code ?? null,
        details: normalizePayload(error.details || {}),
        message: typeof error.message === "string" && error.message ? error.message : fallback,
        name: typeof error.name === "string" && error.name ? error.name : "BrowserFrameBridgeError",
        stack: typeof error.stack === "string" ? error.stack : ""
      };
    }

    return {
      code: null,
      details: {},
      message: String(error || fallback),
      name: typeof error || "BrowserFrameBridgeError",
      stack: ""
    };
  }

  function serializeErrorSummary(error, fallbackMessage = "Browser frame bridge request failed.") {
    const serialized = serializeError(error, fallbackMessage);
    return {
      code: serialized.code ?? null,
      details: normalizePayload(serialized.details || {}),
      message: serialized.message || String(fallbackMessage || "Browser frame bridge request failed."),
      name: serialized.name || "Error"
    };
  }

  function createRemoteBridgeError(message) {
    const payload = isPlainObject(message.payload)
      ? message.payload
      : {
          message: String(message.payload || `Browser frame bridge request \"${message.type}\" failed.`),
          name: "BrowserFrameBridgeError"
        };

    return createNamedError(
      typeof payload.name === "string" && payload.name ? payload.name : "BrowserFrameBridgeError",
      typeof payload.message === "string" && payload.message ? payload.message : `Browser frame bridge request \"${message.type}\" failed.`,
      {
        code: payload.code ?? null,
        details: isPlainObject(payload.details) ? payload.details : {},
        payload,
        requestId: String(message.requestId || ""),
        type: message.type
      }
    );
  }

  function createEnvelope(phase, type, payload, details = {}) {
    const envelope = {
      channel: BRIDGE_CHANNEL,
      payload: normalizePayload(payload),
      phase,
      type: normalizeType(type)
    };

    if (details.requestId) {
      envelope.requestId = String(details.requestId);
    }

    if (phase === BRIDGE_PHASE.RESPONSE) {
      envelope.ok = details.ok !== false;
    }

    return envelope;
  }

  function resolveTargetWindow(targetWindow) {
    if (targetWindow && typeof targetWindow.postMessage === "function") {
      return targetWindow;
    }

    if (typeof globalThis.parent?.postMessage === "function" && globalThis.parent !== globalThis) {
      return globalThis.parent;
    }

    return null;
  }

  function resolveDesktopTransport() {
    const transport = globalThis[BRIDGE_DESKTOP_TRANSPORT_KEY];
    if (!transport) {
      return null;
    }

    const receiveEventName = typeof transport.receiveEventName === "string" && transport.receiveEventName.trim()
      ? transport.receiveEventName.trim()
      : typeof transport.eventName === "string" && transport.eventName.trim()
      ? transport.eventName.trim()
      : "";
    const sendEventName = typeof transport.sendEventName === "string" && transport.sendEventName.trim()
      ? transport.sendEventName.trim()
      : "";

    return {
      postEnvelope(envelope) {
        if (sendEventName) {
          globalThis.dispatchEvent(new CustomEvent(sendEventName, {
            detail: envelope
          }));
          return envelope;
        }

        if (typeof transport.sendEnvelope === "function") {
          transport.sendEnvelope(envelope);
          return envelope;
        }

        throw new Error("Browser frame desktop transport cannot post outbound envelopes.");
      },

      subscribe(listener) {
        if (receiveEventName) {
          const handleDesktopEnvelope = (event) => {
            listener(event?.detail, {
              origin: "electron://desktop",
              source: "desktop"
            });
          };

          globalThis.addEventListener(receiveEventName, handleDesktopEnvelope);
          return () => {
            globalThis.removeEventListener(receiveEventName, handleDesktopEnvelope);
          };
        }

        if (typeof transport.bindReceiver !== "function") {
          throw new Error("Browser frame desktop transport cannot subscribe to inbound envelopes.");
        }

        return transport.bindReceiver((envelope) => {
          listener(envelope, {
            origin: "electron://desktop",
            source: "desktop"
          });
        });
      }
    };
  }

  function resolveWindowTransport(options = {}) {
    const targetOrigin = typeof options.targetOrigin === "string" && options.targetOrigin.trim()
      ? options.targetOrigin.trim()
      : "*";

    return {
      postEnvelope(envelope) {
        const targetWindow = resolveTargetWindow(options.targetWindow);
        if (!targetWindow) {
          throw new Error("Browser frame bridge target window is unavailable.");
        }

        targetWindow.postMessage(envelope, targetOrigin);
        return envelope;
      },

      subscribe(listener) {
        const handleMessage = (event) => {
          const expectedSource = resolveTargetWindow(options.targetWindow);
          if (expectedSource && event.source !== expectedSource) {
            return;
          }

          listener(event?.data, {
            origin: String(event?.origin || ""),
            source: event?.source || null
          });
        };

        globalThis.addEventListener("message", handleMessage);
        return () => {
          globalThis.removeEventListener("message", handleMessage);
        };
      }
    };
  }

  function resolveBridgeTransport(options = {}) {
    return resolveDesktopTransport() || resolveWindowTransport(options);
  }

  function coerceSelectorList(payload) {
    if (typeof payload === "string") {
      return [payload];
    }

    if (Array.isArray(payload?.selectors)) {
      return payload.selectors;
    }

    if (typeof payload?.selectors === "string") {
      return [payload.selectors];
    }

    if (Array.isArray(payload?.selector)) {
      return payload.selector;
    }

    if (typeof payload?.selector === "string") {
      return [payload.selector];
    }

    if (Array.isArray(payload)) {
      return payload;
    }

    return [];
  }

  function normalizeSelectorList(payload) {
    return coerceSelectorList(payload)
      .map((selector) => String(selector || "").trim())
      .filter(Boolean);
  }

  function getDomHelper() {
    const helper = globalThis[DOM_HELPER_KEY];
    if (helper?.captureDocument) {
      return helper;
    }

    return null;
  }

  async function captureDomHelperDocument(payload = null) {
    const helper = getDomHelper();
    if (!helper) {
      return null;
    }

    try {
      const helperPayload = {};
      const selectors = normalizeSelectorList(payload);
      if (selectors.length) {
        helperPayload.selectors = selectors;
      }

      const snapshotMode = typeof payload?.snapshotMode === "string"
        ? payload.snapshotMode.trim()
        : "";
      if (snapshotMode) {
        helperPayload.snapshotMode = snapshotMode;
      }

      const snapshot = await helper.captureDocument(helperPayload);
      const html = String(snapshot?.html || "").trim();
      const hasTargets = Boolean(snapshot?.targets && typeof snapshot.targets === "object");
      if (!html && !hasTargets) {
        return null;
      }

      return {
        html,
        snapshot
      };
    } catch {
      return null;
    }
  }

  function parseHtmlDocument(html) {
    if (typeof globalThis.DOMParser !== "function") {
      return null;
    }

    try {
      return new globalThis.DOMParser().parseFromString(String(html || ""), "text/html");
    } catch {
      return null;
    }
  }

  async function serializeDocumentHtml() {
    const helperDocument = await captureDomHelperDocument();
    if (helperDocument?.html) {
      return helperDocument.html;
    }

    if (typeof globalThis.XMLSerializer === "function" && globalThis.document) {
      try {
        return new globalThis.XMLSerializer().serializeToString(globalThis.document);
      } catch {
        // Fall through to outerHTML-based serialization.
      }
    }

    return String(globalThis.document?.documentElement?.outerHTML || "");
  }

  async function serializeSelectorHtml(selector) {
    const helperDocument = await captureDomHelperDocument({
      selectors: [selector],
      snapshotMode: "dom"
    });
    if (helperDocument?.snapshot?.targets && typeof helperDocument.snapshot.targets === "object") {
      return String(helperDocument.snapshot.targets?.[selector] || "");
    }

    if (helperDocument?.html) {
      const parsedDocument = parseHtmlDocument(helperDocument.html);
      if (parsedDocument?.querySelectorAll) {
        let parsedElements = [];
        try {
          parsedElements = [...parsedDocument.querySelectorAll(selector)];
        } catch (error) {
          throw createNamedError(
            "BrowserFrameBridgeSelectorError",
            `Browser frame bridge could not resolve selector \"${selector}\".`,
            {
              details: {
                selector
              }
            }
          );
        }

        return parsedElements
          .map((element) => String(element?.outerHTML || ""))
          .join("\n");
      }
    }

    let elements = [];
    try {
      elements = [...(globalThis.document?.querySelectorAll?.(selector) || [])];
    } catch (error) {
      throw createNamedError(
        "BrowserFrameBridgeSelectorError",
        `Browser frame bridge could not resolve selector \"${selector}\".`,
        {
          details: {
            selector
          }
        }
      );
    }

    return elements
      .map((element) => String(element?.outerHTML || ""))
      .join("\n");
  }

  async function collectDomSnapshot(payload = null) {
    const selectors = normalizeSelectorList(payload);
    if (!selectors.length) {
      return {
        document: await serializeDocumentHtml()
      };
    }

    const helperPayload = payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload }
      : {};
    const helperDocument = await captureDomHelperDocument({
      ...helperPayload,
      selectors,
      snapshotMode: "dom"
    });
    if (helperDocument?.snapshot?.targets && typeof helperDocument.snapshot.targets === "object") {
      const snapshot = {};
      selectors.forEach((selector) => {
        snapshot[selector] = String(helperDocument.snapshot.targets?.[selector] || "");
      });
      return snapshot;
    }

    const snapshot = {};
    for (const selector of selectors) {
      snapshot[selector] = await serializeSelectorHtml(selector);
    }
    return snapshot;
  }

  function getPageContentHelper() {
    const helper = globalThis[PAGE_CONTENT_HELPER_KEY];
    if (helper?.capture && helper?.detail) {
      return helper;
    }

    throw createNamedError(
      "BrowserFrameBridgeContentUnavailableError",
      "Browser frame page content helper is unavailable in this runtime.",
      {
        code: "browser_frame_content_unavailable"
      }
    );
  }

  function resolveReferencePayload(payload) {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload.referenceId ?? payload.ref ?? payload.id ?? null;
    }

    return payload;
  }

  function resolveTypedReferencePayload(payload) {
    const referenceId = resolveReferencePayload(payload);
    const value = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload.value ?? payload.text ?? ""
      : "";

    return {
      referenceId,
      value
    };
  }

  async function invokePageContentHelper(methodName, args, errorName, errorMessage, errorCode) {
    const helper = getPageContentHelper();
    const method = helper?.[methodName];

    if (typeof method !== "function") {
      throw createNamedError(
        "BrowserFrameBridgeContentUnavailableError",
        "Browser frame page content helper does not support this action in the current runtime.",
        {
          code: "browser_frame_content_action_unavailable",
          details: {
            action: methodName
          }
        }
      );
    }

    try {
      return await method(...args);
    } catch (error) {
      throw createNamedError(
        errorName,
        errorMessage,
        {
          code: errorCode,
          cause: error,
          details: {
            action: methodName,
            cause: serializeErrorSummary(error, errorMessage)
          }
        }
      );
    }
  }

  async function collectSemanticContent(payload = null) {
    return invokePageContentHelper(
      "capture",
      [payload],
      "BrowserFrameBridgeContentError",
      "Browser frame bridge could not collect semantic page content.",
      "browser_frame_content_error"
    );
  }

  async function collectReferenceDetail(payload = null) {
    return invokePageContentHelper(
      "detail",
      [payload],
      "BrowserFrameBridgeDetailError",
      "Browser frame bridge could not resolve the requested reference detail.",
      "browser_frame_detail_error"
    );
  }

  async function clickReference(payload = null) {
    return invokePageContentHelper(
      "click",
      [resolveReferencePayload(payload)],
      "BrowserFrameBridgeClickError",
      "Browser frame bridge could not click the requested reference.",
      "browser_frame_click_error"
    );
  }

  async function typeReference(payload = null) {
    const typedPayload = resolveTypedReferencePayload(payload);

    return invokePageContentHelper(
      "type",
      [typedPayload.referenceId, typedPayload.value],
      "BrowserFrameBridgeTypeError",
      "Browser frame bridge could not type into the requested reference.",
      "browser_frame_type_error"
    );
  }

  async function submitReference(payload = null) {
    return invokePageContentHelper(
      "submit",
      [resolveReferencePayload(payload)],
      "BrowserFrameBridgeSubmitError",
      "Browser frame bridge could not submit the requested reference.",
      "browser_frame_submit_error"
    );
  }

  async function typeSubmitReference(payload = null) {
    const typedPayload = resolveTypedReferencePayload(payload);

    return invokePageContentHelper(
      "typeSubmit",
      [typedPayload.referenceId, typedPayload.value],
      "BrowserFrameBridgeTypeSubmitError",
      "Browser frame bridge could not type and submit the requested reference.",
      "browser_frame_type_submit_error"
    );
  }

  async function scrollReference(payload = null) {
    return invokePageContentHelper(
      "scroll",
      [resolveReferencePayload(payload)],
      "BrowserFrameBridgeScrollError",
      "Browser frame bridge could not scroll to the requested reference.",
      "browser_frame_scroll_error"
    );
  }

  function resolveEvaluateScript(payload = null) {
    const rawScript = typeof payload === "string"
      ? payload
      : payload?.script;
    const script = String(rawScript || "").trim();

    if (script) {
      return script;
    }

    throw createNamedError(
      "BrowserFrameBridgeEvaluateError",
      "Browser frame bridge evaluate requires a non-empty script.",
      {
        code: "browser_frame_evaluate_script_required"
      }
    );
  }

  async function evaluateScript(payload = null) {
    const script = resolveEvaluateScript(payload);

    try {
      return await Promise.resolve(globalThis.eval(script));
    } catch (error) {
      throw createNamedError(
        "BrowserFrameBridgeEvaluateError",
        "Browser frame bridge could not evaluate the requested script.",
        {
          code: "browser_frame_evaluate_error",
          cause: error,
          details: {
            cause: serializeErrorSummary(error, "Browser frame bridge could not evaluate the requested script.")
          }
        }
      );
    }
  }

  function readNavigationCapability(key) {
    return typeof globalThis.navigation?.[key] === "boolean"
      ? globalThis.navigation[key]
      : null;
  }

  function collectNavigationState() {
    const canGoBack = readNavigationCapability("canGoBack");
    const canGoForward = readNavigationCapability("canGoForward");

    return {
      canGoBack: canGoBack == null ? Number(globalThis.history?.length || 0) > 1 : canGoBack,
      canGoForward: canGoForward == null ? false : canGoForward,
      title: String(globalThis.document?.title || ""),
      url: String(globalThis.location?.href || "")
    };
  }

  function scheduleHistoryAction(direction) {
    const navigation = globalThis.navigation;
    const fallback = () => {
      globalThis.history?.[direction]?.();
    };

    setTimeout(() => {
      if (direction === "back" && typeof navigation?.back === "function") {
        try {
          Promise.resolve(navigation.back()).catch(() => {
            fallback();
          });
        } catch {
          fallback();
        }
        return;
      }

      if (direction === "forward" && typeof navigation?.forward === "function") {
        try {
          Promise.resolve(navigation.forward()).catch(() => {
            fallback();
          });
        } catch {
          fallback();
        }
        return;
      }

      fallback();
    }, 0);

    return {
      scheduled: direction,
      state: collectNavigationState()
    };
  }

  function scheduleReload() {
    setTimeout(() => {
      if (typeof globalThis.location?.reload === "function") {
        globalThis.location.reload();
        return;
      }

      if (typeof globalThis.location?.href === "string" && globalThis.location.href) {
        globalThis.location.href = globalThis.location.href;
      }
    }, 0);

    return {
      scheduled: "reload",
      state: collectNavigationState()
    };
  }

  function normalizeNavigationTarget(payload) {
    const rawTarget = typeof payload === "string"
      ? payload
      : payload && typeof payload === "object"
        ? payload.url
        : "";
    const normalizedTarget = String(rawTarget || "").trim();

    const looksLikeLocalHost = (value) => {
      const host = String(value || "").trim().split(/[/?#]/u, 1)[0] || "";
      return /^(?:localhost|\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$/iu.test(host);
    };

    const looksLikeTypedHost = (value) => {
      const trimmedValue = String(value || "").trim();
      if (!trimmedValue || /\s/u.test(trimmedValue)) {
        return false;
      }

      const host = trimmedValue.split(/[/?#]/u, 1)[0] || "";
      return /^(?:localhost|\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d-]{2,63})(?::\d+)?$/iu.test(host);
    };

    if (!normalizedTarget) {
      throw createNamedError(
        "BrowserFrameBridgeNavigationError",
        "Browser frame bridge requires a non-empty navigation target."
      );
    }

    try {
      if (
        !/^[a-z][a-z\d+\-.]*:\/\//iu.test(normalizedTarget)
        && !/^(about|blob|data|file|mailto|tel):/iu.test(normalizedTarget)
        && !/^[/?#.]/u.test(normalizedTarget)
        && looksLikeTypedHost(normalizedTarget)
      ) {
        const protocol = looksLikeLocalHost(normalizedTarget) ? "http://" : "https://";
        return new URL(`${protocol}${normalizedTarget}`, globalThis.location?.href || "http://localhost/").href;
      }

      return new URL(normalizedTarget, globalThis.location?.href || "http://localhost/").href;
    } catch {
      throw createNamedError(
        "BrowserFrameBridgeNavigationError",
        `Browser frame bridge rejected invalid navigation target "${normalizedTarget}".`,
        {
          details: {
            url: normalizedTarget
          }
        }
      );
    }
  }

  function scheduleNavigate(payload) {
    const nextUrl = normalizeNavigationTarget(payload);

    setTimeout(() => {
      try {
        globalThis.location?.assign?.(nextUrl);
      } catch {
        try {
          globalThis.location.href = nextUrl;
        } catch {
          // Ignore navigation failures during unload or blocked page teardown.
        }
      }
    }, 0);

    return {
      scheduled: "navigate",
      state: {
        ...collectNavigationState(),
        url: nextUrl
      }
    };
  }

  function normalizeWindowTarget(target) {
    const normalizedTarget = String(target || "").trim();
    if (!normalizedTarget) {
      return "_blank";
    }

    return normalizedTarget;
  }

  function emitRequestedWindowOpen(bridge, payload = {}) {
    const rawUrl = String(payload.url || "").trim();
    if (!rawUrl) {
      return null;
    }

    let normalizedUrl = "";
    try {
      normalizedUrl = new URL(rawUrl, globalThis.location?.href || "http://localhost/").href;
    } catch {
      return null;
    }

    const message = {
      disposition: String(payload.disposition || "new-window").trim() || "new-window",
      frameName: normalizeWindowTarget(payload.frameName),
      referrerUrl: String(payload.referrerUrl || globalThis.location?.href || "").trim(),
      url: normalizedUrl
    };

    try {
      bridge.send("open_window", message);
      return message;
    } catch {
      return null;
    }
  }

  function installOpenWindowHooks(bridge) {
    if (!bridge || bridge[BRIDGE_OPEN_WINDOW_FLAG]) {
      return bridge;
    }

    const originalOpen = typeof globalThis.open === "function"
      ? globalThis.open.bind(globalThis)
      : null;

    globalThis.open = function patchedOpen(url = "", target = "_blank", features = "") {
      const normalizedTarget = normalizeWindowTarget(target);
      if (normalizedTarget === "_self" || normalizedTarget === "_top" || normalizedTarget === "_parent") {
        if (originalOpen) {
          return originalOpen(url, normalizedTarget, features);
        }

        const nextUrl = String(url || "").trim();
        if (nextUrl) {
          globalThis.location.href = nextUrl;
        }
        return null;
      }

      emitRequestedWindowOpen(bridge, {
        disposition: "window-open",
        frameName: normalizedTarget,
        url
      });
      return null;
    };

    globalThis.document?.addEventListener?.("click", (event) => {
      if (event.defaultPrevented || event.button !== 0) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const anchor = event.target instanceof Element
        ? event.target.closest("a[href][target]")
        : null;
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }

      const normalizedTarget = normalizeWindowTarget(anchor.getAttribute("target"));
      if (normalizedTarget === "_self" || normalizedTarget === "_top" || normalizedTarget === "_parent") {
        return;
      }

      const requestedWindow = emitRequestedWindowOpen(bridge, {
        disposition: "target-blank",
        frameName: normalizedTarget,
        referrerUrl: globalThis.location?.href || "",
        url: anchor.href || anchor.getAttribute("href") || ""
      });

      if (!requestedWindow) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    }, true);

    bridge[BRIDGE_OPEN_WINDOW_FLAG] = true;
    return bridge;
  }

  function installHistoryChangeHooks(notify) {
    if (globalThis[HISTORY_PATCH_FLAG]) {
      return;
    }

    const history = globalThis.history;
    ["pushState", "replaceState"].forEach((methodName) => {
      const original = history?.[methodName];
      if (typeof original !== "function") {
        return;
      }

      history[methodName] = function patchedHistoryState(...args) {
        const result = original.apply(this, args);
        notify();
        return result;
      };
    });

    globalThis[HISTORY_PATCH_FLAG] = true;
  }

  function createBridge(options = {}) {
    const eventListeners = new Map();
    const requestHandlers = new Map();
    const pendingRequests = new Map();
    const defaultTimeoutMs = Math.max(0, Number(options.requestTimeoutMs) || 0);
    const transport = resolveBridgeTransport(options);

    function postEnvelope(envelope) {
      if (!transport) {
        throw new Error("Browser frame bridge transport is unavailable.");
      }

      return transport.postEnvelope(envelope);
    }

    async function respondToRequest(message) {
      if (!message.requestId) {
        return;
      }

      const handler = requestHandlers.get(message.type);
      if (!handler) {
        postEnvelope(
          createEnvelope(BRIDGE_PHASE.RESPONSE, message.type, serializeError({
            message: `No browser frame bridge handler is registered for \"${message.type}\".`,
            name: "BrowserFrameBridgeMissingHandlerError"
          }), {
            ok: false,
            requestId: message.requestId
          })
        );
        return;
      }

      try {
        const responsePayload = await handler(message.payload, message);
        postEnvelope(createEnvelope(BRIDGE_PHASE.RESPONSE, message.type, responsePayload, {
          ok: true,
          requestId: message.requestId
        }));
      } catch (error) {
        console.error(
          `[space-browser/frame] Request handler failed for "${message.type}".`,
          serializeError(error)
        );
        postEnvelope(createEnvelope(BRIDGE_PHASE.RESPONSE, message.type, serializeError(error), {
          ok: false,
          requestId: message.requestId
        }));
      }
    }

    function handleEnvelope(rawMessage, meta = {}) {
      if (!rawMessage || rawMessage.channel !== BRIDGE_CHANNEL || typeof rawMessage.type !== "string") {
        return;
      }

      const phase = rawMessage.phase;
      if (phase !== BRIDGE_PHASE.EVENT && phase !== BRIDGE_PHASE.REQUEST && phase !== BRIDGE_PHASE.RESPONSE) {
        return;
      }

      const message = {
        ok: rawMessage.ok !== false,
        origin: String(meta.origin || ""),
        payload: rawMessage.payload,
        phase,
        raw: rawMessage,
        requestId: typeof rawMessage.requestId === "string" ? rawMessage.requestId : "",
        source: meta.source || null,
        type: normalizeType(rawMessage.type)
      };

      if (phase === BRIDGE_PHASE.EVENT) {
        const listeners = eventListeners.get(message.type);
        if (!listeners) {
          return;
        }

        listeners.forEach((listener) => listener(message));
        return;
      }

      if (phase === BRIDGE_PHASE.REQUEST) {
        void respondToRequest(message);
        return;
      }

      const pendingRequest = pendingRequests.get(message.requestId);
      if (!pendingRequest) {
        return;
      }

      pendingRequests.delete(message.requestId);
      if (pendingRequest.timeoutId != null) {
        clearTimeout(pendingRequest.timeoutId);
      }

      if (message.ok === false) {
        pendingRequest.reject(createRemoteBridgeError(message));
        return;
      }

      pendingRequest.resolve(message);
    }

    const offTransport = typeof transport?.subscribe === "function"
      ? transport.subscribe(handleEnvelope)
      : () => {};

    return {
      channel: BRIDGE_CHANNEL,

      destroy() {
        offTransport?.();
        pendingRequests.forEach((pendingRequest) => {
          if (pendingRequest.timeoutId != null) {
            clearTimeout(pendingRequest.timeoutId);
          }

          pendingRequest.reject(createNamedError("AbortError", "Browser frame bridge is destroyed."));
        });
        pendingRequests.clear();
        eventListeners.clear();
        requestHandlers.clear();
      },

      handle(type, handler) {
        if (typeof handler !== "function") {
          throw new Error("Browser frame bridge handlers must be functions.");
        }

        const normalizedType = normalizeType(type);
        requestHandlers.set(normalizedType, handler);

        return () => {
          if (requestHandlers.get(normalizedType) === handler) {
            requestHandlers.delete(normalizedType);
          }
        };
      },

      on(type, listener) {
        if (typeof listener !== "function") {
          throw new Error("Browser frame bridge listeners must be functions.");
        }

        const normalizedType = normalizeType(type);
        if (!eventListeners.has(normalizedType)) {
          eventListeners.set(normalizedType, new Set());
        }

        const listeners = eventListeners.get(normalizedType);
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
          if (!listeners.size) {
            eventListeners.delete(normalizedType);
          }
        };
      },

      request(type, payload = null, options = {}) {
        const requestId = createRequestId();
        const deferred = createDeferred();
        const timeoutMs = Math.max(0, Number(options.timeoutMs) || defaultTimeoutMs);
        const normalizedType = normalizeType(type);
        let timeoutId = null;

        if (timeoutMs > 0) {
          timeoutId = setTimeout(() => {
            pendingRequests.delete(requestId);
            deferred.reject(createNamedError(
              "TimeoutError",
              `Browser frame bridge request \"${normalizedType}\" timed out after ${timeoutMs}ms.`,
              { requestId, type: normalizedType }
            ));
          }, timeoutMs);
        }

        pendingRequests.set(requestId, {
          reject: deferred.reject,
          resolve: deferred.resolve,
          timeoutId,
          type: normalizedType
        });

        try {
          postEnvelope(createEnvelope(BRIDGE_PHASE.REQUEST, normalizedType, payload, { requestId }));
        } catch (error) {
          pendingRequests.delete(requestId);
          if (timeoutId != null) {
            clearTimeout(timeoutId);
          }
          deferred.reject(error);
        }

        return deferred.promise;
      },

      send(type, payload = null) {
        return postEnvelope(createEnvelope(BRIDGE_PHASE.EVENT, type, payload));
      }
    };
  }

  function installNavigationEvents(bridge) {
    if (!bridge || bridge[BRIDGE_NAVIGATION_EVENTS_FLAG]) {
      return bridge;
    }

    let notifyQueued = false;

    const notify = () => {
      if (notifyQueued) {
        return;
      }

      notifyQueued = true;
      setTimeout(() => {
        notifyQueued = false;

        try {
          bridge.send("navigation_state", collectNavigationState());
        } catch {
          // Ignore bridge send failures during frame teardown or cross-origin transitions.
        }
      }, 0);
    };

    installHistoryChangeHooks(notify);

    [
      "DOMContentLoaded",
      "hashchange",
      "load",
      "pageshow",
      "popstate"
    ].forEach((eventName) => {
      globalThis.addEventListener(eventName, notify);
    });

    notify();
    bridge[BRIDGE_NAVIGATION_EVENTS_FLAG] = true;
    return bridge;
  }

  function createInjectedRuntime(bridge) {
    const messageHandlers = new Map();

    const runtime = {
      bridge,
      clickReference,
      collectDomSnapshot,
      collectNavigationState,
      collectReferenceDetail,
      collectSemanticContent,
      createNamedError,
      evaluateScript,
      installNavigationEvents() {
        installNavigationEvents(bridge);
        return runtime;
      },
      installOpenWindowHooks() {
        installOpenWindowHooks(bridge);
        return runtime;
      },
      async handleMessage(message) {
        const normalizedType = normalizeType(message?.type);
        const handler = messageHandlers.get(normalizedType);
        if (typeof handler !== "function") {
          throw createNamedError(
            "BrowserFrameBridgeMissingHandlerError",
            `No browser frame bridge handler is registered for "${normalizedType}".`,
            {
              code: "browser_frame_missing_handler",
              details: {
                type: normalizedType
              }
            }
          );
        }

        return handler(message?.payload, message, runtime);
      },
      registerMessageHandler(type, handler) {
        if (typeof handler !== "function") {
          throw new Error("Browser frame runtime handlers must be functions.");
        }

        const normalizedType = normalizeType(type);
        messageHandlers.set(normalizedType, handler);
        const offBridge = bridge.handle(normalizedType, (payload, message) => runtime.handleMessage({
          ...message,
          payload,
          type: normalizedType
        }));

        return () => {
          if (messageHandlers.get(normalizedType) === handler) {
            messageHandlers.delete(normalizedType);
          }
          offBridge?.();
        };
      },
      scheduleHistoryAction,
      scheduleNavigate,
      scheduleReload,
      scrollReference,
      sendEvent(type, payload = null) {
        return bridge.send(type, payload);
      },
      submitReference,
      typeReference,
      typeSubmitReference,
      version: "1"
    };

    return runtime;
  }

  const existingBridge = globalThis[BRIDGE_GLOBAL_KEY];
  const bridge = existingBridge || createBridge();
  const existingRuntime = globalThis[BRIDGE_RUNTIME_KEY];
  const runtime = existingRuntime?.bridge === bridge
    ? existingRuntime
    : createInjectedRuntime(bridge);
  const bootstrap = isPlainObject(globalThis[BRIDGE_BOOTSTRAP_KEY])
    ? globalThis[BRIDGE_BOOTSTRAP_KEY]
    : isPlainObject(globalThis.__spaceBrowserFrameInjectBootstrap__)
    ? globalThis.__spaceBrowserFrameInjectBootstrap__
    : {};

  globalThis[BRIDGE_GLOBAL_KEY] = bridge;
  globalThis[BRIDGE_RUNTIME_KEY] = runtime;
  globalThis[BRIDGE_META_KEY] = {
    browserId: typeof bootstrap.browserId === "string" ? bootstrap.browserId : "",
    iframeId: typeof bootstrap.iframeId === "string" ? bootstrap.iframeId : "",
    loadedAt: Date.now(),
    scriptPath: typeof bootstrap.scriptPath === "string" ? bootstrap.scriptPath : "",
    scriptUrl: typeof bootstrap.scriptUrl === "string" ? bootstrap.scriptUrl : ""
  };

  console.info("[space-browser/frame] Bridge runtime ready.", {
    browserId: globalThis[BRIDGE_META_KEY].browserId,
    iframeId: globalThis[BRIDGE_META_KEY].iframeId,
    location: String(globalThis.location?.href || ""),
    scriptUrl: globalThis[BRIDGE_META_KEY].scriptUrl,
    transport: globalThis[BRIDGE_DESKTOP_TRANSPORT_KEY] ? "desktop" : "window"
  });

  try {
    bridge.send("__bridge_ready__", {
      browserId: globalThis[BRIDGE_META_KEY].browserId,
      iframeId: globalThis[BRIDGE_META_KEY].iframeId,
      location: String(globalThis.location?.href || ""),
      transport: globalThis[BRIDGE_DESKTOP_TRANSPORT_KEY] ? "desktop" : "window"
    });
  } catch (error) {
    console.error("[space-browser/frame] Failed to emit bridge-ready event.", error);
  }
})();
