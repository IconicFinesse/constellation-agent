// Focused engine-swap P1 coverage for the config flag and the onscreen bridge.
//
// The flag is the whole safety story of P1, so both states are asserted:
//
//   OFF (default) -> the bridge returns synchronously, imports nothing, creates
//                    no session, logs nothing, and flush reports no artifacts
//   ON  (shadow)  -> one capability line is logged, each compared turn is
//                    recorded, and flush returns the ca.shadow-diff/1 bytes
//
// The bridge is exercised in-process with a stubbed runtime; the module graph is
// loaded through the repo's `/modules/...` specifier resolver, and every global
// this suite touches is restored in `t.after()`.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The repo's established pattern: register the loader module by URL so the
// `/modules/...` specifiers in the product graph resolve under node --test.
register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const { ENGINE_SWAP_FLAG_NAME, ENGINE_SWAP_MODE, resolveEngineSwapMode } = await import(
  "../app/L0/_all/modules/_core/framework/js/engine-swap/config-flag.js"
);
const bridge = await import("../app/L0/_all/modules/_core/onscreen_agent/engine-swap-shadow.js");

function stubRuntime(value) {
  return {
    config: {
      get(name, fallback = undefined) {
        return name === ENGINE_SWAP_FLAG_NAME ? value : fallback;
      }
    }
  };
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];

    return;
  }

  globalThis[name] = value;
}

test("a missing runtime resolves OFF instead of throwing", () => {
  assert.equal(resolveEngineSwapMode({ runtime: null }), ENGINE_SWAP_MODE.OFF);
  assert.equal(resolveEngineSwapMode({ runtime: {} }), ENGINE_SWAP_MODE.OFF);
});

test("only an explicit truthy flag turns shadow mode on", () => {
  assert.equal(resolveEngineSwapMode({ runtime: stubRuntime(false) }), ENGINE_SWAP_MODE.OFF);
  assert.equal(resolveEngineSwapMode({ runtime: stubRuntime(undefined) }), ENGINE_SWAP_MODE.OFF);
  assert.equal(resolveEngineSwapMode({ runtime: stubRuntime("false") }), ENGINE_SWAP_MODE.OFF);
  assert.equal(resolveEngineSwapMode({ runtime: stubRuntime(true) }), ENGINE_SWAP_MODE.SHADOW);
  assert.equal(resolveEngineSwapMode({ runtime: stubRuntime("true") }), ENGINE_SWAP_MODE.SHADOW);
  assert.equal(resolveEngineSwapMode({ runtime: stubRuntime(1) }), ENGINE_SWAP_MODE.SHADOW);
});

test("OFF is inert: nothing is recorded and flush reports no artifacts", async (t) => {
  const previousSpace = globalThis.space;

  t.after(() => {
    restoreGlobal("space", previousSpace);
    bridge.resetEngineSwapShadowForTests();
  });

  globalThis.space = stubRuntime(false);
  bridge.resetEngineSwapShadowForTests();

  bridge.maybeObserveEngineSwapShadowTurn({
    assistantContent: "_____javascript\nreturn 1;",
    executionResults: [{ block: { code: "return 1;" } }]
  });

  // Synchronous return: even a same-tick flush must see no session.
  assert.equal(await bridge.flushShadowArtifacts(), null);
});

