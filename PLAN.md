# Constellation Agent (SpaceAgentFork) — Dynamic Execution Plan

Live execution plan for the project. Split of duties:
`ISSUES.md` is the **bug ledger** (what/why, park verdicts, PR map);
`ROADMAP.md` is the **product roadmap** (shipped / in progress /
exploring); this file is the **how/when** — phase state, lane composition,
check-in points, open decisions.

Working evidence lives in the maintainer's local checkout: paths under
`fixes/`, `prs/`, `worktrees/`, and `local/` are not tracked in this repository.

Updated: 2026-10-23 03:45 MST — **Phase 3 Lane 1 (connected mode) COMPLETE
AND RELEASED at `v0.66-fork.7`; Lane 2 (saved-server removal) merged and
awaiting the next release.** No lane is active. Bug-fix phase closed at
`v0.66-fork.6`.

## Phase status

| Phase | State |
| --- | --- |
| 1 — bug squash | **COMPLETE 2026-10-22** — last fixes released in `v0.66-fork.6` |
| 2 — parked ladder | **DEFERRED** by owner decision; no further bug work until new reports arrive |
| 3 — features, ideas, improvements | **OPEN** — Lane 1 (connected mode) shipped in `v0.66-fork.7`; Lane 2 (saved-server removal) merged, awaiting release; no lane active |

Nothing in `fixes/` or `prs/` requires action. The upstream PR phase closed
with the rebrand; six staged bodies remain only as reference.

## Lanes — Phase 3 (all closed; Lane 1 released, Lane 2 awaiting release)

Approved plan v1.0; owner answers recorded in the project's private memory.

- **Lane A — serving infra. COMPLETE 2026-10-23.** An owner-hosted HTTPS endpoint is live through a Cloudflare Tunnel; the connector runs as a systemd unit inside the self-hosted server guest; HTTPS health 200; real-browser login succeeded (secure context + Web Crypto + redirect to dashboard); private-network fallback intact; negative auth path also verified. Evidence: `fixes/lane-a-probe-2026-10-22.log` + `fixes/lane-a-tunnel-2026-10-22.log`. Docs: private deployment notes (not tracked here).
- **Lane B — the feature. MERGED to main 2026-10-23 as `075c25f`.**
  Branch `feat/connected-mode` in `worktrees/connected-mode` (cut from main
  `b78f221`): `c8f79d2` resolver + 13 unit tests, `1c818fc` main-process wiring,
  `fd77459` launcher chooser + preload bridge, `df9e617` app-shell runtime-tag
  assertion, `c596b0b` DOX pass. Evidence: `fixes/lane-b-connected-mode-2026-10-22.log`.
  Runtime-proven: connected window loads the live tunnel with the preload bridge
  live; standalone default path unchanged; chooser renders and its pick flow
  persists the saved origin; and on the real app shell the framework runtime tag
  reads `app` (`APP_RUNTIME_PROVEN`) — the browser wall's input — with zero
  `web_browsing/` changes. Full `tests/*_test.mjs` gate NOT run in-lane; it
  belongs to the pre-tag batch gate.
  **Gates on merge (2026-10-23):** code gate `fixes/integration-gate7-2026-10-23.log`
  — 54 suites, 53 green, 1 red (`browser_desktop_harness_test` rc=124 timeout;
  same suite was rc=1 on unchanged main in gate6, already parked as non-hermetic,
  and this run overlapped an orphaned copy after a session-reset incident —
  disclosed in the log, not buried). DOX gate on merged main: PASS (53 tracked
  AGENTS.md, none under 200 bytes, no conflict markers, `packaging/AGENTS.md`
  byte-identical to the branch parent). Post-merge regression: lane suite 13/13,
  `desktop_packaging_test` 17/17.
  **Release run 1 failed on a real code bug, now fixed in `88c73cb`.** Every
  fork tag (`v0.66-fork.N`) was unparseable by
  `packaging/scripts/release-version.js` (`RELEASE_TAG_PATTERN` accepted only
  `vX.Y.Z`), so the `prepare` job died before any build. The fork ordinal now
  maps to the semver patch (`v0.66-fork.7` -> `0.66.7`, monotonic for the
  desktop updater); plain semver mapping is unchanged. Regression suite
  `tests/release_version_test.mjs` fails pristine (2/6) and passes with the fix
  (6/6). `main` pushed to `88c73cb`; tag `v0.66-fork.7` deleted and re-cut at the
  same commit — no artifact or release page ever existed, so nothing consumed
  the old tag. Evidence: `fixes/fork-tag-release-fix-2026-10-23.log`.
  **Runs 2 and 3 (tag push + dispatch) passed version parsing — the fix is
  confirmed in CI — and both failed at the release-notes step:**
  `OPENROUTER_API_KEY and OPENROUTER_MODEL_NAME are required when --require-ai
  is set.` Neither setting has ever existed on this fork, because Actions were
  disabled for every earlier tag so no release step ever ran. This is a
  configuration gap, not code: verified live, `openai/gpt-4o-mini` answers 200 on
  OpenRouter with the container key, while two candidate models are retired
  (404). **Owner action required** — the fine-grained PAT 403s on every
  secrets/variables endpoint, so the agent cannot create them. macOS signing
  secrets are absent but optional (workflow exports `SKIP_SIGNING=1`).
  **RELEASED 2026-10-23.** Owner added the repo's first Actions secrets
  (`OPENROUTER_API_KEY` + `OPENROUTER_MODEL_NAME=openai/gpt-4o-mini`, both probe-
  verified against the live OpenRouter endpoint). Run `39932995373`: prepare
  green, all six platform builds green, publish green — **8/8**. Release page
  `github.com/IconicFinesse/constellation-agent/releases/tag/v0.66-fork.7` with
  12 assets (Linux x64/arm64 AppImage, macOS x64/arm64 DMG + updater zip,
  Windows x64/arm64 EXE, four metadata files), tag `f94be65`. This was the first
  successful desktop release of the fork — every earlier tag had Actions
  disabled.
