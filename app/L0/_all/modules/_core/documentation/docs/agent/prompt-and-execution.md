# Prompt And Execution

This doc focuses on the standard prepared prompt path used by the onscreen and admin agents, and on how execution results are fed back into history.

## Primary Sources

- `app/L0/_all/modules/_core/onscreen_agent/AGENTS.md`
- `app/L0/_all/modules/_core/agent_prompt/AGENTS.md`
- `app/L0/_all/modules/_core/onscreen_agent/prompts/AGENTS.md`
- `app/L0/_all/modules/_core/promptinclude/AGENTS.md`
- `app/L0/_all/modules/_core/agent_prompt/prompt-runtime.js`
- `app/L0/_all/modules/_core/onscreen_agent/llm.js`
- `app/L0/_all/modules/_core/admin/views/agent/prompt.js`
- `app/L0/_all/modules/_core/onscreen_agent/execution.js`
- `app/L0/_all/modules/_core/onscreen_agent/api.js`
- `app/L0/_all/modules/_core/promptinclude/promptinclude.js`

## Prompt Boot Timing

The first-party agent surfaces now share one standard prepared-prompt builder, but they do not all bootstrap it at the same time.

Current timing:

- onscreen init restores config, browser UI state, and saved history first, and then waits until the first prompt-dependent action before loading prompt dependencies and assembling prompt input
- admin primes the same standard prompt runtime during init because prompt history and instruction editing are always visible on that surface
- later prompt rebuilds still run through the same shared prompt runtime, so prompt-history previews and outbound request payloads stay aligned after settled turns
- the shared prompt runtime caches only structured-clone-safe prompt input snapshots; runtime-only references such as live prompt instances are stripped before caching, and defensive clone fallback keeps prompt-history tooling from crashing on stray non-cloneable values
- admin's only prompt-order difference is custom instruction placement: its user-authored instructions are appended after the shared standard system sections

## Prepared Prompt Order

The prepared prompt order is:

```txt
system -> examples -> compacted history summary (when present) -> live history -> transient
```

Important details:

- example messages are ordinary alternating user/assistant messages inserted before live history
- when any example messages exist, the prepared prompt appends one final example-sourced `_____framework` boundary that says `start of new conversation - don't refer to previous contents` before the first live-history turn
- example messages count toward token totals but are never replaced by compaction
- owner modules may prepend extra system-prompt sections before the skill catalog; `_core/promptinclude` currently injects a stable `## prompt includes` instruction block there and then appends readable `*.system.include.md` files as extra system-prompt sections
- transient runtime context is emitted as its own trailing prepared message when present
- `_core/onscreen_agent` currently adds one short lowercase `chat display mode` transient section only in compact mode so the model sees `chat is in compact mode` and `keep replies short unless more detail is needed for correctness or the user asks for it`; full mode adds no display-mode section
- `_core/onscreen_agent` also appends a bounded `user home files` transient section built from the current user's `~/` tree, omitting `.git/` directories entirely and formatting the remaining paths as a simple indented folder-first listing with `/` suffixes on folders and explicit `# ... more folders` or `# ... more files` summaries when the current defaults `maxDepth: 5`, `maxFoldersPerFolder: 20`, `maxFilesPerFolder: 20`, or `maxLines: 250` hide children
- `_core/web_browsing` may also append a `currently open web browsers` transient section when registered browser surfaces exist, using the compact pipe-delimited rows `browser id|url|title` so the agent can see the current browser set without inflating prompt size
- `_core/web_browsing` may also append `last interacted web browser` when a browser surface targeted by agent-driven open or create or navigation or inspection or interaction helpers, explicit `state(...)` checks, or direct browser-surface focus is still open at prompt-build time; that hook fetches fresh simplified `content` for that one browser during transient-section construction instead of caching page content at click or type time, retries a few short settle-and-read passes there so content usually appears without teaching a public `sync(...)` step, and contributes nothing stale when that browser later closes
- `_core/promptinclude` may also append a `prompt includes` transient section that lists readable `**/*.transient.include.md` files in alphabetical full-path order and renders each file body in its own fenced block
- `_core/spaces` may append `available spaces` with compact `id|title` rows on any prompt build, and `current space widgets` with compact widget layout rows while a current space is open; post-write `Current Widget` still comes from the runtime transient store

## Message Markers

Prepared user-role messages use explicit wrappers:

- `_____user`: real human submission
- `_____framework`: framework-generated follow-up such as execution output
- `_____transient`: trailing mutable runtime context

These markers matter for prompt inspection, execution flows, and staged widget workflows.

When a real user turn includes attachments, the `_____user` block contains the literal message text plus the `Attachments↓` list, and the `space.chat` runtime instructions for those attachments are emitted as a following `_____framework` block.

## Skill Injection

Prompt construction includes two skill-related sections:

- the top-level skill catalog built from readable `modules/*/*/ext/skills/*/SKILL.md` files
- the auto-loaded skill context for readable top-level `ext/skills/*/SKILL.md` files whose `metadata.loaded` condition currently passes

Both sections are filtered by the current document's live `<x-context>` tags before prompt assembly.

