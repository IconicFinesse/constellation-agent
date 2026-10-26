// The single capability-resolution seam for the engine-swap transport layer.
//
// Per the plan (§3.1, rev 2) there is exactly ONE provider-truth table in the
// product, consumed by the swap and by any future provider-management work.
// A second table anywhere else is the anti-pattern this seam exists to prevent:
// two copies of config truth diverge exactly the way two copies of extraction
// code did before BUG-007.
//
// Resolution is a pure function of (provider, model):
//   1. provider defaults from PROVIDER_CAPABILITY_DEFAULTS
//   2. model-specific rules from MODEL_CAPABILITY_RULES, in declaration order
//   3. hard clamps from the provider's declared transport support
//
// Unknown providers resolve to the conservative `unknown` row: every optional
// capability off, which keeps such a config on Tier 3 instead of guessing.

export const CAPABILITY_FLAGS = Object.freeze([
  "tools",
  "tools_strict",
  "parallel_tool_calls",
  "json_mode",
  "prompt_cache"
]);

export const UNKNOWN_PROVIDER_KEY = "unknown";

export const TIER = Object.freeze({
  TIER_1: "tier1",
  TIER_3: "tier3"
});

function freezeFlags(flags) {
  const frozen = {};

  CAPABILITY_FLAGS.forEach((flag) => {
    frozen[flag] = flags[flag] === true;
  });

  return Object.freeze(frozen);
}

// Provider defaults. `transportSupport` is what the adapter itself can carry;
// a capability cannot resolve true where the transport cannot express it.
const PROVIDER_CAPABILITY_DEFAULTS = Object.freeze({
  neuralwatt: {
    label: "NeuralWatt",
    flags: freezeFlags({
      json_mode: true,
      parallel_tool_calls: false,
      prompt_cache: false,
      tools: true,
      tools_strict: false
    }),
    transportSupport: freezeFlags({ json_mode: true, parallel_tool_calls: true, prompt_cache: false, tools: true, tools_strict: true })
  },
  openai: {
    label: "OpenAI",
    // OpenAI supports prompt caching, but the launch OpenAI-shape adapter emits
    // no cache markers yet — that is P5 work. The clamp below keeps resolution
    // honest until the transport can actually carry the flag.
    flags: freezeFlags({
      json_mode: true,
      parallel_tool_calls: true,
      prompt_cache: true,
      tools: true,
      tools_strict: true
    }),
    transportSupport: freezeFlags({ json_mode: true, parallel_tool_calls: true, prompt_cache: false, tools: true, tools_strict: true })
  },
  openrouter: {
    label: "OpenRouter",
    flags: freezeFlags({
      json_mode: true,
      parallel_tool_calls: true,
      prompt_cache: false,
      tools: true,
      tools_strict: true
    }),
    transportSupport: freezeFlags({ json_mode: true, parallel_tool_calls: true, prompt_cache: false, tools: true, tools_strict: true })
  },
  synthetic: {
    label: "Synthetic",
    flags: freezeFlags({
      json_mode: true,
      parallel_tool_calls: false,
      prompt_cache: false,
      tools: true,
      tools_strict: true
    }),
    transportSupport: freezeFlags({ json_mode: true, parallel_tool_calls: true, prompt_cache: false, tools: true, tools_strict: true })
  },
  [UNKNOWN_PROVIDER_KEY]: {
    label: "Unknown",
    flags: freezeFlags({}),
    transportSupport: freezeFlags({})
  }
});

function freezeRuleFlags(flags) {
  return flags && typeof flags === "object" ? Object.freeze({ ...flags }) : Object.freeze({});
}

// Model rules. `modelPattern` is matched against the resolved model id.
// Later rules win over earlier ones, and every rule must name its provider so
// an OpenRouter model id can never leak capability onto another provider.
const MODEL_CAPABILITY_RULES = Object.freeze([
  Object.freeze({
    flags: freezeRuleFlags({ parallel_tool_calls: true, tools: true, tools_strict: false }),
    modelPattern: /^deepseek-v4\.1-flash/iu,
    note: "deepseek-v4.1-flash tool-calls reliably but does not honour strict schemas",
    provider: "neuralwatt"
  }),
  Object.freeze({
    flags: freezeRuleFlags({ tools: false }),
    modelPattern: /^qwen-3\.8-27b/iu,
    note: "qwen-3.8-27b is the deployed daily-driver; tool-calling unproven",
    provider: "neuralwatt"
  })
]);

