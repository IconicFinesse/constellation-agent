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
