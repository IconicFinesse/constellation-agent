# Memory And Prompt Includes

This doc covers the first-party persistent-memory workflow built on `_core/memory` and `_core/promptinclude`.

## Primary Sources

- `app/L0/_all/modules/_core/memory/AGENTS.md`
- `app/L0/_all/modules/_core/memory/ext/skills/memory/SKILL.md`
- `app/L0/_all/modules/_core/promptinclude/AGENTS.md`
- `app/L0/_all/modules/_core/promptinclude/promptinclude.js`
- `app/L0/_all/modules/_core/onscreen_agent/AGENTS.md`
- `app/L0/_all/modules/_core/admin/views/agent/AGENTS.md`

## Memory Model

`_core/memory` is a headless module. It does not create a second database, store, or backend API.

Instead:

- the module contributes one top-level `memory` skill
- that skill is auto-loaded with `metadata.loaded: true`
- the skill uses `metadata.placement: system`, so its instructions stay in the system prompt
- the actual remembered content lives in user-owned prompt-include files under `~/memory/`
- `_core/promptinclude` still owns discovery, file reads, ordering, and final prompt injection

That means memory stays transparent. The policy lives in the skill. The remembered content lives in ordinary app files. Prompt assembly still flows through the existing prompt-include contract.

## Standard Memory Files

The first-party memory skill standardizes these paths:

- `~/memory/behavior.system.include.md`: stable behavior changes, preferences, and standing instructions
- `~/memory/memories.transient.include.md`: general rolling notes worth carrying across conversations
- `~/memory/*.transient.include.md`: extra focused note files when one topic deserves its own evolving memory file

The files are plain markdown include bodies, not YAML config. `_core/promptinclude` injects readable `*.system.include.md` files as separate system-prompt sections and readable `*.transient.include.md` files as transient context later in the prepared prompt.

## Agent Workflow

The intended workflow is:

- when something meaningful should persist, create or update the right file under `~/memory/`
- when the user explicitly asks to change behavior, edit `~/memory/behavior.system.include.md`
- when a fact, decision, project note, or preference is worth remembering but may change more often, keep it in `~/memory/memories.transient.include.md` or another focused `*.transient.include.md` file
- when you only need to add one new memory note or drop content under a known heading, prefer incremental `fileWrite(...)` append, prepend, or insert operations over rereading and rewriting the entire file
- never construct memory or note paths as `~/L2/<username>/...`: `~` already means your own root and the server canonicalizes that doubled form; plain `~/memory/...` paths are correct
- keep memory concise and current by rewriting or deleting stale lines instead of stacking duplicates
- do not only acknowledge memory updates verbally; persist them when they should affect later turns

## Cross-Provider Prompt Behavior

API-mode agent prompts append the normal top-level skill catalog and the matching auto-loaded skill context, so the `memory` skill appears there automatically.

The first-party onscreen and admin agent surfaces now keep the same full prepared prompt path in both API and local-provider modes, so the `memory` skill plus prompt-include-backed `~/memory/` files stay active across provider switches without a separate reduced local prompt profile.

## Related Docs

- `agent/prompt-and-execution.md`
- `agent/skills-and-documentation.md`
- `app/runtime-and-layers.md`
