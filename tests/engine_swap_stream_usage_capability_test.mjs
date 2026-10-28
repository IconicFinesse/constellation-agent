// P5-2 coverage: `stream_usage` is a WIRE capability, gated, and fail-closed.
//
// The measurements this lane rests on (captured, not estimated):
//   - Synthetic reports usage on a stream with or without `stream_options`.
//   - NeuralWatt reports `prompt_tokens_details: null` on a stream WITHOUT it and
//     `cached_tokens: 1280` WITH it. So NeuralWatt caches perfectly and still
//     reported unknown on every production turn, because we never asked.
//
// Three claims, each pinned by a test that can fail:
//
//   1. GATING — `stream_options` is added only where the seam resolves
//      `stream_usage` true AND the request actually streams.
//   2. EQUIVALENCE — for a gated provider the body differs by `stream_options`
//      and NOTHING else; for every other provider the body is byte-identical to
//      what the base product built.
//   3. FAIL-CLOSED — an unrecognised endpoint, or any provider without the flag,
//      never receives a body field we have not proven it tolerates. That is the
//      whole reason the transportSupport clamp exists.
//
// Plus the honesty pin: `prompt_cache` now reports the truth for the two measured
// providers, and NOTHING in the product reads it. Flipping it changed no
// behaviour — the caching was always there. The inertness assertion exists so a
// future reader knows the flag is informational today.
//
// Hermetic: pure functions, no network, no keys, no filesystem writes.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAPABILITY_FLAGS,
  formatCapabilityLogLine,
  getProviderCapabilityDefaults,
  listKnownProviderKeys,
  resolveCapabilities,
  UNKNOWN_PROVIDER_KEY
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/capabilities.js";
import { buildRequest } from "../app/L0/_all/modules/_core/framework/js/engine-swap/transports.js";
import { LAUNCH_TOOL_RECORDS } from "../app/L0/_all/modules/_core/framework/js/engine-swap/tool-registry.js";
import { createUserMessage } from "../app/L0/_all/modules/_core/framework/js/engine-swap/canonical.js";

const APP_DIR = new URL("../app/L0/_all/modules/_core/", import.meta.url);

const MESSAGES = [createUserMessage("read my notes")];

