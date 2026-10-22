import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createServerBootstrap } from "../server/app.js";
import {
  AUTH_DATA_DIR_ENV_NAME,
  buildAuthDataDir
} from "../server/lib/auth/keys_manage.js";

const require = createRequire(import.meta.url);
const {
  resolveDesktopAuthDataDir,
  resolveDesktopServerTmpDir,
  resolvePackagedDesktopUserDataPath
} = require("../packaging/desktop/server_storage_paths.js");
const {
  cleanupDesktopUpdaterArtifacts,
  resolveDesktopUpdaterCacheRoots,
  resolveDesktopUpdaterInstallMarkerPath,
  writeDesktopUpdaterInstallMarker
} = require("../packaging/desktop/updater_artifacts.js");
const {
  DESKTOP_UPDATER_LOG_RELATIVE_PATH,
  resolveDesktopUpdaterLogPath,
  resolveWindowsUpdaterInstallerArgs
} = require("../packaging/desktop/updater_install_options.js");
const {
  LINUX_ARM64_RELEASE_METADATA_FILE,
  WINDOWS_RELEASE_METADATA_FILE,
  findDesktopWindowsReleaseFile,
  normalizeDesktopReleaseAssetVersion,
  normalizeDesktopDebugReleaseVersion,
  normalizeDesktopWindowsReleaseArch,
  resolveDesktopWindowsReleaseArchFallback,
  resolveDesktopWindowsReleaseAssetFileName,
  resolveDesktopDebugReleaseAssetUrl,
  resolveDesktopDebugReleaseMetadataFileName,
  resolveDesktopDebugReleaseTag,
  stageDesktopDebugRelease
} = require("../packaging/desktop/updater_debug_release.js");
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, "..");

test("packaged desktop uses an OS temp directory outside the bundled server tree", () => {
  assert.equal(resolveDesktopServerTmpDir({ isPackaged: false, tempPath: "/tmp/ignored" }), "");
  assert.equal(
    resolveDesktopServerTmpDir({
      isPackaged: true,
      tempPath: "/run/user/1000"
    }),
    path.join("/run/user/1000", "constellation-agent", "server-tmp")
  );
});

test("packaged desktop temp directory falls back to the host temp root", () => {
  assert.equal(
    resolveDesktopServerTmpDir({
      isPackaged: true,
      tempPath: ""
    }),
    path.join(os.tmpdir(), "constellation-agent", "server-tmp")
  );
});

test("packaged desktop keeps the current user-data root when it already owns runtime state", async (testContext) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "space-desktop-user-data-"));
  const appDataPath = path.join(runtimeRoot, "Roaming");
  const currentUserDataPath = path.join(appDataPath, "Constellation Agent");
  const legacyUserDataPath = path.join(appDataPath, "Agent One");

  testContext.after(async () => {
    await fs.rm(runtimeRoot, {
      force: true,
      recursive: true
    });
  });

  await fs.mkdir(path.join(currentUserDataPath, "customware"), {
    recursive: true
  });
  await fs.mkdir(path.join(legacyUserDataPath, "customware"), {
    recursive: true
  });

  assert.equal(
    resolvePackagedDesktopUserDataPath({
      appDataPath,
      defaultUserDataPath: currentUserDataPath,
      isPackaged: true
    }),
    currentUserDataPath
  );
});

test("packaged desktop reuses the legacy Agent One user-data root when it still owns runtime state", async (testContext) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "space-desktop-legacy-user-data-"));
  const appDataPath = path.join(runtimeRoot, "Roaming");
  const currentUserDataPath = path.join(appDataPath, "Constellation Agent");
  const legacyUserDataPath = path.join(appDataPath, "Agent One");

  testContext.after(async () => {
    await fs.rm(runtimeRoot, {
      force: true,
      recursive: true
    });
  });

  await fs.mkdir(path.join(legacyUserDataPath, "customware"), {
    recursive: true
  });

  assert.equal(
    resolvePackagedDesktopUserDataPath({
      appDataPath,
      defaultUserDataPath: currentUserDataPath,
      isPackaged: true
    }),
    legacyUserDataPath
  );
});

