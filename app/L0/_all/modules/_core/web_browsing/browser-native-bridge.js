import {
  BROWSER_FRAME_BRIDGE_CHANNEL,
  BROWSER_FRAME_BRIDGE_PHASE,
  normalizeBrowserFramePayload,
  normalizeBrowserFrameType,
  serializeBrowserFrameError
} from "./browser-frame-protocol.js";

const bridgeCache = new Map();

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

function normalizeBrowserId(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    throw new Error("Desktop browser bridge requires a non-empty browser id.");
  }

  return normalizedValue;
}

function getDesktopBrowserApi() {
  const browserApi = globalThis.spaceDesktop?.browser;
  return browserApi?.available ? browserApi : null;
}

function normalizePhase(value) {
  if (value === BROWSER_FRAME_BRIDGE_PHASE.EVENT) {
    return BROWSER_FRAME_BRIDGE_PHASE.EVENT;
  }

  if (value === BROWSER_FRAME_BRIDGE_PHASE.REQUEST) {
    return BROWSER_FRAME_BRIDGE_PHASE.REQUEST;
  }

  if (value === BROWSER_FRAME_BRIDGE_PHASE.RESPONSE) {
    return BROWSER_FRAME_BRIDGE_PHASE.RESPONSE;
  }

  return "";
}

function isBridgeEnvelope(value) {
  return Boolean(
    value
    && typeof value === "object"
    && value.channel === BROWSER_FRAME_BRIDGE_CHANNEL
    && typeof value.type === "string"
    && "payload" in value
  );
}

function createRemoteBridgeError(message) {
  const payload = message?.payload && typeof message.payload === "object"
    ? message.payload
    : {
        message: String(message?.payload || `Browser frame bridge request "${message?.type || ""}" failed.`),
        name: "BrowserFrameBridgeError"
      };

  return createNamedError(
    typeof payload.name === "string" && payload.name ? payload.name : "BrowserFrameBridgeError",
    typeof payload.message === "string" && payload.message ? payload.message : `Browser frame bridge request "${message?.type || ""}" failed.`,
    {
      code: payload.code ?? null,
      details: payload.details && typeof payload.details === "object" ? payload.details : {},
      payload,
      requestId: String(message?.requestId || ""),
      type: String(message?.type || "")
    }
  );
}

export function hasDesktopBrowserBridge() {
  return Boolean(getDesktopBrowserApi());
}

export function getDesktopBrowserHostApi() {
  return getDesktopBrowserApi();
}

