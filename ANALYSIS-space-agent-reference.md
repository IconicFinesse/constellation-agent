# Space Agent: A Holistic and Philosophical Analysis

**Repository:** `agent0ai/space-agent` (analyzed at fork `v0.66-fork.3`, `c803b76`)
**Date:** 2026-10-22
**Method:** DOX contract reading, source-tree enumeration, and README self-description cross-checked against implementation. See Appendix A for verification levels.

---

## 1. Thesis

Space Agent is not an agent that uses a product. It is a product that an agent inhabits.

The entire architecture follows from one decision: **the agent runs inside the browser runtime it is meant to reshape.** Not beside it, not through an API — inside `globalThis.space`, in the same JavaScript realm as the page, the modules, the widget renderers, and the filesystem-shaped app tree it can edit. Everything else in the system is a consequence of that residency: the layered `L0/L1/L2` filesystem that gives it a legal place to write, the extension seam geometry that tells it where modification is permitted, the plain-text skill format that lets it author its own capabilities, and the constitutional separation that keeps authority (identity, permissions, truth) on the server while agency (orchestration, prompt construction, execution) stays in the browser.

The usual agent architecture is a controller in one process and tools in another, speaking a schema. Space Agent is a different physics: the controller *is* the medium, and the tool schema is replaced by plain JavaScript in the same message as the reasoning text.

That is genuinely unusual. It is also where every real cost in the system comes from.

---

## 2. The Nine Claims, Tested

The README's *Why Space Agent Is Different* section makes nine claims. Here is each one against what the code actually does.

### 2.1 "The agent reshapes the interface"

**Claim:** ask for a page, tool, widget, or workflow and the agent builds it into the running workspace.

**Reality: honored, and deeper than the pitch.** The agent doesn't just place widgets — its write surface is the entire layered app tree. Through the authenticated file APIs it can write `~/spaces/<id>/widgets/*.yaml`, create `~/spaces/<id>/scripts/*.js` shared modules, write skills as `mod/*/*/ext/skills/*/SKILL.md`, author extension hooks at `mod/*/*/ext/js/<seam>/*.js`, and install whole modules. The `spaces` module exposes `space.current.renderWidget(...)` and roughly 40 sibling runtime helpers for a complete authoring loop: write, read back, patch, reload, see rendered HTML (`seeWidget`), and inspect render health.

The claim undersells it. The agent can reshape the *framework seam geometry*, not just the visible DOM.

### 2.2 "Endless possibilities"

**Claim:** the agent can develop the capabilities it needs from within the system itself.

**Reality: honored with an important qualifier.** Capability growth is real and text-based: a skill is a `SKILL.md` file with frontmatter the discovery system reads. The agent can write one, and the catalog picks it up on the next prompt build. This is a genuine self-extension loop.

**The qualifier:** the loop requires a browser refresh to see new extension files (extension lookups are cached in memory), and *auto-loaded* skill discovery is deliberately limited to top-level `ext/skills/*/SKILL.md` — nested skills are explicit-load only. So "endless" is accurate for authored knowledge, but capability growth is gated by the same permission model as everything else. The agent cannot extend itself into `L0`.

### 2.3 "The agent lives in the frontend runtime"

**Claim:** the agent works directly with the same framework, modules, spaces, and UI it is reshaping.

**Reality: the most consequential claim in the document, and it is exactly true.** The onscreen agent's prompt builder, transport, tool execution, history, and compaction all run in browser JavaScript. `globalThis.space` is explicitly scoped to the current window or iframe — the runtime must never publish into `parent`, `top`, or siblings. The agent executes its actions by emitting a `_____javascript` gate followed by plain code, which the runtime compiles and runs **in the page realm**.

This means there is no impedance mismatch between agent and environment. It also means there is no crash isolation, no headless operation, and — as documented and reproduced in upstream issue #23 — **navigating the tab destroys the running agent**, because the agent is *inside* the thing being navigated. That's not a bug; it's the physics of the design. The fork's fix preserved the history; it could not prevent the interruption, and honestly says so.

### 2.4 "Text-based agent"

**Claim:** new capabilities live in simple `SKILL.md` files the agent can write and extend itself in plain text.

**Reality: honored.** 24 `SKILL.md` files ship in the tree (15 of them top-level and therefore catalog-eligible). Frontmatter controls `metadata.when` (context-tag gating), `metadata.loaded` (auto-injection), and `metadata.placement` (system / transient / history). The memory module is itself just an auto-loaded skill teaching a file convention — explicitly *not* special-cased in prompt-builder code, which is a nice discipline.

### 2.5 "Token-efficient execution"

**Claim:** no bulky tool-call JSON; the agent stays in plain text and plain JavaScript in the same message.

**Reality: honored, and this is a real architectural position rather than a slogan.** There is no function-calling schema anywhere in the agent path. The protocol is:

- `$staging_sequence` — one short sentence of intent
- `_____javascript` — a separator on its own line
- the code, in the same assistant message

