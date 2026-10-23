const HTML2CANVAS_SRC = "/modules/_core/skillset/vendor/html2canvas.min.js";
const DEFAULT_FILENAME = "report.pdf";
const DEFAULT_WIDTH_PX = 816;
const DEFAULT_SCALE = 2;
const DEFAULT_JPEG_QUALITY = 0.92;
const PAGE_PRESETS = {
  a4: { widthPt: 595.276, heightPt: 841.89 },
  letter: { widthPt: 612, heightPt: 792 }
};
const PDF_ENCODER = new TextEncoder();
const DEFAULT_THEME = {
  accentColor: "#2b6ef2",
  backgroundColor: "#f4f7fb",
  borderColor: "#d8e1ee",
  fontFamily: "\"Segoe UI\", system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  mutedColor: "#5b6475",
  surfaceColor: "#ffffff",
  textColor: "#172033"
};

let html2canvasPromise = null;

function clampNumber(value, min, max, fallback) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numericValue));
}

function normalizeFilename(filename, fallback = DEFAULT_FILENAME) {
  const normalizedValue = String(filename ?? "")
    .replace(/[\\/:*?"<>|]+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .trim();
  const baseName = normalizedValue || fallback.replace(/\.pdf$/u, "");
  return baseName.toLowerCase().endsWith(".pdf") ? baseName : `${baseName}.pdf`;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizeParagraphText(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => normalizeText(line))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function escapeCssValue(value, fallback) {
  const normalizedValue = normalizeText(value || fallback);
  return normalizedValue || fallback;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    script.src = src;
    document.head.appendChild(script);
  });
}

async function ensureHtml2Canvas() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("PDF report helpers require a browser window.");
  }

  if (window.html2canvas) {
    return window.html2canvas;
  }

  if (!html2canvasPromise) {
    html2canvasPromise = loadScript(HTML2CANVAS_SRC)
      .then(() => {
        if (!window.html2canvas) {
          throw new Error("html2canvas did not register on window.");
        }

        return window.html2canvas;
      })
      .catch((error) => {
        html2canvasPromise = null;
        throw error;
      });
  }

  return html2canvasPromise;
}

function normalizeTheme(theme = {}) {
  return {
    accentColor: escapeCssValue(theme.accentColor, DEFAULT_THEME.accentColor),
    backgroundColor: escapeCssValue(theme.backgroundColor, DEFAULT_THEME.backgroundColor),
    borderColor: escapeCssValue(theme.borderColor, DEFAULT_THEME.borderColor),
    customCss: String(theme.customCss ?? "").trim(),
    fontFamily: escapeCssValue(theme.fontFamily, DEFAULT_THEME.fontFamily),
    mutedColor: escapeCssValue(theme.mutedColor, DEFAULT_THEME.mutedColor),
    surfaceColor: escapeCssValue(theme.surfaceColor, DEFAULT_THEME.surfaceColor),
    textColor: escapeCssValue(theme.textColor, DEFAULT_THEME.textColor)
  };
}

function renderMetric(metric) {
  const label = normalizeText(metric?.label);
  const value = normalizeText(metric?.value);

  if (!label && !value) {
    return "";
  }

  return `
    <div class="pdf-report-metric">
      ${label ? `<div class="pdf-report-metric-label">${escapeHtml(label)}</div>` : ""}
      ${value ? `<div class="pdf-report-metric-value">${escapeHtml(value)}</div>` : ""}
    </div>
  `;
}

