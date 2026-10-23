---
name: Browser Manager
description: Open or close stand-alone browser windows
metadata:
  placement: system
  when:
    tags:
      - onscreen
  loaded:
    tags:
      - onscreen
---

Use this skill for browser window management on the onscreen agent

transient
- `currently open web browsers` in `_____transient` lists `browser id|url|title` for stand-alone and inline browser surfaces

main helpers
- space.browser.open(urlOrOptions?)
- space.browser.create(urlOrOptions?) = same as open(...)
- space.browser.close(id)
- space.browser.closeAll()
- space.browser.list(), ids(), count(), has(id), state(id)

rules
- visiting another website means open or navigate a stand-alone browser window, never leave the current runtime page
- use numeric browser ids like `1`
- prefer the transient browser list or `space.browser.list()` over guessing ids
- when at least one browser surface is open, the full auto-loaded `browser-control` skill covers navigation, page reads, refs, clicks, typing, and history actions

examples
Opening a browser window now
_____javascript
return await space.browser.open("https://example.com")

Closing browser 1 now
_____javascript
return space.browser.close(1)

Closing all browser windows now
_____javascript
return {
  closed: space.browser.closeAll()
}
