import * as config from "/modules/_core/onscreen_agent/config.js";
import * as llmParams from "/modules/_core/onscreen_agent/llm-params.js";
import * as proxyUrl from "/modules/_core/framework/js/proxy-url.js";
import { prepareOnscreenAgentCompletionRequest } from "/modules/_core/onscreen_agent/llm.js";
import { getHuggingFaceManager } from "/modules/_core/huggingface/manager.js";
// P3: the streaming tool-call assembler. A PURE, dependency-free leaf (no config
// reads, no I/O, no imports of its own), so importing it here cannot make the
// engine-swap dispatch path non-inert with the flag off: nothing runs until a
// streamed tool turn actually arrives, which only a Tier 1 session can request.
import { createStreamingToolCallAssembler } from "/modules/_core/framework/js/engine-swap/stream-assembly.js";

function extractTextContent(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

function extractStreamingDelta(payload) {
  const choice = payload.choices?.[0];

  if (!choice) {
    return "";
  }

  const delta = choice.delta || choice.message || {};
  return extractTextContent(delta.content || choice.text || "");
}

function extractNonStreamingMessage(payload) {
  const choice = payload.choices?.[0];

  if (!choice) {
    return "";
  }

  const message = choice.message || {};
  return extractTextContent(message.content || choice.text || "");
}

function createCompletionResponseMeta(mode) {
  return {
    finishReason: "",
    mode,
    payloadCount: 0,
    protocolObserved: false,
    sawDoneMarker: false,
    textChunkCount: 0,
    verifiedEmpty: false
  };
}

function noteCompletionPayload(meta, payload, textChunk = "") {
  meta.payloadCount += 1;

  const finishReason = payload?.choices?.[0]?.finish_reason;

  if (!meta.finishReason && typeof finishReason === "string" && finishReason) {
    meta.finishReason = finishReason;
  }

  if (typeof textChunk === "string" && textChunk.trim()) {
    meta.textChunkCount += 1;
  }
}

function finalizeCompletionResponseMeta(meta) {
  const protocolObserved = meta.mode === "standard" ? meta.payloadCount > 0 : meta.payloadCount > 0 || meta.sawDoneMarker;

  return {
    ...meta,
    protocolObserved,
    verifiedEmpty: protocolObserved && meta.textChunkCount === 0
  };
}

async function throwResponseError(response) {
  const contentType = response.headers.get("content-type") || "";
  let detail = "";

  if (contentType.includes("application/json")) {
    try {
      const payload = await response.json();
      detail = payload.error?.message || payload.error || JSON.stringify(payload);
    } catch {
      detail = "Unable to parse JSON error body.";
    }
  } else {
    detail = await response.text();
  }

  throw new Error(`Chat request failed with status ${response.status}: ${detail || response.statusText}`);
}

function createUnsupportedCompletionBodyError(response, bodyText) {
  const contentType = response.headers.get("content-type") || "unknown";
  const snippet = String(bodyText || "")
    .trim()
    .slice(0, 120)
    .replace(/\s+/gu, " ");

  return new Error(
    `Chat request returned status ${response.status} with an unsupported response body ` +
      `(content-type: ${contentType}). Expected an OpenAI-compatible JSON completion or a ` +
      `text/event-stream payload but received: ${snippet || "<empty body>"}`
  );
}

function looksLikeEventStreamBody(bodyText) {
  return /^(?:data|event|id|retry):|^:/u.test(String(bodyText || "").trimStart());
}

// `onPayload` is the RAW-payload seam: the text path renders `onDelta` strings and
// needs nothing else, while the Tier 1 tool path (P3) needs the whole delta object
// because `tool_calls` fragments live outside `content`. One parser serves both — a
// second SSE parser would be the two-copies anti-pattern, and the text path is
// unaffected by the added hook.
function pumpEventStreamText(bodyText, onDelta, meta, onPayload = null) {
  let buffer = String(bodyText || "");
  let boundary = buffer.indexOf("\n\n");

  while (boundary !== -1) {
    const eventBlock = buffer.slice(0, boundary).trim();
    buffer = buffer.slice(boundary + 2);

    if (eventBlock && parseEventBlock(eventBlock, onDelta, meta, onPayload)) {
      return finalizeCompletionResponseMeta(meta);
    }

    boundary = buffer.indexOf("\n\n");
  }

  const remaining = buffer.trim();

  if (remaining) {
    parseEventBlock(remaining, onDelta, meta);
  }

  return finalizeCompletionResponseMeta(meta);
}

async function readBufferedResponse(response, onDelta, onPayload = null) {
  const bodyText = await response.text();

  if (looksLikeEventStreamBody(bodyText)) {
    return pumpEventStreamText(bodyText, onDelta, createCompletionResponseMeta("stream"), onPayload);
  }

  let payload;

  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw createUnsupportedCompletionBodyError(response, bodyText);
  }

  const meta = createCompletionResponseMeta("standard");
  const message = extractNonStreamingMessage(payload);

  noteCompletionPayload(meta, payload, message);

  // A provider that ignored `stream: true` still answers with complete calls, so
  // the assembler consumes the single payload and the turn proceeds. The honest
  // failure stays where it belongs: a provider that streams when asked NOT to.
  onPayload?.(payload);

  if (message) {
    onDelta(message);
  }

  return finalizeCompletionResponseMeta(meta);
}