function renderCard(card) {
  const icon = normalizeText(card?.icon);
  const eyebrow = normalizeText(card?.eyebrow);
  const title = normalizeText(card?.title);
  const value = normalizeText(card?.value);
  const text = normalizeParagraphText(card?.text);
  const accentColor = normalizeText(card?.accentColor);
  const styleAttribute = accentColor
    ? ` style="--pdf-report-card-accent:${escapeHtml(accentColor)};"`
    : "";

  if (!icon && !eyebrow && !title && !value && !text) {
    return "";
  }

  return `
    <article class="pdf-report-card"${styleAttribute}>
      ${icon ? `<div class="pdf-report-card-icon">${escapeHtml(icon)}</div>` : ""}
      ${eyebrow ? `<div class="pdf-report-card-eyebrow">${escapeHtml(eyebrow)}</div>` : ""}
      ${title ? `<h3 class="pdf-report-card-title">${escapeHtml(title)}</h3>` : ""}
      ${value ? `<div class="pdf-report-card-value">${escapeHtml(value)}</div>` : ""}
      ${text ? `<p class="pdf-report-card-text">${escapeHtml(text).replace(/\n/gu, "<br>")}</p>` : ""}
    </article>
  `;
}

function renderList(items) {
  const normalizedItems = ensureArray(items).map((item) => normalizeText(item)).filter(Boolean);

  if (!normalizedItems.length) {
    return "";
  }

  return `
    <ul class="pdf-report-list">
      ${normalizedItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
  `;
}

function renderSectionContent(section) {
  const text = normalizeParagraphText(section?.text);
  const html = String(section?.html ?? "").trim();
  const metricsMarkup = ensureArray(section?.metrics).map(renderMetric).filter(Boolean).join("");
  const cardsMarkup = ensureArray(section?.cards).map(renderCard).filter(Boolean).join("");
  const listMarkup = renderList(section?.items);

  return [
    text ? `<p class="pdf-report-section-text">${escapeHtml(text).replace(/\n/gu, "<br>")}</p>` : "",
    listMarkup,
    metricsMarkup ? `<div class="pdf-report-metric-grid">${metricsMarkup}</div>` : "",
    cardsMarkup ? `<div class="pdf-report-card-grid">${cardsMarkup}</div>` : "",
    html ? `<div class="pdf-report-raw-html">${html}</div>` : ""
  ]
    .filter(Boolean)
    .join("");
}

function renderColumn(column) {
  const title = normalizeText(column?.title);
  const eyebrow = normalizeText(column?.eyebrow);
  const contentMarkup = renderSectionContent(column);

  if (!title && !eyebrow && !contentMarkup) {
    return "";
  }

  return `
    <div class="pdf-report-column">
      ${eyebrow ? `<div class="pdf-report-section-eyebrow">${escapeHtml(eyebrow)}</div>` : ""}
      ${title ? `<h3 class="pdf-report-column-title">${escapeHtml(title)}</h3>` : ""}
      ${contentMarkup}
    </div>
  `;
}

function renderSection(section) {
  const title = normalizeText(section?.title);
  const eyebrow = normalizeText(section?.eyebrow);
  const columnsMarkup = ensureArray(section?.columns).map(renderColumn).filter(Boolean).join("");
  const contentMarkup = renderSectionContent(section);

  if (!title && !eyebrow && !columnsMarkup && !contentMarkup) {
    return "";
  }

  return `
    <section class="pdf-report-section">
      ${eyebrow ? `<div class="pdf-report-section-eyebrow">${escapeHtml(eyebrow)}</div>` : ""}
      ${title ? `<h2 class="pdf-report-section-title">${escapeHtml(title)}</h2>` : ""}
      ${contentMarkup}
      ${columnsMarkup ? `<div class="pdf-report-column-grid">${columnsMarkup}</div>` : ""}
    </section>
  `;
}

