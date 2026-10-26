// Onscreen-surface bridge into the engine-swap shadow layer.
//
// This is the ONLY place the live chat path touches the new layer, and it is
// deliberately thin:
//
//   OFF (default) -> resolveEngineSwapMode() reads one frontend config value and
//                    returns; nothing else is imported, allocated, or logged
//   ON (shadow)   -> the layer loads lazily, logs one capability line for the
//                    session, and records each compared turn in memory
//
// Tier 3 behavior is byte-identical in both states. No artifact is written to
// app files from here: the lab consumes artifacts through `flushShadowArtifacts`,
// which returns the exact ca.shadow-diff/1 bytes for the caller to place.

import {
  ENGINE_SWAP_MODE,
  resolveEngineSwapMode
} from "/modules/_core/framework/js/engine-swap/config-flag.js";

export const ENGINE_SWAP_SHADOW_MAX_TURNS = 200;

export const ONSCREEN_ENGINE_SWAP_SURFACE = "onscreen";

let shadowRuntimePromise = null;
let shadowSession = null;
let capabilityLineLoggedFor = "";
let observedTurnCount = 0;
let pendingObservation = Promise.resolve();
let syntheticTurnCounter = 0;
let syntheticSessionId = "";

function getSessionId() {
  if (!syntheticSessionId) {
    syntheticTurnCounter += 1;
    syntheticSessionId = `s-onscreen-${Date.now().toString(36)}-${syntheticTurnCounter}`;
  }

  return syntheticSessionId;
}

async function loadShadowRuntime() {
  if (!shadowRuntimePromise) {
    shadowRuntimePromise = Promise.all([
      import("/modules/_core/framework/js/engine-swap/shadow-session.js"),
      import("/modules/_core/framework/js/engine-swap/shadow-projector.js"),
      import("/modules/_core/framework/js/engine-swap/capabilities.js"),
      import("/modules/_core/framework/js/engine-swap/tool-registry.js")
    ]).then(([session, projector, capabilities, registry]) => ({ capabilities, projector, registry, session }));
  }

  return shadowRuntimePromise;
}

function blockRecordsFromExecutionResults(executionResults) {
  const blocks = [];

  (Array.isArray(executionResults) ? executionResults : []).forEach((result) => {
    const code = typeof result?.block?.code === "string" ? result.block.code : "";

    if (!code) {
      return;
    }

    blocks.push({ code, fenced: false, seq: blocks.length });
  });

  return blocks;
}

function resolveConfigIdentity(settings) {
  const model = String(settings?.model || "").trim();
  const endpoint = String(settings?.apiEndpoint || "").trim();

  if (!model && !endpoint) {
    return "unknown/unknown";
  }

  let provider = "unknown";

  try {
    provider = endpoint ? new URL(endpoint).host : "unknown";
  } catch {
    provider = "unknown";
  }

  return `${provider}/${model || "unknown"}`;
}

async function ensureShadowSession(runtime) {
  if (shadowSession) {
    return shadowSession;
  }

  const loaded = await loadShadowRuntime();
  const resolution = loaded.capabilities.resolveCapabilities({
    apiEndpoint: runtime?.settings?.apiEndpoint,
    model: runtime?.settings?.model
  });

  shadowSession = loaded.session.createShadowSession({
    appCommit: String(runtime?.appCommit || ""),
    appVersion: String(runtime?.appVersion || ""),
    configId: resolveConfigIdentity(runtime?.settings),
    runId: `p1-onscreen-${Date.now().toString(36)}`,
    suite: "live-shadow",
    surface: ONSCREEN_ENGINE_SWAP_SURFACE
  });

  const line = loaded.capabilities.formatCapabilityLogLine(resolution);
  const configKey = `${resolution.provider}/${resolution.model}`;

  if (capabilityLineLoggedFor !== configKey) {
    capabilityLineLoggedFor = configKey;

    try {
      console.info(line);
    } catch {
      // Logging must never break a turn.
    }
  }

  return shadowSession;
}

// The single live-path entry point. Never throws, never awaits work the chat
// turn depends on, and never writes anywhere.
export function maybeObserveEngineSwapShadowTurn({
  assistantContent = "",
  executionResults = [],
  separator = "",
  settings = null
} = {}) {
  if (resolveEngineSwapMode() !== ENGINE_SWAP_MODE.SHADOW) {
    return;
  }

  const observation = (async () => {
    const session = await ensureShadowSession({ settings });

    if (observedTurnCount >= ENGINE_SWAP_SHADOW_MAX_TURNS) {
      return;
    }

    const loaded = await loadShadowRuntime();
    const blocks = blockRecordsFromExecutionResults(executionResults);
    const calls = loaded.projector.projectTurnToCalls(blocks);

    await session.recordTurn({
      replyContent: String(assistantContent || ""),
      separator: String(separator || ""),
      sessionId: getSessionId(),
      tier1Calls: calls,
      tier3Blocks: blocks
    });

    observedTurnCount += 1;
  })();

  // Track the in-flight observation so a lab flush mid-turn cannot lose a turn.
  // The catch keeps an observation failure from becoming an unhandled rejection.
  pendingObservation = observation.catch((error) => {
    try {
      console.warn("[engine-swap] shadow observation skipped:", error?.message || error);
    } catch {
      // Ignore.
    }
  });
}

// Programmatic seam for the lab: returns the exact artifact bytes for the run.
// Awaits the in-flight observation first so a flush mid-turn still includes it.
export async function flushShadowArtifacts() {
  await pendingObservation;

  if (!shadowSession) {
    return null;
  }

  const built = shadowSession.buildArtifacts();

  return {
    manifest: `${JSON.stringify(built.manifest, null, 2)}\n`,
    runId: shadowSession.runId,
    sessions: built.sessions.length ? `${built.sessions.join("\n")}\n` : "",
    summary: `${JSON.stringify(built.summary, null, 2)}\n`
  };
}

export function resetEngineSwapShadowForTests() {
  shadowRuntimePromise = null;
  shadowSession = null;
  capabilityLineLoggedFor = "";
  observedTurnCount = 0;
  pendingObservation = Promise.resolve();
  syntheticSessionId = "";
  syntheticTurnCounter = 0;
}
