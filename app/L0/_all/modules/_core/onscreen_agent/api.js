import * as config from "/modules/_core/onscreen_agent/config.js";
import * as llmParams from "/modules/_core/onscreen_agent/llm-params.js";
import { prepareOnscreenAgentCompletionRequest } from "/modules/_core/onscreen_agent/llm.js";
import { getHuggingFaceManager } from "/modules/_core/huggingface/manager.js";
// P4a-2: the completion-body reader and the tool-turn transport live in the FRAMEWORK now,
// in ONE copy shared with any other surface. This module imports them and keeps no second
// parser. What stays here is surface-shaped: this surface's own settings default and the
// `space.extend` seams, whose extension points are keyed on this module path.
import {
  createApiRequestHeaders,
  extractTextContent,
  readBufferedResponse,
  readStreamingResponse,
  throwResponseError
} from "/modules/_core/framework/js/sse-stream.js";
import {
  completeToolTurnTransport,
  streamToolTurnTransport
} from "/modules/_core/framework/js/engine-swap/tool-turn-transport.js";

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

// Non-streamed tool-turn FALLBACK, for a provider or model that will not stream.
//
// The transport lives in the framework (`engine-swap/tool-turn-transport.js`) so a second
// surface can run a tool turn without importing this module's internals. What remains here
// is genuinely surface-shaped: this surface resolves ITS OWN settings default (the framework
// has no default that could disagree with it) and owns the `space.extend` seam. Exported
// name and signature are unchanged, because store call sites and the transport suites
// address them by name.
export const completeOnscreenAgentToolTurn = globalThis.space.extend(
  import.meta,
  async function completeOnscreenAgentToolTurn({ requestBody, settings, signal } = {}) {
    return completeToolTurnTransport({
      requestBody,
      settings:
        settings && typeof settings === "object" ? settings : config.DEFAULT_ONSCREEN_AGENT_SETTINGS,
      signal
    });
  }
);

// STREAMED tool turn — the transport the Tier 1 loop uses. Same delegation: this module
// resolves the surface default and owns the extension seam; the streaming, the assembler
// wiring and the `onPayload` forwarding belong to the framework module.
export const streamOnscreenAgentToolTurn = globalThis.space.extend(
  import.meta,
  async function streamOnscreenAgentToolTurn({
    onDelta = null,
    onToolCallComplete = null,
    requestBody,
    settings,
    signal
  } = {}) {
    return streamToolTurnTransport({
      onDelta,
      onToolCallComplete,
      requestBody,
      settings:
        settings && typeof settings === "object" ? settings : config.DEFAULT_ONSCREEN_AGENT_SETTINGS,
      signal
    });
  }
);

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
