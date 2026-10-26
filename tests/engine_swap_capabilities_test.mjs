// Focused engine-swap P1 coverage for the single capability-resolution seam.
//
// What this locks down:
//   - the five capability flags exist and always resolve to booleans
//   - a known provider resolves from the ONE provider table
//   - an unknown provider/model resolves conservatively (everything optional
//     off) instead of guessing, which is what keeps such a config on Tier 3
//   - model rules are provider-scoped: the same model id on another provider
//     never inherits capability
//   - a transport that cannot express a flag clamps that flag off
//   - the per-session capability log line names provider, model, tier, flags
//
// Hermetic: no network, no filesystem, no real keys, no globals touched.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_FLAGS,
  TIER,
  UNKNOWN_PROVIDER_KEY,
  formatCapabilityLogLine,
  getProviderCapabilityDefaults,
  listKnownProviderKeys,
  resolveCapabilities,
  resolveProviderKey
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/capabilities.js";

test("CAPABILITY_FLAGS is the closed five-flag set from the plan", () => {
  assert.deepEqual([...CAPABILITY_FLAGS], [
    "tools",
    "tools_strict",
    "parallel_tool_calls",
    "json_mode",
    "prompt_cache"
  ]);
});

test("every launch provider resolves every flag to a real boolean", () => {
  const providers = listKnownProviderKeys();

  assert.ok(providers.length >= 4, "the four launch providers must be declared");

  for (const provider of providers) {
    const resolution = resolveCapabilities({ model: "some-model", provider });

    for (const flag of CAPABILITY_FLAGS) {
      assert.equal(
        typeof resolution.flags[flag],
        "boolean",
        `${provider}.${flag} must be a boolean, not undefined`
      );
    }

    assert.equal(resolution.provider, provider);
    assert.ok(Object.values(TIER).includes(resolution.tier));
  }
});

test("resolveProviderKey maps explicit keys and endpoint hosts", () => {
  assert.equal(resolveProviderKey({ provider: "OpenAI" }), "openai");
  assert.equal(resolveProviderKey({ apiEndpoint: "https://openrouter.ai/api/v1/chat/completions" }), "openrouter");
  assert.equal(resolveProviderKey({ apiEndpoint: "https://api.neuralwatt.com/v1/chat/completions" }), "neuralwatt");
  assert.equal(resolveProviderKey({ provider: "synthetic" }), "synthetic");
});

test("an unknown provider falls back conservatively to the unknown row", () => {
  assert.equal(resolveProviderKey({ apiEndpoint: "https://example.invalid/v1" }), UNKNOWN_PROVIDER_KEY);
  assert.equal(resolveProviderKey({ provider: "not-a-provider" }), UNKNOWN_PROVIDER_KEY);
  assert.equal(resolveProviderKey({}), UNKNOWN_PROVIDER_KEY);

  const resolution = resolveCapabilities({ model: "anything", provider: "not-a-provider" });

  assert.equal(resolution.provider, UNKNOWN_PROVIDER_KEY);
  for (const flag of CAPABILITY_FLAGS) {
    assert.equal(
      resolution.flags[flag],
      false,
      `unknown provider must not guess ${flag}=true`
    );
  }

  // Conservative means Tier 3, i.e. the existing text protocol keeps running.
  assert.equal(resolution.tier, TIER.TIER_3);
});

test("a tools-capable config resolves Tier 1", () => {
  const resolution = resolveCapabilities({ model: "deepseek-v4.1-flash", provider: "neuralwatt" });

  assert.equal(resolution.flags.tools, true);
  assert.equal(resolution.tier, TIER.TIER_1);
});

test("model rules are provider-scoped and never leak across providers", () => {
  const onNeuralWatt = resolveCapabilities({ model: "deepseek-v4.1-flash", provider: "neuralwatt" });
  const onOpenAi = resolveCapabilities({ model: "deepseek-v4.1-flash", provider: "openai" });

  // The neuralwatt rule disables strict schemas for this model.
  assert.equal(onNeuralWatt.flags.tools_strict, false);
  assert.ok(onNeuralWatt.notes.length >= 1);

  // The same id on another provider keeps that provider's own default.
  assert.equal(onOpenAi.flags.tools_strict, true);
  assert.deepEqual([...onOpenAi.notes], []);
});

test("a transport that cannot express a flag clamps it off", () => {
  const neuralwatt = getProviderCapabilityDefaults("neuralwatt");

  assert.equal(neuralwatt.transportSupport.prompt_cache, false);

  const resolution = resolveCapabilities({ model: "deepseek-v4.1-flash", provider: "neuralwatt" });

  assert.equal(resolution.flags.prompt_cache, false);
});

test("the clamp is load-bearing where provider flags exceed transport support", () => {
  // OpenAI supports prompt caching, but the launch OpenAI-shape adapter emits no
  // cache markers yet, so the transport declares no support for it.
  const openai = getProviderCapabilityDefaults("openai");

  assert.equal(openai.flags.prompt_cache, true);
  assert.equal(openai.transportSupport.prompt_cache, false);

  const resolution = resolveCapabilities({ model: "gpt-x", provider: "openai" });

  assert.equal(
    resolution.flags.prompt_cache,
    false,
    "the clamp must win over the provider's own flag"
  );
});

test("the capability log line is one line naming provider, model, tier and flags", () => {
  const resolution = resolveCapabilities({ model: "deepseek-v4.1-flash", provider: "neuralwatt" });
  const line = formatCapabilityLogLine(resolution);

  assert.equal(line.includes("\n"), false);
  assert.match(line, /^\[engine-swap\] provider=neuralwatt model=deepseek-v4\.1-flash tier=tier1 /u);

  for (const flag of CAPABILITY_FLAGS) {
    assert.ok(line.includes(`${flag}=on`) || line.includes(`${flag}=off`), `${flag} must appear in the log line`);
  }
});

test("resolution is a pure function of provider and model", () => {
  const first = resolveCapabilities({ model: "deepseek-v4.1-flash", provider: "neuralwatt" });
  const second = resolveCapabilities({ model: "deepseek-v4.1-flash", provider: "neuralwatt" });

  assert.deepEqual(first, second);
  assert.notEqual(first.flags, second.flags, "each resolution owns its own frozen flag object");
});