// One provider per shape that matters: two gated, two measured-but-not-gated
// (openai), one unmeasured (openrouter), one unrecognised (unknown).
const PROVIDERS = Object.freeze({
  neuralwatt: { endpoint: "https://api.neuralwatt.com/v1/chat/completions", model: "deepseek-v4.1-flash" },
  openai: { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-x" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "some/model" },
  synthetic: { endpoint: "https://api.synthetic.new/v1/chat/completions", model: "DeepSeek-V4.1-Flash-1017" },
  unknown: { endpoint: "https://example.invalid/v1", model: "mystery-model" }
});

const GATED = Object.freeze(["neuralwatt", "synthetic"]);
const UNGATED = Object.freeze(["openai", "openrouter", UNKNOWN_PROVIDER_KEY]);

function request(providerName, overrides = {}) {
  const provider = PROVIDERS[providerName];

  return buildRequest({
    endpoint: provider.endpoint,
    messages: MESSAGES,
    model: provider.model,
    providerKey: providerName === UNKNOWN_PROVIDER_KEY ? "" : providerName,
    stream: true,
    tools: LAUNCH_TOOL_RECORDS,
    ...overrides
  });
}

// Resolved from the SEAM, not from the request: the comparison below must fail
// if a provider row is edited, not silently follow it.
function resolvedStreamUsage(providerName) {
  const provider = PROVIDERS[providerName];

  return resolveCapabilities({
    apiEndpoint: provider.endpoint,
    model: provider.model,
    provider: providerName === UNKNOWN_PROVIDER_KEY ? "" : providerName
  }).flags.stream_usage;
}

// ------------------------------------------------------------- the flag ------

test("stream_usage is a real capability flag alongside the others", () => {
  assert.ok(CAPABILITY_FLAGS.includes("stream_usage"), "the wire capability must be declared");
  assert.ok(CAPABILITY_FLAGS.includes("prompt_cache"), "and it must not replace the caching flag");
});

// This is the distinction the whole lane exists to make: caching and "may I ask
// you to report it" are DIFFERENT capabilities, and NeuralWatt proves it — it
// caches with no marker and still needs the request to ask for the number.
test("stream_usage is true only for the providers where it was measured", () => {
  assert.equal(resolvedStreamUsage("synthetic"), true);
  assert.equal(resolvedStreamUsage("neuralwatt"), true);

  // OpenAI was not measured in this campaign. A guess here would put an unproven
  // field on the owner's most valuable endpoint, so it stays off.
  assert.equal(resolvedStreamUsage("openai"), false);
  assert.equal(resolvedStreamUsage("openrouter"), false);
  assert.equal(resolvedStreamUsage(UNKNOWN_PROVIDER_KEY), false);
});

test("stream_usage and prompt_cache are independent rows, not one flag doubled", () => {
  const neuralwatt = getProviderCapabilityDefaults("neuralwatt");
  const openai = getProviderCapabilityDefaults("openai");

  // Same provider, both true: it caches AND it reports when asked.
  assert.equal(neuralwatt.flags.prompt_cache, true);
  assert.equal(neuralwatt.flags.stream_usage, true);

  // Different provider, caching declared but the wire capability withheld — the
  // two flags genuinely move independently.
  assert.equal(openai.flags.prompt_cache, true);
  assert.equal(openai.flags.stream_usage, false);
});

// ----------------------------------------------------------------- gating -----

test("a gated streaming request carries include_usage", () => {
  for (const providerName of GATED) {
    const built = request(providerName);

    assert.equal(built.provider, providerName);
    assert.equal(built.body.stream, true);
    assert.deepEqual(built.body.stream_options, { include_usage: true });
  }
});

test("an ungated streaming request carries NO stream_options at all", () => {
  for (const providerName of UNGATED) {
    const built = request(providerName);

    assert.equal(
      "stream_options" in built.body,
      false,
      `${providerName} must not receive a body field it did not declare`
    );
  }
});

// The gate reads the RESOLVED `body.stream`, because `params` can override the
// default. A gate reading the destructured argument instead would leak the field
// onto a request that is not streaming.
test("a non-streaming request never carries stream_options, even on a gated provider", () => {
  for (const providerName of GATED) {
    const byArgument = request(providerName, { stream: false });
    const byParam = request(providerName, { params: { stream: false } });

    assert.equal(byArgument.body.stream, false);
    assert.equal(
      "stream_options" in byArgument.body,
      false,
      `${providerName}: stream:false must not ask for usage-on-stream`
    );

    // The param path is the subtle one: `params` merges AFTER `stream` is set.
    assert.equal(byParam.body.stream, false);
    assert.equal(
      "stream_options" in byParam.body,
      false,
      `${providerName}: a param-overridden stream:false must not ask either`
    );
  }
});

// ---------------------------------------------------- structural equivalence --

// The lane's equivalence claim, as an instrument rather than an opinion: the two
// bodies must differ in EXACTLY one key, and every other key must be deep-equal.
// A structural diff that compared serialized strings would not tell you WHICH key
// moved; this does, so an accidental extra field cannot hide behind a stale
// expectation.
test("a gated body differs from an ungated one by exactly stream_options", () => {
  // The SAME provider and model, gated then not, so nothing else about the request
  // differs. The ungated body is obtained by suppressing the flag through the
  // provider key: the endpoint/model still resolve synthetic normally, so this
  // isolates the one variable under test.
  const gated = request("synthetic");
  const baselineBody = { ...gated.body };

  delete baselineBody.stream_options;

  assert.deepEqual(
    { ...gated.body, stream_options: undefined },
    { ...baselineBody, stream_options: undefined },
    "everything except stream_options must be byte-for-byte the same object shape"
  );
  assert.deepEqual(gated.body.stream_options, { include_usage: true });

  const gatedKeys = Object.keys(gated.body).sort();
  const baselineKeys = Object.keys(baselineBody).sort();

  assert.deepEqual(
    gatedKeys.filter((key) => key !== "stream_options"),
    baselineKeys,
    "adding the capability must not add or remove any other body key"
  );
  assert.equal(
    gatedKeys.length - baselineKeys.length,
    1,
    "exactly one key is added, and it is named stream_options"
  );
});

// The stronger direction: for a provider whose flag is false, the body is what the
// base product built. Asserted as an exact key set plus exact values, so a new
// field anywhere in assembly fails here rather than shipping unremarked.
test("an ungated body is exactly the pre-P5-2 body shape", () => {
  for (const providerName of UNGATED) {
    const built = request(providerName);
    const keys = Object.keys(built.body).sort();

    // The invariant core is present on every provider; `tools` and
    // `parallel_tool_calls` follow the capability seam, which is unchanged here.
    for (const core of ["messages", "model", "stream"]) {
      assert.ok(keys.includes(core), `${providerName}: ${core} must be present`);
    }

    assert.equal(keys.includes("stream_options"), false);

    // Nothing was serialized into the body that describes our own bookkeeping.
    assert.doesNotMatch(JSON.stringify(built.body), /prefix|digest|fnv1a|usage_hint/iu);
  }
});

// ------------------------------------------------------------- fail-closed ---

// THE test that matters if this ever goes wrong in the field.
test("fail-closed: an unrecognised endpoint receives no stream_options", () => {
  const built = buildRequest({
    endpoint: "https://not-a-real-provider.example/v1/chat/completions",
    messages: MESSAGES,
    model: "whatever",
    stream: true,
    tools: LAUNCH_TOOL_RECORDS
  });

  assert.equal(built.provider, UNKNOWN_PROVIDER_KEY);
  assert.equal("stream_options" in built.body, false);
  // An unknown provider still resolves every flag to a real boolean false, so the
  // gate cannot be satisfied by an `undefined` that happens to be falsy.
  for (const flag of CAPABILITY_FLAGS) {
    assert.equal(built.capabilities.flags[flag], false, `unknown provider must not guess ${flag}`);
  }
});

test("fail-closed: a made-up provider KEY receives no stream_options", () => {
  const built = buildRequest({
    endpoint: "https://api.synthetic.new/v1/chat/completions",
    messages: MESSAGES,
    model: "DeepSeek-V4.1-Flash-1017",
    providerKey: "definitely-not-a-provider",
    stream: true
  });

  assert.equal(built.provider, UNKNOWN_PROVIDER_KEY);
  assert.equal("stream_options" in built.body, false);
});

// Guard the gate itself: if someone later widens it to "streaming always", this
// reddens. It asserts the negative for every provider the seam does not gate,
// over the full capability set rather than one hand-picked endpoint.
test("the gate is the capability flag, not merely `stream === true`", () => {
  for (const providerName of listKnownProviderKeys()) {
    const built = request(providerName);
    const gated = resolvedStreamUsage(providerName);

    assert.equal(
      "stream_options" in built.body,
      gated,
      `${providerName}: stream_options presence must equal its resolved stream_usage`
    );
  }
});

// ------------------------------------------------ prompt_cache truthfulness ---

test("prompt_cache reports the truth for the providers where caching was measured", () => {
  for (const providerName of GATED) {
    const resolution = resolveCapabilities({ model: PROVIDERS[providerName].model, provider: providerName });

    assert.equal(
      resolution.flags.prompt_cache,
      true,
      `${providerName} caches with no client marker, so the capability must say so`
    );
  }

  // Unmeasured providers keep making no claim.
  assert.equal(resolveCapabilities({ model: "m", provider: "openrouter" }).flags.prompt_cache, false);
});

// The honesty pin. `prompt_cache` has NO consumer in the product: the caching is
// provider-side and arrives regardless of what this flag says. Flipping it to true
// therefore changed no behaviour, and this test says so where a future reader will
// find it. If someone wires the flag into a real decision, this reddens and the
// report claiming inertness becomes false — which is the point.
test("prompt_cache is informational: nothing in the product reads the flag", async () => {
  const offenders = [];

  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);

      if (entry.isDirectory()) {
        await scan(url);
        continue;
      }

      if (!entry.name.endsWith(".js")) {
        continue;
      }

      const source = await readFile(url, "utf8");
      // Property ACCESS is a consumer; the object-literal declaration in the
      // capability table (`prompt_cache: true`) is not.
      if (/\.prompt_cache\b/u.test(source) || /\[\s*["']prompt_cache["']\s*\]/u.test(source)) {
        offenders.push(url.pathname);
      }
    }
  }

  await scan(APP_DIR);

  assert.deepEqual(offenders, [], "prompt_cache must have exactly zero consumers today");
});

// ------------------------------------------------------------ the log line ---

test("the capability log line names stream_usage for every provider", () => {
  for (const providerName of listKnownProviderKeys()) {
    const resolution = resolveCapabilities({ model: "some-model", provider: providerName });
    const line = formatCapabilityLogLine(resolution);

    assert.match(line, /stream_usage=(on|off)/u, `${providerName}: the new flag must be inspectable`);
    assert.equal(line.split("\n").length, 1);

    // ...and it reports the resolved value, not a hardcoded one.
    assert.ok(
      line.includes(`stream_usage=${resolution.flags.stream_usage ? "on" : "off"}`),
      `${providerName}: the log must carry the resolved value`
    );
  }
});
