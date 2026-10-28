// The admin surface's bridge into the shared engine-swap layer (P4a-3c).
//
// WHY THIS MODULE EXISTS. The Tier 1 machinery is framework code: ONE tier resolver
// (`framework/js/engine-swap/config-flag.js`), ONE turn driver (`turn-driver.js`), ONE
// tool-turn transport (`tool-turn-transport.js`). A surface must never import another
// surface's internals, and the onscreen surface already establishes the shape: its
// store holds a single delegating method and a bridge module holds the engine imports.
// Admin mirrors that deliberately. `store.js` reaches the engine ONLY through this
// module, so admin runs the SAME resolver, the SAME driver and the SAME transport
// onscreen runs — a second tier resolver in admin would be the defect this lane exists
// to prevent, even if its output happened to match.
//
// WHAT IS SHARED AND WHAT IS SURFACE-SHAPED. The TIER DECISION is shared:
// `resolveEngineSwapSessionPlan` is called here, unchanged, and it alone decides
// tier1/tier3/none. What stays surface-shaped is the INPUT GATHERING around it — admin's
// own settings vocabulary (`apiEndpoint`, `model`, `provider`) and its own local-provider
// enum. That is the same split P4a-2 established for settings: a framework-level default
// could silently disagree with the surface's, so the surface resolves its own and passes
// it in. No tier rule is re-implemented here.
//
// OFF INERTNESS. Both flags default false, so `resolveAdminTier1Plan` answers
// `tier: "none"` and the engine modules below it are never imported, allocated or
// logged. Admin's shipped text protocol is untouched in that state.

import {
  ENGINE_SWAP_SESSION_TIER,
  resolveEngineSwapSessionPlan
} from "/modules/_core/framework/js/engine-swap/config-flag.js";
import * as config from "/modules/_core/admin/views/agent/config.js";

export const ADMIN_ENGINE_SWAP_SURFACE = "admin";

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
      import("/modules/_core/framework/js/engine-swap/prompt-shape.js")
    ]).then(([capabilities, session, promptShape]) => ({ capabilities, promptShape, session }));
  }

  return dispatchRuntimePromise;
}

/**
 * The tier decision for this admin session.
 *
 * Returns `{ capabilities, diagnostics, dispatchEnabled, runtime, shadowActive, tier }`.
 * `tier === "tier1"` is the ONLY value that changes behaviour; every other value leaves
 * admin's existing text protocol in force, byte for byte.
 */
export async function resolveAdminTier1Plan({ settings = null, runtime = globalThis.space } = {}) {
  // The shared resolver answers the flag question without touching capabilities.
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

  // A local (browser-inference) session has no HTTP tool transport: there is nothing to
  // send a tool list to. This is the SAME fallback rule onscreen applies — one rule for
  // both surfaces, no admin-only variant — expressed in admin's own provider vocabulary.
  if (config.normalizeAdminChatLlmProvider(settings?.provider) === config.ADMIN_CHAT_LLM_PROVIDER.LOCAL) {
    logOncePerConfig(
      "[engine-swap] surface=admin provider=local tier=tier3 fallback=tier3 reason=local-provider-has-no-tool-transport"
    );

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
  // THE decision, from the ONE resolver — the same call onscreen makes.
  const plan = resolveEngineSwapSessionPlan({ capabilities, runtime });
  const diagnostics = loaded.capabilities.formatCapabilityLogLine(capabilities, {
    model: settings?.model
  });

  logOncePerConfig(
    plan.tier === ENGINE_SWAP_SESSION_TIER.TIER_1
      ? `${diagnostics} surface=admin`
      : `${diagnostics} surface=admin fallback=tier3 reason=capability-tools-off`
  );

  return Object.freeze({
    capabilities,
    diagnostics,
    dispatchEnabled: true,
    runtime,
    shadowActive: plan.shadowActive,
    tier: plan.tier
  });
}

// Applies the Tier 1 prompt shape to the prompt admin already assembled. Tier 3 (or no
// dispatch) returns the input untouched, so admin's prompt corpus is byte-identical in
// every non-Tier-1 state.
export async function shapeAdminSystemPromptForTier({ promptText = "", tier = "" } = {}) {
  if (String(tier || "") !== ENGINE_SWAP_SESSION_TIER.TIER_1) {
    return promptText;
  }

  const loaded = await loadDispatchRuntime();

  return loaded.promptShape.shapeSystemPromptForTier({ promptText, tier });
}

/**
 * One Tier 1 turn, fully prepared by the shared driver.
 *
 * The driver builds the turn request (messages, tools, params, endpoint) and hands it
 * here; this function only constructs the shared session and runs it. Nothing here
 * renders, persists or decides a tier.
 *
 * @returns {Promise<{result: object, session: object}>}
 */
export async function runAdminTier1Turn({
  api = null,
  apiEndpoint = "",
  executionContext = null,
  initialMessages = null,
  isStopRequested = null,
  model = "",
  onEvent = null,
  params = {},
  providerKey = "",
  sendCompletion
} = {}) {
  const loaded = await loadDispatchRuntime();

  const session = loaded.session.createTier1Session({
    api,
    apiEndpoint,
    executionContext,
    initialMessages,
    isStopRequested,
    logger: console,
    model,
    onEvent,
    params,
    providerKey,
    sendCompletion
  });

  logOncePerConfig(loaded.promptShape.formatTier1ToolListLine(session.assembled));

  const result = await session.run({ isStopRequested });

  return Object.freeze({ result, session });
}

// THE TURN DRIVER, and the tool-turn transport.
//
// STATIC imports, matching onscreen exactly (`store.js` imports `turn-driver.js` at module
// load). The flag gate is NOT module loading — it is whether a turn ever CALLS the
// driver: with `ENGINE_SWAP_DISPATCH` off the tier resolves `none`, the loop takes the
// legacy branch, and the driver is never constructed. Keeping this static also keeps the
// wiring synchronous, which is what `getTier1TurnDriver()` relies on.
import { createTier1TurnDriver } from "/modules/_core/framework/js/engine-swap/turn-driver.js";
import { streamToolTurnTransport } from "/modules/_core/framework/js/engine-swap/tool-turn-transport.js";

/**
 * Build the shared Tier 1 turn driver for the admin surface.
 *
 * @param {object} options
 * @param {object} options.surface Admin's paint/persist seams and surface-owned state.
 * @param {object} options.inputs Admin's per-turn inputs and framework bridges.
 * @returns {object} the shared driver instance.
 */
export function createAdminTier1TurnDriver({ inputs = {}, surface = {} } = {}) {
  return createTier1TurnDriver({ inputs, surface });
}

/**
 * Stream one Tier 1 tool turn through the SHARED transport.
 *
 * Admin owns no reader, no assembler and no fetch here: the transport resolves the
 * endpoint, sends the assembled request and reports text deltas plus completed calls.
 * `onPayload` stays internal to the transport, exactly as it does for onscreen.
 */
export async function streamAdminToolTurn({ onDelta = null, onToolCallComplete = null, requestBody, settings, signal } = {}) {
  return streamToolTurnTransport({
    onDelta,
    onToolCallComplete,
    requestBody,
    settings,
    signal
  });
}

export function resetAdminEngineSwapBridgeForTests() {
  dispatchRuntimePromise = null;
  lastDiagnosticLine = "";
}