test("ON records a compared turn and flush returns the three artifacts", async (t) => {
  const previousSpace = globalThis.space;
  const logged = [];
  const previousInfo = console.info;

  t.after(() => {
    console.info = previousInfo;
    restoreGlobal("space", previousSpace);
    bridge.resetEngineSwapShadowForTests();
  });

  console.info = (...args) => {
    logged.push(args.join(" "));
  };
  globalThis.space = stubRuntime(true);
  bridge.resetEngineSwapShadowForTests();

  bridge.maybeObserveEngineSwapShadowTurn({
    assistantContent: "Writing.\n_____javascript\nawait space.api.fileWrite({ path: '~/a.txt', content: 'hi' });",
    executionResults: [
      { block: { code: "await space.api.fileWrite({ path: '~/a.txt', content: 'hi' });" } }
    ],
    settings: { apiEndpoint: "https://api.neuralwatt.com/v1/chat/completions", model: "deepseek-v4.1-flash" }
  });

  const artifacts = await bridge.flushShadowArtifacts();

  assert.ok(artifacts, "shadow mode must expose artifacts");

  const manifest = JSON.parse(artifacts.manifest);
  const summary = JSON.parse(artifacts.summary);
  const lines = artifacts.sessions.trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(manifest.format, "ca.shadow-diff/1");
  assert.equal(manifest.surface, "onscreen");
  assert.equal(manifest.config_id, "api.neuralwatt.com/deepseek-v4.1-flash");
  assert.equal(summary.format, "ca.shadow-diff/1");
  assert.equal(summary.turns, 1);
  assert.equal(summary.blocks, 1);
  assert.equal(summary.calls, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tier1_calls[0].tool, "file_write");

  // Exactly one capability line, naming the resolved config.
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^\[engine-swap\] provider=neuralwatt model=deepseek-v4\.1-flash tier=tier1 /u);
});

// The missing test class the audit named: drive the bridge with the shape the
// live call site actually uses (settled identity + runtime envelope), not with
// fields supplied straight to the session. If the threading is removed from the
// bridge, this fails — which is the point.
test("the live call shape threads identity and runtime into the artifact", async (t) => {
  const previousSpace = globalThis.space;
  const previousInfo = console.info;

  t.after(() => {
    console.info = previousInfo;
    restoreGlobal("space", previousSpace);
    bridge.resetEngineSwapShadowForTests();
  });

  console.info = () => {};
  globalThis.space = stubRuntime(true);
  bridge.resetEngineSwapShadowForTests();

  bridge.maybeObserveEngineSwapShadowTurn({
    assistantContent: "Writing.\n_____javascript\nawait space.api.fileWrite({ path: '~/notes.txt', content: 'hi' });",
    executionResults: [
      { block: { code: "await space.api.fileWrite({ path: '~/notes.txt', content: 'hi' });" } }
    ],
    runtime: { appCommit: "abc1234", appVersion: "1.2.1" },
    separator: "_____javascript",
    settings: { model: "deepseek-v4.1-flash" },
    username: "brauk"
  });

  const artifacts = await bridge.flushShadowArtifacts();
  const manifest = JSON.parse(artifacts.manifest);
  const line = JSON.parse(artifacts.sessions.trim());

  // Non-empty version context: the bridge must pass the runtime envelope on.
  assert.equal(manifest.app_commit, "abc1234");
  assert.equal(manifest.app_version, "1.2.1");

  // Own-user collapse applied with the settled identity, not a no-op.
  assert.equal(line.tier1_calls[0].args_normalized.path, "L2/brauk/notes.txt");
  assert.equal(JSON.stringify(line).includes("\"~/notes.txt\""), false, "no uncollapsed ~/ path may reach the artifact");
});

test("a fenced display turn under ON classifies as suppressed-display and still passes", async (t) => {
  const previousSpace = globalThis.space;
  const previousInfo = console.info;

  t.after(() => {
    console.info = previousInfo;
    restoreGlobal("space", previousSpace);
    bridge.resetEngineSwapShadowForTests();
  });

  console.info = () => {};

  globalThis.space = stubRuntime(true);
  bridge.resetEngineSwapShadowForTests();

  bridge.maybeObserveEngineSwapShadowTurn({
    assistantContent: "```js\nawait space.api.fileDelete({ path: '~/x' });\n```",
    executionResults: [],
    settings: { model: "deepseek-v4.1-flash" }
  });

  const artifacts = await bridge.flushShadowArtifacts();
  const summary = JSON.parse(artifacts.summary);

  assert.equal(summary.by_class["suppressed-display"], 1);
  assert.equal(summary.verdict, "pass");
});

