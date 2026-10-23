# Design Philosophy — Borrowed Principles for Constellation

Provenance: distilled from the upstream creator's public launch interview for Space Agent, then mapped onto this tree. Attribution to upstream `agent0ai/space-agent` (MIT) only; this document deliberately contains **no biography, no anecdotes, and no unsourced metrics**. The interview is treated as a source of *hypotheses*, and every hypothesis carries a code anchor or an explicit label saying it lacks one.

**Verification labels used below**

| Label | Meaning |
| --- | --- |
| `inspection-proven` | A code anchor exists in this tree and was read. |
| `interview-derived` | Design intent stated in the interview; not independently verified here. |
| `inferred` | Follows from the above two; not directly observed. |

**How to use this document.** When making a design decision, find the principle it touches and read the *Cost* line. Every principle here is a trade, not an absolute — the cost lines are what stop us from quoting philosophy as if it were a decision.

---

## 1. Residency decides capability

An agent can only reshape the layers it actually lives in. An agent on a VPS behind a messaging API can change the backend but is imprisoned by the chat interface; an agent in the browser runtime can mutate the page it is displayed on. Decide what the agent should be *able to change*, then choose where it lives — not the other way round. This is the load-bearing difference between the two products under our license: Agent Zero runs autonomously in a container; Space Agent runs with the user on the page.

- Anchor: `inspection-proven` — the loop and prompt assembly are browser-resident (`app/L0/_all/mod/_core/onscreen_agent/`), while `server/` is thin infrastructure.
- Cost: residency in the browser ties the run lifetime to the page and forfeits OS access, background jobs, and clean server-side IPs.

## 2. Two social contracts

An agent's autonomy setting is a *social* decision, not a technical one. A background agent must never stop to ask, because nobody may be there to answer — so it continues and fails silently. A front-of-house agent must ask rather than fail, because the human is right there — captcha, login, ambiguous intent. Same house, opposite rules. Confusing the two is how you get an agent that either nags from a cron job or guesses wrong in front of you.

- Anchor: `inspection-proven` — the admin/onscreen and background-capable surfaces are distinct page contexts with distinct prompt assemblies; the admin shell clamps module resolution (`space-max-layer=0`).
- Cost: two contracts means two prompt/tooling surfaces to maintain and no single "agent behaviour" answer.

## 3. Protocol minimalism

Every token spent on ceremony is a token not spent on work. End a turn with plain text — no response envelope, no JSON wrapper, no mandatory tool call. Open an execution block with the smallest possible marker. The protocol should be as close to *nothing* as correctness allows, because the protocol tax is paid on every single turn forever.

- Anchor: `inspection-proven` — `_____javascript` separator with narration before it, enforced as a fail-fast contract (not loose guidance) in `app/L0/_all/mod/_core/spaces/AGENTS.md` and the `space-widgets` skill.
- Cost: a near-empty protocol has almost no structured error surface, so malformed output has to be caught by repair logic rather than by a schema. See Tension A.

## 4. Context economics — the cost compounds per turn, not per call

Volatile state (page transcription, widget source, open browsers) belongs in a **transient tail**, after the last cache breakpoint, replaced every turn. Durable history is never rewritten, because touching it invalidates the provider cache and you re-pay for the whole prefix. The arithmetic that makes this a rule rather than a preference: loading 2k tokens once is free; keeping it is 2k on *every* subsequent turn, and five such states are 10k on every turn.

- Anchor: `inspection-proven` — `buildOnscreenAgentTransientSections` providers exist across `agent_prompt`, `web_browsing`, and `promptinclude` (`onscreen_agent/llm.js/.../end/promptinclude.js` and siblings).
- Cost: transient content is unavailable for audit after the turn, and anything the model needs to *recall* must be promoted deliberately rather than relying on it still being in context. See Tension A.

## 5. Persist capability, not state

Store the generator, not the rendered artefact. A widget is persisted as the **source of a function that can recreate it**, so a reload regenerates it identically and a space stays a few kilobytes of text rather than a serialized DOM blob. Generalised: anything reproducible from source does not need snapshotting.