export function buildReportHtml(report = {}) {
  const theme = normalizeTheme(report.theme);
  const title = normalizeText(report.title || "Report");
  const eyebrow = normalizeText(report.eyebrow);
  const subtitle = normalizeParagraphText(report.subtitle);
  const summary = normalizeParagraphText(report.summary);
  const introHtml = String(report.introHtml ?? "").trim();
  const footer = normalizeParagraphText(report.footer);
  const sectionsMarkup = ensureArray(report.sections).map(renderSection).filter(Boolean).join("");
  const widthPx = clampNumber(report.widthPx, 480, 1600, DEFAULT_WIDTH_PX);
  const rootHtml = `
    <article class="pdf-report-root">
      <header class="pdf-report-header">
        ${eyebrow ? `<div class="pdf-report-header-eyebrow">${escapeHtml(eyebrow)}</div>` : ""}
        <h1 class="pdf-report-title">${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="pdf-report-subtitle">${escapeHtml(subtitle).replace(/\n/gu, "<br>")}</p>` : ""}
      </header>
      ${summary ? `<section class="pdf-report-summary">${escapeHtml(summary).replace(/\n/gu, "<br>")}</section>` : ""}
      ${introHtml ? `<section class="pdf-report-intro">${introHtml}</section>` : ""}
      ${sectionsMarkup}
      ${footer ? `<footer class="pdf-report-footer">${escapeHtml(footer).replace(/\n/gu, "<br>")}</footer>` : ""}
    </article>
  `;
  const css = `
    .pdf-report-capture-root,
    .pdf-report-capture-root * {
      box-sizing: border-box;
    }

    .pdf-report-capture-root {
      width: ${widthPx}px;
      margin: 0;
      padding: 40px;
      background: ${theme.backgroundColor};
      color: ${theme.textColor};
      font-family: ${theme.fontFamily};
    }

    .pdf-report-root {
      display: grid;
      gap: 22px;
      width: 100%;
    }

    .pdf-report-header,
    .pdf-report-summary,
    .pdf-report-section,
    .pdf-report-intro,
    .pdf-report-footer {
      border: 1px solid ${theme.borderColor};
      border-radius: 24px;
      background: ${theme.surfaceColor};
      overflow: hidden;
    }

    .pdf-report-header {
      display: grid;
      gap: 12px;
      padding: 34px;
      color: #ffffff;
      border: none;
      background:
        radial-gradient(circle at top right, rgba(255,255,255,0.22), transparent 38%),
        linear-gradient(135deg, ${theme.accentColor}, ${theme.textColor});
    }

    .pdf-report-header-eyebrow,
    .pdf-report-section-eyebrow,
    .pdf-report-card-eyebrow {
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-size: 11px;
      font-weight: 700;
    }

    .pdf-report-title,
    .pdf-report-section-title,
    .pdf-report-column-title,
    .pdf-report-card-title {
      margin: 0;
      line-height: 1.08;
    }

    .pdf-report-title {
      font-size: 34px;
      font-weight: 800;
    }

    .pdf-report-subtitle,
    .pdf-report-summary,
    .pdf-report-section-text,
    .pdf-report-card-text,
    .pdf-report-footer {
      line-height: 1.55;
      font-size: 15px;
    }

    .pdf-report-summary,
    .pdf-report-intro,
    .pdf-report-footer {
      padding: 24px 28px;
    }

    .pdf-report-section {
      display: grid;
      gap: 18px;
      padding: 28px;
    }

    .pdf-report-section-title {
      font-size: 24px;
      font-weight: 760;
      color: ${theme.textColor};
    }

    .pdf-report-section-text,
    .pdf-report-subtitle,
    .pdf-report-card-text,
    .pdf-report-footer,
    .pdf-report-list {
      margin: 0;
      color: ${theme.mutedColor};
    }

    .pdf-report-list {
      display: grid;
      gap: 10px;
      padding-left: 20px;
      font-size: 15px;
      line-height: 1.5;
    }

    .pdf-report-metric-grid,
    .pdf-report-card-grid,
    .pdf-report-column-grid {
      display: grid;
      gap: 16px;
    }

    .pdf-report-metric-grid {
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    }

    .pdf-report-card-grid,
    .pdf-report-column-grid {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }

    .pdf-report-metric,
    .pdf-report-card,
    .pdf-report-column {
      border: 1px solid ${theme.borderColor};
      border-radius: 18px;
      background: rgba(255,255,255,0.74);
    }

    .pdf-report-metric {
      display: grid;
      gap: 8px;
      padding: 18px;
    }

    .pdf-report-metric-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: ${theme.mutedColor};
    }

    .pdf-report-metric-value {
      font-size: 28px;
      font-weight: 800;
      color: ${theme.textColor};
      line-height: 1;
    }

    .pdf-report-card {
      --pdf-report-card-accent: ${theme.accentColor};
      display: grid;
      gap: 10px;
      padding: 18px;
      border-top: 4px solid var(--pdf-report-card-accent);
    }

    .pdf-report-card-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      min-height: 42px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--pdf-report-card-accent) 14%, white);
      color: var(--pdf-report-card-accent);
      font-size: 20px;
      font-weight: 700;
    }

    .pdf-report-card-value {
      font-size: 26px;
      font-weight: 800;
      color: ${theme.textColor};
      line-height: 1;
    }

    .pdf-report-column {
      display: grid;
      gap: 14px;
      padding: 18px;
    }

    .pdf-report-column-title,
    .pdf-report-card-title {
      font-size: 19px;
      font-weight: 760;
      color: ${theme.textColor};
    }

    .pdf-report-raw-html > *:first-child {
      margin-top: 0;
    }

    .pdf-report-raw-html > *:last-child {
      margin-bottom: 0;
    }

    ${theme.customCss}
  `.trim();

  return {
    backgroundColor: theme.backgroundColor,
    css,
    html: rootHtml,
    widthPx
  };
}

function concatUint8Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

function encodeString(value) {
  return PDF_ENCODER.encode(String(value ?? ""));
}

function dataUrlToBytes(dataUrl) {
  const [, metadata = "", base64 = ""] = String(dataUrl ?? "").match(/^data:([^;]+);base64,(.+)$/u) || [];

  if (!metadata || !base64) {
    throw new Error("Expected a base64 data URL.");
  }

  const binary = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return {
    bytes,
    mimeType: metadata
  };
}

function createPdfObject(id, body) {
  const bodyChunks = Array.isArray(body) ? body : [encodeString(body)];
  return concatUint8Arrays([
    encodeString(`${id} 0 obj\n`),
    ...bodyChunks,
    encodeString("\nendobj\n")
  ]);
}

function formatPdfNumber(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return "0";
  }

  if (Math.abs(numericValue) < 0.0005) {
    return "0";
  }

  const roundedValue = Math.round(numericValue * 1000) / 1000;
  return Number.isInteger(roundedValue)
    ? String(roundedValue)
    : roundedValue.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function normalizePageOptions(page = {}) {
  const preset = PAGE_PRESETS[String(page.size || "letter").toLowerCase()] || PAGE_PRESETS.letter;
  const orientation = String(page.orientation || "portrait").toLowerCase();
  const portraitWidth = preset.widthPt;
  const portraitHeight = preset.heightPt;
  const widthPt = orientation === "landscape" ? portraitHeight : portraitWidth;
  const heightPt = orientation === "landscape" ? portraitWidth : portraitHeight;
  const marginPt = clampNumber(page.marginPt, 12, 96, 36);

  return {
    contentHeightPt: heightPt - marginPt * 2,
    contentWidthPt: widthPt - marginPt * 2,
    heightPt,
    marginPt,
    widthPt
  };
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function waitForStageAssets(stage) {
  await nextFrame();

  const images = [...stage.querySelectorAll("img")];

  await Promise.all(
    images.map(
      (image) =>
        new Promise((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }

          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        })
    )
  );

  if (document.fonts?.ready) {
    await Promise.race([
      document.fonts.ready,
      new Promise((resolve) => setTimeout(resolve, 1200))
    ]);
  }
}

function createOffscreenStage({ html, css = "", widthPx = DEFAULT_WIDTH_PX, backgroundColor = "#ffffff" }) {
  if (typeof document === "undefined") {
    throw new Error("PDF report helpers require a browser document.");
  }

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.left = "-200vw";
  host.style.top = "0";
  host.style.width = `${widthPx}px`;
  host.style.margin = "0";
  host.style.padding = "0";
  host.style.opacity = "1";
  host.style.pointerEvents = "none";
  host.style.zIndex = "-1";
  host.innerHTML = `
    <style>
      .pdf-report-capture-root {
        width: ${widthPx}px;
        margin: 0;
        padding: 0;
        background: ${backgroundColor};
      }
      ${css}
    </style>
    <div class="pdf-report-capture-root">${html}</div>
  `;
  document.body.appendChild(host);

  const stage = host.querySelector(".pdf-report-capture-root");

  if (!stage) {
    host.remove();
    throw new Error("Unable to mount PDF capture stage.");
  }

  return {
    host,
    stage
  };
}

async function renderHtmlToCanvas({ html, css, widthPx, backgroundColor, scale, html2canvasOptions }) {
  const html2canvas = await ensureHtml2Canvas();
  const { host, stage } = createOffscreenStage({
    backgroundColor,
    css,
    html,
    widthPx
  });

  try {
    await waitForStageAssets(stage);

    return await html2canvas(stage, {
      backgroundColor,
      height: stage.scrollHeight,
      scale,
      useCORS: true,
      width: stage.scrollWidth,
      windowHeight: stage.scrollHeight,
      windowWidth: stage.scrollWidth,
      ...html2canvasOptions
    });
  } finally {
    host.remove();
  }
}

function sliceCanvasIntoImages(canvas, pageOptions, options = {}) {
  const backgroundColor = String(options.backgroundColor || "#ffffff");
  const jpegQuality = clampNumber(options.jpegQuality, 0.4, 0.98, DEFAULT_JPEG_QUALITY);
  const pixelsPerPoint = canvas.width / pageOptions.contentWidthPt;
  const sliceHeightPx = Math.max(1, Math.floor(pageOptions.contentHeightPt * pixelsPerPoint));
  const pages = [];

  for (let offsetY = 0; offsetY < canvas.height; offsetY += sliceHeightPx) {
    const heightPx = Math.min(sliceHeightPx, canvas.height - offsetY);
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = canvas.width;
    pageCanvas.height = heightPx;

    const context = pageCanvas.getContext("2d");

    if (!context) {
      throw new Error("Unable to create PDF page canvas.");
    }

    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    context.drawImage(
      canvas,
      0,
      offsetY,
      canvas.width,
      heightPx,
      0,
      0,
      pageCanvas.width,
      pageCanvas.height
    );

    const dataUrl = pageCanvas.toDataURL("image/jpeg", jpegQuality);
    const { bytes, mimeType } = dataUrlToBytes(dataUrl);

    pages.push({
      bytes,
      displayHeightPt: heightPx / pixelsPerPoint,
      displayWidthPt: pageOptions.contentWidthPt,
      mimeType,
      pixelHeight: heightPx,
      pixelWidth: canvas.width
    });
  }

  return pages;
}

function buildPdfFromImages(images, pageOptions) {
  const objects = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;

  const pageRefs = [];
  let nextObjectId = 3;

  for (const image of images) {
    const pageId = nextObjectId;
    const contentId = nextObjectId + 1;
    const imageId = nextObjectId + 2;
    const contentX = pageOptions.marginPt;
    const contentY = pageOptions.heightPt - pageOptions.marginPt - image.displayHeightPt;
    const imageName = "/Im1";
    const contentStream = encodeString(
      `q ${formatPdfNumber(image.displayWidthPt)} 0 0 ${formatPdfNumber(image.displayHeightPt)} ${formatPdfNumber(contentX)} ${formatPdfNumber(contentY)} cm ${imageName} Do Q`
    );

    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatPdfNumber(pageOptions.widthPt)} ${formatPdfNumber(pageOptions.heightPt)}] /Resources << /ProcSet [/PDF /ImageC] /XObject << ${imageName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = [
      encodeString(`<< /Length ${contentStream.length} >>\nstream\n`),
      contentStream,
      encodeString("\nendstream")
    ];
    objects[imageId] = [
      encodeString(`<< /Type /XObject /Subtype /Image /Width ${image.pixelWidth} /Height ${image.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`),
      image.bytes,
      encodeString("\nendstream")
    ];

    pageRefs.push(`${pageId} 0 R`);
    nextObjectId += 3;
  }

  objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pageRefs.length} >>`;

  const chunks = [encodeString("%PDF-1.4\n")];
  const offsets = [0];
  let currentOffset = chunks[0].length;

  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    offsets[objectId] = currentOffset;
    const objectBytes = createPdfObject(objectId, objects[objectId]);
    chunks.push(objectBytes);
    currentOffset += objectBytes.length;
  }

  const xrefOffset = currentOffset;
  const xrefLines = [
    "xref",
    `0 ${objects.length}`,
    "0000000000 65535 f "
  ];

  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    xrefLines.push(`${String(offsets[objectId]).padStart(10, "0")} 00000 n `);
  }

  chunks.push(
    encodeString(
      `${xrefLines.join("\n")}\ntrailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    )
  );

  return concatUint8Arrays(chunks);
}

export async function createPdfFromHtml(options = {}) {
  const html = String(options.html ?? "").trim();

  if (!html) {
    throw new Error("createPdfFromHtml(...) requires html.");
  }

  const pageOptions = normalizePageOptions(options.page);
  const canvas = await renderHtmlToCanvas({
    backgroundColor: String(options.backgroundColor || "#ffffff"),
    css: String(options.css ?? ""),
    html,
    html2canvasOptions:
      options.html2canvasOptions && typeof options.html2canvasOptions === "object"
        ? options.html2canvasOptions
        : {},
    scale: clampNumber(options.scale, 1, 3, DEFAULT_SCALE),
    widthPx: clampNumber(options.widthPx, 320, 1600, DEFAULT_WIDTH_PX)
  });
  const images = sliceCanvasIntoImages(canvas, pageOptions, {
    backgroundColor: String(options.backgroundColor || "#ffffff"),
    jpegQuality: options.jpegQuality
  });

  return buildPdfFromImages(images, pageOptions);
}

export async function createPdfFromReport(options = {}) {
  const builtReport = buildReportHtml(options.report || {});

  return createPdfFromHtml({
    ...options,
    backgroundColor: options.backgroundColor || builtReport.backgroundColor,
    css: `${builtReport.css}\n${String(options.css ?? "").trim()}`.trim(),
    html: builtReport.html,
    widthPx: options.widthPx || builtReport.widthPx
  });
}

export function downloadPdfBytes(bytes, filename = DEFAULT_FILENAME) {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") {
    throw new Error("Browser download APIs are not available.");
  }

  const safeFilename = normalizeFilename(filename, DEFAULT_FILENAME);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = objectUrl;
  anchor.download = safeFilename;
  anchor.rel = "noopener";
  document.body?.appendChild(anchor);
  anchor.click();
  anchor.remove();

  globalThis.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);

  return {
    byteLength: bytes.length,
    downloaded: true,
    filename: safeFilename
  };
}

export async function downloadPdfFromHtml(options = {}) {
  const bytes = await createPdfFromHtml(options);
  return downloadPdfBytes(bytes, options.filename || DEFAULT_FILENAME);
}

export async function downloadPdfFromReport(options = {}) {
  const bytes = await createPdfFromReport(options);
  const fallbackFilename = options.report?.filename || DEFAULT_FILENAME;
  return downloadPdfBytes(bytes, options.filename || fallbackFilename);
}
