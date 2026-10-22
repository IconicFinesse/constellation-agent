# SpaceAgentFork

Fork of [agent0ai/space-agent](https://github.com/agent0ai/space-agent) under [IconicFinesse/constellation-agent](https://github.com/IconicFinesse/constellation-agent).

## Thesis

**The fork is a layer, not a hard fork.** Full decision record:
[`../FORK-THESIS.md`](../FORK-THESIS.md).

One sentence: *fix upstream-shaped, build fork-shaped, and freeze contracts
before content.*

- **Register A** — every file that exists in `upstream/main`. Upstream-shaped,
  minimal, PR-mergeable. The bug phase lives here.
- **Register B** — a fork-owned tracked namespace at
  `app/L0/_all/mod/spaceagentfork/<repo>/`. No upstream restraint applies
  because it cannot appear in a PR diff. This is where fork features live.
- Escalation to a hard fork is **trigger-gated**, never achieved by drift.
  See FORK-THESIS.md §7 for the four triggers.

## Baseline

- Forked from upstream `main` at commit `10f4ffdaf50a8136cf8450d17c11286178fd58e6`
  ("Introduce DOX documentation system", 2026-06-08).
- Local tag `baseline-2026-06-08` marks the pristine upstream state. All
  SpaceAgentFork work diverges from that commit; diffs against the tag define
  our total divergence at any time.
- Upstream had been dormant ~4.5 months at fork time. If it revives: cherry-pick
  or merge is judged per-change against this baseline tag.

## Remotes

- `origin` — IconicFinesse/constellation-agent (ours; releases ship from here)
- `upstream` — agent0ai/space-agent (kept forever; fetch before any merge work)

## Divergence Policy

- Working area for fork development: `app/L0/` firmware (primarily
  `app/L0/_all/mod/_core/`), `server/`, `commands/`, `packaging/`, and `tests/`.
- Runtime data (`L1/`, `L2/`, `server/data/`) is user state: never hand-patched,
  never committed. Generated only through live use or deliberate test fixtures.
- Prefer changes that stay merge-friendly: additive modules/skills over deep
  surgery when the outcome is equal. Exact-duplicate keys across layers replace
  upstream entries — use that override model instead of editing first-party
  files when a layered override can express the change.
- Upstream's 60 open issues are the seed backlog for "make the base better":
  real-user pain beats speculative refactoring.
- Fixes that upstream would want belong on clean branches suitable for PRs
  back upstream. Fork-only features live in fork-named branches
  (`fork/<topic>`).
- Commit discipline: every edit to the fork lands through git. We are the
  firmware vendor for downstream instances (local and UmbrelOS); those instances
  update via git/release, never hot-patching live L0.

## Verification Floor

- Repo test suite (`tests/`) must pass before any change lands on `main`.
- Behavior-affecting agent changes additionally run the
  `tests/agent_llm_performance` harness.
- Smoke check for runtime changes: `npm run dev` or `node space serve` boots,
  auth works, module serving and app-file APIs respond.

## License

MIT, per upstream. The original copyright notice stays in `LICENSE` and in
forked source headers wherever upstream carries one.

## Update Flow (downstream instances)

1. Land work on a `fork/*` branch, verify, merge to `main`.
2. Tag releases (`v0.x+fork.N` unless rebranding says otherwise).
3. Downstream instances (container test instance, UmbrelOS VM) run
   `node space update` style flows or git pulls against `origin`; their L1/L2
   state is expected to survive every update untouched — the same contract
   upstream gave its users, now given by us.
