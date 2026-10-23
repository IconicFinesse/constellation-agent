# SpaceAgentFork — Upstream Issue Manifest

Master ledger of upstream (agent0ai/space-agent) GitHub issues vs. our fork's
work state. Snapshot taken 2026-10-21 22:50 MST (upstream dormant since
2026-06-08, commit `10f4ffd`, our baseline tag `baseline-2026-06-08`).

Referenced evidence files under `fixes/` and `prs/` live in the maintainer's
local checkout and are not tracked in this repository.
Re-verified 2026-10-21 23:15 MST: upstream still dormant; all 32 open issues
accounted for below; no new arrivals.

**How to use this file:** it is the session-independent index. Detail lives in
`fixes/issue-<N>.md` (per-issue root cause + verification), PR bodies in
`prs/issue-<N>.md`, goodwill/comment drafts in `prs/comment-<N>.md`, and the
fix-work log in `fixes/README.md`. The dynamic execution plan (batch
composition, lane statuses, check-in protocol) is `PLAN.md`. New sessions:
read this file + `PLAN.md` + `space-agent/FORK.md` +
`space-agent/PROJECT-THESIS.md`, run `git fetch
upstream main` to check for upstream movement, then pick work.

**Precedence:** `PROJECT-THESIS.md` governs scope decisions (what belongs in
the project at all). Where this ledger and the thesis disagree on scope, the
thesis wins. Architecture and design context live in
`ANALYSIS-space-agent.md`.

**PR phase closed 2026-10-22.** This ledger remains the record of upstream
issues we fixed and the state of the 13 filed PRs. It is no longer a queue for
minting new upstream PRs.

## Our PR map (upstream)

| Upstream PR | Fixes issue | Branch | State |
| --- | --- | --- | --- |
| #84 | #47 provider transport | `fix/issue-47-provider-transport` | open |
| #85 | #58 cleared Params persistence | `fix/issue-58-prompt-defaults-reload` | open |
| #86 | #57 space import 500 | `fix/issue-57-space-import-500` | open |
| #87 | #64 files download | `fix/issue-64-files-download` | open |
| #88 | #39 (+ covers #52) auth-key mismatch | `fix/issue-39-auth-key-mismatch` | open |
| #89 | #23 admin-kills-agent (history-loss half) | `fix/issue-23-admin-kills-agent` | open (owner-opened) |
| pending | #62 talkie box width | `fix/issue-62-talkie-box-width` | merged + released (fork.2); body `prs/issue-62.md`; **awaiting owner to open PR** |
| pending | #49 Web Crypto gate | `fix/issue-49-web-crypto-http` | merged + released (fork.2); body `prs/issue-49.md`; **awaiting owner to open PR** |
| pending | #61 long-message recovery door | `fix/issue-61-widget-truncation` | merged + released (fork.3); body `prs/issue-61.md`; **awaiting owner to open PR** |

## Fork releases

- `v0.66-fork.1` — first integration release: #39, #52, #47, #57, #58, #64 (88 tests green)
- `v0.66-fork.2` — adds #62, #49 (92 tests green) — fork main @ `d74fb2e`
- `v0.66-fork.3` — **RELEASED + RESEALED 2026-10-22**: fork main `46c4b2d`
  (amended from `c803b76` to repair the Section-G item 5 DOX clobber), tag
  re-released on origin; gate **138/138 across 35 suites** (first seal:
  `integration-gate3-2026-10-22.log`; re-gate after the amend:
  `integration-gate3b-2026-10-22.log`). Adds #23 checkpoints (PR #89), #61
  recovery door, G3 `/modules/` loader, G1+G2 suite repairs, G4 share tmp-dir.
  Integrity audit: **zero suite regressions** vs upstream baseline; doc
  regression found + fixed same session — `fixes/integrity-audit-v3.md` +
  post-audit addendum.
- `v0.66-fork.4` — rebrand release: fork main `3905174` (SpaceAgentFork →
  Constellation Agent; remotes, README, CLI help, manifest, update/install
  URLs). Baseline for all post-rebrand work.