- Anchor: `inspection-proven` — `getWidgetRendererReadLines` and `buildWidgetRendererSourceUrl` in `app/L0/_all/mod/_core/spaces/storage.js` / `store.js`.
- Cost: regeneration only works while the runtime that executes the source is intact; a broken runtime takes its own capabilities with it. This is precisely why principle 6 exists.

## 6. Recoverability is a feature, and the escape hatch lives outside the thing that can break

Two layers, deliberately separate. **Time travel** handles the ordinary case: every user and group directory is its own auto-committing repository, so a bad change is undone rather than debugged. **A static escape hatch** handles the catastrophic case: a firmware-level admin surface that exists even when the agent has destroyed the main UI — its own agent, file access, history, and module manager. The generalisable rule is the second one: *the recovery path must not depend on the system that needs recovering.*

- Anchor: `inspection-proven` for both mechanisms — `time_travel/store.js` binds `gitHistoryDiff / List / Preview / Rollback / Revert` over server-owned history; the `admin` module provides a separate entry surface in its own page context.
- Cost: git-per-directory is real disk and commit churn; a static escape hatch is a permanent second UI to keep working.
- **Unverified:** that the hatch survives a *fully* broken UI has never been runtime-tested in this fork. It is the single most important untested claim behind our own product promise.

## 7. Extension with blast radius

Self-extension means real capability surfaces — not just markdown skills — and it needs a permission model, not just an API. Scope it: per-user (invisible to others) → per-group → global. The agent of one user must not be able to silently change the world of another.

- Anchor: `inspection-proven` for the module substrate and existing scoped modules (`user`, `login_hooks`, `user_crypto`, `file_explorer`, `spaces`, `time_travel`, `webllm`, `web_browsing`, …).
- Cost: every scope boundary is a place where "works for me" and "works for the group" can diverge; **`inferred` for our fork** — per-user vs per-group vs global isolation has not been adversarially tested here, and this is our most under-audited security surface.

## 8. Documentation is infrastructure, not overhead

Context windows cannot hold the scope of a real codebase, so an agent without written scope re-derives it — redundantly, inconsistently, and destructively. The fix is per-module documentation that states purpose, core principles, why it works this way, and what not to do, sitting next to the code and loaded before edits. Corollary and the harder claim: unspoken preferences are bugs. Anything not in the repo does not exist for the agent.

- Anchor: `inspection-proven` — this is our DOX chain (`AGENTS.md` per owning directory) and the fork rules already enforce read-before-edit.
- Cost: documentation drifts and can be clobbered by merges; a green code gate has already failed to prove docs survived. Keep the zero-byte DOX gate.

## 9. Prompts are versioned artefacts, not prose

Write an outline by hand, then iterate it mechanically against a harness: generate conservative / medium / wild variants per round, test, promote the winner, and convert every manually observed failure into a permanent test case. Treat the final prompt as a build artefact with a version and a score, because it *is* the program.

- Anchor: `interview-derived` for the generative loop; `inspection-proven` that prompt shape is gated in this tree (`tests/onscreen_agent_prompt_shape_test.mjs`, `tests/prompt_budget_trim_test.mjs`, versioned prompt benchmarks).
- Cost: harness-driven prompt optimisation overfits to the harness; a prompt tuned only on synthetic cases degrades on the weird real input that motivated the work.

## 10. Platform constraint is a design driver, not an obstacle to route around

The browser is simultaneously the most portable runtime in existence and a sandbox that will not let a page touch files, read other origins, or inspect closed shadow roots. The productive response is to accept each boundary and place a thin pressure valve exactly where it is needed — a minimal Node layer for files, auth, and permissions — instead of pretending the boundary is not there or dissolving it wholesale.

- Anchor: `inspection-proven` — thin `server/` for files/auth/persistence; renderer-level hacks and proxying live at the boundary, not scattered through the app.
- Cost: every pressure valve is a trust boundary. CORS proxying and injected renderer hacks are capability grants, and they must be reasoned about as such.

## 11. Deliberate non-goals