Both `metadata.when` and `metadata.loaded` accept either `true` or a `{ tags: [...] }` condition. The shared helper reads those live tags every time it builds the catalog, resolves an explicit skill load, or assembles auto-loaded prompt context. Framework bootstrap contributes exactly one runtime context before that evaluation: `data-runtime="browser"` on normal web sessions or `data-runtime="app"` in the packaged desktop runtime, plus the derived tag `runtime-browser` or `runtime-app`. Auto-loaded prompt discovery is top-level only, and auto-loaded skills may land only in `system` or `transient`, so their missing or invalid placement and explicit `history` all fall back to `system` unless they explicitly set `transient`.

Top-level skill catalog rows use the compact shape:

```txt
skill-id|name|description
```

## Execution Protocol

The agent runs browser-side JavaScript through the execution loop.

Important execution rules:

- execution blocks should be preceded by one short narration line
- `_____javascript` must appear on its own line
- execution output is fed back as `_____framework`
- the live firmware prompt treats off-runtime website visits as browser-control work: open or navigate a stand-alone browser window instead of leaving the current runtime page, and do not use `window.location`, `location.href`, `location.assign(...)`, or `location.replace(...)` to escape the runtime
- the live firmware prompt distinguishes runtime identity fields from persisted YAML keys: `space.api.userSelfInfo()` exposes `fullName`, but `~/user.yaml` stores `full_name`, so profile edits should update `full_name`, not `fullName`
- the live firmware prompt also keeps one compact widget-authoring rule aligned with `_core/spaces`: prefer `async (parent, currentSpace, context) => { ... }` and split shared or large current-space widget logic into `await context.import("scripts/...")`; detailed staged widget workflow still lives in the spaces-owned `space-widgets` skill
- if an execution block returns no result and prints no logs, the transcript says `execution returned no result and no console logs were printed`
- multiline console-print blocks are labeled with `log↓`, `info↓`, `warn↓`, `error↓`, `debug↓`, `dir↓`, `table↓`, or `assert↓`, and multiline returned values are labeled with `result↓`
- immediately before an execution transcript is sent back as `_____framework`, the surface may prepend synthetic console-style transcript logs from its assistant-message evaluation seam; the current first-party repeated-message detector in `_core/agent-chat` emits `info` on the 2nd exact assistant-message send, `warn` on the 3rd send, and `error` on the 4th send onward so the agent sees loop pressure inside the normal execution feedback channel
- structured console-print payloads and structured results should prefer YAML over JSON when the shared serializer can express them cleanly, and ordinary returned arrays or objects should be preserved there rather than collapsed to a short console-style preview
- `space.skills.load(...)` still returns the typed skill object, but `history` placement writes the skill body into history while `system` and `transient` placement only report `skill loaded to system message` or `skill loaded to transient area` and store the skill in runtime prompt context for later requests
- task control treats a successful skill load as a read stage, not automatic completion: if the user asked to use that skill and the task is still open, the next move should use the newly loaded skill or its runtime helpers instead of answering `Done.` or issuing the same load again

## Failure And Retry Behavior

- if a model turn returns no assistant content, the runtime retries the same request once automatically
- only after that retry does it emit a generic protocol-correction user message
- no-result execution output is informational only and should not trigger a synthetic correction message by itself

## LLM Transport

`api.js` owns the final provider call after `llm.js` has built the prepared prompt input.

The transport layer uses one `OnscreenAgentLlmClient` superclass with provider subclasses:

- `OnscreenAgentApiLlmClient` sends the prepared request to an OpenAI-compatible chat-completions endpoint and normalizes standard JSON or SSE streams into text deltas plus completion metadata
- `OnscreenAgentLocalLlmClient` sends the prepared message payload through the shared `_core/huggingface/manager.js` browser runtime, using the configured Hugging Face repo id and dtype
- local sends reuse the same final folded transport messages that the API path would send upstream, while the prompt-history tools still expose the richer pre-fold prepared payload with `_____framework`, `_____user`, and trailing `_____transient` boundaries

When `llm_provider` is `local`, the first-party agent surfaces now keep the same full prepared prompt path that API mode uses, including the firmware prompt, prompt includes, skill catalog, auto-loaded skill context, custom instructions, history, and transient context. The separate `/huggingface` testing page still keeps its own plain system-prompt-only chat surface.

The store and retry loop consume both providers through the same `streamOnscreenAgentCompletion(...)` seam. Provider-specific behavior should stay behind those client classes unless it affects prompt construction, which belongs in `llm.js`.

## Prompt Extension Seams

Feature modules should extend the agent through owner-module seams, not by patching the base prompt blindly.

Important extension families:

- system prompt sections
- example message builders
- history message builders
- transient section builders
- final prompt-input assembly
- execution-plan validation hooks

Current first-party examples include `_core/spaces` for current-space instructions plus the always-on `available spaces` transient section and the in-space `current space widgets` transient section, `_core/promptinclude` for persistent split system/transient include discovery, `_core/memory` for prompt-include-backed `~/memory/` behavior and rolling notes through an auto-loaded system skill, `_core/web_browsing` for the always-loaded onscreen `browser-manager` skill plus brief open-browser-surface status and prompt-time last-interacted browser content in transient context while `browser-control` auto-loads when `browser:open` is present and uses only the top-level numeric-id `space.browser` helpers, and `_core/onscreen_agent` for the compact-mode reply guidance hook plus the bounded current-user `~/` file tree transient section. Module-specific workflow policy still belongs in owner-module skills or owner-module `_core/onscreen_agent/...` JS hooks.