function parseEventBlock(eventBlock, onDelta, meta, onPayload = null) {
  const lines = eventBlock.split(/\r?\n/u);

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const value = line.slice(5).trim();

    if (!value) {
      continue;
    }

    if (value === "[DONE]") {
      meta.sawDoneMarker = true;
      return true;
    }

    const payload = JSON.parse(value);
    const delta = extractStreamingDelta(payload);

    noteCompletionPayload(meta, payload, delta);

    // The raw payload reaches the tool-call assembler BEFORE any text rendering:
    // one SSE frame can carry both a text delta and a `tool_calls` fragment, and
    // the assembler is the only consumer that understands the second half.
    onPayload?.(payload);

    if (delta) {
      onDelta(delta);
    }
  }

  return false;
}

async function readStreamingResponse(response, onDelta, onPayload = null) {
  const meta = createCompletionResponseMeta("stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), {
      stream: !done
    });

    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const eventBlock = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);

      // `onPayload` is forwarded on BOTH callsites. Dropping it here was the P3
      // audit blocker B1: the assembler then never saw a `tool_calls` fragment on a
      // real streaming provider, so the turn ended as a blank answer.
      if (eventBlock && parseEventBlock(eventBlock, onDelta, meta, onPayload)) {
        return finalizeCompletionResponseMeta(meta);
      }

      boundary = buffer.indexOf("\n\n");
    }

    if (done) {
      const remaining = buffer.trim();

      if (remaining) {
        parseEventBlock(remaining, onDelta, meta, onPayload);
      }

      return finalizeCompletionResponseMeta(meta);
    }
  }
}

function normalizeCompletionMessagesForLocal(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const role =
        message?.role === "system"
          ? "system"
          : message?.role === "assistant"
            ? "assistant"
            : message?.role === "user"
              ? "user"
              : "";
      const content = extractTextContent(message?.content || "");

      if (!role || !content.trim()) {
        return null;
      }

      return {
        content,
        role
      };
    })
    .filter(Boolean);
}

function createApiRequestHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function createApiRequestBody(settings, preparedRequest) {
  if (preparedRequest?.requestBody && typeof preparedRequest.requestBody === "object") {
    return {
      ...preparedRequest.requestBody
    };
  }

  const requestMessages = Array.isArray(preparedRequest?.messages) ? preparedRequest.messages : [];

  return {
    ...llmParams.parseOnscreenAgentParamsText(settings?.paramsText || ""),
    model: settings?.model || config.DEFAULT_ONSCREEN_AGENT_SETTINGS.model,
    stream: true,
    messages: requestMessages
  };
}

