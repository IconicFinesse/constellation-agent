# Constellation Agent — Project Thesis

**Status:** binding scope decision
**Date:** 2026-10-22
**Supersedes:** any earlier scope guidance that conflicts
**Companion:** `ANALYSIS-space-agent.md` (architecture and design context), `space-agent/FORK.md` (charter and provenance), `ISSUES.md` (work state), `PLAN.md` (execution board)

---

## 1. The Decision

**Constellation Agent is its own project.**

It descends from [Space Agent](https://github.com/agent0ai/space-agent) — that lineage stays visible, and the GitHub fork badge is kept deliberately as a sign of where the bones came from. But the fork is no longer a staging area for upstream pull requests, and it no longer organizes its work around a reviewer who may never appear.

The PR phase closed on 2026-10-22 with 13 issues filed upstream. Those PRs stay open as free lottery tickets — zero cost to leave them, and if a maintainer ever revives upstream and merges them, excellent. No new upstream PRs will be minted except for genuinely general bugs where the fix is already upstream-shaped.

What replaced it:

> **Constellation Agent is the product. Upstream is a source of free fixes.**

The rest of this document is about how to build under that standing.

---

## 2. What the Analysis Established

Six facts from `ANALYSIS-space-agent.md` shape every decision below.

1. **The agent lives in the frontend runtime**, in the same JavaScript realm as the page, modules, and widget renderers it reshapes. This is the system's identity, and the source of its hard limits: no headless operation, no crash isolation, and a page navigation that tears a live turn down (issue #23). The residency/ephemerality tension is structural.

2. **The layer is the permission.** `L0` is firmware and unwritable; `L1` is group-scoped and writable only by managers; `L2` is personal and writable only by its owner. A constitutional order expressed as a directory tree.

3. **The extension system is a theory of legal change.** Seams are named and owned. If a module needs to change another module's behavior, the *owner* exposes a seam instead of the consumer patching internals. There is a legal path for configuration (`ext/panels/*.yaml`), extension (a seam hook), and override (a ranked-layer replacement).

4. **The frontend/backend split is a separation of powers**, and the server holds no agent state. It is an authenticated filesystem with a job runner attached — which is why it scales trivially and why agent work is weakest when it needs durability.

5. **The prompt is load-bearing software.** Behavior lives in prose, so correctness is statistical rather than structural. The 72-case benchmark harness is a genuinely rigorous answer to an inherently soft medium.

6. **Upstream is dormant.** Last upstream commit `10f4ffd` on 2026-06-08; 32 open issues; roughly 20 open third-party PRs.

Fact 6 is why the fork is now the product rather than the staging area.

---

## 3. One Repo, One Product, One Namespace Rule

There is one repository, one `main`, one history. No dual maintenance, no cherry-picking between parallel projects. Upstream is a git remote, nothing more.

Under that model there is exactly one structural rule:

### The namespace rule

> **New capabilities live in `app/L0/_all/mod/constellation/<repo>/` — additive, tracked, never inside `_core`.**

Not because a reviewer is watching. Because additive namespaces are simply better engineering.

**Why `L0` and not `L1`/`L2`:** `app/L1/` and `app/L2/` are fully gitignored — zero tracked files. They are runtime customware, deployment state belonging to a running instance's groups and users. Anything placed there does not ship, does not version, and does not survive a fresh clone. It is the right home for a *user's* customizations and the wrong home for *our* features. A tracked `L0` author namespace is versioned, packaged with desktop builds, routable as `#/constellation/<repo>/...`, and still fully seam-capable.

**Why not `_core`:** three practical reasons, none of them about permission.

1. **Merges.** Every `_core` edit is a future conflict against upstream. Additive code never conflicts. We still want to pull upstream fixes; this keeps that cheap.
2. **Blame.** Our edits scattered through inherited code makes "is this bug ours or inherited?" needlessly expensive.
3. **Upgrades.** A module can be replaced wholesale without touching the firmware beneath it. That is the difference between an upgradeable product and a fork that decays.

A namespace also keeps provenance legible: `mod/constellation/...` is obviously ours, `mod/_core/...` is obviously inherited. Someone reading the tree in two years can tell instantly which work is which.

### The framework principle

Corollary to the namespace rule:

> **Prefer extending the framework to editing it.**

When a feature needs behavior no seam exposes, **add the seam in the owning module.** That is now a maintenance decision rather than a PR obligation: seams are the cheap kind of change, and a project that reaches into `_core` for every feature stops being upgradeable within a year.

Editing `_core` directly is **allowed**. Nothing forbids it. It is the option you take when a seam genuinely cannot express the change — and when you take it, leave a comment saying why, so the next person doesn't assume it was carelessness.

---

## 4. What This Permits Immediately

- **Features as modules** in `constellation/<repo>/` — routes, widgets, panels, skills, prompt extensions — without touching `_core`.
- **Default-on behavior** via `ext/js/` hooks and `ext/html/` adapters composed at existing shell seams, since `L0/_all` is readable by every user on the instance.
- **Our own skills** as `SKILL.md` packs under the module's `ext/skills/`, subject to the same discovery rules as first-party packs.
- **Direct `_core` work** where a seam cannot carry it, with a comment explaining the choice.
- **Upstream pulls** whenever their work is worth taking.
- **Contract freezing** — writing down the interfaces that user data and our modules will depend on, so they can be defended rather than accidentally changed.
- **Gate hardening** — our own checks that fail the build on regressions the inherited suite does not cover.

---

## 5. What This Forbids

Short list, all for cause:

- **Placing product source in `L1`/`L2`.** Those are deployment state and are gitignored; anything there does not ship.
- **Cosmetic pre-building of the frontend.** Layouts, default widgets, and workflow opinions are deferred (§6).
- **Speculative workflow design.** A baseline designed for a workflow that has not been run is a guess, and wrong guesses become cruft.
- **Silent `_core` edits.** If we edit inherited code, the reason gets written down.
- **Pushing to `upstream`.** We read from it. We never write to it, and PRs are no longer our channel.

---

## 6. The Pre-Build Rule: Freeze Contracts, Leave Content Fluid

This resolves the question of how much to build now versus what should emerge from actual use.

The test is not "is this important?" It is: **does this get more expensive to change later?**

### Pre-build and freeze: contracts

Things accumulated user data and our modules will depend on. Change these after a year of use and you are writing a migration.

- **Path conventions** — logical app paths, `~/` shorthand, `CUSTOMWARE_PATH` relocation.
- **Widget storage schema** — `space.yaml` fields, `widgets/<id>.yaml` shape, `renderer` source format.
- **Skill frontmatter** — `metadata.when`, `metadata.loaded`, `metadata.placement` semantics.
- **Extension seam names** — the shell anchors and JS hook points our modules compose against.
- **Runtime namespace surface** — `space.api`, `space.current`, `space.spaces`, `space.browser`, `space.chat`, and the helpers our code calls.
- **Storage locations** — history, memory, prompt includes, customware roots.

These get written down and asserted (§8.3), so drift is a failing test rather than a discovery.

### Wait for use: content

Things that should be discovered by running the system, because knowing them in advance is not realistic.

- Which widgets actually get built and kept.
- Dashboard and space layout defaults.
- Interaction and visual polish beyond the shared system.
- Which workflows are real and which were imagined.
- Any opinion about what the *default* frontend baseline should contain.

The distinction is information, not ambition: contract decisions can be made correctly from architecture knowledge today, while content decisions can only be made correctly from usage data later.

---

## 7. Upstream: When We Pull, When We Diverge

We keep `upstream` (`agent0ai/space-agent`) as a remote permanently. It is a source of free fixes and useful patterns — not a destination, and not a peer we owe anything to.

**Pull when:**

- They ship a fix for a bug we have not touched.
- They add a capability we want and would otherwise rebuild.
- We want a clean base for a feature that upstream has also been developing.

**Diverge when:**

- Our design disagrees. The three most likely places, per the analysis, are durability, headless operation, and multi-client continuity — each foreclosed by upstream's architecture, and each a legitimate reason for our version to be different.
- Upstream is dormant and we need the change now.

**Merge discipline:** every upstream merge runs the full suite before landing. Their tests encode their contracts, not ours — a green upstream gate is evidence, not proof, that the merge is safe for us.

**Deliberate ownership risks to watch**, since we are now the sole maintainer of what our instances run:

- A bug we inherit is now a bug we own.
- Upstream security fixes only reach us when we pull them.
- Our verification floor matters more than it did, not less.

---

## 8. What the Next Phase Ships

Three artifacts. Each is cheap now, expensive later, and exercises the model end to end.

### 8.1 Project legibility surface — `constellation/status`

A module at `#/constellation/status` showing project version, applied fixes, divergence inventory versus `baseline-2026-06-08`, and gate status. It proves the namespace rule works end to end: a tracked module, a real route, a panel manifest, and a seam extension — none of it touching `_core`. It also makes the project's identity visible *in the product* rather than only in `FORK.md`.

### 8.2 DOX integrity gate — automate the existing pre-tag procedure

A pre-tag DOX gate already exists as a **procedure** in `PLAN.md`: no tracked `AGENTS.md` under 200 bytes plus zero conflict markers. That procedure bounded the one regression in the ledger that was ours (Section G item 5), and it was run by hand at gate time.

The remaining work is to **make it a test rather than a habit**:

- move the byte-floor and conflict-marker checks into `tests/` so they run on every suite execution, not only when someone remembers the pre-tag ritual;
- add **shrink detection** — fail when a tracked `AGENTS.md` loses a large fraction of its bytes versus the merge base, which catches a partial clobber that still clears the 200-byte floor;
- keep it project-owned, so it defends the DOX chain without altering inherited files.

Deliberately scoped as automation of something already proven, not new policy.

### 8.3 Public contract freeze — `CONTRACTS.md` + assertions

Write the six frozen contracts from §6 into one authoritative document, and add a test that asserts the names still exist: seam ids resolvable, runtime namespace keys present, widget/skill frontmatter fields accepted, storage paths unchanged. This is the artifact that makes the namespace rule enforceable rather than aspirational — a module that depends on a seam can rely on it being defended.

---

## 9. The One-Line Version

**Build Constellation as its own product: add in `constellation/`, extend before editing, and freeze contracts before content.**

We keep upstream's bones because they are good bones. We keep the fork badge because the lineage is honest. We stop asking permission for our own project.
