---
name: Skill Authoring
description: Author or update onscreen agent skills under ext/skills
---

Use this skill when creating or updating skills for the onscreen chat agent.

## Skill File Layout

- Onscreen chat-agent skills live inside browser modules under `modules/<author>/<repo>/ext/skills/...`.
- Repo-owned first-party shared onscreen skills should normally live under `app/L0/_all/modules/_core/skillset/ext/skills/...`.
- Module-specific skills that describe one module's private contracts may live under that owning module's `ext/skills/...` tree.
- Group-scoped or admin-only onscreen skills may live under readable customware roots such as `app/L0/_admin/modules/_core/<module>/ext/skills/...`.
- A skill file is always named `SKILL.md`.
- The skill id is the path relative to `ext/skills/` with the trailing `/SKILL.md` removed.

Examples:

- `modules/_core/skillset/ext/skills/browser-control/SKILL.md` -> `browser-control`
- `modules/_core/skillset/ext/skills/development/SKILL.md` -> `development`
- `modules/_core/skillset/ext/skills/development/modules-routing/SKILL.md` -> `development/modules-routing`

## Catalog Rules

- The onscreen prompt catalog lists only top-level skills from `ext/skills/*/SKILL.md`.
- Nested skills are not listed by default.
- Both the catalog and explicit `space.skills.load(...)` calls evaluate the current document's `<x-context>` tags before a skill is eligible.
- `metadata.when` may be `true` or a `{ tags: [...] }` condition; `metadata.when.tags` requires all listed tags before the skill becomes catalog-loadable.
- `metadata.placement` accepts `system`, `transient`, or `history`; ordinary skills default missing or invalid placement to `history`, but auto-loaded skills may not resolve to `history`, so missing or invalid placement and explicit `history` all fall back to `system` unless the skill explicitly sets `transient`.
- Only top-level `ext/skills/*/SKILL.md` skills can auto-load through prompt discovery. Nested skills stay explicit-load-only routing targets even if they define `metadata.loaded`.
- Auto-loaded skills appear after the catalog in the `auto loaded` prompt block when their effective placement is `system`, or in the transient channel when they explicitly set `metadata.placement: transient`.
- Routing skills should tell the agent which deeper skill ids to load next.
- `space.skills.load("<path>")` loads the full skill file on demand and applies the same placement rule.
- `history` placement keeps the loaded skill body in ordinary execution-output history.
- `system` placement stores the loaded skill in the current chat's runtime system-skill registry and execution reports `skill loaded to system message`.
- `transient` placement stores the loaded skill in the current chat's runtime transient-skill registry and execution reports `skill loaded to transient area`.
- Auto-loaded skills cannot resolve to `history`; if they also set `metadata.loaded`, then `metadata.placement: history` is treated as `system`.
- A plain top-level `await space.skills.load("<path>")` is enough to apply the placement; use `return` only if you also want the execution result value explicitly.

## Conflict Rules

- Skill ids must be unique across readable mods.
- If a skill is visible only to a narrower audience, still give it a top-level id that will not collide with shared `_all` skills that those users can also read.
- Conflicting ids are omitted from the catalog.
- Loading a conflicting id fails with an ambiguity error.

## Skill Content Rules

- Start with frontmatter containing `name`, `description`, and optional runtime-owned `metadata`.
- Framework bootstrap already exports exactly one runtime context: `data-runtime="browser"` in normal web sessions or `data-runtime="app"` in the packaged desktop runtime, plus the derived tag `runtime-browser` or `runtime-app`; packaged app routes derive that from the desktop bridge before falling back to launcher runtime info or frontend config.
- Import `/modules/_core/framework/js/context.js` when code needs to read the current live `<x-context>` set directly; use `getTags(...)` for tag collection, `getAttributeValues("data-runtime", ...)` for raw runtime reads, and the other helpers for broader context inspection.
- Use `<x-context>` tags in mounted DOM when a module needs to expose additional live skill-filter state such as `onscreen`, `admin`, `route:spaces`, or `space:open`.
- Use `metadata.when.tags` when the skill should exist only in those live contexts.
- Use `metadata.loaded` only when the skill should be auto-injected without an explicit `space.skills.load(...)` call.
- Use `metadata.placement: system` when the skill body is durable instruction, `metadata.placement: transient` when it should live in the mutable transient block, and let the default `history` placement stand only for ordinary non-auto-loaded skills that should behave like normal conversation context.
- Prompt-facing skill text is token-budgeted. Keep wording terse, avoid unnecessary markdown or filler, and measure before or after changes with the local tokenizer when you edit auto-loaded or catalog-facing skill text.
- When a skill needs reusable browser logic, prefer a small JS helper stored inside that skill's own folder and imported from a stable `/modules/<author>/<repo>/ext/skills/...` path instead of pasting a long inline script into `SKILL.md`.
- Keep the top-level router skill directive and concise.
- Keep nested skills focused on one stable area.
- Prefer exact file paths, runtime names, and examples over vague guidance.
- If a skill subtree becomes complex, add an `AGENTS.md` file inside that subtree and keep it current.

## Maintenance Rules

- When a mirrored source contract changes, update the affected skill files in the same session.
- When a stable feature or workflow changes, update the relevant docs under `/modules/_core/documentation/docs/` and the documentation skill at `/modules/_core/documentation/ext/skills/documentation/SKILL.md` in the same session.
- Do not let skill guidance drift away from the owning `AGENTS.md` files.
- For the development super-skill specifically, keep `/modules/_core/skillset/ext/skills/development/AGENTS.md` current whenever the framework, router, API, layer, or auth contracts it mirrors change.
