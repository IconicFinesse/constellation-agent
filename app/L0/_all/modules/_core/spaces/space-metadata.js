import {
  loadMaterialSymbolNames as loadMaterialSymbolNamesFromVisual,
  normalizeIconHexColor,
  normalizeMaterialSymbolName
} from "/modules/_core/visual/icons/material-symbols.js";

export const UNTITLED_SPACE_LABEL = "Untitled";
export const DEFAULT_SPACE_ICON = "space_dashboard";
export const DEFAULT_SPACE_ICON_COLOR = "#94bcff";

function normalizeLineEndings(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function readMetadataValue(value, key, fallbackKey = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  if (fallbackKey && value[fallbackKey] !== undefined) {
    return value[fallbackKey];
  }

  return value[key];
}

export function normalizeSpaceTitle(value) {
  return String(value ?? "").trim();
}

function normalizeSpaceInstructions(value) {
  return normalizeLineEndings(value).trim();
}

export function normalizeSpaceAgentInstructions(value) {
  return normalizeSpaceInstructions(value);
}

export const normalizeSpaceSpecialInstructions = normalizeSpaceAgentInstructions;

export function normalizeSpaceIcon(value) {
  return normalizeMaterialSymbolName(value);
}

export function normalizeSpaceIconColor(value) {
  return normalizeIconHexColor(value);
}

export function getSpaceDisplayTitle(value) {
  const normalizedTitle = normalizeSpaceTitle(readMetadataValue(value, "title"));
  return normalizedTitle || UNTITLED_SPACE_LABEL;
}

export function getSpaceDisplayIcon(value) {
  const normalizedIcon = normalizeSpaceIcon(readMetadataValue(value, "icon"));
  return normalizedIcon || DEFAULT_SPACE_ICON;
}

export function getSpaceDisplayIconColor(value) {
  const normalizedColor = normalizeSpaceIconColor(readMetadataValue(value, "iconColor", "icon_color"));
  return normalizedColor || DEFAULT_SPACE_ICON_COLOR;
}

export async function loadMaterialSymbolNames() {
  return loadMaterialSymbolNamesFromVisual();
}