function buildFetchRequestInit(apiRequest, signal) {
  const requestInit =
    apiRequest?.requestInit && typeof apiRequest.requestInit === "object"
      ? { ...apiRequest.requestInit }
      : {};
  const headers =
    apiRequest?.headers && typeof apiRequest.headers === "object"
      ? { ...apiRequest.headers }
      : {};

  requestInit.method = typeof apiRequest?.method === "string" && apiRequest.method.trim() ? apiRequest.method : "POST";
  requestInit.headers = headers;
  requestInit.signal = signal;

  if (!("body" in requestInit)) {
    if (apiRequest && "body" in apiRequest) {
      requestInit.body = apiRequest.body;
    } else if (apiRequest?.requestBody !== undefined) {
      requestInit.body = JSON.stringify(apiRequest.requestBody);
    }
  }

  return requestInit;
}

export class OnscreenAgentLlmClient {
  constructor(options = {}) {
    this.settings =
      options.settings && typeof options.settings === "object"
        ? options.settings
        : config.DEFAULT_ONSCREEN_AGENT_SETTINGS;
  }

  async resolvePreparedRequest(options = {}) {
    if (options.preparedRequest && typeof options.preparedRequest === "object") {
      return options.preparedRequest;
    }

    const promptOptions =
      options.promptOptions && typeof options.promptOptions === "object"
        ? options.promptOptions
        : {};

    return prepareOnscreenAgentCompletionRequest({
      messages: options.messages,
      options: promptOptions,
      promptInput: options.promptInput,
      settings: this.settings,
      systemPrompt: options.systemPrompt
    });
  }

  async streamCompletion() {
    throw new Error("LLM client subclasses must implement streamCompletion().");
  }
}

export class OnscreenAgentApiLlmClient extends OnscreenAgentLlmClient {
  validateSettings(settings = this.settings) {
    if (!settings?.apiEndpoint?.trim()) {
      throw new Error("Set an API endpoint before sending a message.");
    }

    if (!settings.apiKey.trim()) {
      throw new Error("Set an API key before sending a message.");
    }

    if (!settings.model.trim()) {
      throw new Error("Set a model before sending a message.");
    }
  }

  async resolveApiRequest(options = {}) {
    const preparedRequest = await this.resolvePreparedRequest(options);
    const effectiveSettings =
      preparedRequest?.settings && typeof preparedRequest.settings === "object"
        ? preparedRequest.settings
        : this.settings;

    return prepareOnscreenAgentApiRequest({
      preparedRequest,
      settings: effectiveSettings
    });
  }

  async streamCompletion(options = {}) {
    const onDelta = typeof options.onDelta === "function" ? options.onDelta : () => {};
    const effectiveRequest = await this.resolveApiRequest(options);
    const effectiveSettings =
      effectiveRequest?.settings && typeof effectiveRequest.settings === "object"
        ? effectiveRequest.settings
        : this.settings;

    this.validateSettings(effectiveSettings);

    const response = await fetch(effectiveRequest.requestUrl, {
      ...buildFetchRequestInit(effectiveRequest, options.signal)
    });

    if (!response.ok) {
      await throwResponseError(response);
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/event-stream")) {
      return readBufferedResponse(response, onDelta);
    }

    if (!response.body) {
      throw new Error("Streaming response body is not available.");
    }

    return readStreamingResponse(response, onDelta);
  }
}

export class OnscreenAgentLocalLlmClient extends OnscreenAgentLlmClient {
  validateSettings(settings = this.settings) {
    const selection = config.getOnscreenAgentLocalModelSelection(settings);

    if (selection.provider !== config.ONSCREEN_AGENT_LOCAL_PROVIDER.HUGGINGFACE) {
      throw new Error("Choose a supported local LLM provider.");
    }

    if (!selection.modelId.trim()) {
      throw new Error("Choose a Hugging Face model before sending a message.");
    }

    if (!selection.dtype.trim()) {
      throw new Error("Choose a Hugging Face dtype before sending a message.");
    }
  }