export function createDesktopBrowserBridge(browserId, options = {}) {
  const normalizedBrowserId = normalizeBrowserId(browserId);
  const browserApi = getDesktopBrowserApi();
  if (!browserApi) {
    throw new Error("Desktop browser bridge is unavailable.");
  }

  const defaultTimeoutMs = Math.max(0, Number(options.requestTimeoutMs) || 0);
  const eventListeners = new Map();
  const pendingRequests = new Map();
  const requestHandlers = new Map();
  let isDestroyed = false;

  function ensureActive() {
    if (isDestroyed) {
      throw createNamedError("AbortError", "Desktop browser bridge is destroyed.");
    }
  }

  function createEnvelope(phase, type, payload, details = {}) {
    const envelope = {
      channel: BROWSER_FRAME_BRIDGE_CHANNEL,
      payload: normalizeBrowserFramePayload(payload),
      phase,
      type: normalizeBrowserFrameType(type)
    };

    if (details.requestId) {
      envelope.requestId = String(details.requestId);
    }

    if (phase === BROWSER_FRAME_BRIDGE_PHASE.RESPONSE) {
      envelope.ok = details.ok !== false;
    }

    return envelope;
  }

  function postEnvelope(envelope) {
    ensureActive();
    browserApi.postEnvelope(normalizedBrowserId, envelope);
    return envelope;
  }

  function notifyListeners(message) {
    const listeners = eventListeners.get(message.type);
    if (!listeners || !listeners.size) {
      return;
    }

    listeners.forEach((listener) => {
      listener(message);
    });
  }

  async function respondToRequest(message) {
    if (!message.requestId) {
      return;
    }

    const handler = requestHandlers.get(message.type);
    if (!handler) {
      postEnvelope(
        createEnvelope(
          BROWSER_FRAME_BRIDGE_PHASE.RESPONSE,
          message.type,
          serializeBrowserFrameError(
            {
              message: `No browser frame bridge handler is registered for "${message.type}".`,
              name: "BrowserFrameBridgeMissingHandlerError"
            },
            `No browser frame bridge handler is registered for "${message.type}".`
          ),
          {
            ok: false,
            requestId: message.requestId
          }
        )
      );
      return;
    }

    try {
      const responsePayload = await handler(message.payload, message);
      postEnvelope(
        createEnvelope(BROWSER_FRAME_BRIDGE_PHASE.RESPONSE, message.type, responsePayload, {
          ok: true,
          requestId: message.requestId
        })
      );
    } catch (error) {
      postEnvelope(
        createEnvelope(
          BROWSER_FRAME_BRIDGE_PHASE.RESPONSE,
          message.type,
          serializeBrowserFrameError(error),
          {
            ok: false,
            requestId: message.requestId
          }
        )
      );
    }
  }

  function handleEnvelope(rawEnvelope) {
    if (isDestroyed || !isBridgeEnvelope(rawEnvelope)) {
      return;
    }

    const phase = normalizePhase(rawEnvelope.phase);
    if (!phase) {
      return;
    }

    let normalizedType = "";
    try {
      normalizedType = normalizeBrowserFrameType(rawEnvelope.type);
    } catch {
      return;
    }

    const message = {
      ok: rawEnvelope.ok !== false,
      origin: "electron://desktop",
      payload: rawEnvelope.payload,
      phase,
      raw: rawEnvelope,
      requestId: typeof rawEnvelope.requestId === "string" ? rawEnvelope.requestId : "",
      source: normalizedBrowserId,
      type: normalizedType
    };

    if (phase === BROWSER_FRAME_BRIDGE_PHASE.EVENT) {
      notifyListeners(message);
      return;
    }

    if (phase === BROWSER_FRAME_BRIDGE_PHASE.REQUEST) {
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

  const offEnvelope = browserApi.onEnvelope(normalizedBrowserId, handleEnvelope);

  return {
    channel: BROWSER_FRAME_BRIDGE_CHANNEL,

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      if (typeof offEnvelope === "function") {
        offEnvelope();
      }

      pendingRequests.forEach((pendingRequest) => {
        if (pendingRequest.timeoutId != null) {
          clearTimeout(pendingRequest.timeoutId);
        }

        pendingRequest.reject(createNamedError("AbortError", "Desktop browser bridge is destroyed."));
      });

      pendingRequests.clear();
      eventListeners.clear();
      requestHandlers.clear();
    },

    handle(type, handler) {
      if (typeof handler !== "function") {
        throw new Error("Desktop browser bridge handlers must be functions.");
      }

      const normalizedType = normalizeBrowserFrameType(type);
      requestHandlers.set(normalizedType, handler);

      return () => {
        if (requestHandlers.get(normalizedType) === handler) {
          requestHandlers.delete(normalizedType);
        }
      };
    },

    on(type, listener) {
      if (typeof listener !== "function") {
        throw new Error("Desktop browser bridge listeners must be functions.");
      }

      const normalizedType = normalizeBrowserFrameType(type);
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

    request(type, payload = null, requestOptions = {}) {
      ensureActive();

      const normalizedType = normalizeBrowserFrameType(type);
      const requestId = createRequestId();
      const deferred = createDeferred();
      const timeoutMs = Math.max(0, Number(requestOptions.timeoutMs) || defaultTimeoutMs);
      let timeoutId = null;

      if (timeoutMs > 0) {
        timeoutId = globalThis.setTimeout(() => {
          pendingRequests.delete(requestId);
          deferred.reject(
            createNamedError(
              "TimeoutError",
              `Desktop browser bridge request "${normalizedType}" timed out after ${timeoutMs}ms.`,
              {
                requestId,
                type: normalizedType
              }
            )
          );
        }, timeoutMs);
      }

      pendingRequests.set(requestId, {
        reject: deferred.reject,
        resolve: deferred.resolve,
        timeoutId,
        type: normalizedType
      });

      try {
        postEnvelope(createEnvelope(BROWSER_FRAME_BRIDGE_PHASE.REQUEST, normalizedType, payload, { requestId }));
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
      return postEnvelope(createEnvelope(BROWSER_FRAME_BRIDGE_PHASE.EVENT, type, payload));
    }
  };
}

export function getDesktopBrowserBridge(browserId, options = {}) {
  const normalizedBrowserId = normalizeBrowserId(browserId);
  if (bridgeCache.has(normalizedBrowserId)) {
    return bridgeCache.get(normalizedBrowserId);
  }

  const bridge = createDesktopBrowserBridge(normalizedBrowserId, options);
  const destroy = bridge.destroy.bind(bridge);
  bridge.destroy = () => {
    if (bridgeCache.get(normalizedBrowserId) === bridge) {
      bridgeCache.delete(normalizedBrowserId);
    }

    destroy();
  };

  bridgeCache.set(normalizedBrowserId, bridge);
  return bridge;
}
