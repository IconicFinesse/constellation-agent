export const DEFAULT_ROUTE_PATH = "dashboard";

function createSearchParams(value) {
  if (value instanceof URLSearchParams) {
    return new URLSearchParams(value);
  }

  if (typeof value === "string") {
    const normalizedValue = value.startsWith("?") ? value.slice(1) : value;
    return new URLSearchParams(normalizedValue);
  }

  if (value && typeof value === "object") {
    const params = new URLSearchParams();

    for (const [key, entryValue] of Object.entries(value)) {
      if (entryValue === undefined || entryValue === null) {
        continue;
      }

      if (Array.isArray(entryValue)) {
        for (const item of entryValue) {
          if (item === undefined || item === null) {
            continue;
          }

          params.append(key, String(item));
        }

        continue;
      }

      params.set(key, String(entryValue));
    }

    return params;
  }

  return new URLSearchParams();
}

function stripRoutePrefix(value) {
  return String(value || "")
    .trim()
    .replace(/^\/?#!\/?/u, "")
    .replace(/^\/?#\/?/u, "");
}

function normalizeSegments(path) {
  return stripRoutePrefix(path)
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function normalizeRoutePath(path, defaultPath = "") {
  const segments = normalizeSegments(path);

  if (segments.length > 0) {
    return segments.join("/");
  }

  return normalizeSegments(defaultPath).join("/");
}

export function resolveRouteViewPath(path, search = "") {
  const segments = normalizeSegments(path);

  if (segments.length === 0) {
    return `/modules/_core/${DEFAULT_ROUTE_PATH}/view.html${search}`;
  }

  if (segments.length === 1) {
    return `/modules/_core/${segments[0]}/view.html${search}`;
  }

  const routePath = segments.join("/");

  if (/\.html?$/iu.test(segments[segments.length - 1])) {
    return `/modules/${routePath}${search}`;
  }

  return `/modules/${routePath}/view.html${search}`;
}

export function parseRouteTarget(target, options = {}) {
  const defaultPath = normalizeRoutePath(options.defaultPath, DEFAULT_ROUTE_PATH) || DEFAULT_ROUTE_PATH;
  const targetString =
    typeof target === "string"
      ? target.trim()
      : target && typeof target === "object"
        ? String(target.hash || target.path || "")
        : "";

  const [pathInput = "", inlineSearch = ""] = stripRoutePrefix(targetString).split("?");
  const explicitPath = normalizeRoutePath(pathInput);
  const path = explicitPath || defaultPath;
  const paramsInput =
    target && typeof target === "object" && !Array.isArray(target) && "params" in target
      ? target.params
      : options.params ?? inlineSearch;
  const searchParams = createSearchParams(paramsInput);
  const searchText = searchParams.toString();
  const search = searchText ? `?${searchText}` : "";
  const hash = `#/${path}${search}`;
  const originPath = globalThis.location?.pathname || "/";
  const originSearch = globalThis.location?.search || "";

  return {
    explicit: explicitPath.length > 0,
    hash,
    href: `${originPath}${originSearch}${hash}`,
    key: hash,
    params: Object.fromEntries(searchParams.entries()),
    path,
    search,
    searchParams,
    segments: path.split("/").filter(Boolean),
    viewPath: resolveRouteViewPath(path, search)
  };
}