The runtime executes it and returns `$framework_telemetry` as a following turn. The firmware prompt explicitly defines the vocabulary: `$mission`, `$protocol`, `$conversation_mode`, `$task_mode`, `$thrust_response` (act, keep the loop alive), `$terminal_response` (speak, end the turn), `$verified_completion`, `$human_command` (`_____user`), `$framework_telemetry` (`_____framework`), `$transient_context` (`_____transient`).

That's a prose-native agent protocol. It removes schema tokens from every turn and, more interestingly, it means the agent's *reasoning and action are the same artifact* — not a thought followed by a serialized intent.

**The cost:** no schema means no structural validation. The system compensates with prompt prose: `` `execution.js` `` fails fast if `_____javascript` is inline rather than on its own line, a buffered non-SSE non-JSON response raises one actionable error, and prompt wording phrases protocol violations as `$mission failed`. It's discipline enforced by language rather than by types.

### 2.6 "Puzzle-piece modularity"

**Claim:** the core stays small; most of the system is modular pieces that can be added, removed, or swapped.

**Reality: honored, and it's the most rigorous part of the design.** Two extension mechanisms:

- **HTML anchors** — `<x-extension id="some/path">` resolves to `mod/<author>/<repo>/ext/html/some/path/*.html`
- **JS hooks** — `space.extend(import.meta, fn)` wraps a function and exposes `/start` and `/end` hook points, resolved from `mod/<author>/<repo>/ext/js/<seam>/*.js`

Both resolve through the layered inheritance chain, with same-path replacement and different-path composition. The shell anchors are a fixed contract: `body/start` mounts the router, `page/admin/body/start` mounts admin. Everything else composes into seams that modules themselves expose.

The discipline is real: `app/AGENTS.md` instructs that if another feature needs to change owned behavior, "expose a seam in the owner instead of reaching into private internals." The onscreen agent's prompt has eight documented JS seams (`buildOnscreenAgentSystemPromptSections`, `buildOnscreenAgentTransientSections`, `buildOnscreenAgentPromptInput`, etc.) precisely so feature modules don't patch its internals. `_core/web_browsing` and `_core/promptinclude` are the worked examples.

### 2.7 "Personal to hierarchical"

**Claim:** use it as a fully personal assistant, or organize it into users and groups as scope grows.

**Reality: honored, via a mode switch that is deeper than a setting.** `SINGLE_USER_APP=true` collapses authentication entirely: request auth resolves every request to an implicit `user` principal, which permission helpers treat as a virtual `_admin` member even with no user or group files on disk. Password SCRAM, sessions, and `userCrypto` are all bypassed.

Multi-user turns on: `group.yaml` with `included_users`, `included_groups`, `managing_users`, `managing_groups`; a derived membership graph; signed session verifiers in `L2/<username>/metadata/logins.json`; per-user encryption records; guest accounts; per-user folder quotas.

Same codebase, two social forms. That is rarer than it sounds.

**The cost:** dual-mode auth is a real bug surface. Upstream #49 was exactly this — the Web Crypto compatibility gate demanded `crypto.subtle` unconditionally, blocking single-user plain-HTTP LAN deployments where password login (and therefore Web Crypto) is never used at all.

### 2.8 "Per-user work, group sharing"

**Claim:** users build in their own layer without affecting anyone else; groups share tools, workflows, and behavior across teams when ready.

**Reality: honored, and cleanly separated.** Personal work goes in `L2/<username>/` — invisible to everyone else. Group work goes in `L1/<group>/` — visible to every member of that group, writable only by managers. A group can include users and *other groups*, and can declare managing users *and* managing groups, so the sharing graph composes recursively.

The mechanism is the same ranked-inheritance resolver, so a personal override wins over a group module wins over firmware without anyone calling an override API. Sharing is a permission grant, not a publish step.

**The cost:** there is no review gate. `group add` may auto-create the writable `L1/<group>/` root and write membership in one step. The model assumes trustworthy managers and relies on Time Travel for recovery rather than on approval workflows.

### 2.9 "Persistent admin and time travel"

**Claim:** admin mode gives a stable control plane; Git-backed history lets you roll back without taking everyone down.

**Reality: honored on both counts.**

- `/admin` runs with `maxLayer=0`, so module and extension resolution is clamped to firmware even while app-file APIs still traverse normal readable/writable layers. A broken L1 or L2 customization cannot break the admin console. That is a genuinely well-chosen safety property.
- Time Travel is Git-backed per-owner history over writable `L1/<group>/` and `L2/<username>/` roots, with list / diff / preview / rollback / revert. Rollback is a hard reset that preserves ignored L2 auth files and keeps the previous head in refs for forward travel. Revert creates an inverse commit using reverse-merge semantics, returning `409` on overlap rather than a generic `500`.

---

## 3. Six Lenses

### 3.1 Self-hosting residency: an agent with no outside

The most philosophically interesting property of Space Agent is that the agent has **no external vantage point**. A conventional agent is a program that manipulates a representation of a system. Space Agent's agent manipulates the system, because `globalThis.space` is the system, and the agent's JavaScript runs in the same realm.

Consequences that follow necessarily:

- **No impedance mismatch.** `space.current.seeWidget(name)` returns stripped rendered HTML plus numbered source readback. The agent doesn't infer what its write did; it sees what the browser actually painted.
- **No crash isolation.** A page reload kills the agent mid-thought.
- **No headless operation.** There is no agent without a browser tab.
- **Identity is ambient.** `space.api.userSelfInfo()` returns `{ username, fullName, groups, managedGroups, sessionId, userCryptoKeyId, userCryptoState }` — the agent knows who it is acting for as a property of its environment, not as a parameter.

This is a coherent and unusual philosophy: **the agent is a citizen of the system, not a client of it.** It's why the "agent reshapes the interface" claim works at all — there's no gap to close.

It's also an honest architectural commitment to a limitation. The fork's #23 investigation confirmed the same-tab admin handoff tears down live turns, and concluded (correctly) that eliminating the interruption "needs cross-tab state sharing or server-side execution — architectural, out of scope." The system chose residency and pays for it with ephemerality.

### 3.2 L0/L1/L2 as political ontology

Most systems have permissions bolted onto a storage layout. Space Agent inverts this: **the layer *is* the permission.**

- `L0` is firmware. *Nobody* writes it.
- `L1` is group customware. You write `L1/<group>/` only if you manage that group, directly or through a managing-group include chain. `_admin` members write any `L1` and `L2`.
- `L2` is personal. You write your own `L2/<username>/` and nothing else.

This is a constitutional order expressed as a directory tree. And because modules resolve by *ranked inheritance* — `L0/_all` → accessible `L0/<group>` → `L1/_all` → accessible `L1/<group>` → `L2/<user>` — the filesystem behaves like a class hierarchy with single-dispatch override on same-path and composition on different-path.

The Unix analogue is `/usr`, `/etc`, and `~` — but with `group.yaml` inserting a social tier that Unix never had. That tier is what makes the "personal to hierarchical" claim structural rather than cosmetic.

`maxLayer` deserves note as a *constitutional emergency power*: `/admin` sets it to `0`, clamping all resolution to firmware. When a customization breaks the app, the control plane that fixes it is guaranteed uncustomized.

### 3.3 Text as substrate

Three separate text-lover's arguments are being made simultaneously, and it's worth separating them:

1. **Economic:** no tool-call JSON. Fewer tokens per turn, more turns per context.
2. **Aesthetic/epistemic:** reasoning and action are the same artifact. The `$staging_sequence` sentence and the code that follows it are one message, so intent and execution can't silently diverge — and telemetry truth rules enforce this: the staging sentence "must describe the code in the same message," and "read-only execution may not be narrated as mutation."
3. **Political:** if skills are text files in the tree the agent can write, the agent can author its capabilities. Self-extension becomes a filesystem operation rather than an API call.

Argument 3 is the deep one. It's what makes "endless possibilities" more than marketing. The system is betting that *plain text is the most extensible interface an agent can have* — because the agent already knows how to write it, and the discovery layer already knows how to read it.

**Honest critique:** this puts enormous weight on prompt prose. The onscreen agent's firmware prompt carries dozens of behavioral requirements, and the repo *knows* this is fragile — which is why `tests/agent_llm_performance/` exists. It is a 72-case benchmark harness that scores prompt variants, and the live prompt was promoted on 2026-04-18 only after improving one-shot from 65/72 to 69/72 (with the full-suite repeat drifting 65–67/72, 206–208/216). Treating the prompt as a compiled artifact with a regression suite is a genuinely sophisticated response to an inherently soft medium. It is still soft.

### 3.4 The frontend/backend split as constitutional separation

The split is not a layering convenience. It is a **separation of powers**, and `app/AGENTS.md` states it as doctrine:

> only push behavior into the backend when the browser cannot safely enforce it because other users, shared data, auth boundaries, or runtime integrity would otherwise be at risk

Read what each side owns:

| | Browser | Server |
|---|---|---|
| **Owns** | orchestration, prompt construction, tool flow, state, optimistic UX, execution | identity, permissions, files, history, sharing, clusters |
| **Never does** | enforce a security boundary | orchestrate an agent turn |

The server is, functionally, **an authenticated filesystem with a job runner attached**. It has no idea an agent exists. That is a remarkable and principled inversion of the usual "thin client, thick server" arrangement.

**What it buys:**

- Inference cost lands on the user's browser and the user's API key, not the host. `api_key` is even stored encrypted at rest via `userCrypto:`.
- The server scales trivially — it's files and auth, not agent state.
- Local model support is native: WebLLM and Hugging Face Transformers.js both run in module-local workers with a shared singleton manager, so the same saved model is reused across onscreen and admin agents in one browser context.
- Privacy is structural: conversation history lives in `~/history/onscreen-agent.json`, in the user's own layer.

**What it costs** — and this is where I part company with the pitch's confidence:

1. **No durable in-flight work.** Documented, reproduced, and only mitigated.
2. **No background reasoning.** Jobs are maintenance (guest cleanup); none of them think.
3. **No multi-client continuity.** The agent is scoped to one window. `space` must not cross browsing contexts. Two tabs are two agents.
4. **No server-side scheduling of agent work.** Combined with (1), it means "ask the agent to do something long" is architecturally the weakest thing the system does.

These are not defects to be patched. They are the price of the constitution, and the honest read is that the project has chosen agency-in-the-browser over durability — correctly, for its stated goals, but the cost is real and should not be minimized.

### 3.5 Puzzle-piece modularity as a theory of legal change

The most rigorous thing in the codebase is the extension system, because it encodes **where modification is legal** and treats everything else as private.

- Seams are named and owned. `body/start`, `page/admin/body/start`, `_core/router/shell_start`, `_core/onscreen_menu/bar_start`, `page/router/overlay/end`.
- Extension files are thin adapters that mount real components from the owning module.
- If a module needs to change another module's behavior, the *owner* exposes a seam. It does not get patched.
- Metadata manifests (`ext/panels/*.yaml`) follow the same readable-layer permissions and override rules as code.

Philosophically: this is a system that knows the difference between **configuration**, **extension**, and **fork** — and provides a legal path for each. Configuration is `ext/panels/*.yaml`. Extension is a seam hook. Fork is an `L1` or `L2` same-path override. Nothing requires touching `L0`.

That's what "the core stays small" actually means: not that there's little code, but that there's little code that *must* be touched.

### 3.6 Personal to hierarchical as two social forms

The dual-mode design (2.7) means Space Agent isn't one product with an enterprise tier bolted on. It's a system whose **social form is a runtime parameter** (`SINGLE_USER_APP`).

Single-user: implicit `_admin`, no auth ceremony, `/enter` as recovery-safe launcher, `WORKERS=1` forced in packaged builds.

Multi-user: group graph, session verifiers, per-user crypto, guest accounts with cleanup policies (72h inactive, 1000 files, 1 GB), per-user folder quotas enforced with `413`.

What's philosophically interesting is that the *agent's capabilities don't change between modes* — only its permissions do. The same agent, in the same code, becomes a personal assistant or a team member because `groups` came back different from `userSelfInfo()`.

---

## 4. Feature Inventory

Layer tags: **L0** firmware browser · **L1** group customware · **L2** user customware · **SRV** server · **HOST** Electron/desktop · **CLI** · **X** cross-cutting.

### 4.1 Kernel and boot — `L0`

| Feature | Detail |
|---|---|
| `initFw.js` bootstrap | Single import per page shell; imports `extensions.js` first so `space.extend` exists before other modules |
| `initializeRuntime` | Publishes `space.api`, `space.config`, `space.chat`, `space.fw.createStore`, `space.utils.markdown`, `space.utils.userCrypto`, `space.utils.yaml`, `space.proxy`, `space.download`, `space.fetchExternal` |
| Extensible initializer | `_core/framework/initializer.js/initialize` with `/start` and `/end` hooks; the shared once-per-page bootstrap seam |
| `<x-component>` loader | Full documents or fragments; mounts styles, module scripts, body nodes; recursive nested loading; in-flight dedupe so observer rescans can't half-hydrate |
| Context tag system | `<x-context>` elements export live runtime state; `getTags`, `getContents`, `getAttributeValues`; framework owns the reserved `data-runtime` element emitting `runtime-browser` / `runtime-app` |
| Navigation interception | Same-origin `_blank` opens inherit `/enter` access; same-tab cross-origin escapes blocked via Navigation API `navigate` with anchor/`location` fallbacks |
| Fetch proxy | Direct-first external fetch with `/api/proxy` fallback and per-origin memory; stamps `Space-State-Version`; retries retryable `503` fences |

### 4.2 Layer substrate — `X`

| Feature | Detail |
|---|---|
| Path model | Logical `/app/L0|L1|L2`, `/mod`, `~` expansion, `CUSTOMWARE_PATH` relocation to external storage |
| Permission chains | Nobody writes L0; own-L2; managed-group L1; `_admin` writes all; readable via derived `group_index` |
| Group graph | `group.yaml`: `included_users`, `included_groups`, `managing_users`, `managing_groups` |
| Ranked inheritance | `L0/_all` → `L0/<group>` → `L1/_all` → `L1/<group>` → `L2/<user>`; same-path overrides, different-path composes |
| `maxLayer` clamping | Explicit request data, query param, `X-Space-Max-Layer` header, or admin-origin fallback |
| Quotas | `USER_FOLDER_SIZE_LIMIT_BYTES` per `L2/<user>/`, derived from indexed `sizeBytes` rather than rescanning |

### 4.3 Identity, auth and crypto — `SRV` + `L0`

