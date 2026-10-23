---
name: PDF Report
description: Create and download browser-generated PDFs from structured data or HTML
metadata:
  when:
    tags:
      - onscreen
---

Use this skill when the user wants a browser-generated PDF report, a downloaded PDF summary, or a PDF built from structured data or custom HTML.

load helper
- Import `/modules/_core/skillset/ext/skills/pdf-report/pdf-report.js`
- Prefer the helper instead of hand-writing raw `%PDF` strings
- The helper renders HTML and CSS to canvas, converts that into a valid downloadable PDF, and also exposes a structured report builder

helpers
- `await import("/modules/_core/skillset/ext/skills/pdf-report/pdf-report.js")`
- `buildReportHtml(report)` -> `{ html, css, backgroundColor, widthPx }`
- `createPdfFromReport({ report, ...options })` -> `Uint8Array`
- `downloadPdfFromReport({ report, filename?, page?, widthPx?, scale?, jpegQuality?, html2canvasOptions? })` -> `{ downloaded: true, filename, byteLength }`
- `createPdfFromHtml({ html, css?, widthPx?, backgroundColor?, page?, scale?, jpegQuality?, html2canvasOptions? })` -> `Uint8Array`
- `downloadPdfFromHtml({ html, css?, filename?, widthPx?, backgroundColor?, page?, scale?, jpegQuality?, html2canvasOptions? })` -> `{ downloaded: true, filename, byteLength }`
- `downloadPdfBytes(bytes, filename?)` -> `{ downloaded: true, filename, byteLength }`

structured report shape
- `report.title`, `eyebrow`, `subtitle`, `summary`, `introHtml`, `footer`, `widthPx`, `filename`
- `report.sections[]` may use `title`, `eyebrow`, `text`, `items`, `metrics`, `cards`, `columns`, and raw `html`
- `report.theme` may override `accentColor`, `backgroundColor`, `borderColor`, `surfaceColor`, `textColor`, `mutedColor`, `fontFamily`, and `customCss`

pdf and html options
- `page.size`: `letter` or `a4`
- `page.orientation`: `portrait` or `landscape`
- `page.marginPt`
- `widthPx`, `backgroundColor`, `scale`, `jpegQuality`, `filename`

guidance
- Use `downloadPdfFromReport(...)` when the user wants a clean report quickly from structured data
- Use `downloadPdfFromHtml(...)` when the user wants a custom visual direction or tighter markup control
- Change theme colors, typography, section structure, cards, columns, and raw HTML to match the request; do not reuse one canned layout unless the user asked for it
- Keep the HTML self-contained and pass any extra styling through `css` or `report.theme.customCss`
- After the download starts, answer the user with a brief summary

examples
Downloading a structured PDF report
_____javascript
const pdfReport = await import("/modules/_core/skillset/ext/skills/pdf-report/pdf-report.js")
return await pdfReport.downloadPdfFromReport({
  filename: "project-status.pdf",
  report: {
    title: "Project Status",
    eyebrow: "Sprint 14",
    subtitle: "Frontend runtime workstream",
    summary: "The helper move is complete and the remaining work is doc cleanup.",
    theme: {
      accentColor: "#0b6bcb",
      backgroundColor: "#eef5ff",
      surfaceColor: "#ffffff"
    },
    sections: [
      {
        title: "Highlights",
        items: [
          "Skill-specific helpers now live inside their owning skill folders.",
          "PDF output is built from generic HTML and CSS instead of a canned weather wrapper."
        ]
      },
      {
        title: "Counts",
        metrics: [
          { label: "Open items", value: "2" },
          { label: "Blocked", value: "0" }
        ]
      }
    ],
    footer: "Generated locally in the browser."
  }
})

Downloading a custom HTML PDF
_____javascript
const pdfReport = await import("/modules/_core/skillset/ext/skills/pdf-report/pdf-report.js")
return await pdfReport.downloadPdfFromHtml({
  filename: "brief.pdf",
  widthPx: 900,
  page: { size: "a4", marginPt: 28 },
  css: `
    .brief { padding: 48px; font-family: Georgia, serif; color: #1f2937; }
    .brief h1 { margin: 0 0 12px; font-size: 36px; }
    .brief .lede { font-size: 18px; color: #4b5563; }
  `,
  html: `
    <article class="brief">
      <h1>Research Brief</h1>
      <p class="lede">This layout is fully custom HTML and CSS.</p>
      <p>Use this path when the user wants a specific art direction instead of the built-in structured report layout.</p>
    </article>
  `
})