- `v0.66-fork.5` — **RELEASED 2026-10-22**: fork main `745baa3`, tag verified
  on origin (peeled to `745baa3`). Adds #15 thumbnail/dashboard negative cache
  (`fix/issue-15-thumbnail-negative-cache`, `1b0dc1d` + docs `e4a3064`).
  Gate `fixes/integration-gate5-2026-10-22.log`: 52 suites, 191 tests,
  **184 pass / 7 fail**, and all 7 are class-identical pre-existing browser
  harness failures on pristine (`browser_address_bar`, `browser_content_format`,
  `browser_desktop_harness`) — **zero regressions**. DOX gate green (53 tracked
  `AGENTS.md`, none under 200 bytes, no conflict markers).
  **This closed the bug-fix phase at the time** — reopened same day for the
  harness and dependency gaps below, then closed again at `v0.66-fork.6`.
  Correction to that entry's "7 fail": six of those seven were red only
  because `electron` was never installed in `packaging/node_modules`; see
  `fixes/browser-harness-container.md`.
- `v0.66-fork.6` — **RELEASED 2026-10-22**: fork main `1484eb3`, parent
  `63d56dc` (rebrand README/roadmap landed concurrently by another session).
  Two lanes merged: **#83 dependency audit** (`fix/dependency-audit`,
  `a04f05a` — `npm audit fix` clears all 5 high production advisories,
  post-fix audit 0 vulnerabilities) and **container browser harness**
  (`fix/browser-harness-container`, `ca30361` + docs `9b032a9` —
  `--disable-dev-shm-usage` for 64 MB `/dev/shm`; 6 of 7 previously-red
  browser tests now execute and pass). Gate
  `fixes/integration-gate6-2026-10-22.log`. Remaining red:
  `browser_desktop_harness_test` alone — non-hermetic live-novinky scenario,
  documented in `fixes/browser-harness-container.md` with unblock options.

## Community PR watchlist (upstream, not ours)

Upstream sits on ~20 open third-party PRs — part of the dormant-maintainer
picture. Ours-adjacent ones:

- PR #53 (2026-05-01) `fix(supervise): share auth keys between supervise and
  user create` — behavioral sibling of our #39/PR #88 diagnosability approach;
  complementary if upstream revives. Watch only.
- PR #69 / #70 (2026-05) `fix(agent-prompt)` truncation-cut stability —
  ruled 2026-10-22 during #61 work: adjacent (prompt-cache stability),
  DIFFERENT mechanism than the broken recovery door; neither ported
  (`fixes/issue-61.md`).
- Verified 2026-10-21: our PR #87 does not touch
  `server/lib/share/service.js`, so the G4 fix below has a clear standalone
  lane.

---

## A. Fixed in this fork (verified, fails-pristine/passes-fix, pushed)

| Issue | Title (short) | Cluster | Fixed by | Log | On fork main |
| --- | --- | --- | --- | --- | --- |
| #39 | Supervisor/CLI auth_keys split → silent login failure | A | PR #88 | `fixes/issue-39.md` | yes (fork.1) |
| #52 | `space user create` seals with unreadable keys | A | covered by #39 fix | (joint) | yes (fork.1) |
| #47 | Non-OpenRouter providers `JSON.parse` error — **owner's own issue** | B | PR #84 | `fixes/issue-47.md` | yes (fork.1) |
| #57 | Space zip import → 500 | C | PR #86 | `fixes/issue-57.md` | yes (fork.1) |
| #58 | `temperature:0.2` resurrects after reload | C | PR #85 | `fixes/issue-58.md` | yes (fork.1) |
| #64 | Files → download broken on read-only installs | C | PR #87 | `fixes/issue-64.md` | yes (fork.1) |
| #62 | Talkie box grows unboundedly wide | C | merged (fork.2); PR body ready | `fixes/issue-62.md` | yes (fork.2) |
| #49 | Web Crypto dead-ends plain-HTTP self-hosters | C | merged (fork.2); PR body ready | `fixes/issue-49.md` | yes (fork.2) |
| #23 | Admin open kills running agent — **history-loss half** fixed | C | PR #89 | `fixes/issue-23.md` | **yes (fork.3)** |
| #61 | Time Travel mid-widget truncation — broken recovery door (truncation half) | C | merged (fork.3); PR body ready | `fixes/issue-61.md` | **yes (fork.3)** |
| #15 | Repeated 404 probes for absent thumbnails + `dashboard.yaml` (**404 half only**) | C | merged (fork.5) | `fixes/issue-15.md` | **yes (fork.5)** |

## B. Addressed but not code-fixed (docs/comments)

| Issue | Why not code | Our artifact |
| --- | --- | --- |
| #50 | Agent-created user can't log in — same root class as #39 (CLI sealed with divergent keys); fix is our #39 work upstream | goodwill comment with re-seal workaround drafted at `prs/comment-50.md` — **awaiting owner approval to post** |
| #56 | LM Studio pain — specific `temperature:0.2` complaint inside is exactly our #58 fix; remainder is per-model config guidance | noted in `fixes/issue-58.md`; no separate work unless upstream wants a docs-only PR |
| #61 | Time Travel widget truncation — truncation half **FIXED 2026-10-22**: broken recovery door (see `fixes/issue-61.md`); patching-helper half remains feature work → idea-crafting | PRs #69/#70 read and ruled adjacent (cache-stability) — different mechanism, neither ported |
| #23 (other half) | Task-kill on same-tab admin navigation is architectural (browser-resident loop) | recorded as known limitation + idea-crafting candidate in `fixes/issue-23.md` |

## C. Parked bugs — need hardware/env we don't have

| Issue | Blocker |
| --- | --- |
| #20 | Mac desktop crash — **diagnosed from the attached log 2026-10-22**: V8 `ThreadIsolation::MakeExecutable` SIGTRAP in Space Agent **0.62.0**, x86-64 translated under Rosetta on macOS 26.3.1. Four releases before our baseline — not our code; the answer is "upgrade first". An owner Mac run is only needed if it reproduces on 0.66+ |
| #27 | Local LLM broken on self-host — ONNX/WebGPU; needs local-model test env |
| #41 | OrtRun WebGPU pipeline failure — hardware-specific, needs repro env |
| #60 | Local model error (Chrome/Mac M4) — hardware + screenshot-only report (screenshot could not be read here; PIL unavailable) |
| #28 | `browser-controls` vs browser widget cross-origin — **ruled 2026-10-22: NOT a defect.** `browser-control` is a `SKILL.md` with no JS; automation runs through the Electron desktop bridge (`packaging/desktop/main.js:482`), which is origin-immune. The reporter's error is their own `iframe.contentDocument` access. Answer material in `fixes/self-host-guidance.md` §28 |
| #15 | Browser-tab memory growth — **404 half FIXED + released (fork.5)**; the memory-growth half stays parked and needs a time-boxed heap-profiling session |

## D. Feature requests → idea-crafting backlog (not bugs)

#21 (workspace zoom), #42 (model discovery), #51 (Claude/Gemini OAuth — note:
upstream PR #59 exists for Claude subscription auth), #63 (Codex provider —
cf. upstream PR #22), #67 (initial git support), #75 (Nix flake), #81
(OrcaRouter provider proposal), #46 (dockerfile/docker hub image).
#83 — **ruled 2026-10-22: guidance, not a defect.** The EROFS claim was
checked: the only `.env` writer in the tree is `writeDotEnvValue`, reached
solely from `node space set` (`commands/lib/server_config.js:36`); no server,
bootstrap, or HTTP path writes it. Answer material for all four questions
(persistence paths, read-only root, reverse proxy, dependency audit) is in
`fixes/self-host-guidance.md` §83. Notable finding: 5 high **production**
advisories (`brace-expansion@2.1.0`, `lodash@4.17.21`, `js-yaml@4.1.1`,
`electron-updater`, `builder-util-runtime`), `npm audit fix` available and
**not applied** — that needs its own validated lane.

## E. Not actionable / upstream-side

- #26 — opinion thread ("waste of time"), no defect to fix
- #43 — "slop app dashboard?" — no action
- #78 — "model issue" — report too vague; default model cache behavior
- #80 — space-agent.ai TLS certificate expired — **resolved upstream: cert
  renewed, valid through 2026-12-28** (TLS probe 2026-10-21). No work item;
  optional goodwill note only.

## F. Closed upstream (pre-fork history, for context)

#5 (LM Studio/Ollama ask), #7 (self-host login), #9 (chat 404), #10 (JSON
parse error — a cousin of our #47 fix), #16 (npm vulns via nodegit, since
removed), #18 (agent quality), #19 (desktop perf), #36 (closed thread), #40
("invalid username or password" — same family as #39), #54 (chat 401 user
not found). Families recur; our fixes address the live instances.

## G. Self-found work (not filed upstream — candidates for our own PRs)

1. `tests/set_command_test.mjs` — hardcoded `/workspace/agent-one` path →
   ENOENT; fails on pristine main. **Fixed (Batch 3, 2026-10-22)** on
   `fix/test-suite-repairs` (`cc7cc24`) — test-side defect: mkdtemp-staged
   workspace root; 5/5 green (pristine exit 1 verified by orchestrator).
2. `tests/router_cache_headers_test.mjs` — `res.once is not a function`;
   fails on pristine main. **Fixed (Batch 3, 2026-10-22)** on
   `fix/test-suite-repairs` (`a0a79c2`) — test-side stub defect (product
   `res` is a real `http.ServerResponse`); Writable-backed mock; 3/3 green.
3. `/modules/` ERR_MODULE_NOT_FOUND test class (`onscreen_agent_prompt_shape_test`
   and 3 siblings) — **Fixed (Batch 4, 2026-10-22)** on `fix/mod-import-harness`
   (loader `53e6638`, docs `a8ac6d5`): tests-side `node:module` resolve hook maps
   `/modules/...` onto `app/L0/_all/modules/...`; register + dynamic import in the 4
   suites. Pristine 4× exit 1 (ERR_MODULE_NOT_FOUND) → fixed 14/14 green;
   standalone port, zero #58 leakage. **DONE — merged + released (v0.66-fork.3); owner PR body ready.** (`prs/mod-import-harness.md`).
4. `server/lib/share/service.js:338-339` — share/import temp work still stages
   in hardcoded `server/tmp` — actual staging site `:326-327` in the `10f4ffd`
   tree (same defect class as #64). **Fixed (Batch 3, 2026-10-22)** on
   `fix/share-service-tmp-dir` (fix `e49f142`, docs `7937893`): resolved
   `tmpDir` now forwarded bootstrap→request handler→API context, share service
   stages under `options.tmpDir || server/tmp`; regression fails-pristine
   exit 1 → passes-fix exit 0 + unprivileged runtime repro 500→200. Standalone
   companion of PR #87 (lane verified clear). **DONE — merged + released (v0.66-fork.3); owner PR body ready.**
   (body `prs/share-service-tmp-dir.md`).
5. **DOX clobber — `server/AGENTS.md` + `server/lib/share/AGENTS.md` emptied
   by merge `c803b76`** (2026-10-22, fork-caused, NOT upstream-reportable).
   **FOUND AND FIXED same session.** Both were tracked as `e69de29` (git's
   empty-blob hash); not gitignored; no generator exists
   (`server/jobs/job_registry.js:8` merely lists the name in a job-discovery
   ignore list). First-parent history: 27,442 / 5,025 bytes at `9fe24f6` →
   0 / 0 at `c803b76` — an orchestrator-side doc-union pass that resolved to
   the empty side, which green code gates never caught because they do not
   inspect doc contents.
   **Repair lesson (kept for future clobber events):** the fix was a UNION,
   not a restore. Do not `git checkout fix/<branch> -- <doctored file>`: those
   branch copies descend from pristine `upstream/main` and predate main's own
   later doc work, so restoring them regresses it. The branch version of
   `server/AGENTS.md` dropped resolved-temp-root language `9fe24f6` already
   had (lines 70/72/129) while adding the hosted-share-extraction clause, and
   the branch version of `server/lib/share/AGENTS.md` still claimed ZIP
   extraction shells out to host `unzip` — contradicting main's `8ba3e39`
   in-process `zlib` contract and its `400` semantics. Correct base is always
   current-main content with only the branch's genuine additions layered in.

   RESOLVED (2026-10-22, orchestrator amend):
   `c803b76` → `46c4b2d` (same parents `9fe24f6` + `7937893`). Both files
   restored as verified 3-way unions over base `10f4ffd`:
   `server/AGENTS.md` 27,442 → 27,777 bytes;
   `server/lib/share/AGENTS.md` 5,025 → 5,489. Machine-checked
   side-completeness: every line each side added across the campaign
   survives in the restored files (ours 4 + 3, theirs 1 + 3; zero missing).
   Hallmarks confirmed: G4 `resolved runtime temp root` language AND #57
   in-process `zlib` validation + CRC/400 semantics all present. New pre-tag
   **DOX gate** green (all tracked `AGENTS.md` above 200 bytes, zero
   conflict markers), full 35-suite re-gate **138/138**
   (`integration-gate3b-2026-10-22.log`), tag moved to `46c4b2d` and
   re-released on origin under the standing sync instruction. Root cause on
   record: the merge helper ran a doc-union pass against empty `:2:`/`:3:`
   stage extracts for files git had already auto-merged, then committed the
   blank `merge-file` output into the release — the guard below is now part
   of every pre-tag gate.
6. **First-run account state — a fresh multi-user install dead-ends at
   `/login`** (self-found 2026-10-22 bringing up a self-hosted C-A instance on
   umbrelOS behind a private-network endpoint). Symptom: every login
   attempt answers `Invalid username or password`, and no account-creation
   path exists anywhere in the browser. Root cause: the auth store held only
   `auth_keys.json` — zero users. `/login` is a password form with no signup,
   `ALLOW_GUEST_USERS` defaults to `false`, and the only supported bootstrap is
   the README's `node space user create`, so the credential error was literally
   correct but actively misleading: it blamed a password for an account that
   had never existed. **Fixed (2026-10-22)** on fork `main` (fix `78834e3`,
   docs `856fa1f`, pushed to origin and deployed to the guest): `user_files.js`
   gains the read-only `hasAnyPasswordUser()` probe; `pages_handler.js` injects
   a derived `HAS_USERS` meta on `/login` only, as deployment state rather than
   a `params.yaml` runtime param, and `router.js` forwards `projectRoot` so it
   can; `createLoginChallenge` names the `node space user create` bootstrap
   path instead of a credential error, but only while zero accounts exist, so
   usernames stay unenumerable once one account is present; `server.js` logs an
   `[auth]` first-run notice; the login shell explains the state in its existing
   status region. Verification: new `tests/first_run_account_state_test.mjs`
   fails on pristine (no `HAS_USERS` meta → expected `false`, actual `''`) and
   passes on the fix; auth/page suite sweep 18/18; deployed at `856fa1f` with
   the live `/login` emitting `HAS_USERS=true`.
   **DONE — pushed + deployed.**

   Two operational findings carried forward:

   - The group index is in-memory, so a CLI-created user reads `groups: []`
     until the service restarts and `_admin` does not apply on a live instance
     until then. Not code-fixed here; restart after adding users.
   - A CLI password reset invalidates `metadata/user_crypto.json` by design (an
     admin reset cannot rewrap a browser-owned key), but that state is
     terminal: `createLoginChallenge` only offers a provisioning share for
     `missing`, and `/api/user_crypto_bootstrap` returns early unless the state
     is `missing`. The account signs in with encrypted values loading empty and
     no path back to a ready key. Harmless on this instance (brand-new account,
     no encrypted data), so the invalidated record was deleted to restore
     first-run provisioning. **Open gap — give `invalidated` a recovery path.**
## Session conventions (carried forward)

- One issue per fix branch; cut from pristine `upstream/main` — NEVER fork main
  (fork main carries merges + FORK.md; upstream PR diffs must stay pristine).
- Never push/PR upstream without explicit owner approval in-session. Owner
  opens upstream PRs personally via compare URLs (fine-grained PAT cannot
  open cross-repo PRs — GitHub limitation).
- Every fix: reproduce first, fails-pristine/passes-fix regression test,
  orchestrator independently reruns everything, DOX pass inside the repo
  (AGENTS.md hierarchy is binding), fix log in `fixes/`, PR body in `prs/`.
- Developer subagents do the deep work; park anything time-heavy — a clean park
  with evidence beats a sprawling PR.
- Tests run in os.tmpdir() mkdtemp roots only; checkout `app/L1`, `app/L2`,
  `server/data`, `server/tmp` are never mutated.
- Upstream dormant: re-check `git fetch upstream main` each session.

## Work queue — ranked by ease × importance (re-ranked 2026-10-22)

Squash slate for the next batch — one developer subagent each, pristine branch
from `upstream/main`, park anything that sprawls. Live lane statuses live in
`PLAN.md` (the dynamic board); this queue holds order + outcomes.

1. **G4 share-tmp fix** (`server/lib/share/service.js:338-339`) — ease
   ★★★★★ / impact ★★★★. **DONE (Batch 3)** — `fix/share-service-tmp-dir`
   (`e49f142` + docs `7937893`); log `fixes/share-service-tmp-dir.md`; body
   `prs/share-service-tmp-dir.md`. **DONE — merged + released (v0.66-fork.3); owner PR body ready.**
2. **G1+G2 test repairs** (`set_command_test` hardcoded workspace path,
   `router_cache_headers_test` `res.once`) — ease ★★★★★ / impact ★★★.
   **DONE (Batch 3)** — both defects test-side; `fix/test-suite-repairs`
   (`cc7cc24`, `a0a79c2`); 5/5 + 3/3 green; log `fixes/test-suite-repairs.md`;
   body `prs/test-suite-repairs.md`. **DONE — merged + released (v0.66-fork.3); owner PR body ready.**
3. **#61 truncation half — bounded probe** — ease ★★★ / impact ★★★★★. AI
   sees truncated widget source after Time Travel and can't patch; reporter
   calls it critical for local models. Read upstream PRs #69/#70 first,
   reproduce the mechanism, then minimal fix or park. **DONE (Batch 4, solo foreground)** — root cause: the placeholder documented a
   recovery call that provably could not fetch the removed middle (hardcoded
   head reread [0,10000)). Fix `b533299` + docs `0a9791e` on
   `fix/issue-61-widget-truncation`, pushed to origin; regression 5/5
   (pristine 4/5 failing) + 7 adjacent suites green. PRs #69/#70 ruled
   adjacent, different mechanism, neither ported. Log `fixes/issue-61.md`;
   body `prs/issue-61.md`. **DONE — merged + released (v0.66-fork.3); owner PR body ready.**
4. **G3 `/modules/` import harness** — ease ★★★ / impact ★★★★. **DONE (Batch
   4)** — `fix/mod-import-harness` (`53e6638` + docs `a8ac6d5`); 4 suites
   ERR_MODULE_NOT_FOUND → 14/14 green; log `fixes/mod-import-harness.md`;
   body `prs/mod-import-harness.md`. **DONE — merged + released (v0.66-fork.3); owner PR body ready.**
5. **#28 browser-controls** — **DONE (Batch 5, 2026-10-22): NOT a defect.**
   `browser-control` is a `SKILL.md` only; automation runs through the Electron
   desktop bridge (`packaging/desktop/main.js:482`), which is origin-immune.
   The reporter's error is their own `iframe.contentDocument` access. Answer
   material in `fixes/self-host-guidance.md` §28.
6. **#83 EROFS** — **DONE (Batch 5, 2026-10-22): NOT a defect.** No server
   path writes `/app/.env`; the only writer is the CLI `set`. Answer material
   in `fixes/self-host-guidance.md` §83.
7. **#15 404 half** — ease ★★★★★ / impact ★★★. **DONE (Batch 5, 2026-10-22)**
   — `fix/issue-15-thumbnail-negative-cache` (`1b0dc1d` + docs `e4a3064`);
   root cause corrected mid-lane to the unconditional sibling delete probes;
   6/6 + 4/4 regression (pristine 0/6 and 2/4). **Merged + released
   (v0.66-fork.5)**; log `fixes/issue-15.md`. **BUG-FIX PHASE CLOSED.**

Owner queue (no dev work): **open 6 upstream PRs** (bodies ready in `prs/`):
issue fixes **#62, #49, #61** + self-found **share-service-tmp-dir,
test-suite-repairs, mod-import-harness**; post `comment-50` as yourself;
optional goodwill note on #80. Releases current through `v0.66-fork.3`
(resealed at `46c4b2d`); audit + post-audit addendum:
`fixes/integrity-audit-v3.md`.

Verification stretch (independent, any time): UmbrelOS VM on fork main →
live-verify PR #84's mislabeled-SSE theory against the synthetic.new endpoint.

Stays parked: #15 (heap-profiling session), #20/#27/#41/#60 (hardware),
#23 task-kill architecture + section-D features (idea-crafting).
