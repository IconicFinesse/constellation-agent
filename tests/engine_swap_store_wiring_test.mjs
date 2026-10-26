// Focused engine-swap P2 coverage for the LIVE STORE CALL SITE.
//
// P1's wiring test drove the bridge directly, supplying `username` at the bridge
// boundary. That left the store's own call site unpinned: deleting
// `username: this.uiStateOwner` from `store.js` kept every suite green while live
// artifacts silently lost identity — the green-suites-dead-wiring class the P1
// re-audit caught (finding 3).
//
// This suite closes that gap by driving `store.executeAssistantBlocks(...)`, the
// real store method that resolves `this.uiStateOwner`, runs the block through the
// live execution context, and invokes the bridge. Two things are asserted
// together because either alone is a false green:
//
//   1. the emitted artifact carries the collapsed own-user path (`L2/<owner>/...`)
//   2. the turn is genuinely recorded AND the block really executed
//
// Harness note — a false-green trap worth knowing: the execution sandbox resolves
// `space` from the TARGET WINDOW, not from `globalThis` (see
// `createExecutionScope` in execution.js). Without `window.space` the block fails
// at runtime while the artifact still records the statically projected call,
// which would let this test pass against a dead turn. The harness wires both and
// the `writes` assertion proves the block actually ran.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const OWNER = "a0-owner-7f3";
const ASSISTANT_CONTENT = [
  "Writing.",
  "_____javascript",
  "await space.api.fileWrite({ path: '~/notes.txt', content: 'hi' });"
].join("\n");

// Minimal stand-in for the authenticated shell. `createStore` returns the model
// itself, which is exactly what the store treats `this` as.
function createHarness() {
  const writes = [];
  const runtime = {
    api: {
      async fileWrite(args) {
        writes.push(args);
        return { ok: true };
      }
    },
    config: {
      get(name, fallback = undefined) {
        // Shadow mode ON for this harness; every other key reads its fallback.
        return name === "ENGINE_SWAP_SHADOW" ? true : fallback;
      }
    },
    extend(_meta, value) {
      return value;
    },
    fw: {
      createStore(_name, model) {
        return model;
      }
    }
  };

  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
    createElement() {
      return {
        classList: { add() {}, remove() {} },
        setAttribute() {},
        appendChild() {},
        style: {}
      };
    },
    body: { appendChild() {} },
    documentElement: { appendChild() {} }
  };
  globalThis.window = {
    // The sandbox reads `space` off the target window — see the file header.
    space: runtime,
    console,
    addEventListener() {},
    removeEventListener() {},
    location: { href: "http://localhost/" },
    matchMedia() {
      return { addEventListener() {}, matches: false };
    }
  };
  globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.space = runtime;

  return { runtime, writes };
}

function restoreGlobals(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete globalThis[name];

      continue;
    }

    globalThis[name] = value;
  }
}

test("the store call site collapses the own-user path and records the turn", async (t) => {
  const previous = {
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    space: globalThis.space,
    window: globalThis.window
  };
  const harness = createHarness();

  t.after(() => {
    restoreGlobals(previous);
  });

  // Imported AFTER the harness installs its globals: these product modules read
  // `globalThis.space` at module scope (`space.extend(...)`, `createStore(...)`).
  const { createExecutionContext } = await import(
    "/modules/_core/onscreen_agent/execution.js"
  );
  const bridge = await import("/modules/_core/onscreen_agent/engine-swap-shadow.js");
  const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

  bridge.resetEngineSwapShadowForTests();

  // The two pieces of live state this test is about: a settled identity on the
  // store, and the execution context `init()` would have built. Nothing else is
  // stubbed — `executeAssistantBlocks` below is the real store method.
  store.uiStateOwner = OWNER;
  store.settings = {
    apiEndpoint: "https://api.example.test/v1/chat/completions",
    model: "wiring-probe-model"
  };
  store.history = [];
  store.executionContext = createExecutionContext({ targetWindow: globalThis.window });

  const executionResults = await store.executeAssistantBlocks(ASSISTANT_CONTENT);

  // Proof the block really executed through the store's own context: a statically
  // projected call would leave this at zero while the artifact still looked fine.
  assert.equal(
    harness.writes.length,
    1,
    "the store's execution context must really run the block"
  );
  assert.equal(
    harness.writes[0].path,
    "~/notes.txt",
    "the executed block keeps the literal user path; collapse happens in the artifact"
  );
  assert.equal(Array.isArray(executionResults) ? executionResults.length : 0, 1);
  assert.equal(executionResults[0].error, null, "the executed block must not error");

  const artifacts = await bridge.flushShadowArtifacts();

  assert.ok(artifacts, "shadow mode ON must expose artifacts for the store's turn");

  const manifest = JSON.parse(artifacts.manifest);
  const summary = JSON.parse(artifacts.summary);
  const line = JSON.parse(artifacts.sessions.trim());

  // (a) The artifact shows a collapsed own-user path, and no tier-1 call keeps a
  // `~/` path. Asserted on the parsed call args, not on raw bytes: the executed
  // block's own `first_line` legitimately quotes the user's literal path.
  assert.equal(line.tier1_calls.length, 1, "one projected call per executed block");
  assert.equal(
    line.tier1_calls[0].args_normalized.path,
    `L2/${OWNER}/notes.txt`,
    "the store's settled uiStateOwner must reach the artifact as a collapsed path"
  );
  assert.equal(
    line.tier1_calls.some((call) => String(call.args_normalized?.path || "").startsWith("~/")),
    false,
    "no tier-1 call may keep an uncollapsed ~/ path"
  );

  // (b) The turn is recorded with the expected identity and comparison outcome.
  assert.equal(summary.turns, 1, "the store's turn must be recorded once");
  assert.equal(summary.blocks, 1);
  assert.equal(summary.calls, 1);
  assert.equal(
    summary.verdict,
    "pass",
    "the executed block and the projected call must compare as a match"
  );
  assert.equal(line.turn_index, 0);
  assert.match(line.session_id, /^s-onscreen-/u);
  assert.equal(line.diffs[0].class, "match");

  // Settings reached the session through the store's own `this.settings`.
  assert.equal(manifest.config_id, "api.example.test/wiring-probe-model");
  assert.equal(manifest.surface, "onscreen");
});