test("packaged desktop updater keeps the stock Windows NSIS installer arguments", () => {
  assert.deepEqual(
    resolveWindowsUpdaterInstallerArgs({
      autoRunAppAfterInstall: true
    }),
    [
      "--updated",
      "--force-run"
    ]
  );
});

test("packaged desktop updater keeps a stable persistent log path under packaged user-data", () => {
  assert.equal(
    resolveDesktopUpdaterLogPath({
      platform: "win32",
      userDataPath: String.raw`C:\Users\alice\AppData\Roaming\Constellation Agent`
    }),
    path.win32.join(String.raw`C:\Users\alice\AppData\Roaming\Constellation Agent`, DESKTOP_UPDATER_LOG_RELATIVE_PATH)
  );
});

test("packaged desktop updater keeps the stock silent Windows NSIS installer arguments", () => {
  assert.deepEqual(
    resolveWindowsUpdaterInstallerArgs({
      autoRunAppAfterInstall: true,
      isForceRunAfter: true,
      isSilent: true,
      packagePath: String.raw`C:\Users\alice\AppData\Local\constellation-agent-updater\package.7z`
    }),
    [
      "--updated",
      "/S",
      "--force-run",
      String.raw`--package-file=C:\Users\alice\AppData\Local\constellation-agent-updater\package.7z`
    ]
  );
});

test("Windows NSIS installer hardens running-app shutdown and logs installer progress", async () => {
  const installerInclude = await fs.readFile(
    path.join(PROJECT_ROOT, "packaging", "platforms", "windows", "installer.nsh"),
    "utf8"
  );

  assert.match(installerInclude, /!macro customCheckAppRunning/);
  assert.match(installerInclude, /Installer checking for running app processes under \$INSTDIR\./);
  assert.match(installerInclude, /Installer is force-closing remaining app processes\./);
  assert.match(installerInclude, /Installer confirmed that no app processes remain under \$INSTDIR\./);
  assert.match(installerInclude, /Installer could not verify \$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\} after file copy\./);
  assert.match(installerInclude, /\$APPDATA\\\$\{APP_PACKAGE_NAME\}\\logs/);
  assert.match(installerInclude, /\$APPDATA\\Agent One\\logs/);
});

test("packaged desktop debug reinstall normalizes release versions and tags", () => {
  assert.equal(normalizeDesktopDebugReleaseVersion("", "0.49.0"), "0.49");
  assert.equal(normalizeDesktopDebugReleaseVersion("v0.48.0"), "0.48");
  assert.equal(normalizeDesktopDebugReleaseVersion("0.48.2"), "0.48.2");
  assert.equal(resolveDesktopDebugReleaseTag("", "0.49.0"), "v0.49");
  assert.equal(resolveDesktopDebugReleaseTag("0.48", "0.49.0"), "v0.48");
});

test("packaged desktop debug reinstall resolves platform metadata files", () => {
  assert.equal(
    resolveDesktopDebugReleaseMetadataFileName({
      platform: "win32",
      arch: "x64"
    }),
    WINDOWS_RELEASE_METADATA_FILE
  );
  assert.equal(
    resolveDesktopDebugReleaseMetadataFileName({
      platform: "linux",
      arch: "arm64"
    }),
    LINUX_ARM64_RELEASE_METADATA_FILE
  );
});

test("packaged desktop updater keeps canonical Windows release asset naming stable across archs", () => {
  assert.equal(normalizeDesktopReleaseAssetVersion("0.52.0"), "0.52");
  assert.equal(normalizeDesktopReleaseAssetVersion("0.52.3"), "0.52.3");
  assert.equal(normalizeDesktopWindowsReleaseArch("amd64"), "x64");
  assert.equal(normalizeDesktopWindowsReleaseArch("arm64"), "arm64");
  assert.equal(
    resolveDesktopWindowsReleaseAssetFileName({
      version: "0.52.0",
      arch: "x64"
    }),
    "Constellation-Agent-0.52-windows-x64.exe"
  );
  assert.equal(
    resolveDesktopWindowsReleaseAssetFileName({
      version: "0.52.0",
      arch: "arm64"
    }),
    "Constellation-Agent-0.52-windows-arm64.exe"
  );
});

