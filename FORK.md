# Constellation Agent — Fork Charter

Fork of [agent0ai/space-agent](https://github.com/agent0ai/space-agent) under [IconicFinesse/constellation-agent](https://github.com/IconicFinesse/constellation-agent).

## Thesis

**Constellation Agent is its own project.** Full decision record:
[`PROJECT-THESIS.md`](PROJECT-THESIS.md).

One sentence: *build Constellation as its own product — add in
`constellation/`, extend before editing, and freeze contracts before content.*

- New capabilities live in `app/L0/_all/mod/constellation/<repo>/`: additive,
  tracked, shippable. Not in the gitignored `L1`/`L2` runtime layers.
- Prefer extending the framework over editing inherited `_core` code. Direct
  `_core` work is allowed when a seam cannot carry it — leave a comment why.
- Upstream (`agent0ai/space-agent`) is a permanent remote and a source of free
  fixes. It is not a destination, and no new upstream PRs are filed.

## Baseline

- Forked from upstream `main` at commit `10f4ffdaf50a8136cf8450d17c11286178fd58e6`
  ("Introduce DOX documentation system", 2026-06-08).
- Local tag `baseline-2026-06-08` marks the pristine upstream state. All
  Constellation work diverges from that commit; diffs against the tag define
  our total divergence at any time.
- Upstream had been dormant ~4.5 months at fork time. If it revives: cherry-pick
  or merge is judged per-change against this baseline tag.

## Remotes

- `origin` — IconicFinesse/constellation-agent (ours; releases ship from here)
- `upstream` — agent0ai/space-agent (kept forever; fetch before any merge work)

## Divergence Policy

- Primary development home: new features as modules under
  `app/L0/_all/mod/constellation/<repo>/`. Inherited firmware (`_core`),
  `server/`, `commands/`, `packaging/`, and `tests/` are worked on directly
  when a feature genuinely belongs there.
- Runtime data (`L1/`, `L2/`, `server/data/`) is user state: never hand-patched,
  never committed. Generated only through live use or deliberate test fixtures.
- Prefer changes that stay merge-friendly: additive modules/skills over deep
  surgery when the outcome is equal. Exact-duplicate keys across layers replace
  upstream entries — use that override model instead of editing first-party
  files when a layered override can express the change.
- Upstream's 60 open issues are the seed backlog for "make the base better":
  real-user pain beats speculative refactoring.
- The upstream PR phase closed 2026-10-22 (13 issues filed); those PRs stay
  open as free lottery tickets. No new upstream PRs except genuine general
  bugs where the fix is already upstream-shaped.
- Feature work lands on `fork/<topic>` branches.
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
