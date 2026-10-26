# AGENTS

## Purpose

`engine-swap/` is the shared transport and tool-registry layer for the LLM action-envelope upgrade, following the `execution-blocks.js` precedent: one pure, shared implementation under `_core/framework/js/`, consumed by both agent surfaces.

P1 builds the machinery and changes no behavior. Sessions keep running the existing Tier 3 text protocol exactly as today; when the `ENGINE_SWAP_SHADOW` flag is on, this layer only assembles and records what the tool-call tier (Tier 1) would have sent.

Dispatch, streaming assembly, admin-surface convergence, prompt caching, and rollout belong to later phases and are deliberately absent here.

## Ownership

- `capabilities.js`: the ONE capability-resolution seam. Provider truth, model rules, transport clamps, and the per-session capability log line.
- `canonical.js`: the canonical internal action shape (OpenAI chat-completions messages/tools/tool_calls) plus canonical to wire transforms.
- `transports.js`: per-provider OpenAI-shape adapter scaffolding (NeuralWatt, OpenRouter, Synthetic, OpenAI). Assembly only, no network calls.
- `tool-registry.js`: tool records as data, deterministic visible-tool-list assembly, strict-schema projection, the dispatch-table stub, and per-tool stats.
- `shadow-normalize.js`: the shared normalization rules for shadow artifacts (own-user path collapse, recursive key sorting, code by hash plus first line, payload redaction).
- `shadow-classifier.js`: the closed nine-class diff enum, display-only detection, and verdict computation for the `ca.shadow-diff/1` gate.
- `shadow-session.js`: shadow run state and the three contract artifacts (manifest, sessions, summary) with an injectable emit sink.
- `shadow-projector.js`: derives the Tier 1 call list from executed Tier 3 block bodies without evaluating them.
- `config-flag.js`: the `ENGINE_SWAP_SHADOW` flag read through the app's existing runtime-parameter system.

The live-path bridge lives with its surface at `_core/onscreen_agent/engine-swap-shadow.js`; it owns lazy loading, the per-session capability line, and the programmatic flush seam.

## Local Contracts

### Flag And Inertness

- The flag is `ENGINE_SWAP_SHADOW`, declared in `commands/params.yaml` as a frontend-exposed boolean with `default: false` and read through `space.config.get(...)`. No second settings store.
- OFF must stay genuinely inert: the bridge statically imports only the dependency-free `config-flag.js` leaf, then resolves the flag synchronously and returns before importing the engine-swap machinery, allocating a session, logging, or writing anything.
- ON must not change behavior either. Tier 3 executes exactly as before; the layer observes and records.
- A flag read that throws resolves OFF; observation failures log once and never break a turn.

### Capability Seam

- Exactly one provider-truth table exists in the product. Future provider-management work consumes this seam instead of introducing a second table.
- Resolution is a pure function of (provider, model): provider defaults, then provider-scoped model rules, then transport clamps.
- Unknown providers resolve to the conservative row with every optional capability off, which keeps such a config on Tier 3 rather than guessing.
- Model rules name their provider; the same model id on another provider never inherits capability.
- A transport cannot carry what it cannot express: a capability flag resolved true against a transport that declares no support is clamped off.
- The per-session capability log line names provider, model, tier, and all five flags.

### Registry And Prefix Determinism

- Tool records are data: `{ name, description, schema, riskClass, handler, source, deferrable }`.
- Visible-tool-list assembly is a pure function of (config, model) with canonical (alphabetical) ordering, so the same config always produces the same list, order, and hash. Session-varying data never enters the list, because the list is half the cacheable prefix.
- Tool descriptions are release-versioned content: editing one is a cache-invalidating change.
- The dispatch-table stub never executes anything. Its honest answer in P1 is `{ dispatched: false }`.
- Launch schemas mirror live server truth, not prose. `tests/engine_swap_registry_test.mjs` reads `ensureValidWriteOperation`, `ensureValidWriteEncoding`, and the `server/api/file_*.js` sources so a written-contract drift fails the build (the BUG-006 lesson).
- Handler refs are identifiers too: a handler is either a real `space.api.<method>` on the api-client surface or a `/modules/<path>#<symbol>` ref that must resolve to a real function in that module. The same suite asserts every ref, so an invented namespace fails the build instead of waiting for P2.

