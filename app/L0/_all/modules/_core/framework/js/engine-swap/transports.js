// Per-provider transport adapters for the engine-swap layer.
//
// One canonical internal shape (OpenAI chat-completions, see canonical.js).
// Every provider difference lives here, in one transports area, with no proxy:
// the key still goes browser -> provider exactly as it does today.
//
// Launch adapters are all OpenAI-shape (NeuralWatt, OpenRouter, Synthetic,
// OpenAI). An Anthropic-native adapter is a named follow-up, not launch scope.
//
// P1 scope: assembly only. Nothing here performs a network call; `buildRequest`
// returns the object Tier 1 would POST so the shadow layer can describe it.

import { canonicalMessagesToOpenAi, toolRecordToOpenAiTool } from "./canonical.js";
import { resolveCapabilities } from "./capabilities.js";

export const OPENAI_SHAPE_ADAPTER_ID = "openai-shape";

const OPENAI_SHAPE_VARIANTS = Object.freeze({
  neuralwatt: Object.freeze({
    extraHeaders: Object.freeze({}),
    providerKey: "neuralwatt"
  }),
  openai: Object.freeze({
    extraHeaders: Object.freeze({}),
    providerKey: "openai"
  }),
  openrouter: Object.freeze({
    extraHeaders: Object.freeze({ "X-Title": "Constellation Agent" }),
    providerKey: "openrouter"
  }),
  synthetic: Object.freeze({
    extraHeaders: Object.freeze({}),
    providerKey: "synthetic"
  })
});

function normalizeEndpoint(endpoint) {
  return String(endpoint || "").trim();
}

// Builds the complete outbound request description for one provider+model.
// Pure and deterministic for a given input, so the shadow artifact is stable.
export function buildRequest({
  endpoint,
  messages = [],
  model = "",
  parallelToolCallOverride,
  params = {},
  providerKey = "",
  stream = true,
  tools = []
} = {}) {
  // The endpoint travels with the request so a provider that is not named
  // explicitly still resolves from its host; without it, host-based resolution
  // would silently degrade to `unknown` at this entry point.
  const capabilities = resolveCapabilities({
    apiEndpoint: endpoint,
    model,
    provider: providerKey
  });
  const variant = OPENAI_SHAPE_VARIANTS[capabilities.provider] || null;
  // P3 retired the P2 non-streamed boundary. Tool turns now STREAM: the surface's
  // reader assembles `tool_calls` fragments per call index and the loop dispatches
  // only complete arguments. A user `stream` param therefore applies to tool turns
  // exactly as it does to text turns — one rule instead of two — and a provider that
  // ignores `stream: true` still answers with one JSON body, which the same
  // assembler consumes.
  const body = {
    messages: canonicalMessagesToOpenAi(messages),
    model,
    stream
  };

  Object.keys(params && typeof params === "object" ? params : {}).forEach((key) => {
    body[key] = params[key];
  });

  if (tools.length && capabilities.flags.tools) {
    body.tools = tools.map((record) =>
      toolRecordToOpenAiTool(record, { strict: capabilities.flags.tools_strict })
    );
  }

  if (tools.length && capabilities.flags.parallel_tool_calls) {
    body.parallel_tool_calls = parallelToolCallOverride !== false;
  }

  // Usage on a STREAM is a wire capability, not a caching one: a provider can cache
  // the prefix perfectly and still report `prompt_tokens_details: null` unless the
  // request asks (NeuralWatt, measured). So the field is added only where the
  // capability seam resolved `stream_usage` true — which means only where it was
  // measured — and only on a request that actually streams. A non-streaming request
  // already carries usage in its body, and a provider that did not declare support
  // never sees a field we have not proven it tolerates. The gate reads the RESOLVED
  // `body.stream`, because `params` may override it above.
  if (body.stream === true && capabilities.flags.stream_usage) {
    body.stream_options = { include_usage: true };
  }

  return Object.freeze({
    adapter: OPENAI_SHAPE_ADAPTER_ID,
    body: Object.freeze(body),
    capabilities,
    endpoint: normalizeEndpoint(endpoint),
    headers: Object.freeze({
      ...(variant?.extraHeaders || {})
    }),
    provider: capabilities.provider
  });
}

// Adapter scaffolding: one descriptor per provider so a future
// provider-management module reads adapter support from here instead of
// re-deriving it. `native` is false for every launch adapter by construction.
export function listTransportAdapters() {
  return Object.freeze(
    Object.keys(OPENAI_SHAPE_VARIANTS).map((providerKey) =>
      Object.freeze({
        adapter: OPENAI_SHAPE_ADAPTER_ID,
        native: false,
        provider: providerKey
      })
    )
  );
}

export function getTransportAdapter(providerKey) {
  const key = String(providerKey || "").trim().toLowerCase();

  if (!Object.prototype.hasOwnProperty.call(OPENAI_SHAPE_VARIANTS, key)) {
    return null;
  }

  return Object.freeze({
    adapter: OPENAI_SHAPE_ADAPTER_ID,
    buildRequest,
    native: false,
    provider: key
  });
}
