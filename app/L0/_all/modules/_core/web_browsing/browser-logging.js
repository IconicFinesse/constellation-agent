const BROWSER_LOG_LEVEL_ORDER = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50
});

export const DEFAULT_BROWSER_LOG_LEVEL = "error";
export const BROWSER_LOG_LEVELS = Object.freeze(Object.keys(BROWSER_LOG_LEVEL_ORDER));

let currentBrowserLogLevel = DEFAULT_BROWSER_LOG_LEVEL;

export function normalizeBrowserLogLevel(value, fallback = DEFAULT_BROWSER_LOG_LEVEL) {
  const normalizedValue = String(value || "").trim().toLowerCase();

  if (!normalizedValue) {
    return fallback;
  }

  if (Object.hasOwn(BROWSER_LOG_LEVEL_ORDER, normalizedValue)) {
    return normalizedValue;
  }

  return fallback;
}

export function getBrowserLogLevel() {
  return currentBrowserLogLevel;
}

export function setBrowserLogLevel(value) {
  const normalizedValue = normalizeBrowserLogLevel(value, null);

  if (!normalizedValue) {
    throw new Error(
      `Browser log level must be one of: ${BROWSER_LOG_LEVELS.join(", ")}.`
    );
  }

  currentBrowserLogLevel = normalizedValue;
  return currentBrowserLogLevel;
}

export function shouldBrowserLog(level) {
  const normalizedLevel = normalizeBrowserLogLevel(level, null);
  if (!normalizedLevel) {
    return false;
  }

  const activeLevel = getBrowserLogLevel();
  if (activeLevel === "silent") {
    return false;
  }

  return BROWSER_LOG_LEVEL_ORDER[normalizedLevel] >= BROWSER_LOG_LEVEL_ORDER[activeLevel];
}

export function logBrowser(level, message, details = undefined) {
  const normalizedLevel = normalizeBrowserLogLevel(level, null);
  if (!normalizedLevel || !shouldBrowserLog(normalizedLevel)) {
    return false;
  }

  const consoleMethod = normalizedLevel === "error"
    ? console.error
    : normalizedLevel === "warn"
      ? console.warn
      : normalizedLevel === "debug"
        ? console.debug
        : console.info;

  if (details === undefined) {
    consoleMethod(message);
    return true;
  }

  consoleMethod(message, details);
  return true;
}

export function browserConsoleEventLevelToLogLevel(level) {
  const normalizedLevel = Number(level);

  if (normalizedLevel >= 2) {
    return "error";
  }

  if (normalizedLevel === 1) {
    return "warn";
  }

  return "info";
}
