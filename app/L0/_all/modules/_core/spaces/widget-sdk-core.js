import {
  DEFAULT_WIDGET_SIZE,
  MAX_WIDGET_COLS,
  MAX_WIDGET_ROWS,
  WIDGET_API_VERSION,
  WIDGET_SIZE_PRESETS
} from "/modules/_core/spaces/constants.js";

const WIDGET_FLAG = "__spaceWidgetDefinition";

function clampInteger(value, min, max, fallback) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsedValue));
}

function coerceSizeObject(size, fallbackSize = DEFAULT_WIDGET_SIZE) {
  return {
    cols: clampInteger(size?.cols ?? size?.width, 1, MAX_WIDGET_COLS, fallbackSize.cols),
    rows: clampInteger(size?.rows ?? size?.height, 1, MAX_WIDGET_ROWS, fallbackSize.rows)
  };
}

function resolveFallbackSize(fallback) {
  if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) {
    return coerceSizeObject(fallback, DEFAULT_WIDGET_SIZE);
  }

  if (typeof fallback === "string" || Array.isArray(fallback)) {
    return normalizeWidgetSize(fallback, DEFAULT_WIDGET_SIZE);
  }

  return {
    cols: DEFAULT_WIDGET_SIZE.cols,
    rows: DEFAULT_WIDGET_SIZE.rows
  };
}

export function isWidgetDefinition(value) {
  return Boolean(value?.[WIDGET_FLAG]);
}

export function sizeToToken(size, fallback = DEFAULT_WIDGET_SIZE) {
  const normalizedSize = normalizeWidgetSize(size, fallback);
  return `${normalizedSize.cols}x${normalizedSize.rows}`;
}

export function normalizeWidgetSize(size, fallback = DEFAULT_WIDGET_SIZE) {
  if (typeof size === "string") {
    const normalizedKey = size.trim().toLowerCase();

    if (WIDGET_SIZE_PRESETS[normalizedKey]) {
      return {
        cols: WIDGET_SIZE_PRESETS[normalizedKey].cols,
        preset: normalizedKey,
        rows: WIDGET_SIZE_PRESETS[normalizedKey].rows
      };
    }

    const tokenMatch = normalizedKey.match(/^(\d+)\s*x\s*(\d+)$/u);

    if (tokenMatch) {
      return normalizeWidgetSize(
        {
          cols: tokenMatch[1],
          rows: tokenMatch[2]
        },
        fallback
      );
    }
  }

  if (Array.isArray(size) && size.length >= 2) {
    return normalizeWidgetSize(
      {
        cols: size[0],
        rows: size[1]
      },
      fallback
    );
  }

  if (size && typeof size === "object") {
    return coerceSizeObject(size, resolveFallbackSize(fallback));
  }

  if (fallback !== DEFAULT_WIDGET_SIZE) {
    return normalizeWidgetSize(fallback, DEFAULT_WIDGET_SIZE);
  }

  return {
    cols: DEFAULT_WIDGET_SIZE.cols,
    rows: DEFAULT_WIDGET_SIZE.rows
  };
}

export function parseWidgetSizeToken(value, fallback = DEFAULT_WIDGET_SIZE) {
  const tokenMatch = String(value || "")
    .trim()
    .match(/^(\d+)\s*x\s*(\d+)$/u);

  if (!tokenMatch) {
    return normalizeWidgetSize(fallback, DEFAULT_WIDGET_SIZE);
  }

  return normalizeWidgetSize(
    {
      cols: tokenMatch[1],
      rows: tokenMatch[2]
    },
    fallback
  );
}

export function defineWidget(definition = {}) {
  if (!definition || typeof definition !== "object") {
    throw new Error("Widget definitions must be objects.");
  }

  if (definition.apiVersion !== undefined && Number(definition.apiVersion) !== WIDGET_API_VERSION) {
    throw new Error(
      `Unsupported widget apiVersion "${definition.apiVersion}". Expected ${WIDGET_API_VERSION}.`
    );
  }

  if (typeof definition.render !== "function") {
    throw new Error("Widget definitions must provide a render(ctx) function.");
  }

  if (definition.load !== undefined && typeof definition.load !== "function") {
    throw new Error("Widget load must be a function when provided.");
  }

  return Object.freeze({
    [WIDGET_FLAG]: true,
    apiVersion: WIDGET_API_VERSION,
    load: definition.load,
    render: definition.render,
    size: normalizeWidgetSize(definition.size ?? definition.defaultSize ?? DEFAULT_WIDGET_SIZE),
    title: String(definition.title || "").trim()
  });
}

export { DEFAULT_WIDGET_SIZE };