- **Lane C — docs. COMPLETE 2026-10-23.** All connected-mode direction docs in
  place: thesis §1.3 Editions (in `b78f221`, visible in repo and via the root
  symlink), ROADMAP Selected entry (`b78f221`), `packaging/AGENTS.md`
  connected-mode + chooser + origin-pin + E2E-seam contracts (on-branch
  `c596b0b`), the private deployment notes' tunnel section (Lane A closeout), and this
  board. Integrity check 2026-10-23 01:07 MST: tunnel 200 on both paths, VM
  services active, worktree and main both clean, all doc greps 1/1, ISSUES.md
  correctly untouched (feature, not bug). README What's-new regeneration is a
  release-gate step, not a lane item.
- **Lane D — saved-server removal. MERGED 2026-10-23 as `421472f`, awaiting
  the next release.** Owner hit a black screen after mistyping a server URL
  and could not delete the entry. Every saved row now carries its own remove
  control: `removeSavedConnection()` in `connection_mode.js` is a pure list
  operation, the chooser-scoped IPC handler persists the result to
  `connections.json` (0600), and the UI re-renders from the returned list so
  it cannot drift from disk. Suite 13 -> 17 cases; `desktop_packaging_test`
  17/17 and `release_version_test` 6/6 stayed green. Runtime-proven by a
  chooser e2e that removed a seeded typo origin and left the valid one
  (`E2E PASS`, file re-read from disk). Evidence:
  `fixes/lane-d-saved-server-removal-2026-10-23.log`.

### Unreleased since `v0.66-fork.7`

`main` carries four commits past the release tag, all awaiting the next tag
(`v0.66-fork.8`):

| Commit | Content |
| --- | --- |
| `b5c49c9` | publish the four planning/doctrine docs that had lived only in the local checkout (sanitized for a public repo) |
| `a039733` | DOX pass: root index for those docs + the public-document rule, the two new suites in `tests/AGENTS.md`, the fork-tag contract in `packaging/AGENTS.md` |
| `421472f` | saved-server removal in the connection chooser (Lane D) |
| — | release-note and README regeneration happen at tag time, not before |

No release should be cut until the owner asks; `v0.66-fork.7` remains the
shipping build and **does not contain** the saved-server removal.

## Phase 3 — what this phase is for

The bug phase resolved inherited defects. This phase builds **our own product**
under the standing in `PROJECT-THESIS.md`: *Constellation Agent is the product;
upstream is a source of free fixes.*

The thesis governs what counts as a feature here. Three filters, applied to
every idea before it earns roadmap space:

1. **Does it need new server authority?** If a feature needs the server to hold
   agent state or orchestrate a turn, it is a different architecture with a
   different thesis. The correct answer is no.
2. **Does it require a capability the residency model cannot honestly provide?**
   Durable background work and multi-client session continuity are foreclosed.
   Say so rather than half-building them.
3. **Is this a contract or a content decision?** Contracts can be decided from
   architecture knowledge today. Content — which widgets, which layouts, which
   workflows — can only be decided from usage data later.

### Selected feature work

All three recorded in `space-agent/ROADMAP.md`; full descriptions in
`PROJECT-THESIS.md` §1.3, §8.4 and §8.5.

