// Config flag for the engine-swap layer.
//
// Mechanism: the app's existing runtime-parameter system. `commands/params.yaml`
// declares ENGINE_SWAP_SHADOW as a frontend-exposed boolean whose default is
// false, the server injects it as a `<meta name="space-config">` tag on
// framework-backed shells, and `space.config.get(...)` reads it back. No new
// server code, no second settings store.
//
// Default OFF, and OFF means inert: every entry point in this layer returns
// before importing any engine-swap machinery. ON means shadow mode — Tier 3
// behavior stays byte-identical and the layer only observes.

export const ENGINE_SWAP_FLAG_NAME = "ENGINE_SWAP_SHADOW";

// P2 master gate. OFF (default) keeps every session on today's text protocol,
// byte-identical. ON lets a tools-capable session resolve Tier 1 per config.
export const ENGINE_SWAP_DISPATCH_FLAG_NAME = "ENGINE_SWAP_DISPATCH";

export const ENGINE_SWAP_MODE = Object.freeze({
  OFF: "off",
  ON: "on",
  SHADOW: "shadow"
});

// Session tiers (plan §6). `OFF` is not a tier: it means the swap never ran for
// this session and today's behavior is in force.
export const ENGINE_SWAP_SESSION_TIER = Object.freeze({
  NONE: "none",
  TIER_1: "tier1",
  TIER_3: "tier3"
});

function readRuntimeFlag(runtime, flagName) {
  const configReader = runtime?.config;

  if (!configReader || typeof configReader.get !== "function") {
    return false;
  }

  let value = false;

  try {
    value = configReader.get(flagName, false);
  } catch {
    // A config read must never break a live chat turn; an unreadable flag is OFF.
    return false;
  }

  return value === true || value === "true" || value === 1 || value === "1";
}

// Pure resolution so tests never need a live runtime.
export function resolveEngineSwapMode({ runtime = globalThis.space } = {}) {
  return readRuntimeFlag(runtime, ENGINE_SWAP_FLAG_NAME) ? ENGINE_SWAP_MODE.SHADOW : ENGINE_SWAP_MODE.OFF;
}

export function isEngineSwapShadowEnabled({ runtime = globalThis.space } = {}) {
  return resolveEngineSwapMode({ runtime }) === ENGINE_SWAP_MODE.SHADOW;
}

export function isEngineSwapDispatchEnabled({ runtime = globalThis.space } = {}) {
  return readRuntimeFlag(runtime, ENGINE_SWAP_DISPATCH_FLAG_NAME);
}

// THE tier decision (plan §6). Dispatch is the master gate; when it is on, the
// tier comes from the one capability seam (`capabilities.js`) and nowhere else.
//
// Exact interaction with ENGINE_SWAP_SHADOW (pinned by tests):
//
//   dispatch  shadow  capabilities  ->  session
//   --------  ------  ------------  ----------------------------------------
//   off       off     any           none   today
//   off       on      any           none   today + shadow observation (P1)
//   on        off     tools         tier1  real tool loop
//   on        on      tools         tier1  real tool loop, shadow suppressed
//   on        off     no tools      tier3  today, one diagnostics line
//   on        on      no tools      tier3  today + shadow observation
//
// Why shadow is suppressed on a real Tier 1 session: shadow compares what Tier 1
// *would* call against the Tier 3 blocks that actually executed. A Tier 1 turn
// executes no Tier 3 blocks, so there is nothing to compare and an empty diff
// would be a false pass, not evidence.
export function resolveEngineSwapSessionTier({ capabilities = null, dispatchEnabled = false } = {}) {
  if (!dispatchEnabled) {
    return ENGINE_SWAP_SESSION_TIER.NONE;
  }

  return capabilities?.flags?.tools === true
    ? ENGINE_SWAP_SESSION_TIER.TIER_1
    : ENGINE_SWAP_SESSION_TIER.TIER_3;
}

// One decision object for the surface: what runs this session, and whether the
// P1 shadow observer should still watch it.
export function resolveEngineSwapSessionPlan({ capabilities = null, runtime = globalThis.space } = {}) {
  const dispatchEnabled = isEngineSwapDispatchEnabled({ runtime });
  const shadowEnabled = isEngineSwapShadowEnabled({ runtime });
  const tier = resolveEngineSwapSessionTier({ capabilities, dispatchEnabled });

  return Object.freeze({
    dispatchEnabled,
    shadowEnabled,
    tier,
    // A real Tier 1 turn has no Tier 3 blocks to diff, so observation is off.
    shadowActive: shadowEnabled && tier !== ENGINE_SWAP_SESSION_TIER.TIER_1
  });
}
