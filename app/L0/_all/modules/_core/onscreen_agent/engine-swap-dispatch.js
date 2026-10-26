// Onscreen-surface bridge into the engine-swap dispatch layer (P2).
//
// This is the ONLY place the live chat path touches the dispatch machinery, and it
// is deliberately thin: it resolves the flags, lazily loads the shared layer, and
// hands back a session. No dispatch logic lives here — the plan's P1 precedent
// applies (surface code only imports and calls).
//
// OFF inertness: this module statically imports only the dependency-free flag
// leaf, exactly like the P1 shadow bridge. With ENGINE_SWAP_DISPATCH off the plan
// resolves to tier `none` and nothing else is imported, allocated, or logged.
// With it on, capability resolution (the ONE seam) decides the tier for the
// session: tools-capable config -> Tier 1, otherwise Tier 3 plus one diagnostics
// line. The tier never changes mid-session because a session object is created per
// send.

import {
  ENGINE_SWAP_SESSION_TIER,
  resolveEngineSwapSessionPlan
} from "/modules/_core/framework/js/engine-swap/config-flag.js";
import * as onscreenConfig from "/modules/_core/onscreen_agent/config.js";

export const ONSCREEN_ENGINE_SWAP_SURFACE = "onscreen";

let dispatchRuntimePromise = null;
let lastDiagnosticLine = "";

function logOncePerConfig(line) {
  const text = String(line || "");

  if (!text || text === lastDiagnosticLine) {
    return;
  }

  lastDiagnosticLine = text;

  try {
    console.info(text);
  } catch {
    // Logging must never break a turn.
  }
}

async function loadDispatchRuntime() {
  if (!dispatchRuntimePromise) {
    dispatchRuntimePromise = Promise.all([
      import("/modules/_core/framework/js/engine-swap/capabilities.js"),
      import("/modules/_core/framework/js/engine-swap/tier1-session.js"),
      import("/modules/_core/framework/js/engine-swap/prompt-shape.js"),
      import("/modules/_core/framework/js/engine-swap/tool-registry.js")
    ]).then(([capabilities, session, promptShape, registry]) => ({ capabilities, promptShape, registry, session }));
  }

  return dispatchRuntimePromise;
}

// Synchronous plan resolution for the surface's hot path. Tier resolution needs
// the capability seam, so this only answers "is dispatch even on" and reports the
// tier as unknown; `resolveOnscreenTier1Plan` answers the full question.
//
export function isOnscreenEngineSwapDispatchEnabled() {
  return resolveEngineSwapSessionPlan({ capabilities: null }).dispatchEnabled;
}

// THE tier decision for the surface. Returns a plan object:
//
//   { dispatchEnabled, shadowActive, tier, capabilities, diagnostics }
//
// `tier === "tier1"` is the only value that changes behavior. Everything else
// leaves the existing text protocol in force, byte for byte.
export async function resolveOnscreenTier1Plan({ settings = null, runtime = globalThis.space } = {}) {
  const flags = resolveEngineSwapSessionPlan({ capabilities: null, runtime });

  if (!flags.dispatchEnabled) {
    return Object.freeze({
      capabilities: null,
      diagnostics: "",
      dispatchEnabled: false,
      runtime,
      shadowActive: flags.shadowActive,
      tier: ENGINE_SWAP_SESSION_TIER.NONE
    });
  }

  // A local (browser-inference) session has no HTTP tool transport: there is
  // nothing to send a tool list to. Resolve Tier 3 explicitly rather than letting
  // the endpoint host of stale API settings decide.
  if (onscreenConfig.normalizeOnscreenAgentLlmProvider(settings?.provider) === onscreenConfig.ONSCREEN_AGENT_LLM_PROVIDER.LOCAL) {
    logOncePerConfig("[engine-swap] provider=local tier=tier3 fallback=tier3 reason=local-provider-has-no-tool-transport");

    return Object.freeze({
      capabilities: null,
      diagnostics: "local-provider",
      dispatchEnabled: true,
      runtime,
      shadowActive: flags.shadowActive,
      tier: ENGINE_SWAP_SESSION_TIER.TIER_3
    });
  }

  const loaded = await loadDispatchRuntime();
  const capabilities = loaded.capabilities.resolveCapabilities({
    apiEndpoint: settings?.apiEndpoint,
    model: settings?.model
  });
  const plan = resolveEngineSwapSessionPlan({ capabilities, runtime });
  const diagnostics = loaded.capabilities.formatCapabilityLogLine(capabilities, {
    model: settings?.model
  });

  if (plan.tier === ENGINE_SWAP_SESSION_TIER.TIER_1) {
    logOncePerConfig(diagnostics);
  } else {
    // Tier fallback per config is explicit, never silent (plan §6).
    logOncePerConfig(`${diagnostics} fallback=tier3 reason=capability-tools-off`);
  }

  return Object.freeze({
    capabilities,
    diagnostics,
    dispatchEnabled: true,
    runtime,
    shadowActive: plan.shadowActive,
    tier: plan.tier
  });
}

// Applies the Tier 1 prompt shape to the prompt the surface already assembled.
// Tier 3 (or no dispatch) returns the input untouched.
export async function shapeOnscreenSystemPromptForTier({ promptText = "", tier = "" } = {}) {
  if (String(tier || "") !== ENGINE_SWAP_SESSION_TIER.TIER_1) {
    return promptText;
  }

  const loaded = await loadDispatchRuntime();

  return loaded.promptShape.shapeSystemPromptForTier({ promptText, tier });
}

// One Tier 1 turn, fully prepared. The surface supplies its live api surface,
// execution context, history and conversation text; this function builds the
// session, runs the loop, and returns everything the surface needs to persist and
// render. Nothing here renders or persists.
export async function runOnscreenTier1Turn({
  api = null,
  executionContext = null,
  history = [],
  initialMessages = null,
  model = "",
  onEvent = null,
  params = {},
  providerKey = "",
  apiEndpoint = "",
  sendCompletion,
  systemPrompt = "",
  transientText = "",
  userContent = ""
} = {}) {
  const loaded = await loadDispatchRuntime();

  // Transient runtime context still reaches a Tier 1 model: it is mutable session
  // context, not a tool contract. It joins the system message rather than becoming
  // a fake tool result, so alternation stays valid on the wire. Only used when the
  // caller did not already hand over a prepared conversation.
  const systemPromptWithTransient = String(transientText || "").trim()
    ? `${systemPrompt}\n\n${String(transientText).trim()}`
    : systemPrompt;

  const session = loaded.session.createTier1Session({
    api,
    apiEndpoint,
    executionContext,
    history,
    initialMessages,
    logger: console,
    model,
    onEvent,
    params,
    providerKey,
    sendCompletion,
    systemPrompt: systemPromptWithTransient,
    userContent
  });

  const shapeLine = loaded.promptShape.formatTier1ToolListLine(session.assembled);

  logOncePerConfig(shapeLine);

  const result = await session.run();

  return Object.freeze({ result, session });
}

// Continuation after a held destructive call is confirmed: the pipeline already
// executed it once, so the loop resumes with the outcome as a tool result.
export async function resumeOnscreenTier1AfterHold({ messages = [], session = null, sendCompletion } = {}) {
  if (!session || typeof session.runContinuation !== "function") {
    throw new Error("A Tier 1 session is required to resume after a hold.");
  }

  return session.runContinuation({ messages, sendCompletion });
}

export function resetOnscreenEngineSwapDispatchForTests() {
  dispatchRuntimePromise = null;
  lastDiagnosticLine = "";
}
