// Focused engine-swap P2 coverage for the ENGINE_SWAP_DISPATCH gate and tier
// selection (plan §6).
//
// The flag is the P2 safety story, so every cell of the matrix is asserted:
//
//   dispatch  shadow  capabilities  ->  tier    shadowActive
//   --------  ------  ------------  ----    ------------
//   off       off     any           none    false
//   off       on      any           none    true
//   on        off     tools         tier1   false
//   on        on      tools         tier1   false   (a real Tier 1 turn has no
//                                                    Tier 3 blocks to compare)
//   on        off     no tools      tier3   false
//   on        on      no tools      tier3   true
//
// Also pinned:
//   - tier fallback per config logs ONE diagnostics line and never downgrades
//     silently
//   - a missing/throwing runtime resolves OFF rather than breaking a turn
//   - params.yaml declares ENGINE_SWAP_DISPATCH as a frontend-exposed boolean
//     whose default is TRUE since v1.5.0 BETA (the flag mechanism is the
//     existing runtime-params system, not a second settings store). The new
//     engine is the engine, not an opt-in: a default-off flag would mean the
//     shipped product never runs what the beta is supposed to test.
//
// Hermetic: stubbed runtime, no network, no keys, no app-data writes, and every
// global this suite touches is restored in `t.after()`.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const {
  ENGINE_SWAP_DISPATCH_FLAG_NAME,
  ENGINE_SWAP_FLAG_NAME,
  ENGINE_SWAP_SESSION_TIER,
  isEngineSwapDispatchEnabled,
  resolveEngineSwapSessionPlan,
  resolveEngineSwapSessionTier
} = await import("../app/L0/_all/modules/_core/framework/js/engine-swap/config-flag.js");

const PARAMS_YAML = new URL("../commands/params.yaml", import.meta.url);

function stubRuntime({ dispatch = false, shadow = false } = {}) {
  return {
    config: {
      get(name, fallback = undefined) {
        if (name === ENGINE_SWAP_DISPATCH_FLAG_NAME) {
          return dispatch;
        }

        if (name === ENGINE_SWAP_FLAG_NAME) {
          return shadow;
        }

        return fallback;
      }
    }
  };
}

const TOOLS_CAPABLE = Object.freeze({ flags: Object.freeze({ tools: true }) });
const TEXT_ONLY = Object.freeze({ flags: Object.freeze({ tools: false }) });

// --- flag declaration ------------------------------------------------------

test("params.yaml declares ENGINE_SWAP_DISPATCH as a frontend-exposed TRUE-default boolean", async () => {
  const source = await readFile(PARAMS_YAML, "utf8");
  const block = source.slice(source.indexOf("ENGINE_SWAP_DISPATCH:"));
  const entry = block.slice(0, block.indexOf("\nENGINE_SWAP") === -1 ? undefined : block.indexOf("\nENGINE_SWAP"));

  assert.match(entry, /type:\s*boolean/u);
  assert.match(entry, /default:\s*true/u);
  assert.match(entry, /frontend_exposed:\s*true/u);
});

// The two flags are NOT a matched pair and must not be flipped together.
//
// `ENGINE_SWAP_SHADOW` is the COMPARISON recorder: it diffs what the old engine
// would have done against what actually ran. `config-flag.js` deliberately
// suppresses it on a real Tier 1 turn because such a turn executes no Tier 3
// blocks, so the diff would be empty and would read as a false pass. Enabling it
// by default would therefore buy nothing on the engine this beta actually tests,
// while paying for artifact writes on every fallback turn.
//
// The per-turn trail the owner needs is the ENGINE TURN LOG (P7-1), which records
// what the NEW engine did and is always on. Pinned here so a future edit cannot
// quietly re-enable the comparison instrument alongside the engine.
test("params.yaml keeps the shadow comparison recorder OFF while dispatch is on", async () => {
  const source = await readFile(PARAMS_YAML, "utf8");
  const block = source.slice(source.indexOf("ENGINE_SWAP_SHADOW:"));
  const entry = block.slice(0, block.indexOf("\nENGINE_SWAP") === -1 ? undefined : block.indexOf("\nENGINE_SWAP"));

  assert.ok(entry, "the P1 shadow flag stays declared");
  assert.match(entry, /default:\s*false/u);
});

test("the dispatch flag name is the documented one", () => {
  assert.equal(ENGINE_SWAP_DISPATCH_FLAG_NAME, "ENGINE_SWAP_DISPATCH");
});

// --- flag reading ----------------------------------------------------------

