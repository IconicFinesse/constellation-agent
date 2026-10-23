---
name: Screenshots
description: Capture the current page or a DOM target as a PNG
---

Use this skill when the user wants a browser screenshot.

load helper
- Import `/modules/_core/skillset/ext/skills/screenshots/screenshots.js`
- The helper lazy-loads `html2canvas` for you
- Prefer these exports instead of pasting the whole capture script inline
- If you need lower-level control, inspect `/modules/_core/skillset/ext/skills/screenshots/screenshots.js` and pass custom `html2canvasOptions`

helpers
- `await import("/modules/_core/skillset/ext/skills/screenshots/screenshots.js")`
- `takeScreenshot({ target?, filename?, type?, quality?, html2canvasOptions? })` -> `{ canvas, blob, width, height, type, filename }`
- `screenshotBase64(options)` -> `{ base64, width, height, type, filename }`
- `screenshotDownload("name.png", options?)` -> downloads and returns `{ downloaded: true, filename, width, height, type }`

target
- Omit `target` for a full-page `document.body` screenshot
- `target` may be a CSS selector string or a DOM element
- Default file name is `page-content.png`

guidance
- Prefer `screenshotDownload(...)` when the user wants an actual image file
- Use `screenshotBase64(...)` only when JavaScript needs inline image data, because the return value is large

examples
Taking a low-level screenshot result
_____javascript
const screenshots = await import("/modules/_core/skillset/ext/skills/screenshots/screenshots.js")
return await screenshots.takeScreenshot()

Downloading a full-page screenshot
_____javascript
const screenshots = await import("/modules/_core/skillset/ext/skills/screenshots/screenshots.js")
return await screenshots.screenshotDownload("page-content.png")

Capturing a specific panel
_____javascript
const screenshots = await import("/modules/_core/skillset/ext/skills/screenshots/screenshots.js")
return await screenshots.screenshotDownload("panel.png", {
  target: "[data-panel]"
})

Getting base64 image data
_____javascript
const screenshots = await import("/modules/_core/skillset/ext/skills/screenshots/screenshots.js")
return await screenshots.screenshotBase64()