| Item | Why it was chosen |
| --- | --- |
| **Capability authoring as the compounding loop** | Content is disposable, capability compounds. An agent that authors skills is a colleague; one that only authors widgets is a tool. |
| **A memory surface, not a memory policy** | A genuine upgrade to the framework, and only possible here — memory is already plain text the user owns, so the surface is a view over files rather than a dashboard over a database. |
| **Connected mode (desktop → remote server)** | First ratified feature. The full desktop client against canonical remote data over HTTPS, with zero new server authority; the embedded-browser wall resolves as signposting. Direction: `PROJECT-THESIS.md` §1.3, `space-agent/ROADMAP.md` Selected. |

### Open decision — sequencing

The unresolved question is whether to build these two features first, or to run a
real use phase and let it drive them. Current recommendation on the table:

- Memory surface **read side** first — days of work, no contract risk, and
  without it a use phase cannot observe the thing it is meant to judge.
- Then a **structured use phase** with a written findings log.
- Then capability authoring and the memory write conventions, driven by that log.

Why not bare use first: without a memory surface, findings reduce to "I wish it
remembered things" — rediscovering decisions already made. Why not both features
first: *when should the agent promote a repeated solution into a skill* is a
judgement about a real workflow and cannot be designed from architecture
knowledge.

**Partially called 2026-10-22:** connected mode is active as Lane 1, and this
section now governs the two module features only. No lane for those starts
until the owner calls the order.

## The operating loop (one iteration per work item)

1. **Pre-flight**: `git fetch upstream main`, confirm the upstream head, check
   `git worktree list` and `pgrep` for active lanes, create lane worktree(s).
2. **Lane spawn**: one lane per work item; one worktree per lane; branch cut
   from fork `main` (feature work is ours — the pristine-upstream rule applied
   to fix branches only).
3. **Lane builds**: read the AGENTS.md chain in its worktree → reproduce or
   design → minimal change → regression test in `os.tmpdir()` mkdtemp roots →
   DOX pass as a separate commit. Local commits only — never push, never
   install, no formatting sweeps.
4. **Orchestrator verification**: rerun each lane's suites independently; label
   every finding runtime-reproduced / inspection-proven / inferred.
5. **Check-in**: report branch, hashes, diff summary, test evidence, park
   verdict if any. Owner approves commit/push/tag.
6. **Artifacts**: `fixes/<slug>.md` log for defect work; the module's own
   `AGENTS.md` for feature work.
7. **Batch gate**: merge approved branches into fork main, resolve expected
   AGENTS.md touch-conflicts, full suite green, DOX gate green, tag
   `v0.66-fork.N`, push (owner-approved).
8. **Cleanup**: drop lane worktrees, flip this board, re-rank.

## Pre-tag gates (both mandatory)

1. **Code gate** — every suite in `tests/*_test.mjs`, logged to
   `fixes/integration-gateN-<date>.log`. Any failure must be classified
   against the pristine baseline (`fixes/audit-v3-evidence/results_pristine.tsv`)
   and recorded in the log; a green number alone never proves the absence of a
   regression.
2. **DOX gate** — no tracked `AGENTS.md` under 200 bytes, zero conflict
   markers, and every doc file touched on both sides of a merge verified by
   content diff against each parent (sizes alone missed the fork.3 clobber).

## Parallel-lane protocol

- Max 3 lanes at once; parallelize only when target file sets are disjoint.
- Per-lane worktrees at `worktrees/<lane>`; `node_modules` symlinked from the
  main checkout; every test still runs in mkdtemp roots and never mutates
  `app/L1`, `app/L2`, `server/data`, `server/tmp`.
- One work item per branch, always. Conflicting lanes on hub files go serial.
- Subagents get self-contained briefs with the rules restated; they report root
  cause + evidence labels + exact commands/results + files touched.
- Park rule: if a lane sprawls, it parks cleanly with evidence and next
  questions. A clean park is a lane completion, not a failure.
- Investigation lanes (unknown mechanism) run solo and are never launched
  silently. Verification stays sequential — the orchestrator reruns everything.
- **Concurrent sessions share one repo.** Another session may hold a worktree,
  a live Electron, or a full-suite run whose `node_modules` symlinks into the
  main checkout. Never `npm ci` in the main checkout while another session's
  suite is running; never kill processes or delete worktrees you did not
  create. Check `pgrep` and `git worktree list` before either.

## Release line

