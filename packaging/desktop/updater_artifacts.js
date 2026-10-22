const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DESKTOP_UPDATER_CACHE_DIRNAMES = Object.freeze([
  "constellation-agent-updater",
  "agent-one-updater"
]);
const DESKTOP_UPDATER_INSTALL_MARKER_FILENAME = "desktop-updater-install.json";
const DESKTOP_UPDATER_PENDING_DIRNAME = "pending";

function resolveDesktopUpdaterBaseCachePath(options = {}) {
  const platform = String(options.platform || process.platform).trim() || process.platform;
  const homeDir = String(options.homeDir || os.homedir()).trim() || os.homedir();

  if (platform === "win32") {
    return String(options.localAppDataPath || process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local")).trim();
  }

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Caches");
  }

  return String(options.xdgCacheHome || process.env.XDG_CACHE_HOME || path.join(homeDir, ".cache")).trim();
}

function resolveDesktopUpdaterCacheRoots(options = {}) {
  if (!options.isPackaged) {
    return [];
  }

  const baseCachePath = String(
    options.baseCachePath || resolveDesktopUpdaterBaseCachePath(options)
  ).trim();

  if (!baseCachePath) {
    return [];
  }

  return DESKTOP_UPDATER_CACHE_DIRNAMES.map((dirname) => path.join(baseCachePath, dirname));
}

function resolveDesktopUpdaterInstallMarkerPath(options = {}) {
  const userDataPath = String(options.userDataPath || "").trim();

  if (!userDataPath) {
    return "";
  }

  return path.join(userDataPath, DESKTOP_UPDATER_INSTALL_MARKER_FILENAME);
}

async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function removeDirectoryIfEmpty(targetPath) {
  try {
    const entries = await fs.readdir(targetPath);

    if (entries.length > 0) {
      return false;
    }

    await fs.rmdir(targetPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTEMPTY") {
      return false;
    }

    throw error;
  }
}

async function writeDesktopUpdaterInstallMarker(options = {}) {
  const markerPath = resolveDesktopUpdaterInstallMarkerPath(options);

  if (!markerPath) {
    return "";
  }

  const payload = {
    fromVersion: String(options.fromVersion || "").trim(),
    targetVersion: String(options.targetVersion || "").trim(),
    writtenAt: new Date().toISOString()
  };

  await fs.mkdir(path.dirname(markerPath), {
    recursive: true
  });
  await fs.writeFile(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return markerPath;
}

async function cleanupDesktopUpdaterArtifacts(options = {}) {
  if (!options.isPackaged) {
    return {
      cleaned: false,
      clearedPaths: [],
      marker: null,
      markerPath: "",
      removedRoots: [],
      reason: "unpackaged"
    };
  }

  const markerPath = resolveDesktopUpdaterInstallMarkerPath(options);

  if (!markerPath) {
    return {
      cleaned: false,
      clearedPaths: [],
      marker: null,
      markerPath,
      removedRoots: [],
      reason: "no-user-data"
    };
  }

  if (!(await pathExists(markerPath))) {
    return {
      cleaned: false,
      clearedPaths: [],
      marker: null,
      markerPath,
      removedRoots: [],
      reason: "not-marked"
    };
  }

  let marker = null;

  try {
    const rawMarker = await fs.readFile(markerPath, "utf8");
    marker = JSON.parse(rawMarker);
  } catch {
    marker = null;
  }

  const clearedPaths = [];
  const removedRoots = [];

  for (const cacheRoot of resolveDesktopUpdaterCacheRoots(options)) {
    const pendingPath = path.join(cacheRoot, DESKTOP_UPDATER_PENDING_DIRNAME);

    if (await pathExists(pendingPath)) {
      await fs.rm(pendingPath, {
        force: true,
        recursive: true
      });
      clearedPaths.push(pendingPath);
    }

    if (await removeDirectoryIfEmpty(cacheRoot)) {
      removedRoots.push(cacheRoot);
    }
  }

  await fs.rm(markerPath, {
    force: true
  });

  return {
    cleaned: true,
    clearedPaths,
    marker,
    markerPath,
    removedRoots,
    reason: "marked"
  };
}

module.exports = {
  cleanupDesktopUpdaterArtifacts,
  resolveDesktopUpdaterBaseCachePath,
  resolveDesktopUpdaterCacheRoots,
  resolveDesktopUpdaterInstallMarkerPath,
  writeDesktopUpdaterInstallMarker
};
