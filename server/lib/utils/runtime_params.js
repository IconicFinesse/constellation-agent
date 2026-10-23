import fs from "node:fs/promises";
import path from "node:path";

import { parseSimpleYaml } from "../../../app/L0/_all/modules/_core/framework/js/yaml-lite.js";
import { getProjectEnvFilePath, readDotEnvFile } from "./env_files.js";

const PARAM_TYPES = new Set(["boolean", "number", "text"]);
const BOOLEAN_ALLOWED_VALUES = ["true", "false"];
const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/u;
const RANGE_PATTERN = /^(-?\d+(?:\.\d+)?)\s*(?:\.\.|-)\s*(-?\d+(?:\.\d+)?)$/u;
const SINGLE_USER_APP_USERNAME = "user";

function normalizeParamName(rawValue) {
  return String(rawValue || "").trim().toUpperCase();
}

function escapeRegExp(sourceText) {
  return String(sourceText || "").replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");
}

function matchesTextRule(value, rule) {
  const normalizedRule = String(rule || "");
  if (!normalizedRule) {
    return false;
  }

  if (
    normalizedRule.length > 2 &&
    normalizedRule.startsWith("/") &&
    normalizedRule.endsWith("/")
  ) {
    return new RegExp(normalizedRule.slice(1, -1), "u").test(value);
  }

  if (normalizedRule.includes("*") || normalizedRule.includes("?")) {
    const regexText = escapeRegExp(normalizedRule)
      .replace(/\\\*/gu, ".*")
      .replace(/\\\?/gu, ".");

    return new RegExp(`^${regexText}$`, "u").test(value);
  }

  return value === normalizedRule;
}

function matchesNumberRule(value, rule, paramName) {
  const normalizedRule = String(rule ?? "").trim();
  if (!normalizedRule) {
    return false;
  }

  const rangeMatch = normalizedRule.match(RANGE_PATTERN);
  if (rangeMatch) {
    const firstValue = Number(rangeMatch[1]);
    const secondValue = Number(rangeMatch[2]);
    const minimum = Math.min(firstValue, secondValue);
    const maximum = Math.max(firstValue, secondValue);

    return value >= minimum && value <= maximum;
  }

  if (!NUMBER_PATTERN.test(normalizedRule)) {
    throw new Error(`Invalid numeric rule "${normalizedRule}" for ${paramName} in commands/params.yaml.`);
  }

  return value === Number(normalizedRule);
}

function normalizeBooleanLiteral(rawValue, fieldLabel) {
  if (rawValue === true || rawValue === false) {
    return rawValue;
  }

  const normalizedValue = String(rawValue ?? "").trim().toLowerCase();

  if (normalizedValue === "true") {
    return true;
  }

  if (normalizedValue === "false") {
    return false;
  }

  throw new Error(`${fieldLabel} must be true or false.`);
}

function formatAllowedValues(allowed) {
  return allowed.map((rule) => String(rule)).join(", ");
}

function normalizeAllowed(rawAllowed, type) {
  if (type === "boolean" && (rawAllowed === undefined || rawAllowed === null)) {
    return [...BOOLEAN_ALLOWED_VALUES];
  }

  if (rawAllowed === undefined || rawAllowed === null) {
    return [];
  }

  if (Array.isArray(rawAllowed)) {
    return rawAllowed.map((value) => String(value));
  }

  return [String(rawAllowed)];
}

function validateConfigValue(spec, rawValue) {
  if (spec.type === "number") {
    const normalizedValue = String(rawValue ?? "").trim();
    if (!NUMBER_PATTERN.test(normalizedValue)) {
      throw new Error(`${spec.name} expects a numeric value.`);
    }

    const numericValue = Number(normalizedValue);
    const isAllowed = spec.allowed.some((rule) =>
      matchesNumberRule(numericValue, rule, spec.name)
    );

    if (!isAllowed) {
      throw new Error(`${spec.name} must match one of: ${formatAllowedValues(spec.allowed)}.`);
    }

    return normalizedValue;
  }

  if (spec.type === "boolean") {
    const normalizedValue = normalizeBooleanLiteral(rawValue, spec.name) ? "true" : "false";
    const isAllowed = spec.allowed.some((rule) => normalizedValue === String(rule).trim().toLowerCase());

    if (!isAllowed) {
      throw new Error(`${spec.name} must match one of: ${formatAllowedValues(spec.allowed)}.`);
    }

    return normalizedValue;
  }

  const normalizedValue = String(rawValue ?? "");
  const isAllowed = spec.allowed.some((rule) => matchesTextRule(normalizedValue, rule));

  if (!isAllowed) {
    throw new Error(`${spec.name} must match one of: ${formatAllowedValues(spec.allowed)}.`);
  }

  return normalizedValue;
}

