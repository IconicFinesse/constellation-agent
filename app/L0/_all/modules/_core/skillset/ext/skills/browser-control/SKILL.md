---
name: Browser Control
description: Inspect, navigate, and interact with open browser surfaces through space.browser
metadata:
  placement: system
  when:
    tags:
      - onscreen
  loaded:
    tags:
      - onscreen
      - browser:open
---

Use this skill once at least one browser surface is open. `browser-manager` handles stand-alone window open or close work.

transient
- `currently open web browsers` lists `browser id|url|title`
- `last interacted web browser` may include fresh `page content↓` with typed ref markers such as `[link 12]`, `[button 18]`, `[image 24]`, or `[input text 30]`

workflow
- pick the target from transient or an explicit numeric browser id such as `1`
- `space.browser` helpers already settle navigation state internally; do not call a separate sync step
- open, navigate, history, reload, `state(...)`, `content(...)`, `detail(...)`, and `dom(...)` settle internally and return fresh read results without a separate sync step, and `evaluate(...)` still resolves a ready guest without requiring a separate sync step first
- ref-targeted action helpers such as `click`, `type`, `submit`, `typeSubmit`, and `scroll` return `{ action, state }`; inspect `result.action.status` before retrying
- `open(...)` and typed `navigate(...)` treat bare hosts like `novinky.cz` or `localhost:3000` as browser-address input instead of app-relative paths
- widget or page-authored `<x-browser src="google.com"></x-browser>` surfaces appear in the same browser list as stand-alone windows
- inspection helpers such as `content(...)`, `detail(...)`, `dom(...)`, and `state(...)` also settle internally and mark that browser as the current prompt-time page-content source
- prefer the fresh `last interacted web browser` transient block after open, navigate, history, reload, and ref-targeted actions before asking for another explicit `content(...)` capture
- use `content(...)` to get readable page content with stable typed refs for the latest capture; unlike `dom(...)`, it should stay cleaned up for agent use and should not include raw helper wrapper markup from nested frames or shadow roots
- `dom(...)` and `content(...)` accept either `{ selector: "..." }` or `{ selectors: ["...", "..."] }` when you want a scoped read instead of the whole page
- `content(...)` is lean by default to save tokens: it uses typed ref boxes like `[link 12] Story`, `[disabled muted button 18] Continue`, `[checked checkbox 7] Email updates`, or `[input text 30] Search placeholder=Hledat value=Ethereum`, omits link destinations, omits quotes around labels, and omits list bullets while keeping list indentation
- those refs also cover generic controls wired through framework or inline handlers such as `@click`, `x-on:click`, `v-on:click`, or `onclick`
- state and semantic tags are best-effort hints, not absolute truth; use `detail(id, ref)` when actionability is unclear
- if you need flatter output, `content(id, { includeStateTags: false, includeSemanticTags: false })` suppresses those extra bracket tags
- images also get refs now, so `detail(id, ref)` works for image targets too
- if a specific link or image target matters, prefer `detail(id, ref)` on that reference instead of asking `content(...)` to print every `-> url`
- use `detail(...)` for deeper DOM on one ref before acting, and use it to inspect a link's real `href`, an image source, another referenced DOM target, or richer state metadata when the destination or actionability matters
- use `click`, `type`, `submit`, `typeSubmit`, and `scroll` only with refs from the latest `content(...)` capture
- `typeSubmit(...)` types into the field and then presses Enter in that same field
- any new `content(...)` call or navigation replaces the old ref ids
- prefer high-level helpers first; use `evaluate(id, script)` or `send(id, "evaluate", { script })` only as a last resort when refs or navigation helpers cannot express the step, and remember that the last evaluated expression or resolved promise value becomes the result
- if `result.action.status.noObservedEffect === true`, stop retrying the same action and re-read the page or inspect the relevant control with `detail(...)`
- treat `validationTextAdded`, `nearbyTextChanged`, `descriptorChanged`, `valueChanged`, `checkedChanged`, `selectedChanged`, and `semanticHints` as evidence about what the page did after your action
- use numeric ids like `1`, not `browser-1`

main helpers
- discovery: list(), ids(), count(), has(id), state(id)
- navigation: navigate(id, url), reload(id), back(id), forward(id)
- inspection: dom(id, payload?), content(id, payload?), detail(id, referenceId), evaluate(id, scriptOrPayload)
- interaction: click(id, ref), type(id, ref, value), submit(id, ref), typeSubmit(id, ref, value), scroll(id, ref)
- escape hatch: send(id, type, payload?)

runtime notes
- in the packaged native app, bridge-backed reads and ref actions work through the injected browser runtime
- in ordinary browser sessions, guarded calls return a structured warning object and also log the same warning text to the console instead of partial native-only behavior

examples
Checking browser 1 now
_____javascript
return await space.browser.state(1)

Reading refs from browser 1 now
_____javascript
return await space.browser.content(1, {
  selectors: ["main", "article"]
})

Reading one scoped region now
_____javascript
return await space.browser.dom(1, {
  selector: "[role='tab'], .nav-link, .tab, button"
})

Inspecting one link target now
_____javascript
return await space.browser.detail(1, 79)

Opting into fuller link-heavy output now
_____javascript
return await space.browser.content(1, {
  includeLinkUrls: true,
  includeLabelQuotes: true,
  includeListMarkers: true
})

Opening the first referenced result now
_____javascript
const content = await space.browser.content(1)
console.log(content.document)
return await space.browser.click(1, 79)

Typing into the active search box now
_____javascript
const content = await space.browser.content(1)
console.log(content.document)
return await space.browser.typeSubmit(1, 79, "Constellation Agent")

Running a last-resort page script now
_____javascript
return await space.browser.evaluate(1, `
  const target = [...document.querySelectorAll("*")]
    .find((element) => element.textContent.trim() === "Update")
  if (!target) {
    "no update tab found"
  } else {
    target.click()
    "clicked: " + target.tagName
  }
`)
