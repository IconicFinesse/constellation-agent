const FRONTEND_CONFIG_META_NAME = "space-config";

let cachedServerConfigValues;

function normalizeConfigName(name) {
  return String(name || "").trim().toUpperCase();
}

function parseMetaValue(metaTag) {
  const type = String(metaTag?.dataset?.spaceType || "text").trim().toLowerCase();
  const content = String(metaTag?.content ?? "");

  if (type === "boolean") {
    return content === "true";
  }

  if (type === "number") {
    const numericValue = Number(content);
    return Number.isFinite(numericValue) ? numericValue : undefined;
  }

  return content;
}

function getFrontendServerConfigValues() {
  if (cachedServerConfigValues !== undefined) {
    return cachedServerConfigValues;
  }

  const values = {};
  const metaTags = document.querySelectorAll(`meta[name="${FRONTEND_CONFIG_META_NAME}"][data-space-param]`);

  metaTags.forEach((metaTag) => {
    const name = normalizeConfigName(metaTag.dataset.spaceParam);

    if (!name) {
      return;
    }

    const value = parseMetaValue(metaTag);

    if (value === undefined) {
      return;
    }

    values[name] = value;
  });

  cachedServerConfigValues = Object.freeze(values);
  return cachedServerConfigValues;
}

function getFrontendServerConfigValue(name, fallback = undefined) {
  const normalizedName = normalizeConfigName(name);
  const values = getFrontendServerConfigValues();

  return Object.prototype.hasOwnProperty.call(values, normalizedName) ? values[normalizedName] : fallback;
}

function hasFrontendServerConfigValue(name) {
  const normalizedName = normalizeConfigName(name);
  return Object.prototype.hasOwnProperty.call(getFrontendServerConfigValues(), normalizedName);
}

export {
  FRONTEND_CONFIG_META_NAME,
  getFrontendServerConfigValue,
  getFrontendServerConfigValues,
  hasFrontendServerConfigValue
};