function coerceRuntimeValue(spec, rawValue) {
  const normalizedValue = validateConfigValue(spec, rawValue);

  if (spec.type === "number") {
    return Number(normalizedValue);
  }

  if (spec.type === "boolean") {
    return normalizedValue === "true";
  }

  return normalizedValue;
}

function serializeRuntimeValue(spec, rawValue) {
  if (spec.type === "boolean") {
    return rawValue ? "true" : "false";
  }

  return String(rawValue ?? "");
}

function normalizeParamSpec(paramName, rawSpec) {
  if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
    throw new Error(`commands/params.yaml entry ${paramName} must be an object.`);
  }

  const type = String(rawSpec.type || "").trim().toLowerCase();
  if (!PARAM_TYPES.has(type)) {
    throw new Error(`commands/params.yaml entry ${paramName} must use type "boolean", "text", or "number".`);
  }

  const allowed = normalizeAllowed(rawSpec.allowed, type);
  if (!allowed.length) {
    throw new Error(`commands/params.yaml entry ${paramName} must define at least one allowed value or range.`);
  }

  const spec = {
    allowed,
    description: String(rawSpec.description || ""),
    frontendExposed:
      rawSpec.frontend_exposed === undefined
        ? false
        : normalizeBooleanLiteral(rawSpec.frontend_exposed, `${paramName} frontend_exposed`),
    name: paramName,
    type
  };

  if (rawSpec.default !== undefined) {
    spec.defaultValue = validateConfigValue(spec, rawSpec.default);
  }

  return spec;
}

async function loadParamSpecs(projectRoot) {
  const paramsFilePath = path.join(projectRoot, "commands", "params.yaml");
  const sourceText = await fs.readFile(paramsFilePath, "utf8");
  const parsedParams = parseSimpleYaml(sourceText);

  return Object.entries(parsedParams).map(([paramName, rawSpec]) =>
    normalizeParamSpec(paramName, rawSpec)
  );
}

async function findParamSpec(projectRoot, rawParamName) {
  const paramName = normalizeParamName(rawParamName);
  if (!paramName) {
    throw new Error("A parameter name is required.");
  }

  const paramSpecs = await loadParamSpecs(projectRoot);
  const spec = paramSpecs.find((entry) => entry.name === paramName);

  if (!spec) {
    throw new Error(`Unknown server config parameter: ${paramName}`);
  }

  return spec;
}

function getStoredParamValue(projectRoot, paramName) {
  const envValues = readDotEnvFile(getProjectEnvFilePath(projectRoot));

  if (!Object.prototype.hasOwnProperty.call(envValues, paramName)) {
    return "";
  }

  return envValues[paramName];
}

function normalizeRuntimeParamSources(options = {}) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    (!("env" in options) && !("overrides" in options) && !("storedValues" in options))
  ) {
    return {
      env: options || process.env,
      overrides: {},
      storedValues: null
    };
  }

  return {
    env: options.env || process.env,
    overrides:
      options.overrides && typeof options.overrides === "object" && !Array.isArray(options.overrides)
        ? options.overrides
        : {},
    storedValues:
      options.storedValues && typeof options.storedValues === "object" && !Array.isArray(options.storedValues)
        ? options.storedValues
        : null
  };
}

function normalizeRuntimeParamEntrySnapshot(entry = {}) {
  const name = normalizeParamName(entry.name);

  if (!name) {
    return null;
  }

  return {
    allowed: Array.isArray(entry.allowed) ? entry.allowed.map((value) => String(value)) : [],
    description: String(entry.description || ""),
    frontendExposed: Boolean(entry.frontendExposed),
    name,
    source: String(entry.source || "snapshot"),
    type: String(entry.type || "text"),
    value: entry.value
  };
}

function resolveRuntimeParamEntry(spec, sources = {}) {
  const overrides = sources.overrides || {};
  const storedValues = sources.storedValues || {};
  const envValues = sources.env || process.env;
  let rawValue;
  let source = "unset";

  if (Object.prototype.hasOwnProperty.call(overrides, spec.name)) {
    rawValue = overrides[spec.name];
    source = "launch";
  } else if (Object.prototype.hasOwnProperty.call(storedValues, spec.name)) {
    rawValue = storedValues[spec.name];
    source = "stored";
  } else if (Object.prototype.hasOwnProperty.call(envValues, spec.name)) {
    rawValue = envValues[spec.name];
    source = "env";
  } else if (spec.defaultValue !== undefined) {
    rawValue = spec.defaultValue;
    source = "default";
  }

  return {
    ...spec,
    source,
    value: rawValue === undefined ? undefined : coerceRuntimeValue(spec, rawValue)
  };
}

