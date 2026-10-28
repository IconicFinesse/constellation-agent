// P5-1 prefix-digest coverage: stability as a MEASUREMENT, not a belief.
//
// What this locks down:
//   - two consecutive turns in one session produce byte-identical digests
//   - appending messages does NOT move the digest of the shared prefix
//   - each of the three perturbations DOES move it (different system prompt,
//     reordered tool list, edited earlier message) -- a digest that cannot see a
//     perturbation is not evidence, so these are the negative controls
//   - canonical serialization: JSON key order cannot move the digest
//   - the digest is secret-free by construction (messages + tools only)
//   - `transientText` has no caller, so nothing poisons the system prompt today
//   - the turn loop only ever APPENDS to `messages` (the property that keeps a
//     prefix cache alive), asserted structurally so a future normalisation of
//     earlier turns cannot silently kill the cache
//   - the digest annotation does not reach the outbound request body
//
// Hermetic: no network, no keys, no timers, no app-data writes.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  PREFIX_DIGEST_VERSION,
  computePrefixDigest,
  formatPrefixDigestLine
} from "../app/L0/_all/modules/_core/framework/js/engine-swap/prefix-digest.js";
import {
  DEMO_HEAD,
  DEMO_TOOLS,
  buildSessionRequestBody,
  twoTurnDigests
} from "./prefix_digest_fixtures.mjs";

const ENGINE_SWAP_DIR = new URL(
  "../app/L0/_all/modules/_core/framework/js/engine-swap/",
  import.meta.url
);
const DISPATCH_PATH = new URL(
  "../app/L0/_all/modules/_core/onscreen_agent/engine-swap-dispatch.js",
  import.meta.url
);

// ---------------------------------------------------------------- stability ---

test("two consecutive turns in one session produce byte-identical digests", async () => {
  const { first, second, turnCount } = await twoTurnDigests();

  // The count is asserted FIRST so this can never pass vacuously: one turn would
  // leave `second` empty and a comparison of two empty strings is not evidence.
  assert.equal(turnCount, 2, `expected two real requests, saw ${turnCount}`);
  assert.match(first, /^fnv1a32:[0-9a-f]{8}$/u);
  assert.equal(second, first);
});

test("appending messages preserves the digest of the shared prefix", () => {
  const base = computePrefixDigest({ headLength: DEMO_HEAD.length, messages: DEMO_HEAD, tools: DEMO_TOOLS });
  const appended = computePrefixDigest({
    headLength: DEMO_HEAD.length,
    messages: [
      ...DEMO_HEAD,
      { content: "a", role: "assistant" },
      { content: "b", role: "tool" },
      { content: "c", role: "assistant" }
    ],
    tools: DEMO_TOOLS
  });

  assert.equal(appended.digest, base.digest);
  assert.equal(appended.headLength, base.headLength);
  // The bound is what makes the claim honest: the digest covered the head, not
  // the whole (by design growing) list.
  assert.equal(base.headLength, DEMO_HEAD.length);
});

// ----------------------------------------------------- negative controls ------

test("perturbation: a different system prompt changes the digest", () => {
  const original = computePrefixDigest({ headLength: DEMO_HEAD.length, messages: DEMO_HEAD, tools: DEMO_TOOLS });
  const messages = DEMO_HEAD.map((message) =>
    message.role === "system" ? { ...message, content: `${message.content}\n\nEXTRA RUNTIME CONTEXT` } : message
  );
  const perturbed = computePrefixDigest({ headLength: DEMO_HEAD.length, messages, tools: DEMO_TOOLS });

  assert.notEqual(perturbed.digest, original.digest);
  // ...and it moved for the RIGHT reason.
  assert.notEqual(perturbed.systemDigest, original.systemDigest);
  assert.equal(perturbed.toolsDigest, original.toolsDigest);
  assert.equal(perturbed.headDigest, original.headDigest);
});

test("perturbation: a reordered tool list changes the digest", () => {
  const original = computePrefixDigest({ headLength: DEMO_HEAD.length, messages: DEMO_HEAD, tools: DEMO_TOOLS });
  const reordered = computePrefixDigest({
    headLength: DEMO_HEAD.length,
    messages: DEMO_HEAD,
    tools: [...DEMO_TOOLS].reverse()
  });

  assert.notEqual(reordered.digest, original.digest);
  assert.notEqual(reordered.toolsDigest, original.toolsDigest);
  assert.equal(reordered.systemDigest, original.systemDigest);
  assert.equal(reordered.headDigest, original.headDigest);
});

test("perturbation: an edited EARLIER message changes the digest", () => {
  const original = computePrefixDigest({ headLength: DEMO_HEAD.length, messages: DEMO_HEAD, tools: DEMO_TOOLS });
  const earlierIndex = DEMO_HEAD.findIndex((message) => message.role === "user");

  assert.ok(earlierIndex > -1, "fixture must contain an earlier user message");

  const messages = DEMO_HEAD.map((message, index) =>
    index === earlierIndex ? { ...message, content: `${message.content} (edited)` } : message
  );
  const perturbed = computePrefixDigest({ headLength: DEMO_HEAD.length, messages, tools: DEMO_TOOLS });

  assert.notEqual(perturbed.digest, original.digest);
  assert.notEqual(perturbed.headDigest, original.headDigest);
  assert.equal(perturbed.systemDigest, original.systemDigest);
  assert.equal(perturbed.toolsDigest, original.toolsDigest);
});

// --------------------------------------------------------- canonical form -----

