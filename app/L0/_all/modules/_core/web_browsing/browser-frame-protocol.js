export const BROWSER_FRAME_BRIDGE_CHANNEL = "space.web_browsing.browser_frame";
export const BROWSER_FRAME_BRIDGE_PHASE = Object.freeze({
  EVENT: "event",
  REQUEST: "request",
  RESPONSE: "response"
});

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

function matchAllowedOrigin(allowedOrigins, origin = "") {
  if (!allowedOrigins || allowedOrigins === "*") {
    return true;
  }

  if (Array.isArray(allowedOrigins)) {
    return allowedOrigins.includes("*") || allowedOrigins.includes(origin);
  }

  return String(allowedOrigins) === origin;
}

function isWindowLike(value) {
  return Boolean(value && typeof value.postMessage === "function");
}

function isBridgeEnvelope(value, channel) {
  return Boolean(
    value
    && typeof value === "object"
    && value.channel === channel
    && typeof value.type === "string"
    && "payload" in value
  );
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

export function cloneBrowserFrameValue(value, seen = new WeakMap()) {
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
      const clonedEntry = cloneBrowserFrameValue(entry, seen);
      clonedArray.push(clonedEntry === undefined ? null : clonedEntry);
    });

    return clonedArray;
  }

  if (value instanceof Map) {
    const clonedEntries = [];
    seen.set(value, clonedEntries);

    value.forEach((entryValue, entryKey) => {
      clonedEntries.push([
        cloneBrowserFrameValue(entryKey, seen),
        cloneBrowserFrameValue(entryValue, seen)
      ]);
    });

    return clonedEntries;
  }

  if (value instanceof Set) {
    const clonedEntries = [];
    seen.set(value, clonedEntries);

    value.forEach((entryValue) => {
      clonedEntries.push(cloneBrowserFrameValue(entryValue, seen));
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
      const clonedEntry = cloneBrowserFrameValue(entryValue, seen);

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

export function normalizeBrowserFramePayload(payload) {
  const normalizedPayload = cloneBrowserFrameValue(payload);
  return normalizedPayload === undefined ? null : normalizedPayload;
}

export function normalizeBrowserFrameType(type) {
  const normalizedType = String(type || "").trim();
  if (!normalizedType) {
    throw new Error("Browser frame bridge messages require a non-empty type.");
  }

  return normalizedType;
}

export function serializeBrowserFrameError(error, fallbackMessage = "Browser frame bridge request failed.") {
  const fallback = String(fallbackMessage || "Browser frame bridge request failed.");

  if (error instanceof Error) {
    return {
      code: error.code ?? null,
      details: normalizeBrowserFramePayload(error.details || {}),
      message: error.message || fallback,
      name: error.name || "Error",
      stack: error.stack || ""
    };
  }

  if (isPlainObject(error)) {
    return {
      code: error.code ?? null,
      details: normalizeBrowserFramePayload(error.details || {}),
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

export function createWindowMessageBridge(options = {}) {
  const channel = String(options.channel || BROWSER_FRAME_BRIDGE_CHANNEL);
  const localWindow = options.localWindow || globalThis;
  const resolveTargetWindow =
    typeof options.resolveTargetWindow === "function"
      ? options.resolveTargetWindow
      : () => options.targetWindow || null;
  const targetOrigin = typeof options.targetOrigin === "string" && options.targetOrigin.trim()
    ? options.targetOrigin.trim()
    : "*";
  const allowedOrigins = options.allowedOrigins ?? options.allowedOrigin ?? null;
  const defaultTimeoutMs = Math.max(0, Number(options.requestTimeoutMs) || 0);
  const eventListeners = new Map();
  const requestHandlers = new Map();
  const pendingRequests = new Map();
  let isDestroyed = false;

  if (typeof localWindow.addEventListener !== "function" || typeof localWindow.removeEventListener !== "function") {
    throw new Error("Browser frame bridge requires a window-like local event target.");
  }

  function getTargetWindow() {
    const targetWindow = resolveTargetWindow();
    return isWindowLike(targetWindow) ? targetWindow : null;
  }

  function ensureActive() {
    if (isDestroyed) {
      throw createNamedError("AbortError", "Browser frame bridge is destroyed.");
    }
  }

  function createEnvelope(phase, type, payload, details = {}) {
    const envelope = {
      channel,
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
    const targetWindow = getTargetWindow();

    if (!targetWindow) {
      throw new Error("Browser frame bridge target window is unavailable.");
    }

    targetWindow.postMessage(envelope, targetOrigin);
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
              message: `No browser frame bridge handler is registered for \"${message.type}\".`,
              name: "BrowserFrameBridgeMissingHandlerError"
            },
            `No browser frame bridge handler is registered for \"${message.type}\".`
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

  function handleMessage(event) {
    if (isDestroyed) {
      return;
    }

    const rawMessage = event?.data;
    if (!isBridgeEnvelope(rawMessage, channel)) {
      return;
    }

    if (!matchAllowedOrigin(allowedOrigins, String(event.origin || ""))) {
      return;
    }

    const expectedSource = getTargetWindow();
    if (expectedSource && event.source !== expectedSource) {
      return;
    }

    const phase = normalizePhase(rawMessage.phase);
    if (!phase) {
      return;
    }

    let normalizedType = "";
    try {
      normalizedType = normalizeBrowserFrameType(rawMessage.type);
    } catch {
      return;
    }

    const message = {
      ok: rawMessage.ok !== false,
      origin: String(event.origin || ""),
      payload: rawMessage.payload,
      phase,
      raw: rawMessage,
      requestId: typeof rawMessage.requestId === "string" ? rawMessage.requestId : "",
      source: event.source || null,
      type: normalizedType
    };

    if (phase === BROWSER_FRAME_BRIDGE_PHASE.EVENT) {
      notifyListeners(message);
      return;
    }

    if (phase === BROWSER_FRAME_BRIDGE_PHASE.REQUEST) {
      respondToRequest(message);
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

  localWindow.addEventListener("message", handleMessage);

  return {
    channel,

    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      localWindow.removeEventListener("message", handleMessage);

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
        throw new Error("Browser frame bridge listeners must be functions.");
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
      const envelope = createEnvelope(BROWSER_FRAME_BRIDGE_PHASE.REQUEST, type, payload, { requestId });
      let timeoutId = null;

      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          pendingRequests.delete(requestId);
          deferred.reject(
            createNamedError(
              "TimeoutError",
              `Browser frame bridge request \"${normalizeBrowserFrameType(type)}\" timed out after ${timeoutMs}ms.`,
              { requestId, type: normalizeBrowserFrameType(type) }
            )
          );
        }, timeoutMs);
      }

      pendingRequests.set(requestId, {
        reject: deferred.reject,
        resolve: deferred.resolve,
        timeoutId,
        type: normalizeBrowserFrameType(type)
      });

      try {
        postEnvelope(envelope);
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
