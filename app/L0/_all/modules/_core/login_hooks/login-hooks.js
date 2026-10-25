export const LOGIN_HOOKS_STATE_PATH = "~/metadata/login_hooks.json";
export const FIRST_LOGIN_EXTENSION_POINT = "_core/login_hooks/first_login";
export const ANY_LOGIN_EXTENSION_POINT = "_core/login_hooks/any_login";
export const LOGIN_PAGE_PATHNAME = "/login";

async function callConfiguredLoginExtensions(...args) {
  const { callJsExtensions } = await import("../framework/js/extensions.js");
  return callJsExtensions(...args);
}

async function callConfiguredLoginExtensionsChecked(...args) {
  const { callJsExtensionsChecked } = await import("../framework/js/extensions.js");
  return callJsExtensionsChecked(...args);
}

function getRuntime() {
  const runtime = globalThis.space;

  if (!runtime || typeof runtime !== "object") {
    throw new Error("Space runtime is not available.");
  }

  if (
    !runtime.api ||
    typeof runtime.api.userSelfInfo !== "function" ||
    typeof runtime.api.fileWrite !== "function"
  ) {
    throw new Error("space.api login hook helpers are not available.");
  }

  if (
    typeof runtime.api.fileInfo !== "function" &&
    typeof runtime.api.fileRead !== "function"
  ) {
    throw new Error("space.api fileInfo() or fileRead() is required for login hook marker checks.");
  }

  return runtime;
}

export function isMissingFileError(error) {
  const message = String(error?.message || "");
  return /\bstatus 404\b/u.test(message) || /File not found\./u.test(message) || /Path not found\./u.test(message);
}

function normalizePathname(pathname) {
  const normalizedPathname = String(pathname || "").trim();

  if (!normalizedPathname) {
    return "";
  }

  const trimmedPathname = normalizedPathname.replace(/\/+$/u, "");
  return trimmedPathname || "/";
}

export function isLoginNavigation({
  loginPathname = LOGIN_PAGE_PATHNAME,
  origin = globalThis.location?.origin || "http://localhost",
  referrer = globalThis.document?.referrer || ""
} = {}) {
  const normalizedReferrer = String(referrer || "").trim();

  if (!normalizedReferrer) {
    return false;
  }

  let parsedOrigin;
  let parsedReferrer;

  try {
    parsedOrigin = new URL(String(origin || "http://localhost"), "http://localhost");
    parsedReferrer = new URL(normalizedReferrer, parsedOrigin.origin);
  } catch {
    return false;
  }

  return (
    parsedReferrer.origin === parsedOrigin.origin &&
    normalizePathname(parsedReferrer.pathname) === normalizePathname(loginPathname)
  );
}

export function buildLoginHooksStateContent({
  firstLoginCompletedAt = new Date().toISOString()
} = {}) {
  return `${JSON.stringify({
    first_login_completed: true,
    first_login_completed_at: String(firstLoginCompletedAt || "").trim(),
    version: 1
  }, null, 2)}\n`;
}

async function hasFirstLoginMarker(runtime, markerPath) {
  if (typeof runtime.api.fileInfo === "function") {
    try {
      await runtime.api.fileInfo(markerPath);
      return true;
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }

      throw error;
    }
  }

  try {
    await runtime.api.fileRead(markerPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

function buildLoginHookContext({
  identity,
  isFirstLogin,
  isLoginNavigation: arrivedFromLogin,
  markerPath
}) {
  return {
    identity,
    isFirstLogin: isFirstLogin === true,
    isLoginNavigation: arrivedFromLogin === true,
    markerPath,
    username: String(identity?.username || "").trim()
  };
}

export async function executeLoginHooksBootstrap(options = {}) {
  const {
    extensionCaller = callConfiguredLoginExtensions,
    firstLoginExtensionPoint = FIRST_LOGIN_EXTENSION_POINT,
    anyLoginExtensionPoint = ANY_LOGIN_EXTENSION_POINT,
    markerPath = LOGIN_HOOKS_STATE_PATH,
    now = new Date().toISOString(),
    origin = globalThis.location?.origin || "http://localhost",
    referrer = globalThis.document?.referrer || "",
    runtime = getRuntime()
  } = options;
  // The first-login point is checked by default because it gates a durable marker.
  // A caller that injected `extensionCaller` keeps owning every point, so existing
  // embedders and tests do not have to know about the checked variant.
  const firstLoginExtensionCaller =
    typeof options.firstLoginExtensionCaller === "function"
      ? options.firstLoginExtensionCaller
      : Object.prototype.hasOwnProperty.call(options, "extensionCaller")
        ? extensionCaller
        : callConfiguredLoginExtensionsChecked;
  const identity = await runtime.api.userSelfInfo();
  const username = String(identity?.username || "").trim();

  if (!username) {
    return {
      identity,
      isFirstLogin: false,
      isLoginNavigation: false,
      markerExists: false,
      ranAnyLogin: false,
      ranFirstLogin: false
    };
  }

  const markerExists = await hasFirstLoginMarker(runtime, markerPath);
  const arrivedFromLogin = isLoginNavigation({ origin, referrer });
  const isFirstLogin = markerExists !== true;
  let ranFirstLogin = false;
  let ranAnyLogin = false;

  if (isFirstLogin) {
    const firstLoginContext = buildLoginHookContext({
      identity,
      isFirstLogin: true,
      isLoginNavigation: arrivedFromLogin,
      markerPath
    });

    let firstLoginResolved = false;

    try {
      // The marker is permanent state: write it only when every first-login hook
      // resolved, so a failed onboarding install is retried on the next login
      // instead of being recorded as completed.
      await firstLoginExtensionCaller(firstLoginExtensionPoint, firstLoginContext);
      firstLoginResolved = true;
    } catch (error) {
      console.error("Login hook failed; first-login marker not written.", error);
    }

    if (firstLoginResolved) {
      await runtime.api.fileWrite(
        markerPath,
        buildLoginHooksStateContent({ firstLoginCompletedAt: now }),
        "utf8"
      );
      ranFirstLogin = true;
    }
  }

  if (arrivedFromLogin) {
    await extensionCaller(
      anyLoginExtensionPoint,
      buildLoginHookContext({
        identity,
        isFirstLogin,
        isLoginNavigation: true,
        markerPath
      })
    );
    ranAnyLogin = true;
  }

  return {
    identity,
    isFirstLogin,
    isLoginNavigation: arrivedFromLogin,
    markerExists,
    ranAnyLogin,
    ranFirstLogin
  };
}

export async function runLoginHooksBootstrap() {
  return executeLoginHooksBootstrap();
}