const PROVIDER_ALIASES = Object.freeze({
  "api.neuralwatt.com": "neuralwatt",
  "api.openai.com": "openai",
  "api.synthetic.ai": "synthetic",
  "api.syntheticlab.ai": "synthetic",
  "openrouter.ai": "openrouter"
});

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

// Resolves the provider key from an explicit key or from the configured API
// endpoint host. Returns UNKNOWN_PROVIDER_KEY when nothing is recognized.
export function resolveProviderKey(source = {}) {
  const explicit = normalizeKey(source.provider || source.providerKey);

  if (explicit) {
    return Object.prototype.hasOwnProperty.call(PROVIDER_CAPABILITY_DEFAULTS, explicit)
      ? explicit
      : UNKNOWN_PROVIDER_KEY;
  }

  const endpoint = String(source.apiEndpoint || source.endpoint || "").trim();

  if (!endpoint) {
    return UNKNOWN_PROVIDER_KEY;
  }

  let host = "";

  try {
    host = new URL(endpoint).host.toLowerCase();
  } catch {
    host = endpoint.toLowerCase();
  }

  const matchedHost = Object.keys(PROVIDER_ALIASES).find((candidate) => host === candidate || host.endsWith(`.${candidate}`));

  return matchedHost ? PROVIDER_ALIASES[matchedHost] : UNKNOWN_PROVIDER_KEY;
}

export function getProviderCapabilityDefaults(providerKey) {
  const key = normalizeKey(providerKey);
  const row = PROVIDER_CAPABILITY_DEFAULTS[key] || PROVIDER_CAPABILITY_DEFAULTS[UNKNOWN_PROVIDER_KEY];

  return Object.freeze({
    flags: row.flags,
    key: Object.prototype.hasOwnProperty.call(PROVIDER_CAPABILITY_DEFAULTS, key) ? key : UNKNOWN_PROVIDER_KEY,
    label: row.label,
    transportSupport: row.transportSupport
  });
}

// The seam. Callers must never assemble capability truth themselves.
export function resolveCapabilities(source = {}) {
  const providerKey = resolveProviderKey(source);
  const provider = getProviderCapabilityDefaults(providerKey);
  const model = String(source.model || "").trim();
  const resolved = { ...provider.flags };
  const appliedRules = [];

  if (model) {
    MODEL_CAPABILITY_RULES.forEach((rule) => {
      if (rule.provider !== provider.key || !rule.modelPattern.test(model)) {
        return;
      }

      Object.keys(rule.flags).forEach((flag) => {
        if (CAPABILITY_FLAGS.includes(flag)) {
          resolved[flag] = rule.flags[flag] === true;
        }
      });
      appliedRules.push(rule.note);
    });
  }

  // A transport cannot carry what it cannot express.
  CAPABILITY_FLAGS.forEach((flag) => {
    if (!provider.transportSupport[flag]) {
      resolved[flag] = false;
    }
  });

  const flags = freezeFlags(resolved);
  const tier = flags.tools ? TIER.TIER_1 : TIER.TIER_3;

  return Object.freeze({
    flags,
    model,
    notes: Object.freeze(appliedRules),
    provider: provider.key,
    providerLabel: provider.label,
    source: provider.key === UNKNOWN_PROVIDER_KEY ? UNKNOWN_PROVIDER_KEY : "table",
    tier
  });
}

// One-line per-session capability log. Sessions never guess silently: this
// line is what makes a session's tier inspectable.
export function formatCapabilityLogLine(resolution, source = {}) {
  const flags = resolution?.flags || freezeFlags({});
  const flagText = CAPABILITY_FLAGS.map((flag) => `${flag}=${flags[flag] ? "on" : "off"}`).join(" ");
  const model = resolution?.model || String(source.model || "").trim() || "(no model)";

  return `[engine-swap] provider=${resolution?.provider || UNKNOWN_PROVIDER_KEY} model=${model} tier=${resolution?.tier || TIER.TIER_3} ${flagText}`;
}

export function listKnownProviderKeys() {
  return Object.freeze(Object.keys(PROVIDER_CAPABILITY_DEFAULTS).filter((key) => key !== UNKNOWN_PROVIDER_KEY));
}
