# Constellation Agent — Project Thesis

**Status:** binding scope decision
**Date:** 2026-10-22 (revised 2026-10-22, features phase)
**Supersedes:** any earlier scope guidance that conflicts
**Companion:** `ANALYSIS-space-agent-reference.md` (architecture and design context), `FORK.md` (charter and provenance), `ISSUES.md` (bug ledger), `PLAN.md` (execution board), `ROADMAP.md` (product tiers)

---

## 1. The Decision

**Constellation Agent is its own project.**

It descends from [Space Agent](https://github.com/agent0ai/space-agent) — that lineage stays visible, and the GitHub fork badge is kept deliberately as a sign of where the bones came from. But the fork is no longer a staging area for upstream pull requests, and it no longer organizes its work around a reviewer who may never appear.

The PR phase closed on 2026-10-22 with 13 issues filed upstream. Those PRs stay open as free lottery tickets — zero cost to leave them, and if a maintainer ever revives upstream and merges them, excellent. No new upstream PRs will be minted except for genuinely general bugs where the fix is already upstream-shaped.

What replaced it:

> **Constellation Agent is the product. Upstream is a source of free fixes.**

### 1.1 What we are actually building

The analysis states it in one line:

> *Space Agent is not an agent that uses a product. It is a product that an agent inhabits.*

And its sharper form, which is the thesis of this project:

> **The agent is a citizen of the system, not a client of it.**

There is no external vantage point. No schema boundary between thinking and doing. The reasoning text and the JavaScript that acts on the workspace are the same artifact, in the same message, executed in the same realm as the interface it reshapes. `seeWidget()` does not reconstruct what the screen looks like — it reads what the browser painted. **There is nothing to synchronize, because there is no gap.**

Every other agent product holds a representation of your computer and hopes the representation is current. This one stands inside it.

The second half is the split. The server holds no agent state and has no idea an agent exists. That is not an engineering convenience — it is what makes the agent **unhostable**. Its intelligence runs on the user's hardware, on the user's key, against files in layers the user owns. Nobody upstream of that deployment can meter it, throttle it, censor it, or hold it hostage. That stance is structurally unavailable to any cloud agent product, and it is not for sale.

### 1.2 The product shape that follows

If the agent inhabits the workspace, then **the workspace is the product, not the conversation.**

Concretely:

- **The unit of work is the space, not the chat.** Chat is what you do *to* the room. The room is what persists, and what the agent is a resident of.
- **Success is a better workspace**, not a better answer. The measure of a turn is whether the thing you live in improved.
- **Memory is owned text.** `~/memory/*.include.md` lives in the user's own layer and opens in a file editor. No other agent can say that. It is not a feature we added; it is a consequence of the architecture we must not waste.
- **Capability is authored, not trained.** A `SKILL.md` the agent writes is a durable extension of what it can do, in a format a human can read and correct.

### 1.3 Editions: one product, three clients

The agent lives in the client; the server is a thin authenticated filesystem.
That split produces exactly three ways to open the product, and no fourth is
planned:

1. **Server edition (self-hosted, any OS).** The canonical workspace: files,
   auth, job runner — nothing else. Opened from a plain browser tab it gives
   the whole workspace minus one capability: the embedded browser. That is
   permanent and correct signposting, not a defect to fix. Guest-page
   injection is a privilege a desktop webview holds and a sandboxed tab does
   not; no server-side work can move it.
2. **Desktop edition, standalone — the default.** The packaged Electron app
   spawns a local server on loopback. Zero-config for a new user.
3. **Desktop edition, connected.** The same binary pointed at a remote server
   URL instead of a local spawn: same renderer, same agent runtime, same
   embedded browser at full `space.browser` capability, with canonical data
   on the owner's server. One app, two connection modes chosen at launch.

Rules that fall out, binding for future work:

- The embedded browser is a **client capability**. Any server-side browsing
  (headless agent research, a remotely rendered view) is a different project
  that must argue for itself on its own merits — it is never described as
  "parity."
- **Standalone remains the default.** Connected mode adds a
  saved-connection chooser at launch; it never replaces local operation.
- Connections are HTTPS-only outside explicit localhost dev targets; the
  origin is pinned on first connect, with a visible warning if it changes.
- There is no separate hybrid artifact, wire protocol, or server build.
  One server; three clients.

---

## 2. What the Analysis Established

Six facts from `ANALYSIS-space-agent-reference.md` shape every decision below.

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

Under that model there are exactly two structural rules. They are equally binding.

### 3.1 The namespace rule

> **New capabilities live in `app/L0/_all/modules/constellation/<repo>/` — additive, tracked, never inside `_core`.**

Not because a reviewer is watching. Because additive namespaces are simply better engineering.

**Why `L0` and not `L1`/`L2`:** `app/L1/` and `app/L2/` are fully gitignored — zero tracked files. They are runtime customware, deployment state belonging to a running instance's groups and users. Anything placed there does not ship, does not version, and does not survive a fresh clone. It is the right home for a *user's* customizations and the wrong home for *our* features. A tracked `L0` author namespace is versioned, packaged with desktop builds, routable as `#/constellation/<repo>/...`, and still fully seam-capable.

**Why not `_core`:** three practical reasons, none of them about permission.

1. **Merges.** Every `_core` edit is a future conflict against upstream. Additive code never conflicts. We still want to pull upstream fixes; this keeps that cheap.
2. **Blame.** Our edits scattered through inherited code makes "is this bug ours or inherited?" needlessly expensive.
3. **Upgrades.** A module can be replaced wholesale without touching the firmware beneath it. That is the difference between an upgradeable product and a fork that decays.

A namespace also keeps provenance legible: `modules/constellation/...` is obviously ours, `modules/_core/...` is obviously inherited. Someone reading the tree in two years can tell instantly which work is which.

### 3.2 The modularity rule

> **A constellation module is self-contained and independently removable.**

The namespace rule keeps our work separable from inherited work. The modularity rule keeps our work separable *from itself*, because iteration speed is the scarcest resource a small project has and coupling is what destroys it.

Binding form:

- **A module may depend on firmware seams and on the published runtime surface (`space.api`, `space.current`, `space.spaces`, `space.chat`, `space.browser`, `space.utils.*`). It may not import another constellation module's internals.**
- **A module may be deleted, disabled, or replaced without breaking any other constellation module.** If removing module A breaks module B, the dependency is the defect — fix the dependency or expose a seam between them, exactly as `_core` does for its own consumers.
- **Cross-module coordination goes through a seam or the runtime surface**, never through a shared mutable helper file in some `common/` directory. A `common/` directory is undeclared coupling with better manners.
- **Each module ships its own `AGENTS.md`** stating purpose, owned seams, its external dependencies, and what it does when a dependency is missing.

The payoff is concrete: faster iteration (build and test one module without loading the world), safe deletion (a bad idea can be removed cleanly instead of rotting in place), and honest ownership (every piece says what it needs).

This mirrors the inherited architecture on purpose. `_core` proves the discipline works at scale; our modules should be held to the same standard rather than to a looser one because we wrote them.

### 3.3 The framework principle

Corollary to both rules:

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
- **Undeclared coupling between our own modules.** See §3.2. A module that only works when a sibling exists is a design error, not a fact of life.
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

### The feature filters

Every candidate feature answers three questions before it earns roadmap space. A "no" on the first two does not mean the idea is bad — it means the idea belongs to a different product.

1. **Does it need new server authority?** If a feature needs the server to hold agent state, orchestrate a turn, or schedule agent work, it dissolves the constitution that makes the agent unhostable. The answer stays no.
2. **Does it require a capability the residency model cannot honestly provide?** Durable background work and multi-client session continuity are foreclosed. Say so plainly rather than half-building them.
3. **Is this a contract or a content decision?** Contracts are decidable today from architecture knowledge. Content is decidable only from usage. Do not pre-build content.

A useful fourth question for anything that survives: **does it strengthen the workspace-with-an-agent-in-it shape, or does it slip back into chat-with-artifacts?** The second is what everyone else ships.

### Selected governance artifacts

Cheap now, expensive later, and each exercises the model end to end.

#### 8.1 Project legibility surface — `constellation/status`

A module at `#/constellation/status` showing project version, applied fixes, divergence inventory versus `baseline-2026-06-08`, and gate status. It proves the namespace rule works end to end: a tracked module, a real route, a panel manifest, and a seam extension — none of it touching `_core`. It also makes the project's identity visible *in the product* rather than only in `FORK.md`.

This is also the reference implementation of §3.2: the first module doubles as the worked example of what a self-contained constellation module looks like, including its `AGENTS.md`.

#### 8.2 DOX integrity gate — automate the existing pre-tag procedure

A pre-tag DOX gate already exists as a **procedure** in `PLAN.md`: no tracked `AGENTS.md` under 200 bytes plus zero conflict markers. That procedure bounded the one regression in the ledger that was ours, and it was run by hand at gate time.

The remaining work is to **make it a test rather than a habit**:

- move the byte-floor and conflict-marker checks into `tests/` so they run on every suite execution, not only when someone remembers the pre-tag ritual;
- add **shrink detection** — fail when a tracked `AGENTS.md` loses a large fraction of its bytes versus the merge base, which catches a partial clobber that still clears the 200-byte floor;
- keep it project-owned, so it defends the DOX chain without altering inherited files.

Deliberately scoped as automation of something already proven, not new policy.

#### 8.3 Public contract freeze — `CONTRACTS.md` + assertions

Write the six frozen contracts from §6 into one authoritative document, and add a test that asserts the names still exist: seam ids resolvable, runtime namespace keys present, widget/skill frontmatter fields accepted, storage paths unchanged. This is the artifact that makes both structural rules enforceable rather than aspirational — a module that depends on a seam can rely on it being defended.

### Selected feature work

Two features were chosen from a wider idea set because each one compounds rather than decorates, and because each is only possible *here*. Neither requires new server authority. Both are additive modules under §3.1, self-contained under §3.2.

#### 8.4 Capability authoring as the compounding loop

**The shape:** the agent goes from *building the thing you asked for* to *building the capability that builds those things*.

The analysis already names this as the first trajectory the architecture opens: because skills are readable and writable text in a tree the agent can reach, and because the extension system has legal seams, "build me a widget" can become "build me a capability that builds these widgets." The bundled `development` skill tree — seven sub-skills covering app-file APIs, backend reference, extensions and components, the frontend runtime, layers and ownership, modules and routing, and skills — is effectively a curriculum for exactly this.

**Why it was chosen:** content is disposable; capability compounds. A widget helps you once. A skill that produces widgets of a class helps you every time after. That is the difference between an agent that is the tool and an agent that is the colleague.

**Frontend/backend placement:** the authoring loop is browser-side — writing `SKILL.md`, validating frontmatter, reloading the catalog, proving the new capability fires. The server contributes nothing beyond the file APIs it already has. No new endpoint, no new authority.

**What it makes real:** the system's claim that *plain text is the most extensible interface an agent can have*, because the agent already knows how to write it and the discovery layer already knows how to read it.

**Honest constraints, stated up front:**

- Extension lookups are cached in memory, so a newly authored extension file is not live until a refresh. Skill files are re-read on prompt build; extension hooks are not. The feature must be honest about which kind of capability it just created.
- Auto-loaded skill discovery is limited to top-level `ext/skills/*/SKILL.md`; nested skills are explicit-load only. Capability authoring inherits that rule rather than working around it.
- **When should a repeated solution be promoted into a skill?** is a judgement about a real workflow and cannot be designed from architecture knowledge. That part is content, and it is discovered by use.

The promotion-trigger question is also the reason this feature is not purely a build task, which informs sequencing in §8.6.

#### 8.5 A memory surface, not a memory policy

**The shape:** a way to *see, understand, and correct* what the agent remembers and why.

Memory in this system is already the right substance: `~/memory/*.include.md`, plain text, in the user's own layer, readable in a file editor, auto-loaded by a skill that teaches a convention rather than by prompt-builder special-casing. That is an unusually strong foundation, and it is currently invisible.

Every competing product delivers agent transparency as a dashboard over an opaque store: you get categories and confidence scores you cannot inspect or meaningfully edit. Here it can be a **view over files the user already owns** — what it remembers, when it learned it, which space or conversation produced it, and what is currently in the prompt versus merely resident.

**Why it was chosen:** it is a genuine upgrade rather than a new surface bolted on. It makes an existing architectural advantage legible, which is the cheapest kind of value to add and the most durable. It also pays for itself immediately — a user who can read the agent's memory can correct it, and a corrected memory is worth more than a longer context window.

**Frontend/backend placement:** entirely browser-side. The files exist; the file APIs exist; the prompt-include assembly exists. The module reads them, explains them, and offers corrections as file writes. **No new server authority is required for any of it.**

**The part that is contract, and the part that is content:**

- Contract (decidable now): where memory lives, its format, how it is discovered and ordered, and the runtime surface the surface module reads through. This is already fixed by the inherited architecture, so the chosen feature *defends* an existing contract instead of inventing one — a meaningful advantage over building something that needs a new freeze.
- Content (discovered by use): when the agent should write memory on its own, what belongs in memory versus a space's own files, how much is too much, and which memories deserve promotion into skills.

That split is why the read-only half of this feature can ship before a use phase, and the write-behaviour half cannot.

### 8.6 Sequencing — the open decision

Two features are selected. What is not yet decided is their order relative to a real use phase. The argument on the table:

1. **Memory surface, read side, first.** Days of work, no new contract, self-contained module. Without it a use phase cannot observe the very thing it exists to judge — what the agent remembers and whether it is right.
2. **Then a structured use phase** with a written findings log: what hurt, what was missing, what got reached for. This produces the content the pre-build rule says cannot be invented (§6).
3. **Then capability authoring and the memory write conventions**, driven by that log rather than guessed in advance.

Why not bare use first: findings without a memory surface reduce to "I wish it remembered things," which rediscovers decisions already recorded here. Why not both features first: the promotion trigger in §8.4 is a judgement about a workflow nobody has run yet.

**Status: open.** Recorded in `PLAN.md` as the phase's blocking decision. No lane starts until the owner calls it.

---

## 9. The One-Line Version

**Build Constellation as a workspace with an agent resident in it: add in `constellation/`, keep every module self-contained, extend before editing, and freeze contracts before content.**

We keep upstream's bones because they are good bones. We keep the fork badge because the lineage is honest. We stop asking permission for our own project.
