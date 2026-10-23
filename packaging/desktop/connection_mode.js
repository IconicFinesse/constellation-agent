const CONNECTION_MODE = Object.freeze({
  STANDALONE: "standalone",
  CONNECTED: "connected"
});

const CONNECTION_MODE_ENV_NAME = "SPACE_DESKTOP_CONNECTION_MODE";
const CONNECTED_SERVER_URL_ENV_NAME = "SPACE_DESKTOP_SERVER_URL";

const LOCAL_DEV_HOSTNAMES = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeConnectionMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === CONNECTION_MODE.CONNECTED
    ? CONNECTION_MODE.CONNECTED
    : CONNECTION_MODE.STANDALONE;
}

function isLocalDevHostname(hostname) {
  return LOCAL_DEV_HOSTNAMES.includes(normalizeText(hostname).toLowerCase());
}

// Returns { ok, url, origin, error }. Enforces HTTPS except for explicit local
// development targets, so credentials and the runtime never travel in clear.
function validateRemoteServerUrl(value) {
  const raw = normalizeText(value);

  if (!raw) {
    return { ok: false, url: "", origin: "", error: "A server URL is required." };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, url: "", origin: "", error: "That is not a valid URL." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, url: "", origin: "", error: "Only http and https URLs are supported." };
  }

  if (parsed.protocol === "http:" && !isLocalDevHostname(parsed.hostname)) {
    return {
      ok: false,
      url: "",
      origin: "",
      error: "Remote servers must use https. Use http only for localhost development."
    };
  }

  if (!parsed.hostname) {
    return { ok: false, url: "", origin: "", error: "The URL needs a hostname." };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      url: "",
      origin: "",
      error: "Do not embed credentials in the URL; log in through the app."
    };
  }

  return {
    ok: true,
    url: parsed.href,
    origin: parsed.origin,
    error: ""
  };
}

// A saved connection is { label, url, origin }. Origin is what gets pinned, so
// the mode never silently follows a host that changed under the same name.
function normalizeSavedConnection(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const label = normalizeText(value.label).slice(0, 80);
  const validation = validateRemoteServerUrl(value.url);

  if (!validation.ok) {
    return null;
  }

  const pinnedOrigin = normalizeText(value.origin) || validation.origin;
  if (pinnedOrigin && pinnedOrigin !== validation.origin) {
    return {
      label: label || validation.origin,
      url: validation.url,
      origin: validation.origin,
      pinnedOriginChanged: true
    };
  }

  return {
    label: label || validation.origin,
    url: validation.url,
    origin: validation.origin,
    pinnedOriginChanged: false
  };
}

function normalizeSavedConnections(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];

  values.forEach((entry) => {
    const connection = normalizeSavedConnection(entry);
    if (!connection || seen.has(connection.origin)) {
      return;
    }

    seen.add(connection.origin);
    normalized.push(connection);
  });

  return normalized;
}

// Resolves the effective connection for this launch from an explicit request
// (user choice or test seam) plus saved connections, never trusting a saved
// URL whose origin no longer matches its pinned origin.
function resolveConnectionConfig(options = {}) {
  const requestedMode = normalizeConnectionMode(options.mode);

  if (requestedMode !== CONNECTION_MODE.CONNECTED) {
    return { mode: CONNECTION_MODE.STANDALONE, url: "", origin: "", label: "", error: "" };
  }

  const saved = normalizeSavedConnections(options.savedConnections);
  const requestedUrl = normalizeText(options.url);
  const requestedLabel = normalizeText(options.label);

  if (requestedUrl) {
    const validation = validateRemoteServerUrl(requestedUrl);
    if (!validation.ok) {
      return { mode: CONNECTION_MODE.CONNECTED, url: "", origin: "", label: "", error: validation.error };
    }

    const pinned = saved.find((entry) => entry.origin === validation.origin);
    if (pinned && pinned.pinnedOriginChanged) {
      return {
        mode: CONNECTION_MODE.CONNECTED,
        url: validation.url,
        origin: validation.origin,
        label: requestedLabel || pinned.label,
        error: "This connection's server address changed since it was saved. Review it before connecting."
      };
    }

    return {
      mode: CONNECTION_MODE.CONNECTED,
      url: validation.url,
      origin: validation.origin,
      label: requestedLabel || pinned?.label || validation.origin,
      error: ""
    };
  }

  if (saved.length) {
    const first = saved[0];
    return {
      mode: CONNECTION_MODE.CONNECTED,
      url: first.url,
      origin: first.origin,
      label: first.label,
      error: first.pinnedOriginChanged
        ? "This connection's server address changed since it was saved. Review it before connecting."
        : ""
    };
  }

  return {
    mode: CONNECTION_MODE.CONNECTED,
    url: "",
    origin: "",
    label: "",
    error: "No saved remote server is configured yet. Add one to connect."
  };
}

// Launch-time seam: env vars win so the e2e harness can drive connected mode
// without a UI. Absent env, the caller passes the chooser's decision.
function readConnectionRequestFromEnv(env = process.env) {
  const mode = normalizeText(env?.[CONNECTION_MODE_ENV_NAME]);
  const url = normalizeText(env?.[CONNECTED_SERVER_URL_ENV_NAME]);

  if (!mode && !url) {
    return null;
  }

  return { mode: mode || (url ? CONNECTION_MODE.CONNECTED : ""), url };
}

// Deleting a saved server is a pure list operation so the chooser can drop a
// mistyped entry without owning filesystem access. Returns the normalized
// remainder plus whether anything was actually removed.
function removeSavedConnection(values, origin) {
  const saved = normalizeSavedConnections(values);
  const normalizedOrigin = normalizeText(origin);

  if (!normalizedOrigin) {
    return { removed: false, connections: saved };
  }

  const next = saved.filter((entry) => entry.origin !== normalizedOrigin);
  return { removed: next.length !== saved.length, connections: next };
}

module.exports = {
  CONNECTION_MODE,
  CONNECTION_MODE_ENV_NAME,
  CONNECTED_SERVER_URL_ENV_NAME,
  isLocalDevHostname,
  normalizeConnectionMode,
  normalizeSavedConnection,
  normalizeSavedConnections,
  readConnectionRequestFromEnv,
  removeSavedConnection,
  resolveConnectionConfig,
  validateRemoteServerUrl
};
