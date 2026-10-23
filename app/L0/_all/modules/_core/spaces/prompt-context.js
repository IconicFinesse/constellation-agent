import { SPACES_ROUTE_PATH } from "./constants.js";

export const AVAILABLE_SPACES_TRANSIENT_HEADING = "available spaces";
export const AVAILABLE_SPACES_TRANSIENT_KEY = "spaces/available";
export const CURRENT_SPACE_WIDGETS_TRANSIENT_HEADING = "current space widgets";
export const CURRENT_SPACE_WIDGETS_TRANSIENT_KEY = "spaces/current-space-widgets";
const UNTITLED_SPACE_LABEL = "Untitled";

function normalizeTransientCell(value) {
  return String(value ?? "")
    .replace(/\|/gu, "/")
    .replace(/\s+/gu, " ")
    .trim();
}

function resolveDisplayTitle(value) {
  return normalizeTransientCell(value) || UNTITLED_SPACE_LABEL;
}

function buildAvailableSpaceTransientRow(spaceEntry = {}) {
  const id = normalizeTransientCell(spaceEntry?.id);
  const title = resolveDisplayTitle(spaceEntry?.displayTitle ?? spaceEntry?.title);

  if (!id) {
    return "";
  }

  return `${id}|${title}`;
}

function buildCurrentSpaceWidgetTransientRow(widget = {}) {
  const id = normalizeTransientCell(widget?.id);

  if (!id) {
    return "";
  }

  const name = resolveDisplayTitle(widget?.name);
  const col = Number.isFinite(widget?.col) ? String(widget.col) : "0";
  const row = Number.isFinite(widget?.row) ? String(widget.row) : "0";
  const cols = Number.isFinite(widget?.cols) ? String(widget.cols) : "0";
  const rows = Number.isFinite(widget?.rows) ? String(widget.rows) : "0";
  const state = normalizeTransientCell(widget?.state) || "expanded";
  const renderStatus = normalizeTransientCell(widget?.renderStatus || widget?.render?.status) || "unknown";

  return `${id}|${name}|${col}|${row}|${cols}|${rows}|${state}|${renderStatus}`;
}

export function buildCurrentSpaceContextTags(spaceId = "") {
  const normalizedSpaceId = String(spaceId || "").trim();
  return normalizedSpaceId ? `space:open space:id:${normalizedSpaceId}` : "";
}

export function buildAvailableSpacesTransientSection(options = {}) {
  const rows = (Array.isArray(options.spaceList) ? options.spaceList : [])
    .map((spaceEntry) => buildAvailableSpaceTransientRow(spaceEntry))
    .filter(Boolean);

  return {
    content: [
      "spaces (id|title)↓",
      ...(rows.length ? rows : ["[empty]"])
    ].join("\n"),
    heading: AVAILABLE_SPACES_TRANSIENT_HEADING,
    key: AVAILABLE_SPACES_TRANSIENT_KEY,
    order: 110
  };
}

export function buildCurrentSpaceWidgetsTransientSection(options = {}) {
  const routePath = String(options.routePath || "").trim();
  const currentSpaceId = String(options.currentSpaceId || "").trim();
  const currentSpaceTitle = resolveDisplayTitle(options.currentSpaceTitle);
  const rows = (Array.isArray(options.widgets) ? options.widgets : [])
    .map((widget) => buildCurrentSpaceWidgetTransientRow(widget))
    .filter(Boolean);

  if (routePath !== SPACES_ROUTE_PATH || !currentSpaceId) {
    return null;
  }

  return {
    content: [
      "space id|title",
      `${currentSpaceId}|${currentSpaceTitle}`,
      "",
      "widgets (id|name|col|row|cols|rows|state|render status)↓",
      ...(rows.length ? rows : ["[empty]"])
    ].join("\n"),
    heading: CURRENT_SPACE_WIDGETS_TRANSIENT_HEADING,
    key: CURRENT_SPACE_WIDGETS_TRANSIENT_KEY,
    order: 210
  };
}