  getCompletionMessages(preparedRequest) {
    const requestBodyMessages = Array.isArray(preparedRequest?.requestBody?.messages)
      ? preparedRequest.requestBody.messages
      : [];
    const requestMessages = Array.isArray(preparedRequest?.messages) ? preparedRequest.messages : [];

    // Local generation should reuse the same final transport message shape as the API path.
    return normalizeCompletionMessagesForLocal(requestBodyMessages.length ? requestBodyMessages : requestMessages);
  }

  async streamCompletion(options = {}) {
    const onDelta = typeof options.onDelta === "function" ? options.onDelta : () => {};
    const effectiveRequest = await this.resolvePreparedRequest(options);
    const effectiveSettings =
      effectiveRequest?.settings && typeof effectiveRequest.settings === "object"
        ? effectiveRequest.settings
        : this.settings;

    this.validateSettings(effectiveSettings);

    const result = await getHuggingFaceManager().streamCompletion({
      messages: this.getCompletionMessages(effectiveRequest),
      modelSelection: config.getOnscreenAgentLocalModelSelection(effectiveSettings),
      onDelta,
      requestOptions: llmParams.parseOnscreenAgentParamsText(effectiveSettings.paramsText || ""),
      signal: options.signal
    });

    return result.responseMeta;
  }
}

export const prepareOnscreenAgentApiRequest = globalThis.space.extend(
  import.meta,
  async function prepareOnscreenAgentApiRequest({ preparedRequest, settings } = {}) {
    const effectivePreparedRequest =
      preparedRequest && typeof preparedRequest === "object" ? preparedRequest : {};
    const effectiveSettings =
      settings && typeof settings === "object"
        ? settings
        : effectivePreparedRequest?.settings && typeof effectivePreparedRequest.settings === "object"
          ? effectivePreparedRequest.settings
          : config.DEFAULT_ONSCREEN_AGENT_SETTINGS;
    const apiEndpoint = String(effectiveSettings?.apiEndpoint || "").trim();

    return {
      apiEndpoint,
      headers: createApiRequestHeaders(String(effectiveSettings?.apiKey || "").trim()),
      messages: Array.isArray(effectivePreparedRequest?.messages) ? effectivePreparedRequest.messages : [],
      method: "POST",
      preparedRequest: effectivePreparedRequest,
      promptInput:
        effectivePreparedRequest?.promptInput && typeof effectivePreparedRequest.promptInput === "object"
          ? effectivePreparedRequest.promptInput
          : null,
      requestBody: createApiRequestBody(effectiveSettings, effectivePreparedRequest),
      requestUrl:
        typeof effectivePreparedRequest?.requestUrl === "string" && effectivePreparedRequest.requestUrl.trim()
          ? effectivePreparedRequest.requestUrl
          : apiEndpoint,
      settings: effectiveSettings,
      systemPrompt:
        typeof effectivePreparedRequest?.systemPrompt === "string" ? effectivePreparedRequest.systemPrompt : ""
    };
  }
);

export function createOnscreenAgentLlmClient(settings = config.DEFAULT_ONSCREEN_AGENT_SETTINGS) {
  const provider = config.normalizeOnscreenAgentLlmProvider(settings?.provider);

  if (provider === config.ONSCREEN_AGENT_LLM_PROVIDER.LOCAL) {
    return new OnscreenAgentLocalLlmClient({
      settings
    });
  }

  return new OnscreenAgentApiLlmClient({
    settings
  });
}

