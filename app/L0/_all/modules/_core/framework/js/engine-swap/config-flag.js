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

export const ENGINE_SWAP_MODE = Object.freeze({
  OFF: "off",
  SHADOW: "shadow"
});

function readRuntimeFlag(runtime) {
  const configReader = runtime?.config;

  if (!configReader || typeof configReader.get !== "function") {
    return false;
  }

  let value = false;

  try {
    value = configReader.get(ENGINE_SWAP_FLAG_NAME, false);
  } catch {
    // A config read must never break a live chat turn; an unreadable flag is OFF.
    return false;
  }

  return value === true || value === "true" || value === 1 || value === "1";
}

// Pure resolution so tests never need a live runtime.
export function resolveEngineSwapMode({ runtime = globalThis.space } = {}) {
  return readRuntimeFlag(runtime) ? ENGINE_SWAP_MODE.SHADOW : ENGINE_SWAP_MODE.OFF;
}

export function isEngineSwapShadowEnabled({ runtime = globalThis.space } = {}) {
  return resolveEngineSwapMode({ runtime }) === ENGINE_SWAP_MODE.SHADOW;
}