test("packaged desktop updater detects Windows metadata that is missing the current arch installer", () => {
  const armOnlyInfo = {
    version: "0.52.0",
    files: [
      {
        url: "Constellation-Agent-0.52-windows-arm64.exe",
        sha512: "abc123",
        size: "1"
      }
    ]
  };

  assert.equal(findDesktopWindowsReleaseFile(armOnlyInfo, "x64"), null);
  assert.equal(findDesktopWindowsReleaseFile(armOnlyInfo, "arm64")?.url, "Constellation-Agent-0.52-windows-arm64.exe");
  assert.deepEqual(resolveDesktopWindowsReleaseArchFallback(armOnlyInfo, "x64"), {
    actualFiles: ["Constellation-Agent-0.52-windows-arm64.exe"],
    expectedArch: "x64",
    expectedFileName: "Constellation-Agent-0.52-windows-x64.exe"
  });
  assert.equal(resolveDesktopWindowsReleaseArchFallback(armOnlyInfo, "arm64"), null);
  assert.equal(
    resolveDesktopWindowsReleaseArchFallback(
      {
        version: "0.52.0",
        files: [
          {
            url: "Constellation-Agent-0.52-windows-arm64.exe",
            sha512: "abc123",
            size: "1"
          },
          {
            url: "Constellation-Agent-0.52-windows-x64.exe",
            sha512: "def456",
            size: "2"
          }
        ]
      },
      "x64"
    ),
    null
  );
});

test("packaged desktop debug reinstall stages same-version and downgrade releases against canonical GitHub assets", async () => {
  const publishConfig = {
    provider: "github",
    owner: "IconicFinesse",
    repo: "constellation-agent"
  };
  const fetchCalls = [];
  const fetchText = async (url) => {
    fetchCalls.push(url);
    return url.includes("/v0.48/")
      ? [
          "version: 0.48.0",
          "files:",
          "  - url: Constellation Agent 0.48 windows x64.exe",
          "    sha512: def456"
        ].join("\n")
      : [
          "version: 0.49.0",
          "files:",
          "  - url: Constellation Agent 0.49 windows x64.exe",
          "    sha512: abc123"
        ].join("\n");
  };
  const sameVersionStage = await stageDesktopDebugRelease({
    currentVersion: "0.49.0",
    platform: "win32",
    publishConfig,
    fetchText
  });
  const downgradeStage = await stageDesktopDebugRelease({
    requestedVersion: "0.48",
    currentVersion: "0.49.0",
    platform: "win32",
    publishConfig,
    fetchText
  });

  assert.equal(sameVersionStage.comparison, 0);
  assert.equal(sameVersionStage.tag, "v0.49");
  assert.equal(
    sameVersionStage.metadataUrl,
    resolveDesktopDebugReleaseAssetUrl({
      publishConfig,
      tag: "v0.49",
      fileName: WINDOWS_RELEASE_METADATA_FILE
    })
  );
  assert.equal(
    sameVersionStage.provider.resolveFiles(sameVersionStage.info)[0].url.href,
    "https://github.com/IconicFinesse/constellation-agent/releases/download/v0.49/Constellation-Agent-0.49-windows-x64.exe"
  );
  assert.equal(downgradeStage.comparison, -1);
  assert.equal(downgradeStage.tag, "v0.48");
  assert.deepEqual(fetchCalls, [
    "https://github.com/IconicFinesse/constellation-agent/releases/download/v0.49/metadata-latest-windows.yml",
    "https://github.com/IconicFinesse/constellation-agent/releases/download/v0.48/metadata-latest-windows.yml"
  ]);
});

test("packaged desktop updater cache roots cover current and legacy rebrand directories", () => {
  assert.deepEqual(
    resolveDesktopUpdaterCacheRoots({
      baseCachePath: "/Users/alessandro/AppData/Local",
      isPackaged: true
    }),
    [
      path.join("/Users/alessandro/AppData/Local", "constellation-agent-updater"),
      path.join("/Users/alessandro/AppData/Local", "agent-one-updater")
    ]
  );
});

