export const STATE_VERSION_HEADER = "Space-State-Version";
export const STATE_VERSION_COOKIE_NAME = "space_state_version";

const STATE_VERSION_SESSION_STORAGE_KEY = "space.state-version";
const STATE_VERSION_COOKIE_MAX_AGE_SECONDS = 10;

let currentStateVersion = 0;
let hydratedStateVersion = false;

export function normalizeStateVersion(value) {
  const normalizedValue = Math.floor(Number(value));
  return Number.isFinite(normalizedValue) && normalizedValue >= 0 ? normalizedValue : 0;
}

function readStoredStateVersion() {
  try {
    return normalizeStateVersion(window.sessionStorage.getItem(STATE_VERSION_SESSION_STORAGE_KEY));
  } catch {
    return 0;
  }
}

function writeStoredStateVersion(value) {
  try {
    window.sessionStorage.setItem(STATE_VERSION_SESSION_STORAGE_KEY, String(value));
  } catch {}
}

function readCookieStateVersion() {
  if (typeof document === "undefined") {
    return 0;
  }

  const encodedName = `${encodeURIComponent(STATE_VERSION_COOKIE_NAME)}=`;
  const entries = String(document.cookie || "").split(";");

  for (const entry of entries) {
    const trimmedEntry = entry.trim();

    if (!trimmedEntry.startsWith(encodedName)) {
      continue;
    }

    try {
      return normalizeStateVersion(decodeURIComponent(trimmedEntry.slice(encodedName.length)));
    } catch {
      return normalizeStateVersion(trimmedEntry.slice(encodedName.length));
    }
  }

  return 0;
}

function writeCookieStateVersion(value) {
  if (typeof document === "undefined") {
    return;
  }

  const cookieParts = [
    `${encodeURIComponent(STATE_VERSION_COOKIE_NAME)}=${encodeURIComponent(String(value))}`,
    `Max-Age=${STATE_VERSION_COOKIE_MAX_AGE_SECONDS}`,
    "Path=/",
    "SameSite=Lax"
  ];

  if (window.location.protocol === "https:") {
    cookieParts.push("Secure");
  }

  document.cookie = cookieParts.join("; ");
}

function hydrateCurrentStateVersion() {
  if (hydratedStateVersion) {
    return currentStateVersion;
  }

  hydratedStateVersion = true;
  currentStateVersion = Math.max(readStoredStateVersion(), readCookieStateVersion());
  return currentStateVersion;
}

export function getCurrentStateVersion() {
  return hydrateCurrentStateVersion();
}

export function observeStateVersion(value) {
  hydrateCurrentStateVersion();
  const normalizedVersion = normalizeStateVersion(value);

  if (normalizedVersion > currentStateVersion) {
    currentStateVersion = normalizedVersion;
    writeStoredStateVersion(currentStateVersion);
    writeCookieStateVersion(currentStateVersion);
  }

  return currentStateVersion;
}

export function applyStateVersionRequestHeader(headers, minimumStateVersion = 0) {
  const normalizedVersion = Math.max(
    getCurrentStateVersion(),
    normalizeStateVersion(minimumStateVersion)
  );

  if (!(headers instanceof Headers) || normalizedVersion <= 0 || headers.has(STATE_VERSION_HEADER)) {
    return headers;
  }

  headers.set(STATE_VERSION_HEADER, String(normalizedVersion));
  return headers;
}

export function observeStateVersionFromResponse(response) {
  if (!response || !response.headers || typeof response.headers.get !== "function") {
    return getCurrentStateVersion();
  }

  return observeStateVersion(response.headers.get(STATE_VERSION_HEADER));
}

hydrateCurrentStateVersion();