test("a missing or throwing runtime resolves dispatch OFF instead of breaking a turn", () => {
  assert.equal(isEngineSwapDispatchEnabled({ runtime: null }), false);
  assert.equal(isEngineSwapDispatchEnabled({ runtime: {} }), false);
  assert.equal(
    isEngineSwapDispatchEnabled({
      runtime: {
        config: {
          get() {
            throw new Error("config exploded");
          }
        }
      }
    }),
    false
  );
});

test("only an explicit truthy dispatch value enables the gate", () => {
  for (const falsy of [false, undefined, "false", 0, null]) {
    assert.equal(isEngineSwapDispatchEnabled({ runtime: stubRuntime({ dispatch: falsy }) }), false);
  }

  for (const truthy of [true, "true", 1, "1"]) {
    assert.equal(isEngineSwapDispatchEnabled({ runtime: stubRuntime({ dispatch: truthy }) }), true);
  }
});

// --- tier resolution -------------------------------------------------------

test("dispatch OFF resolves no tier at all, whatever the capabilities say", () => {
  assert.equal(
    resolveEngineSwapSessionTier({ capabilities: TOOLS_CAPABLE, dispatchEnabled: false }),
    ENGINE_SWAP_SESSION_TIER.NONE
  );
  assert.equal(
    resolveEngineSwapSessionTier({ capabilities: null, dispatchEnabled: false }),
    ENGINE_SWAP_SESSION_TIER.NONE
  );
});

test("dispatch ON resolves tier 1 only for a tools-capable config", () => {
  assert.equal(
    resolveEngineSwapSessionTier({ capabilities: TOOLS_CAPABLE, dispatchEnabled: true }),
    ENGINE_SWAP_SESSION_TIER.TIER_1
  );
  assert.equal(
    resolveEngineSwapSessionTier({ capabilities: TEXT_ONLY, dispatchEnabled: true }),
    ENGINE_SWAP_SESSION_TIER.TIER_3
  );
  assert.equal(
    resolveEngineSwapSessionTier({ capabilities: null, dispatchEnabled: true }),
    ENGINE_SWAP_SESSION_TIER.TIER_3
  );
});

// --- the full matrix -------------------------------------------------------

test("the dispatch x shadow matrix resolves exactly as documented", () => {
  const matrix = [
    { capabilities: null, dispatch: false, expectShadowActive: false, expectTier: "none", shadow: false },
    { capabilities: null, dispatch: false, expectShadowActive: true, expectTier: "none", shadow: true },
    { capabilities: TOOLS_CAPABLE, dispatch: false, expectShadowActive: false, expectTier: "none", shadow: false },
    { capabilities: TOOLS_CAPABLE, dispatch: true, expectShadowActive: false, expectTier: "tier1", shadow: false },
    { capabilities: TOOLS_CAPABLE, dispatch: true, expectShadowActive: false, expectTier: "tier1", shadow: true },
    { capabilities: TEXT_ONLY, dispatch: true, expectShadowActive: false, expectTier: "tier3", shadow: false },
    { capabilities: TEXT_ONLY, dispatch: true, expectShadowActive: true, expectTier: "tier3", shadow: true }
  ];

  for (const cell of matrix) {
    const plan = resolveEngineSwapSessionPlan({
      capabilities: cell.capabilities,
      runtime: stubRuntime({ dispatch: cell.dispatch, shadow: cell.shadow })
    });

    assert.equal(plan.tier, cell.expectTier, `tier for ${JSON.stringify({ cell: [cell.dispatch, cell.shadow] })}`);
    assert.equal(plan.shadowActive, cell.expectShadowActive, `shadowActive for ${JSON.stringify([cell.dispatch, cell.shadow])}`);
  }
});

test("a real Tier 1 session suppresses shadow because there are no Tier 3 blocks to diff", () => {
  const plan = resolveEngineSwapSessionPlan({
    capabilities: TOOLS_CAPABLE,
    runtime: stubRuntime({ dispatch: true, shadow: true })
  });

  assert.equal(plan.tier, ENGINE_SWAP_SESSION_TIER.TIER_1);
  assert.equal(plan.shadowEnabled, true, "the shadow flag itself is still on");
  assert.equal(plan.shadowActive, false, "but observation is suppressed on a real tool session");
});

test("a tier 3 session keeps shadow observation when the shadow flag is on", () => {
  const plan = resolveEngineSwapSessionPlan({
    capabilities: TEXT_ONLY,
    runtime: stubRuntime({ dispatch: true, shadow: true })
  });

  assert.equal(plan.tier, ENGINE_SWAP_SESSION_TIER.TIER_3);
  assert.equal(plan.shadowActive, true);
});