// Non-streamed completion used by the engine-swap Tier 1 tool loop.
//
// P2 shipped this as the ONLY tool-turn transport because the incremental reader
// extracted text deltas and dropped `tool_calls`. P3 replaced that boundary: a tool
// turn now streams and `streamOnscreenAgentToolTurn` assembles fragments per call
// index. This function stays because a provider/model that ignores streaming still
// has to work, and because "ask for one body" remains the right move when a stream
// is unavailable — it is the fallback, not the contract.
//
// The shared engine-swap layer builds the request BODY (transports.js) and never
// fetches; this function owns the URL, the auth header, and the response parse,
// exactly as `streamCompletion` does for the streaming path.
export const completeOnscreenAgentToolTurn = globalThis.space.extend(
  import.meta,
  async function completeOnscreenAgentToolTurn({ requestBody, settings, signal } = {}) {
    const effectiveSettings =
      settings && typeof settings === "object" ? settings : config.DEFAULT_ONSCREEN_AGENT_SETTINGS;
    const apiEndpoint = String(effectiveSettings?.apiEndpoint || "").trim();

    if (!apiEndpoint) {
      throw new Error("Set an API endpoint before sending a message.");
    }

    if (!String(effectiveSettings?.apiKey || "").trim()) {
      throw new Error("Set an API key before sending a message.");
    }

    if (!String(effectiveSettings?.model || "").trim()) {
      throw new Error("Set a model before sending a message.");
    }

    if (!requestBody || typeof requestBody !== "object") {
      throw new Error("A tool turn requires an assembled request body.");
    }

    const response = await fetch(resolveToolTurnRequestUrl(apiEndpoint), {
      body: JSON.stringify(requestBody),
      headers: createApiRequestHeaders(String(effectiveSettings.apiKey || "").trim()),
      method: "POST",
      signal
    });

    if (!response.ok) {
      await throwResponseError(response);
    }

    const bodyText = await response.text();
    let payload;

    try {
      payload = JSON.parse(bodyText);
    } catch {
      // A tool turn asked for a single JSON body. An event stream here means the
      // provider ignored `stream: false`; report that plainly rather than parsing
      // half an event as a completion.
      if (looksLikeEventStreamBody(bodyText)) {
        throw new Error(
          "Tool turn expected one JSON completion but the provider streamed an event payload. " +
            "Disable streaming for this provider or wait for the streaming tool-call assembler."
        );
      }

      throw createUnsupportedCompletionBodyError(response, bodyText);
    }

    return payload;
  }
);

