---
name: Modules And Routing
description: Place first-party modules correctly, make them routable, and use router seams instead of hardwiring features into shells.
---

Use this skill when creating or updating routed modules, deciding where files belong, or wiring a feature into the authenticated app shell.

If the user wants a reusable app surface, tool UI, settings panel, or workflow screen, prefer a custom routed page module over a space. Spaces are for persisted user-authored widget canvases; custom pages are for feature-owned interfaces.

## First-Party Module Placement

- Browser modules are namespaced as `modules/<author>/<repo>/...`.
- Repo-owned first-party modules should normally live under `app/L0/_all/modules/_core/<feature>/`.
- A routed feature should usually own its own `view.html` under that module root.
- Keep the module root as the real implementation location and use `ext/html/...` files only as thin adapters into existing seams.

## Custom Pages Instead Of Spaces

- Build a custom routed page when the extension should behave like a first-class feature screen instead of a widget on a persisted space canvas.
- Use spaces when the user wants a configurable board of widgets that lives under `~/spaces/...`.
- Use a routed page when the feature owns its own layout, state, and navigation flow.
- To make a custom page appear in the dashboard `Panels` section, add `ext/panels/<name>.yaml` in the owning module.
- Panel manifests should define `name`, `path`, optional `description`, optional `icon`, and optional `color`.
- For first-party `_core` routes, the manifest `path` may use shorthand such as `user` instead of a full `/modules/...` path.
- Panel manifest `path` values may use shorthand route paths such as `user`, prefixed hash paths such as `#/user`, or direct `/modules/...` HTML paths such as `/modules/_core/user/view.html`.

## Router Resolution

- The main app is hash-routed.
- `#/dashboard` resolves to `/modules/_core/dashboard/view.html`.
- `#/time_travel` resolves to `/modules/_core/time_travel/view.html`.
- A multi-segment route such as `#/author/repo/path` resolves to `/modules/author/repo/path/view.html`.
- If the final route segment already ends in `.html`, the router resolves directly to that file under `/modules/...`.
- Query parameters stay attached to the resolved route target.

## Router-Owned Seams

Current routed shell anchors are:

- `_core/router/shell_start`
- `_core/router/shell_end`
- `page/router/route/start`
- `page/router/route/end`
- `page/router/overlay/start`
- `page/router/overlay/end`

Use those anchors before editing router shell markup directly. Floating UI such as the onscreen agent belongs in the routed overlay anchors.

## Common Module Shape

For a new first-party routed feature, the normal home is:

```text
app/L0/_all/modules/_core/<feature>/
  view.html
  <feature>.css
  store.js
  panel.html or supporting components
  ext/panels/<feature>.yaml when the page should be discoverable from the dashboard
  ext/html/... only when the feature mounts into an existing seam
```

Minimal first-party custom page example:

```text
app/L0/_all/modules/_core/my_tool/
  view.html
  my-tool.css
  store.js
  ext/panels/my-tool.yaml
```

Example panel manifest:

```yaml
name: My Tool
path: my_tool
description: A custom routed tool page.
icon: build
color: "#94bcff"
```

## Panel Helper Script

Reusable helper script:

```js
const panelTools = await import("/modules/_core/skillset/ext/skills/development/modules-routing/panel-tools.js");
```

Available helpers:

- `await panelTools.listPanels()` returns the normalized dashboard panel entries discovered from `ext/panels/*.yaml`, each with `routePath` and ready-to-use `href`
- `await panelTools.findPanel("user")` resolves a panel by visible name, route path, hash route, direct `/modules/...` HTML path, or a panel object returned by `listPanels()`
- `await panelTools.resolvePanelRoutePath("/modules/_core/user/view.html")` normalizes a panel target into its router route path
- `await panelTools.createPanelHref("#/user")` returns the routed href
- `await panelTools.goToPanel("User")` navigates through `space.router` with a hash fallback
- `await panelTools.openPanel(panelEntry)` is an alias for `goToPanel(...)`

Use those helpers when you need to inspect the registered panels before wiring new links or when the user asks to navigate to one of them.

Example:

```js
const panelTools = await import("/modules/_core/skillset/ext/skills/development/modules-routing/panel-tools.js");
const panels = await panelTools.listPanels();
const userPanel = await panelTools.findPanel("/modules/_core/user/view.html");
await panelTools.goToPanel(userPanel ?? "user");
```

## Shell Rules

- `/` is the authenticated app shell and mounts `_core/router`.
- `/admin` is separate and firmware-clamped to `L0`; do not treat it as the default home for user-facing routed features.
- Keep page-shell concerns in the router or page shells and keep feature logic inside the owning module.

## Mandatory Doc Follow-Up

- If route resolution, stable router seams, or the first-party module placement rules change, update the router docs and the `development` skill subtree in the same session.