| Tag | Commit | Content |
| --- | --- | --- |
| `v0.66-fork.1` | `0e3e9d0` | #39/#52, #47, #57, #58, #64 |
| `v0.66-fork.2` | `d74fb2e` | #62, #49 |
| `v0.66-fork.3` | `46c4b2d` | #23 checkpoints, #61 recovery door, G1–G4 self-found; resealed after the DOX-clobber amend |
| `v0.66-fork.4` | `3905174` | rebrand to Constellation Agent |
| `v0.66-fork.5` | `745baa3` | #15 thumbnail/dashboard negative cache |
| `v0.66-fork.6` | `1484eb3` | production dependency audit + container browser harness |
| `v0.66-fork.7` | `f94be65` | desktop connected mode + fork-tag release fix + privacy redaction |

`v0.66-fork.7` was the first **feature** release of the fork (desktop connected
mode) and the first build the owner installed end-to-end: standalone launched,
the chooser listed both modes, the cloud instance signed in over HTTPS, and the
embedded browser worked with full `space.browser` capability.

`v0.66-fork.8` is not cut yet; see *Unreleased since `v0.66-fork.7`* above.

## Batch history

- **Batch 3** — G4 share-tmp fix + G1/G2 suite repairs. Released in `fork.3`.
- **Batch 4** — G3 `/mod/` harness + #61 truncation half. Released in `fork.3`.
- **Batch 5** — #15 404 half (fixed, `fork.5`); #28 + #83 ruled non-defects and
  answered in `fixes/self-host-guidance.md`.
- **Batch 6** — #83 dependency audit + container browser harness (fixed,
  `fork.6`).
- **Batch 7** — desktop connected mode (Lane A tunnel + Lane B feature + Lane C
  docs), the fork-tag release-parser fix, and the private-detail redaction.
  Released in `fork.7` — the fork's first successful desktop release.
- **Batch 8** — doc synchronization into the public repo (with the
  public-document rule), the follow-up DOX pass, and saved-server removal.
  Merged, **not yet released**.

## Parked ladder (no work scheduled)

| Order | Item | Unblock |
| --- | --- | --- |
| 1 | `browser_desktop_harness_test` (1 red) | Owner call on test strictness: hermetic local fixture (preferred), opt-in settle tolerance, or leave red/documented |
| 2 | `packaging/package-lock.json` advisories | 21 advisories in the desktop build toolchain; own lane + electron-builder compatibility check |
| 3 | #15 memory growth | Time-boxed heap-profiling session (headless Chrome snapshots); re-park if inconclusive |
| 4 | #28 residual | Needs a cross-origin **design** decision → idea-crafting input, not a fix |
| 5 | #27/#41/#60 local-LLM + WebGPU | GPU-passthrough VM or owner repro env |
| 6 | #20 Mac desktop crash | Only if it reproduces on 0.66+; the 0.62.0 log is not our code |

## Owner queue (non-blocking)

- Optional: post `fixes/self-host-guidance.md` answers on #83 and #28.
- Optional: post `prs/comment-50.md` goodwill comment as yourself.
- PR phase stays closed — do not resume upstream PR work from this file.

## Rebrand follow-ups

Found during the first end-to-end desktop test of `v0.66-fork.7`, then worked
through in the `rebrand/terminology-cleanup` session.

### Resolved

- **Upstream social and project links are gone.** The dashboard resource row,
  the `/login` and `/enter` shell footer social rows, and their four SVG icons
  were removed outright rather than repointed. `RESOURCE_LINKS` is deleted.
- **Repository identity points at the fork.** `repository.url`, the
  `build.publish` owner (which had been mixed — upstream owner with this fork's
  repo name, i.e. a repository that does not exist), and the release-notes
  default slug all resolve to `IconicFinesse/constellation-agent`.
- **The dead `#host` anchor is fixed.** The login host link pointed at a README
  heading that never existed; it now targets `#run-it-yourself`.
- **`CLOUD_SHARE_URL` no longer defaults to upstream.** It shipped as
  `share.space-agent.ai`, which would have routed hosted space shares to
  upstream's receiver. The default is now empty, which the existing
  `normalizeCloudShareBaseUrl` and `canShareToCloud` guards already treat as
  unavailable: local ZIP export and import are untouched and the hosted button
  stays hidden until a receiver is configured deliberately.
- **Linux maintainer metadata** now names the fork owner. The global `author`
  field keeps Jan Tomasek, so original authorship credit survives.
- **The `space-agent` profile folder is no longer adopted.** Owner decision: the
  fork has no install base to protect yet, so `Space Agent` and `space-agent`
  were dropped from `DESKTOP_LEGACY_USER_DATA_DIRNAMES` rather than migrated.
  `Agent One` and `agent-one` stay, because those are the project's original
  pre-`space-agent` name rather than a `space-agent` reference, and the desktop
  packaging contract still asserts on them. Contract lives in
  `packaging/desktop/server_storage_paths.js`.