// STREAMED tool turn (P3). This is the transport the Tier 1 loop uses now: the
// same fetch/auth/URL handling as `completeOnscreenAgentToolTurn`, but the body is
// consumed incrementally and `stream-assembly.js` accumulates `tool_calls`
// fragments per call index. Argument fragments stay STRINGS until the stream says
// it is finished; nothing is parsed mid-flight, so a partial call can never be
// dispatched.
//
// Two provider deviations are handled explicitly rather than by hoping:
//   - the provider answers with one JSON body although streaming was requested:
//     the same assembler consumes that single payload and the turn proceeds
//   - the provider reports `finish_reason: "length"` (it stopped mid-output) or the
//     transport aborted: the assembled calls are marked incomplete AND the caller
//     sees `truncated`, so nothing is dispatched from a cut stream
//
// `onDelta` gets the text deltas so the surface can render prose while calls are
// still assembling. Rendering is optional; assembly is not.
export const streamOnscreenAgentToolTurn = globalThis.space.extend(
  import.meta,
  async function streamOnscreenAgentToolTurn({
    onDelta = null,
    onToolCallComplete = null,
    requestBody,
    settings,
    signal
  } = {}) {
    const effectiveSettings =
      settings && typeof settings === "object" ? settings : config.DEFAULT_ONSCREEN_AGENT_SETTINGS;
    const apiEndpoint = String(effectiveSettings?.apiEndpoint || "").trim();

    if (!apiEndpoint) {
      throw new Error("Set an API endpoint before sending a message.");
    }

    if (!String(effectiveSettings?.apiKey || "").trim()) {
      throw new Error("Set an API key before sending a message.");
    }

    if (!String(effectiveSettings?.model || "").trim()) {
      throw new Error("Set a model before sending a message.");
    }

    if (!requestBody || typeof requestBody !== "object") {
      throw new Error("A tool turn requires an assembled request body.");
    }

    const assembler = createStreamingToolCallAssembler();
    const response = await fetch(resolveToolTurnRequestUrl(apiEndpoint), {
      body: JSON.stringify(requestBody),
      headers: createApiRequestHeaders(String(effectiveSettings.apiKey || "").trim()),
      method: "POST",
      signal
    });

    if (!response.ok) {
      await throwResponseError(response);
    }

    const onPayload = (payload) => {
      assembler.applyPayload(payload);

      // PROVISIONAL CHIP HOOK (chat-surface polish, item 2). The surface wants to
      // paint a `running` chip as soon as a call's arguments COMPLETE, not only when
      // the turn ends. `finish()` is pure and non-mutating, so asking it mid-stream
      // reuses the ONE completeness owner instead of re-deriving a second verdict
      // beside it. The loop still dispatches from the FINAL assembled result; this
      // notification changes nothing about assembly or dispatch.
      if (typeof onToolCallComplete === "function") {
        let assembledNow = null;

        try {
          assembledNow = assembler.finish();
        } catch {
          assembledNow = null;
        }

        (assembledNow?.toolCalls || []).forEach((call) => {
          if (call.argumentsComplete !== true) {
            return;
          }

          try {
            onToolCallComplete({ id: call.id, name: call.name });
          } catch {
            // Painting must never break assembly or dispatch.
          }
        });
      }
    };
    const deliver = (delta) => {
      try {
        onDelta?.(delta);
      } catch {
        // Rendering must never break assembly.
      }
    };

    // A missing `content-type` cannot veto the turn: the buffered reader already
    // sniffs an event-stream body, so an unlabelled response is handled, not failed.
    const contentType = String(response.headers?.get?.("content-type") || "");

    if (contentType.includes("text/event-stream") && response.body) {
      await readStreamingResponse(response, deliver, onPayload);
    } else {
      await readBufferedResponse(response, deliver, onPayload);
    }

    // `truncated` is not passed here: an abort surfaces as a thrown fetch error, and
    // a provider that stopped mid-output says so in `finish_reason`, which the
    // assembler reads itself. Inventing a truncation signal from a missing
    // end-marker would refuse healthy turns from providers that never send one.
    const assembled = assembler.finish();

    // A stream that delivered NO payload is a transport anomaly, and it must be a
    // legible error rather than an empty assistant turn (P3 audit N1): without this,
    // a silently-empty stream is indistinguishable from "the model answered nothing".
    if (assembled.sawAnyPayload === false) {
      throw new Error(
        "The streaming tool turn produced no completion payload. Check the provider's streaming support, then retry."
      );
    }

    return assembled;
  }
);

function resolveToolTurnRequestUrl(apiEndpoint) {
  if (!proxyUrl.isProxyableExternalUrl(apiEndpoint)) {
    return apiEndpoint;
  }

  // `window` is absent under `node --test`; the proxy is a browser affordance, so
  // its absence falls through to the plain URL rather than throwing a ReferenceError.
  const browserWindow = typeof window === "undefined" ? null : window;

  if (browserWindow?.space?.proxy?.buildUrl) {
    return browserWindow.space.proxy.buildUrl(apiEndpoint);
  }

  return proxyUrl.buildProxyUrl(apiEndpoint);
}

export const streamOnscreenAgentCompletion = globalThis.space.extend(
  import.meta,
  async function streamOnscreenAgentCompletion({
    messages,
    onDelta,
    preparedRequest,
    promptOptions,
    promptInput,
    settings,
    signal,
    systemPrompt
  }) {
    const normalizedSettings =
      settings && typeof settings === "object" ? settings : preparedRequest?.settings;
    const client = createOnscreenAgentLlmClient(normalizedSettings);

    return client.streamCompletion({
      messages,
      onDelta,
      preparedRequest,
      promptOptions,
      promptInput,
      signal,
      systemPrompt
    });
  }
);