test("packaged desktop updater cleanup keeps cached blockmaps but removes stale pending payloads after an install handoff", async (testContext) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "space-desktop-updater-cache-"));
  const localAppDataPath = path.join(runtimeRoot, "Local");
  const userDataPath = path.join(runtimeRoot, "Constellation Agent");
  const [currentCacheRoot, legacyCacheRoot] = resolveDesktopUpdaterCacheRoots({
    baseCachePath: localAppDataPath,
    isPackaged: true
  });
  const currentPendingPath = path.join(currentCacheRoot, "pending");
  const legacyPendingPath = path.join(legacyCacheRoot, "pending");
  const markerPath = resolveDesktopUpdaterInstallMarkerPath({
    userDataPath
  });

  testContext.after(async () => {
    await fs.rm(runtimeRoot, {
      force: true,
      recursive: true
    });
  });

  await fs.mkdir(currentPendingPath, {
    recursive: true
  });
  await fs.mkdir(legacyPendingPath, {
    recursive: true
  });
  await fs.writeFile(path.join(currentPendingPath, "Constellation-Agent-0.48-windows-x64.exe"), "installer\n", "utf8");
  await fs.writeFile(path.join(currentCacheRoot, "current.blockmap"), "blockmap\n", "utf8");
  await fs.writeFile(path.join(legacyPendingPath, "Agent-One-0.41-windows-x64.exe"), "installer\n", "utf8");

  const skippedResult = await cleanupDesktopUpdaterArtifacts({
    baseCachePath: localAppDataPath,
    isPackaged: true,
    userDataPath
  });

  assert.equal(skippedResult.cleaned, false);
  assert.equal(skippedResult.reason, "not-marked");
  assert.equal(await fs.stat(currentPendingPath).then(() => true, () => false), true);

  await writeDesktopUpdaterInstallMarker({
    fromVersion: "0.47.0",
    targetVersion: "0.48",
    userDataPath
  });

  const cleanupResult = await cleanupDesktopUpdaterArtifacts({
    baseCachePath: localAppDataPath,
    isPackaged: true,
    userDataPath
  });

  assert.equal(cleanupResult.cleaned, true);
  assert.equal(cleanupResult.marker?.targetVersion, "0.48");
  assert.deepEqual(cleanupResult.clearedPaths.sort(), [currentPendingPath, legacyPendingPath].sort());
  assert.equal(await fs.stat(path.join(currentCacheRoot, "current.blockmap")).then(() => true, () => false), true);
  assert.equal(await fs.stat(currentPendingPath).then(() => true, () => false), false);
  assert.equal(await fs.stat(legacyPendingPath).then(() => true, () => false), false);
  assert.equal(await fs.stat(legacyCacheRoot).then(() => true, () => false), false);
  assert.equal(await fs.stat(markerPath).then(() => true, () => false), false);
});
test("packaged desktop auth data moves to the user-data tree", () => {
  const userDataPath = "/home/alessandro/.config/Constellation Agent";

  assert.equal(
    resolveDesktopAuthDataDir({
      isPackaged: true,
      userDataPath
    }),
    path.join(userDataPath, "server", "data")
  );
  assert.equal(
    buildAuthDataDir("/tmp/.mount_Space-abc123/resources/app", {
      [AUTH_DATA_DIR_ENV_NAME]: path.join(userDataPath, "server", "data")
    }),
    path.join(userDataPath, "server", "data")
  );
});

test("server bootstrap honors a packaged desktop tmpDir override", async (testContext) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "space-desktop-bootstrap-"));
  const tmpDir = path.join(runtimeRoot, "runtime", "constellation-agent", "server-tmp");

  testContext.after(async () => {
    await fs.rm(runtimeRoot, {
      force: true,
      recursive: true
    });
  });

  const bootstrap = await createServerBootstrap({
    projectRoot: PROJECT_ROOT,
    runtimeParamEnv: {},
    runtimeParamOverrides: {
      CUSTOMWARE_PATH: path.join(runtimeRoot, "customware"),
      HOST: "127.0.0.1",
      PORT: "0",
      SINGLE_USER_APP: "true",
      WORKERS: "1"
    },
    tmpDir
  });

  const stats = await fs.stat(tmpDir);

  assert.equal(bootstrap.tmpDir, tmpDir);
  assert.equal(stats.isDirectory(), true);
});
