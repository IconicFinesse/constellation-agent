# Skills And Documentation

This doc covers the shared browser-side skill-loading contract and the documentation skill/helper contract.

## Primary Sources

- `app/L0/_all/modules/_core/onscreen_agent/AGENTS.md`
- `app/L0/_all/modules/_core/skillset/AGENTS.md`
- `app/L0/_all/modules/_core/onscreen_agent/skills.js`
- `app/L0/_all/modules/_core/skillset/skills.js`
- `app/L0/_all/modules/_core/skillset/ext/skills/development/AGENTS.md`
- `app/L0/_all/modules/_core/documentation/AGENTS.md`
- `app/L0/_all/modules/_core/documentation/documentation.js`

## Skill Discovery

Onscreen skills are discovered from readable module trees:

- top-level discovery pattern: `modules/*/*/ext/skills/*/SKILL.md`

Important rules:

- top-level skills appear in the prompt catalog automatically
- nested skills are not listed by default
- both catalog visibility and explicit skill loads evaluate the current document's live `<x-context>` tags
- `metadata.when` may be `true` or a `{ tags: [...] }` condition, and `metadata.when.tags` requires all listed tags before the skill becomes catalog-loadable
- only top-level skills may auto-load through prompt discovery; nested skills remain explicit-load-only even when they define `metadata.loaded`
- `metadata.placement` chooses where that auto-loaded or manually loaded skill content lands: `system`, `transient`, or `history`, except that auto-loaded skills may land only in `system` or `transient` and therefore fall back to `system` unless they explicitly set `transient`
- when a skill should auto-load or move, update its `ext/skills/.../SKILL.md` metadata or module ownership rather than hardcoding that id into a prompt builder that already uses shared discovery
- skill ids are relative to `ext/skills/` without the trailing `/SKILL.md`

Current first-party context examples:

- framework bootstrap exports exactly one runtime context: `data-runtime="browser"` on normal web sessions or `data-runtime="app"` in the packaged desktop runtime, plus the derived tag `runtime-browser` or `runtime-app`; packaged app routes resolve that runtime from the desktop bridge before falling back to launcher runtime info or frontend config
- `_core/onscreen_agent/panel.html` exports `onscreen`
- `_core/admin/views/shell/shell.html` exports `admin`
- `_core/router/view.html` exports `route:<current-path>`
- `_core/spaces/view.html` exports `space:open` plus `space:id:<id>` when a current space is active
- `_core/web_browsing/window.html` exports `browser:open` while at least one registered browser surface is open, including popup windows and inline `<x-browser>` elements

Examples:

- `ext/skills/documentation/SKILL.md` -> `documentation`
- `ext/skills/browser-manager/SKILL.md` -> `browser-manager`
- `ext/skills/browser-control/SKILL.md` -> `browser-control`
- `ext/skills/development/modules-routing/SKILL.md` -> `development/modules-routing`

## Loading And Visibility

On-demand loading uses:

```js
await space.skills.load("skill/path")
```

Loaded skills follow the effective placement: ordinary `history` placement is inserted into execution output and then becomes part of history, while `system` and `transient` placement register runtime prompt context and return short load-result text instead of dumping the full body into history. Auto-loaded skills are top-level only and may not resolve to `history`, so missing or invalid placement and explicit `history` all behave as `system` unless the skill explicitly sets `transient`. For task control, history-placed skill loads behave like read stages: the load call should use the exact skill id from the catalog or loaded-skill header, and if the task still needs action the next move should use the loaded skill rather than reload it.

Visibility rules:

- readable group-scoped modules may contribute extra skills
- admin-only groups may contribute admin-only skills
- module-owned context tags may hide those skills unless the current page exports the required tags
- same-module layered overrides replace lower-ranked skill files before the catalog is built

Conflict rules:

- skill ids must be unique across readable modules
- conflicting ids are omitted from the catalog
- loading a conflicting id fails with an ambiguity error

## Current First-Party Shared Top-Level Skills

Current repo-owned shared top-level skills include:

- `development`
- `browser-manager`
- `browser-control`
- `memory`
- `file-download`
- `pdf-report`
- `spaces`
- `space-widgets`
- `screenshots`
- `user-management`
- `documentation`

Additional group-scoped skills may exist for narrower audiences.

Some of those first-party ids are still gated by live context tags. For example, the shared `file-download`, `user-management`, and `browser-manager` skills require `onscreen`, `space-widgets` requires `space:open`, and `browser-control` auto-loads when `browser:open` is present on an onscreen surface. Skills may also target the framework-owned `runtime-browser` or `runtime-app` tags when their instructions depend on a normal web session versus the packaged desktop runtime. The shared `development` skill is the main frontend-development router and is intentionally not tag-gated, so it remains visible and auto-included as the stable index for its nested development skills. The first-party `memory` skill is also top-level and auto-loaded, and it keeps the prompt-include-backed `~/memory/` convention in model context without needing any special-case prompt-builder code. The first-party `spaces` skill is also top-level and auto-loaded without a tag gate.