async function createRuntimeParams(projectRoot, options = {}) {
  const sources = normalizeRuntimeParamSources(options);
  const specs = await loadParamSpecs(projectRoot);
  const storedValues = sources.storedValues || readDotEnvFile(getProjectEnvFilePath(projectRoot));
  const entries = specs.map((spec) =>
    resolveRuntimeParamEntry(spec, {
      ...sources,
      storedValues
    })
  );
  const entryMap = new Map(entries.map((entry) => [entry.name, entry]));

  return {
    get(rawParamName, fallback = undefined) {
      const paramName = normalizeParamName(rawParamName);
      const entry = paramName ? entryMap.get(paramName) : null;
      return entry && entry.value !== undefined ? entry.value : fallback;
    },
    getEntry(rawParamName) {
      const paramName = normalizeParamName(rawParamName);
      return paramName ? entryMap.get(paramName) || null : null;
    },
    has(rawParamName) {
      const paramName = normalizeParamName(rawParamName);
      const entry = paramName ? entryMap.get(paramName) : null;
      return Boolean(entry && entry.value !== undefined);
    },
    list() {
      return entries.map((entry) => ({ ...entry }));
    },
    listFrontendExposed() {
      return entries
        .filter((entry) => entry.frontendExposed && entry.value !== undefined)
        .map((entry) => ({
          ...entry,
          content: serializeRuntimeValue(entry, entry.value)
        }));
    }
  };
}

function hydrateRuntimeParams(entries = []) {
  const normalizedEntries = Array.isArray(entries)
    ? entries.map((entry) => normalizeRuntimeParamEntrySnapshot(entry)).filter(Boolean)
    : [];
  const entryMap = new Map(normalizedEntries.map((entry) => [entry.name, entry]));

  return {
    get(rawParamName, fallback = undefined) {
      const paramName = normalizeParamName(rawParamName);
      const entry = paramName ? entryMap.get(paramName) : null;
      return entry && entry.value !== undefined ? entry.value : fallback;
    },
    getEntry(rawParamName) {
      const paramName = normalizeParamName(rawParamName);
      const entry = paramName ? entryMap.get(paramName) || null : null;
      return entry ? { ...entry } : null;
    },
    has(rawParamName) {
      const paramName = normalizeParamName(rawParamName);
      const entry = paramName ? entryMap.get(paramName) : null;
      return Boolean(entry && entry.value !== undefined);
    },
    list() {
      return normalizedEntries.map((entry) => ({ ...entry }));
    },
    listFrontendExposed() {
      return normalizedEntries
        .filter((entry) => entry.frontendExposed && entry.value !== undefined)
        .map((entry) => ({
          ...entry,
          content: serializeRuntimeValue(entry, entry.value)
        }));
    }
  };
}

function serializeRuntimeParams(runtimeParams) {
  if (!runtimeParams || typeof runtimeParams.list !== "function") {
    return [];
  }

  return runtimeParams.list().map((entry) => ({
    ...entry
  }));
}

function isSingleUserApp(runtimeParams) {
  return Boolean(runtimeParams && typeof runtimeParams.get === "function" && runtimeParams.get("SINGLE_USER_APP"));
}

function isLoginAllowed(runtimeParams) {
  if (isSingleUserApp(runtimeParams)) {
    return false;
  }

  return Boolean(
    runtimeParams &&
      typeof runtimeParams.get === "function" &&
      runtimeParams.get("LOGIN_ALLOWED", true)
  );
}

function areGuestUsersAllowed(runtimeParams) {
  if (isSingleUserApp(runtimeParams)) {
    return false;
  }

  return Boolean(
    runtimeParams &&
      typeof runtimeParams.get === "function" &&
      runtimeParams.get("ALLOW_GUEST_USERS", false)
  );
}

function isCloudShareAllowed(runtimeParams) {
  return Boolean(
    runtimeParams &&
      typeof runtimeParams.get === "function" &&
      runtimeParams.get("CLOUD_SHARE_ALLOWED", false)
  );
}

export {
  SINGLE_USER_APP_USERNAME,
  areGuestUsersAllowed,
  createRuntimeParams,
  findParamSpec,
  formatAllowedValues,
  getStoredParamValue,
  hydrateRuntimeParams,
  isCloudShareAllowed,
  isLoginAllowed,
  isSingleUserApp,
  loadParamSpecs,
  normalizeParamName,
  serializeRuntimeParams,
  serializeRuntimeValue,
  validateConfigValue
};
