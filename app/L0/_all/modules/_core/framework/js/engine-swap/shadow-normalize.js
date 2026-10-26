// Shared normalization rules for the engine-swap shadow-diff artifacts
// (contract: ca.shadow-diff/1).
//
// Both the build-side emitter and the lab-side checker normalize with these
// exact rules, so a gate never fails on a formatting mismatch:
//
// - app paths are canonicalized against the session user with the own-user
//   collapse rule that the server's file-access layer already applies
//   (`~/x`, `~/L2/<user>/x`, and `L2/<user>/x` all resolve to `L2/<user>/x`,
//   and stacked own-user prefixes collapse all the way); another user's name
//   inside a doubled shorthand is never collapsed
// - JSON keys are sorted recursively before comparison
// - executed code is compared by hash plus first line and is never embedded
//   whole in an artifact, so artifacts stay small and carry no code payloads

const APP_PATH_PREFIX_PATTERN = /^\/?app\//u;

export function normalizeJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }

  if (value && typeof value === "object") {
    const normalized = {};

    Object.keys(value)
      .sort()
      .forEach((key) => {
        normalized[key] = normalizeJsonValue(value[key]);
      });

    return normalized;
  }

  return value;
}

export function stableStringify(value) {
  return JSON.stringify(normalizeJsonValue(value));
}

function normalizeUsername(username) {
  return String(username || "").trim();
}

function stripAppRootPrefix(path) {
  return path.replace(APP_PATH_PREFIX_PATTERN, "");
}

// Canonicalizes one app path for the given session user. Empty input returns an
// empty string, and paths that are not app-rooted are returned unchanged after
// trimming so unrelated values are never rewritten.
export function collapseOwnUserPath(path, username) {
  const normalizedUsername = normalizeUsername(username);
  let normalizedPath = String(path ?? "").trim();

  if (!normalizedPath) {
    return "";
  }

  normalizedPath = stripAppRootPrefix(normalizedPath);

  if (!normalizedUsername) {
    return normalizedPath;
  }

  const ownRoot = `L2/${normalizedUsername}`;

  if (normalizedPath === "~") {
    return ownRoot;
  }

  if (normalizedPath.startsWith("~/")) {
    normalizedPath = `${ownRoot}/${normalizedPath.slice(2)}`;
  }

  // Collapse stacked own-user prefixes the way the server's file-access layer
  // does for the bug-era doubled form, and never touch another user's name.
  // The inner path after `L2/<user>/` must itself start with the full own root
  // (`L2/<user>/`), so the remainder is compared with a trailing slash.
  const doubledPrefix = `${ownRoot}/${ownRoot}/`;

  while (normalizedPath.startsWith(doubledPrefix)) {
    normalizedPath = `${ownRoot}/${normalizedPath.slice(doubledPrefix.length)}`;
  }

  return normalizedPath;
}

// Tool argument keys that carry app paths and therefore take part in the
// own-user collapse rule. Unknown keys are normalized as plain JSON only.
const PATH_ARGUMENT_KEYS = Object.freeze(["path", "paths"]);

function normalizeArgumentValue(key, value, username) {
  if (PATH_ARGUMENT_KEYS.includes(key)) {
    if (Array.isArray(value)) {
      return value.map((entry) => collapseOwnUserPath(entry, username));
    }

    if (typeof value === "string") {
      return collapseOwnUserPath(value, username);
    }
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeArgumentValue("", entry, username));
  }

  if (value && typeof value === "object") {
    const normalized = {};

    Object.keys(value)
      .sort()
      .forEach((nestedKey) => {
        normalized[nestedKey] = normalizeArgumentValue(nestedKey, value[nestedKey], username);
      });

    return normalized;
  }

  return value;
}

export function normalizeToolArguments(args, { username = "" } = {}) {
  return normalizeArgumentValue("", args && typeof args === "object" ? args : {}, username);
}

export function firstLineOfCode(code, maxLength = 120) {
  const lines = String(code ?? "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed) {
      return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
    }
  }

  return "";
}

async function defaultDigest(text) {
  const cryptoImpl = globalThis.crypto;

  if (!cryptoImpl || !cryptoImpl.subtle || typeof cryptoImpl.subtle.digest !== "function") {
    throw new Error("SHA-256 hashing requires crypto.subtle in this runtime.");
  }

  const bytes = new TextEncoder().encode(String(text ?? ""));
  const digestBuffer = await cryptoImpl.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digestBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintText(text, { digest = defaultDigest } = {}) {
  const hex = await digest(String(text ?? ""));
  return `sha256:${String(hex).slice(0, 12)}`;
}

export async function fingerprintCode(code, options = {}) {
  return {
    code_sha: await fingerprintText(code, options),
    first_line: firstLineOfCode(code)
  };
}

export async function fingerprintToolArguments(args, options = {}) {
  return fingerprintText(stableStringify(args), options);
}

// Argument keys that carry a payload rather than a coordinate. The contract
// keeps artifacts small and free of code payloads, so these are replaced by a
// digest marker before an artifact ever sees them.
const PAYLOAD_ARGUMENT_KEYS = Object.freeze(["code", "content"]);

// Strings longer than this are treated as payload even under an unknown key,
// because "artifacts stay small" is a property of the artifact, not of a name.
export const ARTIFACT_PAYLOAD_STRING_LIMIT = 1000;

function utf8ByteLength(value) {
  // TextEncoder exists in browsers and in Node's global scope; Buffer does not
  // exist in the browser, and this module is shared by both runtimes.
  return new TextEncoder().encode(String(value)).length;
}

function payloadMarker(value, digestText) {
  return {
    bytes: utf8ByteLength(value),
    omitted: "payload",
    sha256: digestText
  };
}

async function redactValue(key, value, { digest } = {}) {
  if (typeof value === "string" && (PAYLOAD_ARGUMENT_KEYS.includes(key) || value.length > ARTIFACT_PAYLOAD_STRING_LIMIT)) {
    const hex = await (digest ? digest(value) : defaultDigest(value));

    return payloadMarker(value, `sha256:${String(hex).slice(0, 12)}`);
  }

  if (Array.isArray(value)) {
    const redacted = [];

    for (const entry of value) {
      redacted.push(await redactValue("", entry, { digest }));
    }

    return redacted;
  }

  if (value && typeof value === "object") {
    const redacted = {};

    for (const nestedKey of Object.keys(value).sort()) {
      redacted[nestedKey] = await redactValue(nestedKey, value[nestedKey], { digest });
    }

    return redacted;
  }

  return value;
}

// Replaces payload-bearing values with { omitted, bytes, sha256 } so a
// normalized-arguments object can be embedded without carrying code or file
// contents. Applied after normalizeToolArguments.
export async function redactArtifactArguments(args, options = {}) {
  return redactValue("", args && typeof args === "object" ? args : {}, options);
}