Not replicating what already exists elsewhere is a feature. An agent that does everything badly serves nobody; an honest "we do not do background jobs — use the other tool" is stronger positioning than a half-working copy. Pair it with an honest maturity claim: knowing you have explored a small fraction of your own product's possibility space is a *credibility* asset, not an admission.

- Anchor: `inspection-proven` for the split of labour with Agent Zero (different residency, different autonomy contract); `interview-derived` for the non-goals stance.
- Cost: non-goals invite scope pressure from users, and holding the line requires saying no repeatedly to people who are otherwise right.

## 12. The reviewer role — AI writes, the human spots the inefficiency

Generation is cheap; judgement is the scarce input. The durable human contribution is not typing but *watching*: spotting bad decisions, naming the safety or scalability consequence, and redirecting early. A codebase produced this way inherits an obligation — because nobody hand-wrote it, structural discipline has to be enforced by contracts, gates, and audits instead of by muscle memory.

- Anchor: `inspection-proven` for the resulting shape of this repository (DOX chain, regression-test floor, pre-tag gates, read-only A/B audits) — all of which exist *because* the code was not hand-written line by line.
- Cost: reviewer attention is the bottleneck and does not scale; unreviewed lanes accumulate drift that tests will not catch, because the tests were written by the same process that wrote the code.

---

## Tensions for Constellation

Open questions, not verdicts. These are the places where two borrowed principles pull against each other and we have to choose consciously.

### A. Minimal protocol vs. fail-fast enforcement

Principle 3 says the protocol should be as close to nothing as correctness allows. Principle 8 says unspoken rules are bugs. Our tree resolves this in the *stricter* direction — narration must precede the separator, and inline forms such as `Checking widget catalog._____javascript` fail as protocol errors, where upstream treats the shape as guidance. That is a deliberate divergence and it should stay documented as one: **we traded a little tolerance for a much better failure message.** The unresolved half is what happens to transient context under that strictness — a fail-fast protocol that discards the offending turn can also discard the state the model needed to retry.

### B. Recoverability vs. raw capability

Principle 6 buys safety with a second permanent surface. Every capability we grant the agent expands the set of states the escape hatch must survive. We have never tested the catastrophic path (hatch opens after the main UI is destroyed). Until we do, our recoverability claim is architectural intent, not a verified property. Cheap test, real gap.

### C. Documented non-goals vs. feature pressure

Principle 11 says refuse the copy. Every refusal costs a user, and users are how a fork justifies itself. The test we should apply before accepting any feature: *does it require a capability our residency model cannot honestly provide?* If yes, it belongs to the sibling product, not to us.

### D. Immutable history vs. prompt budget

Principle 4 says never touch history. But prompt assembly in this tree does trim over-budget contributors to fit the window (`prompt_budget_trim_test.mjs`, `prompt-items.js`), which is a controlled rewrite of what the model sees. These are reconcilable — the *stored* history is immutable, the *assembled* prompt is budgeted, and truncation recovery is the read path's job — but the distinction has already been confused once in this project (issue #61: a rewind restored intact history, and truncation was misdiagnosed as storage corruption). Anyone touching prompt budgeting should state which of the two layers they mean.

---

## Verification ledger

| Claim | Status |
| --- | --- |
| Browser-resident loop, thin server | inspection-proven |
| `_____javascript` separator, enforced strictly in our tree | inspection-proven |
| Transient tail providers across prompt/browsing/promptinclude | inspection-proven |
| Widget persisted as renderer source, regenerated on load | inspection-proven |
| Git-backed time travel over file layers | inspection-proven |
| Static admin escape hatch exists in its own page context | inspection-proven |
| Escape hatch survives a fully broken main UI | **not tested** |
| Per-user / per-group / global module isolation is airtight | **inferred, not audited** |
| Prompt built by an automated variant-and-harness loop | interview-derived |
| Exact token counts, CPU/memory figures, model-benchmark parity claims | **not reproduced; do not quote as fact** |

Rule of thumb carried forward: interview material is a good source of hypotheses and a poor source of facts. The useful deliverable is the anchor map plus the explicit list of what remains unverified.