| Feature | Detail |
|---|---|
| Password challenge/proof | Shared challenge-and-proof flow; `login_challenge` → `login` |
| Session model | `space_session` cookie: HttpOnly, SameSite=Strict, 30-day; username-hinted token so auth loads only that user's files |
| Session verifiers | Backend-keyed, signed metadata, absolute expiry, in `L2/<u>/metadata/logins.json`; unsigned/expired rejected |
| `userCrypto` | Per-user wrapped master key; session-derived localStorage wrapping key via HMAC of `sessionId`; server never persists the unwrapped key |
| Crypto states | `missing` (self-heal via bootstrap share) vs `invalidated` (don't reprovision over old ciphertext) |
| Single-user mode | Implicit `user` principal as virtual `_admin`; bypasses cookie auth entirely |
| Guest accounts | Randomized `guest_...` prefix; created via `guest_create`; cleanup jobs |
| Password rotation | `password_change` requires current password and, when crypto is ready, a replacement wrapped record |
| Browser compat gate | Mode-aware Web Crypto check; `/login` and `/enter` shells |

### 4.4 The agents — `L0`

| Feature | Detail |
|---|---|
| Onscreen overlay agent | Floating avatar, compact/full modes, drag/edge-hide/height placement, browser-local UI state |
| Admin agent | `/admin`-hosted, `maxLayer=0`, own loop, shared prepared-prompt runtime |
| Shared prompt runtime | `_core/agent_prompt`: `AgentPromptInstance`, prompt-input cloning, history rebuild fallback |
| Shared chat helpers | `_core/agent-chat`: exact-repeat detection, severity-based loop warnings, synthetic transcript prepending |
| Transport | Brokered through `prepareOnscreenAgentApiRequest` seam; SSE incremental reader; buffered re-detection for mislabeled content types |
| Run persistence | Turn written at prompt start; throttled mid-stream checkpoints flagged interrupted; turn-boundary writes authoritative |
| Local providers | Hugging Face and WebLLM via module-local workers; shared singleton manager across surfaces |
| Provider policy | OpenRouter-specific headers via `_core/open_router` extension, not hardcoded in `llm.js` |

### 4.5 Prompt architecture — `L0`

| Feature | Detail |
|---|---|
| Prepared-prompt contract | `system → examples → compacted summary → live history → transient` |
| Message framing | `_____user` (real human) / `_____framework` (runtime follow-up) / `_____transient` (mutable context) |
| Token budgeting | Cached counts; single-message cap first, then part budgets (`system 30`, `history 40`, `transient 30`, `singleMessage 10`); min 250-token contributor trims |
| Prompt includes | `*.system.include.md` → system sections; `*.transient.include.md` → transient blocks; sorted by full logical path |
| Skill catalog | Compact plain-text `id|name|description` rows from readable top-level `ext/skills/*/SKILL.md` |
| Skill gating | `metadata.when` / `metadata.loaded` as `true` or `{ tags: [...] }`; `metadata.placement` system/transient/history |
| Memory policy | Auto-loaded `_core/memory` skill teaching `~/memory/*.include.md` — no prompt-builder special-casing |
| History compaction | Manual and automatic; replaces live turns only, never examples or transient |
| Prompt seams | Eight documented JS extension points in `llm.js` |
| Benchmark harness | `tests/agent_llm_performance/`: 72-case prompt scoring with recorded histories and results |

### 4.6 Space as workspace — `L0`

| Feature | Detail |
|---|---|
| Space persistence | `~/spaces/<id>/`: `space.yaml`, `widgets/*.yaml`, `data/`, `assets/`, `scripts/` |
| Widget SDK | `renderWidget({ id, name, cols, rows, metadata, renderer })`; renderer stored as source string, compiled to named virtual script for readable stack traces |
| Widget context | `ctx.paths` (root/data/assets/scripts/widget), `ctx.import()` for space-local modules, optional cleanup function |
| Grid | 24×24 cap, ~85px cells, responsive auto-layout, drag/resize, minimize |
| Camera contract | Opens occupied cells horizontally centered, top row below shell bar, clamps only when outer cell would leave view |
| Runtime API | ~20 `space.current.*` and ~30 `space.spaces.*` helpers covering CRUD, patch, reload, render inspection, layout, duplication |
| Onboarding | First-login `Big Bang` space; staged empty-canvas animation; curated example presets (Daily News, Crypto Dashboard, Retro Arcade, Agent Zero Videos, WYSIWYG Editor) |
| Sharing | Local ZIP export/import (always available) + optional hosted sharing with browser-side encryption |
| Thumbnails | Browser-captured ~200×200 `thumbnail.webp` biased toward widget bounds |

### 4.7 Conversation surface — `L0`

| Feature | Detail |
|---|---|
| Thread snapshot | `space.chat` publishes live messages plus `promptItems` metadata |
| Long-message reads | `readLongMessage({ id, from, to })` with sliding windows for trimmed contributors |
| Registries | Non-persisted `space.chat.transient` and `space.chat.skills` |
| Rendering | Shared markdown wrapper (`space.utils.markdown.render`), bubble primitives in `_core/visual` |
| Attachments | `_____user` carries literal text + attachment list; runtime access guidance moves to a following `_____framework` block |

### 4.8 Capability surfaces — `L0`

| Feature | Detail |
|---|---|
| Bundled skills | `browser-control`, `browser-manager`, `file-download`, `pdf-report`, `screenshots`, `development` (7 sub-skills), `spaces`, `space-widgets`, `documentation`, `memory`, `user-management`, `file-download`, `admin-user-management` |
| Web browsing | `<x-browser>` element; draggable/minimizable/resizable popups; iframe in browser, DOM `<webview>` in desktop; typed-ref page captures (`[button 18]`, `[input text 30]`); ref-targeted actions; `space.browser` numeric-id API |
| Desktop guest kernel | `browser-dom-helper.js`: recursive shadow-root + nested-iframe snapshot, helper node ids, visible-content filtering, action-effect flags |
| WebLLM | Routed `#/webllm` test surface, module-local worker, compiled custom model loading, throughput reporting |
| Hugging Face | Routed `#/huggingface` + dashboard panel; shared singleton manager, saved-model state, dtype selection, worker bootstrap error handling |
| OpenRouter policy | Shared endpoint detection + header mutation as extension hooks |

### 4.9 Files and storage — `L0` + `SRV`

| Feature | Detail |
|---|---|
| File explorer | Reusable component: browse, select, create, edit, copy, move, delete, rename, download; mounted by routed page and admin adapter |
| App-file APIs | `file_list`, `file_paths`, `file_read`, `file_write`, `file_delete`, `file_copy`, `file_move`, `file_info` |
| Batch semantics | All targets validated before any mutation begins |
| Write modes | Full replace, `append`, `prepend`, `insert` (line/before/after) |
| Folder download | Streamed ZIP via `HEAD` preflight + `GET`/`POST`; staged in resolved `tmpDir`, never buffered |
| Direct fetch | `/~/...` → user L2; `/L0`, `/L1`, `/L2` logical paths; `.git` always blocked; per-segment percent-decoding with encoded separators rejected |
| Path index | Watchdog-maintained `file_index` shards; L2 shards pulled on demand per user |

### 4.10 Time and memory — `L0` + `SRV`

| Feature | Detail |
|---|---|
| Time Travel UI | Routed page: repository picker, paginated commits, file filter, diffs, preview, travel, revert |
| History service | Per-owner-root Git repos; `ensureRepository`, `commitAll`, `listCommits`, `getCommitDiff`, `previewOperation`, `rollbackToCommit`, `revertCommit` |
| Backends | `native` → `isomorphic` fallback, selectable via `GIT_BACKEND`; per-`repoRoot` serialization queue |
| Safety | Ignores `metadata/password.json` and `metadata/logins.json`; preserves pre-reset head in refs for forward travel |
| Conflict handling | Reverse-merge revert; `409` naming blocking file and both versions |
| Conversation history | `~/history/onscreen-agent.json` with checkpoint recovery |

### 4.11 Human interface and ritual — `L0`

| Feature | Detail |
|---|---|
| Router shell | Hash-based; `#/dashboard` default; one-segment and multi-segment resolution; per-route scroll persistence |
| Shell seams | `shell_start`, `shell_end`, route/start, route/end, overlay/start, overlay/end |
| Onscreen menu | Reserved centered header bar, Home shortcut, left/right control seams, dropdown item seam with `data-order` sorting |
| Dashboard | Landing shell with stable extension seams; injects a route-owned control cluster into the menu bar |
| Panels row | `ext/panels/*.yaml` discovery → dashboard secondary row |
| Welcome surface | Dismissible, preference-persisted, bundled demo-space launcher |
| Admin shell | Split two-pane, drag-resize, tablist with overflow dropdown, mirrored inject host, leave-admin |
| Admin views | dashboard, agent, files, time_travel, modules |
| Public shells | `/login` (public even when login disabled), `/enter` (recovery-safe launcher), `/logout`, `/share/space/<token>` |
| Visual system | Shadowless glass treatment, semantic tokens, stationary hover hitboxes, shared dialog/button/popover/card primitives, icon-color selector |
| Login hooks | `first_login` (once per user, marker in `~/metadata/login_hooks.json`) and `any_login` (from `/login`) |

### 4.12 Server transport and API — `SRV`

| Feature | Detail |
|---|---|
| Endpoint discovery | Dynamic from `server/api/*.js`; filename → route; authenticated by default; `allowAnonymous` opt-in |
| Auth endpoints (5) | `health`, `guest_create`, `login_challenge`, `login`, `login_check` |
| App-file endpoints (14) | Including 5 `git_history_*` |
| Share/import endpoints (5) | `cloud_share_create/info/download/clone`, `space_import` — anonymous where links must open pre-session |
| Module endpoints (4) | `module_list/info/install/remove` |
| Runtime/identity endpoints (7) | `extensions_load`, `debug_path_index`, `password_generate`, `password_change`, `user_crypto_bootstrap`, `user_crypto_session_key`, `user_self_info` |
| Proxy | `/api/proxy` fallback for blocked origins |
| Streaming | SSE framing, streamed file/ZIP responses, Web `Response` bridging |
| Error discipline | 4xx quiet to backend logs; 5xx logged once with `error.cause` preserved; bodies redacted |

### 4.13 Server authority and integrity — `SRV`

| Feature | Detail |
|---|---|
| Single-process runtime | `WORKERS=1` |
| Cluster runtime | `WORKERS>1`: primary + workers; workers own HTTP and local writes, primary owns authoritative watchdog and state |
| Unified state system | `state[area][id]`; global monotonic version; 1000-version delta window; snapshot reset when behind |
| State-version fencing | `Space-State-Version` request/response; workers pull immediately on higher requested version |
| L2 shard laziness | Replicated version markers only; workers demand-pull full user shards |
| Named locks | Token-based `acquireLock` / `releaseLock` in primary state |
| Mutation flow | Worker writes locally → commits logical paths to primary once → primary rebuilds, schedules history, publishes asynchronously |
| File watchdog | Primary-only `fs.watch` + config watch + periodic reconcile backstop; workers hold replicas |
| Jobs (3 active) | `guest_cleanup_inactive` (72h), `guest_cleanup_oversized` (1000 files / 1 GB), `guest_collect`; primary-only, named-lock guarded, interval scheduling |
| Process titles | `space-serve-p`, `space-serve-w<N>`, `space-supervise` for operator tooling |

### 4.14 Deployment shapes — `HOST` + `CLI` + `SRV`

| Feature | Detail |
|---|---|
| Electron desktop host | Thin: starts server, opens app; stable `userData` across rebrands; loopback `PORT=0`; `WORKERS=1` + `SINGLE_USER_APP=true`; `<temp>/space-agent/server-tmp` |
| Desktop browser surfaces | `<webview>` preferred over `WebContentsView`; owned `space-browser-*` partitions with forced preload; `_blank` routed to in-app modals |
| Desktop updates | `electron-updater` against GitHub Releases; `/enter`-owned background check; explicit download and restart-to-install; no auto-install on quit |
| Updater helpers | `updater_artifacts.js` (cache ownership), `updater_install_options.js` (log path, NSIS args), `updater_debug_release.js` (asset naming, arch-mismatch recovery) |
| Release automation | `.github/workflows/release-desktop.yml`: tag-gated, AI release notes from commits, multi-arch metadata merge, filtered/staged assets |
| `serve` | Starts the runtime with `PARAM=VALUE` overrides |
| `supervise` | Reverse-proxy supervisor; replaceable children; health-gated traffic switch; drain-aware stops; optional auto-update polling |
| `user` / `group` | State-management command families for layered runtime data |
| `get` / `set` / `version` / `update` / `help` | Operational command family |
| Config schema | `commands/params.yaml`: 14 params with type, allowed values, default, and `frontend_exposed` |

### 4.15 Documentation as architecture — `X`

| Feature | Detail |
|---|---|
| DOX chain | 53 `AGENTS.md` files (~589 KB) with Purpose / Ownership / Local Contracts / Work Guidance / Verification / Child DOX Index |
| Agent-facing docs | `_core/documentation/docs/` — browsable corpus, `documentation.js` focused-read helper, routing skill |
| Skill docs as behavior | `SKILL.md` is simultaneously documentation and runtime capability |
| Test harnesses | `tests/agent_llm_performance/` (72 prompt cases), `tests/browser_component_harness/` (desktop bridge debugging), 55 top-level test files |
| **Gap** | `server/AGENTS.md` and `server/lib/share/AGENTS.md` are **0 bytes** |

---

## 5. The Split, Examined Honestly

The separation is principled, and it is also the system's binding constraint. Three costs deserve naming plainly:

**1. Ephemerality is structural, not incidental.** Issue #23 is the canonical case: same-tab navigation to `/admin` kills a live turn because the loop is in that shell. The fork fixed the *symptom* (history now persists at prompt start with throttled interrupted-flagged checkpoints) and explicitly parked the *cause*, because fixing it requires cross-tab state sharing or server-side execution. That is not a backlog item; it's a different architecture. The current design has no path to durable long-running agent work without crossing its own constitutional line.

**2. The prompt is load-bearing software.** Because there is no tool schema, behavior lives in prose. The repo's response — a 72-case benchmark harness gating prompt promotions, with recorded results and backup versions — is genuinely rigorous. But the honest reading of `65/72 → 69/72` one-shot, with full-suite repeats drifting between 65 and 67, is that the firmware prompt is a *statistical* object. It mostly works. That's a different reliability class than "the typechecker rejects this."

**3. Dual-mode auth has a real bug surface.** `SINGLE_USER_APP` isn't a flag on one code path; it's a second personality of the auth layer. #49 proved it: a Web Crypto gate written for the multi-user path blocked a single-user deployment where password login never happens. Every auth-adjacent change must be reasoned about in two modes.

Against those, the split buys something no conventional architecture offers: **the agent and the interface are the same substance.** `seeWidget()` returns what the browser actually painted. `renderWidget()` writes to the same tree the user's UI reads from. There is no synchronization problem, because there is nothing to synchronize.

---

## 6. What It Could Be

The design opens certain trajectories and forecloses others. Being specific about both is more useful than enthusiasm.

### 6.1 Trajectories the current design makes possible

**Agent-authored capabilities, not just agent-authored content.** Because skills are text files in a readable/writable tree, and because the extension system has legal seams, an agent could plausibly go from "build me a widget" to "build me a capability that builds these widgets." The `development` skill tree (7 sub-skills covering app-files APIs, backend reference, extensions/components, frontend runtime, layers/ownership, modules/routing, skills) is essentially a curriculum for exactly this. Nothing in the architecture blocks it. The fork's stated next phase — idea-crafting toward a fork thesis — sits right at this boundary.

**Multi-agent collaboration within one space.** Spaces are filesystem trees with permissions. Groups can share `L1`. If agent state is files-in-a-layer, then two agents acting for two users in a shared group layer is a *permissions* problem, not an architecture problem. That's an unusually clean path to collaborative agents — and no part of the current server would need to know they exist.

**Local-first, provider-agnostic inference.** WebLLM and Hugging Face already run in browser workers with shared saved-model state. The same architecture that makes API keys browser-owned makes full local operation plausible. `SINGLE_USER_APP` + a local model + `CUSTOMWARE_PATH` is a genuinely private deployment.

**The admin console as a true control plane.** `maxLayer=0` plus app-file APIs spanning all layers plus Time Travel equals: a guaranteed-working surface that can inspect and repair any broken customization. That's a stronger operational story than most systems have.

### 6.2 Trajectories it forecloses

**Durable background agent work.** No server-side orchestration, no headless agent. A task that outlives the tab cannot exist in this design as specified.

**Multi-client session continuity.** `space` must not cross browsing contexts. Two devices are two independent agents with a shared filesystem.

**Structural guarantees about agent behavior.** Without schemas, correctness is statistical. The benchmark harness mitigates; it cannot guarantee.

### 6.3 The unresolved tension

The system's two strongest claims are in direct tension. "The agent lives in the frontend runtime" and "the agent can do serious, persistent, structural work" cannot both be fully true, because the frontend runtime is ephemeral by nature. Every real limitation the project has is an instance of that tension.

The most interesting possible future for Space Agent is not resolving the tension but **making the handoff between the two honest**: browser-resident agent for interactive, high-bandwidth, in-context work; something else for the long tail. The extension system is well-suited to hosting that second thing without violating `L0`. That is, notably, exactly the shape of work a fork could take on without becoming a fork of the architecture.

---

## Appendix A: Verification Levels

**Runtime-reproduced:** nothing in this report. No tests were executed for this analysis.

**Inspection-proven (strong):** repository state and version (`v0.66-fork.3`, `c803b76`); file and directory enumeration; endpoint file list; module inventory and file counts; skill pack enumeration; parameter schema (14 params); server/AGENTS.md and server/lib/share/AGENTS.md being 0 bytes; the README's own claims; every DOX contract quoted or paraphrased.

**Inspection-proven (moderate):** behavioral claims derived from DOX contracts (permission rules, cluster semantics, prompt protocol, extension resolution) are as accurate as the documentation is. Where DOX and implementation could diverge, I did not diff every path.

**Inferred:** the philosophical interpretations (residency as ontology, layers as constitution, extension seams as a theory of legal change) are analytical readings, not claims about author intent. The "what it could be" trajectories are possibilities, not roadmap items.

## Appendix B: Notable Observations

1. **`server/AGENTS.md` is empty.** The most important server contract file in a 600 KB DOX system is 0 bytes, and so is `server/lib/share/AGENTS.md`. Yet `server/api/AGENTS.md`, `server/router/AGENTS.md`, and every `server/lib/*` child are thorough. This looks like a specific documentation regression rather than an intentional gap — and it is precisely the file that would orient a newcomer to the server's constitutional role.

2. **The prompt is a versioned artifact.** `prompts/system-prompt.backup-before-089A-086A-browser-skill-exact-id-2026-04-18.md` is a real file in the tree. Recording promotion history with measured scores is closer to release engineering than to prompt tweaking, and it's the most credible thing the project does about its softest surface.

3. **Telemetry-truth rules are unusually explicit.** "The `$staging_sequence` must describe the code in the same message." "Read-only execution may not be narrated as mutation." "An `execution error` telemetry turn forbids any success claim." These are anti-hallucination constraints written at the protocol level rather than patched per-case.

4. **The prompt forbids its own most natural failure mode.** The firmware prompt states that visiting another website means using `browser-control` and a standalone browser window, and that leaving the runtime page via `window.location`, `location.href`, `location.assign(...)`, or `location.replace(...)` is **forbidden** — because navigating away would destroy the agent (see §2.3). The system teaches its agent not to do the one thing that would kill it. That's a striking and slightly wonderful detail: the prompt contains a survival instruction.

5. **`app/share/` exists as a sibling of `L0/L1/L2`.** It is not a layer and not a module root; it appears to be backend-owned hosted-share state living under the app tree. Worth understanding before any fork work touches sharing.

---

*This analysis was produced by reading DOX contracts and enumerating the source tree, not by executing the system. Every claim about behavior should be treated as documented-and-inspected unless a test run is cited. See Appendix A.*