- **The Agent Zero video demos are gone.** Both bundled demo spaces streamed
  upstream's YouTube channel, which is an upstream social reference shipped as
  product surface. `compareExamples` only sorts and never filters, so the
  `EXAMPLE_ORDER` entry alone would have left the demo listed last; the example
  trees and the onboarding launcher entry went with it.

### Deliberately left alone

- **Code identifiers** containing the old word. The `normalizeSpace*` family and
  `buildCurrentSpaceAgentInstructionsPromptSection` describe a *space's* agent
  instructions — the domain noun, not the product — so renaming them would make
  the code lie. Confirmed with the owner.
- **Upstream attribution.** README, `PROJECT-THESIS.md`, `DESIGN-PHILOSOPHY.md`,
  `FORK.md`, `LICENSE`, and the `llms` files keep their honest upstream
  references. `Agent One` in the packaged user-data list falls in the same
  category.
- **The eval fixtures.** The ~50 `tests/agent_llm_performance/prompts/*` files
  and the dated `onscreen_agent/prompts/system-prompt.backup-*` snapshots open
  with `you are space agent ...`. They are benchmark inputs and historical
  snapshots; editing them would invalidate existing eval baselines. The live
  system prompt already reads `you are a browser runtime operator`.

### Outstanding: artwork (mapped, not yet replaced)

Every asset below is still upstream artwork. Icons are a separate pass from the
terminology sweep; this list is the marker set so the replacement does not miss
a surface. The new `constellation-agent-icon*` files already sit beside their
`space-agent-icon*` counterparts.

**Page identity** (wired into all six server pages and the PWA manifest):

- `server/pages/res/favicon.ico`
- `server/pages/res/favicon-16x16.png`
- `server/pages/res/favicon-32x32.png`
- `server/pages/res/apple-touch-icon.png`
- `server/pages/res/android-chrome-192x192.png`
- `server/pages/res/android-chrome-512x512.png`

**Desktop packaging** (wired into electron-builder):

- `packaging/platforms/windows/icon.ico`
- `packaging/platforms/linux/icons/` — `16x16`, `24x24`, `32x32`, `48x48`,
  `64x64`, `128x128`, `256x256`, `512x512`, plus `icon.png`

**Superseded sources** (replace, do not layer over):

- `packaging/resources/icons/source/space-agent-icon.png`
- `packaging/resources/icons/source/space-agent-icon-256.webp`
- `packaging/resources/icons/source/space-agent-icon-512.webp`

**Astronaut visual identity:**

- `server/pages/res/astronaut_no_bg.png`, `astronaut_no_bg.webp`,
  `astronaut_green_bg.png`
- `app/L0/_all/mod/_core/visual/res/chat/overlay/astronaut_no_bg.webp`
- `app/L0/_all/mod/_core/visual/res/chat/admin/astronaut_no_bg.png` and `.webp`
- `app/L0/_all/mod/_core/visual/res/engineer/astronaut_red_no_bg.png` and
  `astronaut_red_512h.webp`

**Unreferenced GitHub assets** (safe to drop whenever the artwork pass runs):

- `.github/thumbnail.webp`
- `.github/readme-banner.png`
- `.github/readme-banner.webp`
- `.github/readme-banner-thin.webp`
- `.github/readme-try-live-now.svg`

`.github/readme-banner-thin.svg` is the one that is actually referenced from the
README. Note `server/pages/res/readme-banner.webp` is a *different* file with the
same basename and is the live Open Graph image — do not confuse the two.

### Outstanding: polish

- **Chooser polish:** the window comfortably shows about two saved servers
  before scrolling, and saved servers can only be managed at launch — there is
  no in-app settings surface for them yet.

## Check-in contract

- Per lane: completion + orchestrator rerun → report branch, hashes, evidence
  labels, files touched — and hold for the commit/push call.
- Per batch: gate proposal (merge list, expected AGENTS.md conflicts, tag name)
  — push/tag/merge only on explicit owner go.
- Any lane that finds a root cause disagreeing with the ledger gets flagged at
  the top of its check-in, not buried.
- Decision asks go only to genuinely blocking forks. A check-in with nothing
  blocking ends "nothing needs you yet".

## Maintenance rules for this file

- Flip statuses at every lane transition; refresh the `Updated:` stamp.
- Root-cause or park changes also update `ISSUES.md` in the same session.
- Roadmap-tier changes update `space-agent/ROADMAP.md` in the same session, not
  this file — this board tracks execution, that file tracks product state.
