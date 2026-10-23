const APP_LOGICAL_PATH_PATTERN = /^(?:\/app\/|\/)?(?:~|L0|L1|L2)(?:\/|$)/u;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/u;

function normalizeModuleSpecifier(specifier) {
  return String(specifier ?? "")
    .trim()
    .replace(/\\/gu, "/");
}

function normalizeAbsoluteAppLogicalPath(specifier) {
  if (specifier.startsWith("/~/")) {
    return `~/${specifier.slice(3)}`;
  }

  if (/^\/(L0|L1|L2)\//u.test(specifier)) {
    return specifier.slice(1);
  }

  return specifier;
}

function normalizeCurrentSpaceRelativePath(specifier) {
  let normalizedSpecifier = normalizeModuleSpecifier(specifier);

  while (normalizedSpecifier.startsWith("./")) {
    normalizedSpecifier = normalizedSpecifier.slice(2);
  }

  if (normalizedSpecifier.startsWith("/")) {
    normalizedSpecifier = normalizedSpecifier.slice(1);
  }

  const segments = normalizedSpecifier
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (!segments.length) {
    throw new Error("A current-space module path is required.");
  }

  if (segments.includes("..")) {
    throw new Error(`Current-space module imports may not escape the current space root: ${specifier}`);
  }

  return segments.join("/");
}

export function resolveCurrentSpaceModulePath(specifier, options = {}) {
  const normalizedSpecifier = normalizeModuleSpecifier(specifier);
  const spaceRootPath = String(options.spaceRootPath || "").trim();

  if (!normalizedSpecifier) {
    throw new Error("A current-space module specifier is required.");
  }

  if (!spaceRootPath) {
    throw new Error("A current-space root path is required.");
  }

  if (URL_SCHEME_PATTERN.test(normalizedSpecifier)) {
    throw new Error(`Current-space module imports do not support URL specifiers: ${specifier}`);
  }

  if (APP_LOGICAL_PATH_PATTERN.test(normalizedSpecifier)) {
    return normalizeAbsoluteAppLogicalPath(normalizedSpecifier);
  }

  return `${spaceRootPath}${normalizeCurrentSpaceRelativePath(normalizedSpecifier)}`;
}

function buildCurrentSpaceModuleVersionToken(pathInfo = {}) {
  const modifiedAt = String(pathInfo?.modifiedAt || "").trim() || "0";
  const size = Number.isFinite(pathInfo?.size) ? Number(pathInfo.size) : 0;
  return `${modifiedAt}:${size}`;
}

async function defaultImportModule(moduleUrl) {
  return import(moduleUrl);
}

export async function importCurrentSpaceModule(specifier, options = {}) {
  const {
    fileInfo,
    importModule = defaultImportModule,
    locationOrigin = globalThis.location?.origin,
    resolveAppUrl,
    spaceRootPath
  } = options;

  if (typeof fileInfo !== "function") {
    throw new Error("Current-space module imports require a fileInfo(path) helper.");
  }

  if (typeof resolveAppUrl !== "function") {
    throw new Error("Current-space module imports require resolveAppUrl(path).");
  }

  const logicalPath = resolveCurrentSpaceModulePath(specifier, { spaceRootPath });
  const pathInfo = await fileInfo(logicalPath);

  if (!pathInfo || typeof pathInfo !== "object") {
    throw new Error(`Current-space module import could not read file info for ${logicalPath}.`);
  }

  if (pathInfo.isDirectory) {
    throw new Error(`Current-space module import expected a file path, not a folder: ${logicalPath}`);
  }

  const moduleUrl = new URL(resolveAppUrl(logicalPath), locationOrigin || globalThis.location?.origin || "http://localhost");
  moduleUrl.searchParams.set("v", buildCurrentSpaceModuleVersionToken(pathInfo));

  return importModule(moduleUrl.toString());
}

export function createCurrentSpaceModuleImporter(options = {}) {
  return async (specifier) => importCurrentSpaceModule(specifier, options);
}
