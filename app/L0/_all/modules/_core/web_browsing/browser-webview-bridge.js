import {
  BROWSER_FRAME_BRIDGE_CHANNEL,
  BROWSER_FRAME_BRIDGE_PHASE,
  normalizeBrowserFramePayload,
  normalizeBrowserFrameType,
  serializeBrowserFrameError
} from "./browser-frame-protocol.js";
import {
  logBrowser
} from "./browser-logging.js";
import {
  isWebviewLike
} from "./browser-webview.js";

const bridgeCache = new WeakMap();

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

  return `browser-webview-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
        message: String(message?.payload || `Browser webview bridge request "${message?.type || ""}" failed.`),
        name: "BrowserFrameBridgeError"
      };

  return createNamedError(
    typeof payload.name === "string" && payload.name ? payload.name : "BrowserFrameBridgeError",
    typeof payload.message === "string" && payload.message ? payload.message : `Browser webview bridge request "${message?.type || ""}" failed.`,
    {
      code: payload.code ?? null,
      details: payload.details && typeof payload.details === "object" ? payload.details : {},
      payload,
      requestId: String(message?.requestId || ""),
      type: String(message?.type || "")
    }
  );
}

export function createBrowserWebviewBridge(webview, options = {}) {
  if (!isWebviewLike(webview)) {
    throw new Error("Browser webview bridge requires a <webview> element.");
  }

  const defaultTimeoutMs = Math.max(0, Number(options.requestTimeoutMs) || 0);
  const eventListeners = new Map();
  const pendingRequests = new Map();
  const requestHandlers = new Map();
  let isDestroyed = false;

  function ensureActive() {
    if (isDestroyed) {
      throw createNamedError("AbortError", "Browser webview bridge is destroyed.");
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
    logBrowser("debug", "[space-browser/webview-bridge] Sending envelope to guest.", {
      phase: envelope.phase,
      type: envelope.type,
      requestId: String(envelope.requestId || "")
    });
    webview.send(BROWSER_FRAME_BRIDGE_CHANNEL, envelope);
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
              message: `No browser webview bridge handler is registered for "${message.type}".`,
              name: "BrowserFrameBridgeMissingHandlerError"
            },
            `No browser webview bridge handler is registered for "${message.type}".`
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
      origin: "electron://webview",
      payload: rawEnvelope.payload,
      phase,
      raw: rawEnvelope,
      requestId: typeof rawEnvelope.requestId === "string" ? rawEnvelope.requestId : "",
      source: webview,
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

  const handleIpcMessage = (event) => {
    if (event.channel !== BROWSER_FRAME_BRIDGE_CHANNEL) {
      return;
    }

    const envelope = event.args?.[0] ?? null;
    logBrowser("debug", "[space-browser/webview-bridge] Received envelope from guest.", {
      phase: String(envelope?.phase || ""),
      type: String(envelope?.type || ""),
      requestId: String(envelope?.requestId || "")
    });

    handleEnvelope(envelope);
  };

  webview.addEventListener("ipc-message", handleIpcMessage);

  return {
    channel: BROWSER_FRAME_BRIDGE_CHANNEL,

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      webview.removeEventListener("ipc-message", handleIpcMessage);
      pendingRequests.forEach((pendingRequest) => {
        if (pendingRequest.timeoutId != null) {
          clearTimeout(pendingRequest.timeoutId);
        }

        pendingRequest.reject(createNamedError("AbortError", "Browser webview bridge is destroyed."));
      });
      pendingRequests.clear();
      eventListeners.clear();
      requestHandlers.clear();
    },

    handle(type, handler) {
      if (typeof handler !== "function") {
        throw new Error("Browser webview bridge handlers must be functions.");
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
        throw new Error("Browser webview bridge listeners must be functions.");
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

    request(type, payload = null, options = {}) {
      ensureActive();

      const requestId = createRequestId();
      const deferred = createDeferred();
      const timeoutMs = Math.max(0, Number(options.timeoutMs) || defaultTimeoutMs);
      const normalizedType = normalizeBrowserFrameType(type);
      let timeoutId = null;

      if (timeoutMs > 0) {
        timeoutId = globalThis.setTimeout(() => {
          pendingRequests.delete(requestId);
          deferred.reject(createNamedError(
            "TimeoutError",
            `Browser webview bridge request "${normalizedType}" timed out after ${timeoutMs}ms.`,
            {
              requestId,
              type: normalizedType
            }
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
        postEnvelope(createEnvelope(BROWSER_FRAME_BRIDGE_PHASE.REQUEST, normalizedType, payload, {
          requestId
        }));
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

export function getBrowserWebviewBridge(webview, options = {}) {
  if (!isWebviewLike(webview)) {
    throw new Error("Browser webview bridge requires a <webview> element.");
  }

  if (bridgeCache.has(webview)) {
    return bridgeCache.get(webview);
  }

  const bridge = createBrowserWebviewBridge(webview, options);
  bridgeCache.set(webview, bridge);
  return bridge;
}
