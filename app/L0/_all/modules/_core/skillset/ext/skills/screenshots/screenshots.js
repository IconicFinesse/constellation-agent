const DEFAULT_FILENAME = "page-content.png";
const DEFAULT_TYPE = "image/png";
const HTML2CANVAS_SRC = "/modules/_core/skillset/vendor/html2canvas.min.js";

let html2canvasPromise = null;

function isElement(value) {
  return typeof Element !== "undefined" && value instanceof Element;
}

function normalizeFilename(filename) {
  const value = String(filename || "").trim();
  return value || DEFAULT_FILENAME;
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

export async function ensureHtml2Canvas() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Screenshot helpers require a browser window.");
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

function resolveTarget(target) {
  if (!target) {
    return document.body;
  }

  if (typeof target === "string") {
    const element = document.querySelector(target);

    if (!element) {
      throw new Error(`Screenshot target not found: ${target}`);
    }

    return element;
  }

  if (isElement(target)) {
    return target;
  }

  throw new Error("Screenshot target must be a selector string or DOM element.");
}

function isPageTarget(target) {
  return target === document.body || target === document.documentElement;
}

function buildDefaultHtml2CanvasOptions(target) {
  if (!isPageTarget(target)) {
    return {
      backgroundColor: null,
      useCORS: true
    };
  }

  const root = document.documentElement;
  const body = document.body;

  return {
    backgroundColor: null,
    scrollX: 0,
    scrollY: -window.scrollY,
    useCORS: true,
    windowHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight),
    windowWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0, root.clientWidth)
  };
}

async function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Unable to serialize screenshot canvas."));
        return;
      }

      resolve(blob);
    }, type, quality);
  });
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Unable to read screenshot blob."));
    reader.readAsDataURL(blob);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function renderScreenshotCanvas(options = {}) {
  const html2canvas = await ensureHtml2Canvas();
  const {
    target: rawTarget,
    html2canvasOptions = {}
  } = options && typeof options === "object" ? options : {};
  const target = resolveTarget(rawTarget);

  return html2canvas(target, {
    ...buildDefaultHtml2CanvasOptions(target),
    ...html2canvasOptions
  });
}

export async function takeScreenshot(options = {}) {
  const {
    filename,
    quality,
    type = DEFAULT_TYPE
  } = options && typeof options === "object" ? options : {};
  const canvas = await renderScreenshotCanvas(options);
  const blob = await canvasToBlob(canvas, type, quality);
  const resolvedFilename = normalizeFilename(filename);

  return {
    blob,
    canvas,
    filename: resolvedFilename,
    height: canvas.height,
    type,
    width: canvas.width
  };
}

export async function screenshotBase64(options = {}) {
  const result = await takeScreenshot(options);
  const base64 = await blobToDataUrl(result.blob);

  return {
    base64,
    filename: result.filename,
    height: result.height,
    type: result.type,
    width: result.width
  };
}

export async function screenshotDownload(filenameOrOptions, maybeOptions = {}) {
  const options =
    typeof filenameOrOptions === "string" || filenameOrOptions == null
      ? { ...maybeOptions, filename: filenameOrOptions || maybeOptions.filename }
      : { ...(filenameOrOptions || {}) };
  const result = await takeScreenshot(options);

  downloadBlob(result.blob, result.filename);

  return {
    downloaded: true,
    filename: result.filename,
    height: result.height,
    type: result.type,
    width: result.width
  };
}