The first-party `development` tree is intentionally split into narrower nested skills. The top-level `development` skill is the always-included router for that tree: it should stay concise, but it must keep one visible subsection per nested development skill so agents can choose the right follow-up skill quickly.

In particular, `development/modules-routing` now teaches custom routed pages as the main alternative to spaces when the user wants a reusable feature surface, shows how to publish dashboard panels through `ext/panels/*.yaml`, and points agents at the importable helper script `/modules/_core/skillset/ext/skills/development/modules-routing/panel-tools.js` instead of pasting one-off browser snippets into the skill text.

The top-level `browser-manager` skill is the short onscreen browser-window guide. It auto-loads on onscreen surfaces, covers opening and closing stand-alone browser windows through the top-level numeric-id `space.browser` helpers, relies on the `currently open web browsers` transient section for the compact `browser id|url|title` readback, and hands in-browser page work off to `browser-control` once any browser surface is open.

The top-level `browser-control` skill is the full onscreen browser-automation guide. It auto-loads when the onscreen page also exports `browser:open`, focuses on the top-level numeric-id `space.browser` navigation and inspection helpers plus ref-based page interaction for already-open browser surfaces, including widget-authored `<x-browser>` elements, relies on the `currently open web browsers` and `last interacted web browser` transient sections, does not teach per-window handles or an explicit `sync(...)` step, keeps `typeSubmit(...)` defined as type then press Enter in the same field, teaches the lean-token capture rule that `content(...)` uses typed ref boxes such as `[disabled muted button 18]`, `[checked checkbox 7]`, `[image 24]`, or `[input text 30]`, now treats generic event-bound controls as refs too, accepts either `selector` or `selectors` for scoped `dom(...)` and `content(...)` reads, reserves `evaluate(id, script)` or `send(id, "evaluate", { script })` as the last-resort escape hatch when normal helpers are not expressive enough, omits link destinations and label quotes by default, suppresses list bullets while keeping indentation, gives images actionable refs, falls back to truncated URL text for otherwise-empty links or images, and treats those state or semantic tags as best-effort hints that can be suppressed with `includeStateTags: false` or `includeSemanticTags: false` when flatter output matters. The skill also teaches that ref-targeted actions return `{ action, state }` and that `action.status.noObservedEffect` is the main stop-and-reinspect signal for loops, while `detail(id, ref)` remains the preferred way to inspect one link target, image source, DOM target, or control state on demand.

The top-level `spaces` skill is the always-loaded guide for space selection and `space.yaml` work. It stays concise, covers opening and creating and removing spaces plus editing the space file, and relies on the `Available Spaces` transient section for the compact `id|title` readback.

The top-level `space-widgets` skill is the in-space widget-authoring guide. It auto-loads only on `space:open`, teaches the staged `readWidget(...)` and `patchWidget(...)` and `renderWidget(...)` flow, relies on the `Current Space Widgets` and `Current Widget` transient sections, and points complex current-space widget logic at `context.import("scripts/...")` for shared state, cross-widget communication, and large widget splits.

Current first-party panel helper exports include:

- `listPanels()` for the current user's visible dashboard panels
- `findPanel(target)` for resolving a panel by visible name, route path, hash route, or direct `/modules/...` HTML path
- `resolvePanelRoutePath(target)` and `createPanelHref(target)` for converting panel targets into concrete router destinations
- `goToPanel(target)` or `openPanel(target)` for navigation through `space.router` with a hash fallback

Skill-specific browser helpers live with the skill that owns them under `ext/skills/<skill>/...`; `skills.js` owns discovery and prompt placement, not those execution helpers.

The first-party `screenshots` skill imports `/modules/_core/skillset/ext/skills/screenshots/screenshots.js`. That helper lazy-loads the vendored `html2canvas@1.4.1` bundle from `/modules/_core/skillset/vendor/html2canvas.min.js`, so page screenshots do not depend on jsDelivr or another CDN at runtime.

The first-party `pdf-report` skill imports `/modules/_core/skillset/ext/skills/pdf-report/pdf-report.js`. That helper owns the generic HTML/CSS-to-PDF pipeline, the structured report builder, and the download wrappers, so agents should use it instead of improvising raw `%PDF` strings or reusing a canned domain-specific template.

## Documentation Skill And Helper

Broad orientation starts in the top-level `documentation` skill:

```js
await space.skills.load("documentation");
```

That skill carries the compact docs map directly in its body. Use the helper below only for focused follow-up reads once you know the path you need.

The documentation helper lives at:

```txt
/modules/_core/documentation/documentation.js
```

Stable exports:

- `read("relative/path.md")`
- `url("relative/path.md")`

Examples:

```js
await space.skills.load("documentation");
const documentation = await import("/modules/_core/documentation/documentation.js");
const filesDoc = await documentation.read("server/api/files.md");
```

## How To Use These Docs Correctly

- use the `documentation` skill for fast orientation
- use the helper for focused doc reads once you know the relative path
- use the relevant `AGENTS.md` file for the concrete contract
- use code for exact implementation detail

When you change a stable contract or workflow, update all three layers together.