### Shadow Artifacts (`ca.shadow-diff/1`)

- Three artifacts: `manifest.json` (one per run), `sessions.jsonl` (one line per compared turn), `summary.json` (the gate).
- The diff enum is closed: non-failing `match`, `split`, `merge`, `fallback-run-code`, `suppressed-display`; failing `unmapped`, `order-divergence`, `extra-call`, `missing-call`. The gate passes iff all four failing classes are zero, and counts always report in full.
- Display detection reuses the shared `execution-blocks.js` fence classifier. A second copy of fence logic is the BUG-007 anti-pattern and is forbidden.
- Normalization is shared with the lab side: own-user path collapse, recursive key sorting, code compared by SHA-256 plus first line, and payload-bearing argument values redacted to `{ omitted, bytes, sha256 }`. Code and file contents are never embedded whole.
- Artifact emission takes an injected sink. This layer performs no I/O of its own; the lab harness owns placement.

### Purity And Runtime Neutrality

- These modules are shared by the browser and by `node --test`. No browser-only or Node-only globals: hashing uses `crypto.subtle` or an injected digest, and byte lengths use `TextEncoder`.
- Projection never evaluates the code it reads. Unreadable arguments fall back to a single `run_code` call instead of guessing.

## Work Guidance

- Keep this area pure. No DOM reads, no network calls, no app-file writes, no `space.*` calls that mutate state.
- Add a provider by adding one table row plus its adapter descriptor. Do not add a second capability table anywhere.
- Add a launch tool by adding one data record and extending the drift assertions in the registry suite.
- Keep the classifier single-path: every diff class must be produced in exactly one place.
- When the artifact shape changes, bump the format version in the plan first; a shape change is a plan amendment, not a surprise.
- When a flag, seam, or contract here changes, update this file and the framework parent index in the same change.

## Verification

- `tests/engine_swap_capabilities_test.mjs`: flag set, provider/model resolution, conservative unknown fallback, provider-scoped rules, the load-bearing transport clamp, the log line, and purity.
- `tests/engine_swap_registry_test.mjs`: launch inventory shape, deterministic assembly and hash, canonical ordering, strict-schema projection (null present in both type and enum for optional enum fields), the inert dispatch stub, live-server drift assertions, and a handler-ref assertion that every record's handler resolves to a real product identifier.
- `tests/engine_swap_classifier_test.mjs`: the closed enum, one fixture per diff class including all four failing classes, and the shared fence contract (unterminated and tilde fences, fenced display beside a real execution).
- `tests/engine_swap_artifacts_test.mjs`: field-by-field artifact shapes, payload redaction, no embedded code body, mapping, verdict, emit sink, and normalization rules.
- `tests/engine_swap_projector_test.mjs`: typed-call projection, source order, unregistered methods, honest `run_code` fallback, and proof that projection does not execute.
- `tests/engine_swap_flag_test.mjs`: flag resolution, OFF inertness, ON recording, the capability line, the flush seam, and a wiring-level test that drives the bridge with the live call shape (settled identity + runtime envelope) and asserts collapsed paths and non-empty commit/version on the artifact.
- `tests/engine_swap_transports_test.mjs`: the launch adapter set (four OpenAI-shape, none native), per-provider request assembly driven by the capability seam, canonical message wire shape (JSON-string tool arguments), provider resolution from the real Synthetic host, conservative unknown fallback, param merging, and purity.

Every suite runs hermetically under `node --test` with no network, no real keys, and no app-data writes. Seeded mutations over this area must turn the owning suite red before a change is considered covered.

## Child DOX Index

- No child DOX docs.
