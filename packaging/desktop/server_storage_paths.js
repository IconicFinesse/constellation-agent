const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DESKTOP_RUNTIME_STATE_MARKERS = Object.freeze([
  ["customware"],
  ["server", "data"]
]);
const DESKTOP_LEGACY_USER_DATA_DIRNAMES = Object.freeze([
  "Agent One",
  "agent-one",
  "Constellation Agent",
  "constellation-agent"
]);

function hasDesktopRuntimeState(rootPath) {
  const normalizedRootPath = String(rootPath || "").trim();

  if (!normalizedRootPath) {
    return false;
  }

  return DESKTOP_RUNTIME_STATE_MARKERS.some((segments) => {
    try {
      return fs.statSync(path.join(normalizedRootPath, ...segments)).isDirectory();
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        return false;
      }

      throw error;
    }
  });
}

function resolvePackagedDesktopUserDataPath(options = {}) {
  if (!options.isPackaged) {
    return "";
  }

  const defaultUserDataPath = String(options.defaultUserDataPath || "").trim();

  if (!defaultUserDataPath) {
    return "";
  }

  if (hasDesktopRuntimeState(defaultUserDataPath)) {
    return defaultUserDataPath;
  }

  const appDataPath = String(options.appDataPath || "").trim();

  if (!appDataPath) {
    return defaultUserDataPath;
  }

  for (const dirname of DESKTOP_LEGACY_USER_DATA_DIRNAMES) {
    const candidatePath = path.join(appDataPath, dirname);

    if (candidatePath === defaultUserDataPath) {
      continue;
    }

    if (hasDesktopRuntimeState(candidatePath)) {
      return candidatePath;
    }
  }

  return defaultUserDataPath;
}

function resolveDesktopServerTmpDir(options = {}) {
  if (!options.isPackaged) {
    return "";
  }

  const tempPath = String(options.tempPath || os.tmpdir());
  return path.join(tempPath, "constellation-agent", "server-tmp");
}

function resolveDesktopAuthDataDir(options = {}) {
  if (!options.isPackaged) {
    return "";
  }

  const userDataPath = String(options.userDataPath || "").trim();

  if (!userDataPath) {
    return "";
  }

  return path.join(userDataPath, "server", "data");
}

module.exports = {
  resolveDesktopAuthDataDir,
  resolveDesktopServerTmpDir,
  resolvePackagedDesktopUserDataPath
};