test("JSON key order cannot move the digest", () => {
  const left = computePrefixDigest({
    headLength: 1,
    messages: [{ content: "x", role: "user" }],
    tools: [{ name: "a", riskClass: "read", schema: { a: 1, b: 2 } }]
  });
  const right = computePrefixDigest({
    headLength: 1,
    messages: [{ role: "user", content: "x" }],
    tools: [{ schema: { b: 2, a: 1 }, riskClass: "read", name: "a" }]
  });

  assert.equal(right.digest, left.digest);
});

test("the digest is deterministic across independent computations", () => {
  const first = computePrefixDigest({ headLength: DEMO_HEAD.length, messages: DEMO_HEAD, tools: DEMO_TOOLS });
  const second = computePrefixDigest({ headLength: DEMO_HEAD.length, messages: DEMO_HEAD, tools: DEMO_TOOLS });

  assert.equal(second.digest, first.digest);
  assert.equal(second.version, PREFIX_DIGEST_VERSION);
});

test("the digest input carries no secret surface", () => {
  // Secret-free BY CONSTRUCTION: the function signature accepts messages and tools
  // only. There is no settings, header, key or endpoint argument to leak through.
  const withSecretishMessage = computePrefixDigest({
    headLength: 1,
    messages: [{ content: "hello", role: "user" }],
    tools: []
  });

  assert.equal(typeof withSecretishMessage.digest, "string");
  assert.doesNotMatch(JSON.stringify(withSecretishMessage), /sk-|api[_-]?key|authorization/iu);
});

test("the log line reports the digest and its components", () => {
  const info = computePrefixDigest({ headLength: DEMO_HEAD.length, messages: DEMO_HEAD, tools: DEMO_TOOLS });
  const line = formatPrefixDigestLine(info);

  assert.match(line, /^\[engine-swap\] prefix digest=fnv1a32:[0-9a-f]{8} head=\d+ /u);
  assert.match(line, new RegExp(`head=${DEMO_HEAD.length}`, "u"));
  assert.match(line, new RegExp(`tools=${info.toolsDigest}\\(${DEMO_TOOLS.length}\\)`, "u"));
  assert.equal(formatPrefixDigestLine(null), "[engine-swap] prefix digest=unknown");
});

// -------------------------------------------------- the request body claim ----

test("the digest does not reach the outbound request body", async () => {
  const { request } = await buildSessionRequestBody();
  const serialized = JSON.stringify(request.body);

  assert.doesNotMatch(serialized, /prefix|digest|fnv1a/iu);

  // The EXACT key set this fixture can produce — a literal, not a filter of itself and
  // not a superset. A permitted-but-absent key would make this guard toothless exactly
  // where it has teeth: the one committed exact-key check over a real gated-provider
  // body. (Synthetic resolves `parallel_tool_calls` false, so it emits no such field;
  // permitting it here would tolerate any value at all in it.) If a future change makes
  // the fixture emit a sixth key, this must be edited deliberately.
  assert.deepEqual(Object.keys(request.body).sort(), [
    "messages",
    "model",
    "stream",
    "stream_options",
    "tools"
  ]);
  assert.deepEqual(request.body.stream_options, { include_usage: true });
});

// ------------------------------------------------ recon facts, asserted ------

test("no caller passes transientText, so nothing poisons the system prompt", async () => {
  const dispatchSource = await readFile(DISPATCH_PATH, "utf8");
  const occurrences = dispatchSource.split("transientText").length - 1;

  // The parameter plus the two lines that use it. A fourth occurrence is a caller
  // passing it, which is a cache poisoner appended to the END of the system prompt.
  assert.equal(occurrences, 3, `transientText occurrences: ${occurrences}`);
  assert.doesNotMatch(dispatchSource, /transientText\s*:/u, "a caller is passing transientText");

  // Tree-wide: the identifier appears in NO other engine or surface module.
  const offenders = [];

  for (const name of await readdir(ENGINE_SWAP_DIR)) {
    if (!name.endsWith(".js")) {
      continue;
    }

    const source = await readFile(new URL(name, ENGINE_SWAP_DIR), "utf8");

    if (source.includes("transientText")) {
      offenders.push(name);
    }
  }

  assert.deepEqual(offenders, [], `transientText leaked into: ${offenders.join(",")}`);
});

test("the turn loop only ever APPENDS to messages", async () => {
  const source = await readFile(
    new URL("tool-turn-loop.js", ENGINE_SWAP_DIR),
    "utf8"
  );
  const methods = [...source.matchAll(/messages\.([A-Za-z]+)\(/gu)].map((match) => match[1]);

  assert.ok(methods.length > 0, "the loop must mutate messages at all");
  assert.deepEqual(
    [...new Set(methods)],
    ["push"],
    `messages mutated by: ${[...new Set(methods)].join(",")}`
  );
  // No index assignment, splice, shift, unshift, sort or reverse anywhere.
  assert.doesNotMatch(source, /messages\[[^\]]+\]\s*=[^=]/u, "messages[index] assignment");
  assert.doesNotMatch(source, /messages\.(splice|shift|unshift|sort|reverse)\(/u, "reordering call");
});

test("the tool list is assembled in a deterministic canonical order", async () => {
  const { canonicalToolOrder } = await import(
    "../app/L0/_all/modules/_core/framework/js/engine-swap/tool-registry.js"
  );
  const records = [{ name: "zeta" }, { name: "alpha" }, { name: "mid" }];

  assert.deepEqual(canonicalToolOrder(records).map((record) => record.name), ["alpha", "mid", "zeta"]);
  // Independent of declaration order.
  assert.deepEqual(
    canonicalToolOrder([...records].reverse()).map((record) => record.name),
    ["alpha", "mid", "zeta"]
  );
});
