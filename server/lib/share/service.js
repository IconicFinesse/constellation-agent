import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  parseSimpleYaml,
  serializeSimpleYaml
} from "../../../app/L0/_all/mod/_core/framework/js/yaml-lite.js";
import { SERVER_TMP_DIR } from "../../config.js";
import { recordAppPathMutations } from "../customware/git_history.js";
import { normalizeEntityId } from "../customware/layout.js";
import { ensureServerTmpDir } from "../tmp/tmp_watch.js";
import {
  areGuestUsersAllowed,
  isCloudShareAllowed
} from "../utils/runtime_params.js";
import { createGuestUser } from "../auth/user_manage.js";
import { buildUserAbsolutePath } from "../auth/user_files.js";

const CLOUD_SHARE_MAX_BYTES = 2 * 1024 * 1024;
const SHARE_TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SHARE_TOKEN_LENGTH = 8;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9]{8}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const IMPORTED_SPACE_PREFIX = "imported-";
const MAX_ARCHIVE_TOOL_STDIO_BYTES = 8192;

function createShareError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeShareToken(value) {
  const candidate = String(value || "").trim();
  return SHARE_TOKEN_PATTERN.test(candidate) ? candidate : "";
}

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) {
    return value;
  }

  const candidate = String(value || "").trim().toLowerCase();

  if (candidate === "true") {
    return true;
  }

  if (candidate === "false") {
    return false;
  }

  return fallback;
}

function normalizePositiveInteger(value, fallback = 0) {
  const candidate = Number(value);
  return Number.isInteger(candidate) && candidate > 0 ? candidate : fallback;
}

function isBase64UrlValue(value) {
  const candidate = String(value || "").trim();
  return Boolean(candidate) && BASE64URL_PATTERN.test(candidate);
}

function normalizeCloudShareEncryptionMeta(value = {}) {
  const encrypted = normalizeBoolean(value.encrypted, false);

  if (!encrypted) {
    return {
      encrypted: false,
      encryption: null
    };
  }

  const salt = String(value.salt || "").trim();
  const iv = String(value.iv || "").trim();
  const iterations = normalizePositiveInteger(value.iterations, 0);
  const cipher = String(value.cipher || "AES-GCM").trim() || "AES-GCM";
  const kdf = String(value.kdf || "PBKDF2-SHA-256").trim() || "PBKDF2-SHA-256";

  if (!isBase64UrlValue(salt) || !isBase64UrlValue(iv) || !iterations) {
    throw createShareError("Invalid cloud-share encryption metadata.", 400);
  }

  return {
    encrypted: true,
    encryption: {
      cipher,
      iv,
      iterations,
      kdf,
      salt
    }
  };
}

function createRandomString(length, alphabet) {
  const normalizedLength = Number(length);
  const sourceAlphabet = String(alphabet || "");

  if (!Number.isInteger(normalizedLength) || normalizedLength <= 0 || !sourceAlphabet) {
    return "";
  }

  const bytes = randomBytes(normalizedLength);
  let output = "";

  for (let index = 0; index < normalizedLength; index += 1) {
    output += sourceAlphabet[bytes[index] % sourceAlphabet.length];
  }

  return output;
}

function createShareToken() {
  return createRandomString(SHARE_TOKEN_LENGTH, SHARE_TOKEN_ALPHABET);
}

function normalizeCloudSharePublicBaseUrl(runtimeParams, requestUrl = null) {
  const configuredValue =
    runtimeParams && typeof runtimeParams.get === "function"
      ? String(runtimeParams.get("CLOUD_SHARE_URL", "") || "").trim()
      : "";
  const fallbackValue = requestUrl && requestUrl.origin ? String(requestUrl.origin) : "";
  const candidate = configuredValue || fallbackValue;

  if (!candidate) {
    return "";
  }

  const normalizedInput = /^https?:\/\//iu.test(candidate) ? candidate : "https://" + candidate;

  try {
    const normalizedUrl = new URL(normalizedInput);
    normalizedUrl.hash = "";
    normalizedUrl.search = "";
    normalizedUrl.pathname = "";
    return normalizedUrl.toString().replace(/\/$/u, "");
  } catch {
    return fallbackValue.replace(/\/$/u, "");
  }
}

function getConfiguredCustomwareRoot(projectRoot, runtimeParams) {
  const configuredPath =
    runtimeParams && typeof runtimeParams.get === "function"
      ? String(runtimeParams.get("CUSTOMWARE_PATH", "") || "").trim()
      : "";

  if (!configuredPath) {
    return "";
  }

  return path.resolve(String(projectRoot || ""), configuredPath);
}

function getCloudShareStoreRoot(projectRoot, runtimeParams) {
  const customwareRoot = getConfiguredCustomwareRoot(projectRoot, runtimeParams);

  if (!customwareRoot) {
    throw createShareError("Hosted cloud sharing requires CUSTOMWARE_PATH.", 503);
  }

  return path.join(customwareRoot, "share", "spaces");
}

async function ensureCloudShareStoreRoot(projectRoot, runtimeParams) {
  const shareStoreRoot = getCloudShareStoreRoot(projectRoot, runtimeParams);
  await fsp.mkdir(shareStoreRoot, { recursive: true });
  return shareStoreRoot;
}

function buildCloudShareArchivePath(shareStoreRoot, shareToken) {
  return path.join(shareStoreRoot, shareToken + ".zip");
}

function buildCloudShareMetaPath(shareStoreRoot, shareToken) {
  return path.join(shareStoreRoot, shareToken + ".json");
}

async function findAvailableCloudShareToken(shareStoreRoot) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const shareToken = createShareToken();
    const archivePath = buildCloudShareArchivePath(shareStoreRoot, shareToken);

    try {
      await fsp.access(archivePath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return shareToken;
      }

      throw error;
    }
  }

  throw createShareError("Failed to allocate a cloud share token.", 500);
}

async function writeCloudShareMetaFile(metaPath, metadata) {
  await fsp.writeFile(metaPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
}

async function createHostedCloudShare(options = {}) {
  const payloadBuffer = Buffer.isBuffer(options.payloadBuffer)
    ? options.payloadBuffer
    : Buffer.from(options.payloadBuffer || []);

  if (!isCloudShareAllowed(options.runtimeParams)) {
    throw createShareError("Cloud-share uploads are disabled on this server.", 404);
  }

  if (!areGuestUsersAllowed(options.runtimeParams)) {
    throw createShareError("Guest users are disabled on this server.", 404);
  }

  if (!payloadBuffer.length) {
    throw createShareError("Shared space uploads must not be empty.", 400);
  }

  if (payloadBuffer.length > CLOUD_SHARE_MAX_BYTES) {
    throw createShareError("Shared space uploads must be 2 MB or smaller.", 413);
  }

  const encryptionMeta = normalizeCloudShareEncryptionMeta(options.meta || {});
  const shareStoreRoot = await ensureCloudShareStoreRoot(options.projectRoot, options.runtimeParams);
  const shareToken = await findAvailableCloudShareToken(shareStoreRoot);
  const createdAt = new Date().toISOString();
  const metadata = {
    createdAt,
    encrypted: encryptionMeta.encrypted,
    encryption: encryptionMeta.encryption,
    lastUsedAt: "",
    sizeBytes: payloadBuffer.length,
    token: shareToken
  };

  await fsp.writeFile(buildCloudShareArchivePath(shareStoreRoot, shareToken), payloadBuffer);
  await writeCloudShareMetaFile(buildCloudShareMetaPath(shareStoreRoot, shareToken), metadata);

  return {
    shareToken,
    shareUrl: normalizeCloudSharePublicBaseUrl(options.runtimeParams, options.requestUrl) + "/share/space/" + shareToken
  };
}

async function readHostedCloudShareMeta(projectRoot, runtimeParams, rawShareToken) {
  const shareToken = normalizeShareToken(rawShareToken);

  if (!shareToken) {
    throw createShareError("Invalid cloud-share token.", 404);
  }

  const shareStoreRoot = getCloudShareStoreRoot(projectRoot, runtimeParams);
  const metaPath = buildCloudShareMetaPath(shareStoreRoot, shareToken);
  let sourceText = "";

  try {
    sourceText = await fsp.readFile(metaPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw createShareError("Cloud share not found.", 404);
    }

    throw error;
  }

  let metadata;

  try {
    metadata = JSON.parse(sourceText);
  } catch {
    throw createShareError("Stored cloud-share metadata is invalid.", 500);
  }

  return {
    metaPath,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    shareStoreRoot,
    shareToken
  };
}

async function readHostedCloudShareArchive(projectRoot, runtimeParams, rawShareToken) {
  const shareInfo = await readHostedCloudShareMeta(projectRoot, runtimeParams, rawShareToken);
  const archivePath = buildCloudShareArchivePath(shareInfo.shareStoreRoot, shareInfo.shareToken);
  let payloadBuffer;

  try {
    payloadBuffer = await fsp.readFile(archivePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw createShareError("Cloud share not found.", 404);
    }

    throw error;
  }

  return {
    ...shareInfo,
    archivePath,
    payloadBuffer
  };
}

async function updateHostedCloudShareLastUsed(projectRoot, runtimeParams, rawShareToken) {
  const shareInfo = await readHostedCloudShareMeta(projectRoot, runtimeParams, rawShareToken);
  shareInfo.metadata.lastUsedAt = new Date().toISOString();
  await writeCloudShareMetaFile(shareInfo.metaPath, shareInfo.metadata);
  return shareInfo.metadata;
}

function sanitizeTempSegment(value) {
  const candidate = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return candidate || "share";
}

function createUniqueTempDir(prefix, tmpDir) {
  const tmpRoot = ensureServerTmpDir(tmpDir || SERVER_TMP_DIR);
  const tempDirPath = path.join(
    tmpRoot,
    sanitizeTempSegment(prefix) + "-" + Date.now().toString(36) + "-" + randomBytes(5).toString("hex")
  );
  fs.mkdirSync(tempDirPath, { recursive: true });
  return tempDirPath;
}

function removePathQuietly(targetPath) {
  if (!targetPath) {
    return;
  }

  fs.rm(targetPath, { force: true, recursive: true }, () => {});
}

function runArchiveTool(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || undefined,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdoutText = "";
    let stderrText = "";

    child.stdout.on("data", (chunk) => {
      if (stdoutText.length < MAX_ARCHIVE_TOOL_STDIO_BYTES) {
        stdoutText += String(chunk);
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderrText.length < MAX_ARCHIVE_TOOL_STDIO_BYTES) {
        stderrText += String(chunk);
      }
    });

    child.once("error", (error) => {
      reject(createShareError((options.missingCommandMessage || "Archive tool is unavailable.") + " " + error.message, 500));
    });

    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({
          stderrText: stderrText.trim(),
          stdoutText: stdoutText.trim()
        });
        return;
      }

      const detail = stderrText.trim() || stdoutText.trim();
      reject(
        createShareError(
          (options.failurePrefix || "Archive tool failed.") + (detail ? " " + detail : signal ? " Interrupted by " + signal + "." : " Exit code " + String(code) + "."),
          400
        )
      );
    });
  });
}

async function listArchiveEntries(archivePath) {
  const result = await runArchiveTool(
    "unzip",
    ["-Z1", archivePath],
    {
      failurePrefix: "Share archive inspection failed.",
      missingCommandMessage: "The unzip tool is unavailable on this host."
    }
  );

  return result.stdoutText
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
}

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw createShareError("Shared space archives must not be empty.", 400);
  }

  return entries.map((entry) => {
    const normalizedEntry = String(entry || "").replace(/\\/gu, "/").trim();

    if (!normalizedEntry) {
      throw createShareError("Shared space archive contains an invalid entry.", 400);
    }

    if (normalizedEntry.startsWith("/") || /^[A-Za-z]:/u.test(normalizedEntry)) {
      throw createShareError("Shared space archive contains an absolute path.", 400);
    }

    const segments = normalizedEntry.replace(/\/+$/u, "").split("/").filter(Boolean);

    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw createShareError("Shared space archive contains an unsafe path.", 400);
    }

    return normalizedEntry;
  });
}

async function extractArchiveToDirectory(archivePath, targetDir) {
  await runArchiveTool(
    "unzip",
    ["-q", archivePath, "-d", targetDir],
    {
      failurePrefix: "Share archive extraction failed.",
      missingCommandMessage: "The unzip tool is unavailable on this host."
    }
  );
}

async function resolveExtractedSpaceRoot(extractionDir) {
  const directManifestPath = path.join(extractionDir, "space.yaml");

  try {
    const stats = await fsp.stat(directManifestPath);

    if (stats.isFile()) {
      return extractionDir;
    }
  } catch {}

  const topLevelEntries = await fsp.readdir(extractionDir, { withFileTypes: true });
  const candidateDirectories = topLevelEntries.filter((entry) => entry.isDirectory() && entry.name !== "__MACOSX");
  const nonAuxiliaryEntries = topLevelEntries.filter((entry) => entry.name !== "__MACOSX");

  if (candidateDirectories.length === 1 && nonAuxiliaryEntries.length === 1) {
    const candidateRoot = path.join(extractionDir, candidateDirectories[0].name);
    const candidateManifestPath = path.join(candidateRoot, "space.yaml");
    const stats = await fsp.stat(candidateManifestPath).catch(() => null);

    if (stats && stats.isFile()) {
      return candidateRoot;
    }
  }

  throw createShareError("Shared space archive must contain exactly one space folder.", 400);
}

async function assertDirectoryTreeHasNoSymlinks(rootDir) {
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const dirEntries = await fsp.readdir(currentDir, { withFileTypes: true });

    for (const entry of dirEntries) {
      const absolutePath = path.join(currentDir, entry.name);
      const stats = await fsp.lstat(absolutePath);

      if (stats.isSymbolicLink()) {
        throw createShareError("Shared space archives must not contain symbolic links.", 400);
      }

      if (stats.isDirectory()) {
        queue.push(absolutePath);
      }
    }
  }
}

async function validateExtractedSpaceRoot(spaceRoot) {
  await assertDirectoryTreeHasNoSymlinks(spaceRoot);

  const manifestPath = path.join(spaceRoot, "space.yaml");
  const widgetsDir = path.join(spaceRoot, "widgets");
  const manifestSource = await fsp.readFile(manifestPath, "utf8").catch(() => "");

  if (!manifestSource.trim()) {
    throw createShareError("Shared space archives must include space.yaml.", 400);
  }

  let manifest;

  try {
    manifest = parseSimpleYaml(manifestSource);
  } catch {
    throw createShareError("Shared space manifest is invalid.", 400);
  }

  const widgetEntries = await fsp.readdir(widgetsDir, { withFileTypes: true }).catch(() => []);
  const widgetFiles = widgetEntries.filter((entry) => entry.isFile() && /\.(yaml|js)$/u.test(entry.name));

  if (widgetFiles.length === 0) {
    throw createShareError("Shared spaces must include at least one widget.", 400);
  }

  for (const widgetEntry of widgetFiles) {
    const widgetPath = path.join(widgetsDir, widgetEntry.name);
    const widgetSource = await fsp.readFile(widgetPath, "utf8");

    if (!widgetSource.trim()) {
      throw createShareError("Shared space widget files must not be empty.", 400);
    }

    if (widgetEntry.name.endsWith(".yaml")) {
      let widgetRecord;

      try {
        widgetRecord = parseSimpleYaml(widgetSource);
      } catch {
        throw createShareError("Shared space widget YAML is invalid.", 400);
      }

      if (!widgetRecord || typeof widgetRecord !== "object") {
        throw createShareError("Shared space widget YAML is invalid.", 400);
      }

      if (!String(widgetRecord.renderer || "").trim()) {
        throw createShareError("Shared space widget YAML must include a renderer.", 400);
      }
    }
  }

  return manifest && typeof manifest === "object" ? manifest : {};
}

async function extractValidatedSpaceArchive(payloadBuffer, options = {}) {
  const archiveDir = createUniqueTempDir(options.tempPrefix || "share-archive", options.tmpDir);
  const archivePath = path.join(archiveDir, "space.zip");
  const extractionDir = path.join(archiveDir, "extracted");
  await fsp.mkdir(extractionDir, { recursive: true });
  await fsp.writeFile(archivePath, payloadBuffer);

  try {
    const entries = validateArchiveEntries(await listArchiveEntries(archivePath));

    if (!entries.length) {
      throw createShareError("Shared space archives must not be empty.", 400);
    }

    await extractArchiveToDirectory(archivePath, extractionDir);
    const spaceRoot = await resolveExtractedSpaceRoot(extractionDir);
    const manifest = await validateExtractedSpaceRoot(spaceRoot);

    return {
      archiveDir,
      manifest,
      spaceRoot
    };
  } catch (error) {
    removePathQuietly(archiveDir);
    throw error;
  }
}

async function removeExtractedSpaceArchive(archiveHandle) {
  removePathQuietly(archiveHandle && archiveHandle.archiveDir ? archiveHandle.archiveDir : "");
}

async function readExistingImportedSpaceIds(projectRoot, username, runtimeParams) {
  const spacesRoot = buildUserAbsolutePath(projectRoot, username, "spaces", runtimeParams);
  const dirEntries = await fsp.readdir(spacesRoot, { withFileTypes: true }).catch(() => []);
  return dirEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function createNextImportedSpaceId(projectRoot, username, runtimeParams) {
  const existingIds = new Set(await readExistingImportedSpaceIds(projectRoot, username, runtimeParams));
  let suffix = 1;

  while (true) {
    const nextId = IMPORTED_SPACE_PREFIX + String(suffix);

    if (!existingIds.has(nextId)) {
      return nextId;
    }

    suffix += 1;
  }
}

function normalizeInstalledSpaceTitle(value, fallback) {
  const candidate = String(value || "").trim();
  return candidate || String(fallback || "").trim() || "Imported";
}

function writeInstalledSpaceManifest(spaceRoot, manifest, destinationId, destinationTitle) {
  const manifestPath = path.join(spaceRoot, "space.yaml");
  const timestamp = new Date().toISOString();
  const nextManifest = {
    ...(manifest && typeof manifest === "object" ? manifest : {}),
    created_at: timestamp,
    id: destinationId,
    title: normalizeInstalledSpaceTitle(destinationTitle, destinationId),
    updated_at: timestamp
  };

  fs.writeFileSync(manifestPath, serializeSimpleYaml(nextManifest), "utf8");
}

async function installExtractedSpaceIntoUser(options = {}) {
  const destinationId = normalizeEntityId(options.destinationId);
  const username = normalizeEntityId(options.username);

  if (!destinationId || !username) {
    throw createShareError("Imported spaces require a destination id and username.", 400);
  }

  const spacesRoot = buildUserAbsolutePath(options.projectRoot, username, "spaces", options.runtimeParams);
  const destinationRoot = path.join(spacesRoot, destinationId);
  await fsp.mkdir(spacesRoot, { recursive: true });
  await fsp.rm(destinationRoot, { force: true, recursive: true });
  fs.cpSync(options.spaceRoot, destinationRoot, { force: true, recursive: true });
  await fsp.mkdir(path.join(destinationRoot, "data"), { recursive: true });
  await fsp.mkdir(path.join(destinationRoot, "assets"), { recursive: true });
  await fsp.mkdir(path.join(destinationRoot, "widgets"), { recursive: true });
  writeInstalledSpaceManifest(destinationRoot, options.manifest, destinationId, options.destinationTitle);
  recordAppPathMutations(
    {
      projectRoot: options.projectRoot,
      runtimeParams: options.runtimeParams
    },
    ["/app/L2/" + username + "/spaces/" + destinationId + "/"]
  );

  return {
    spaceId: destinationId,
    title: normalizeInstalledSpaceTitle(options.destinationTitle, destinationId)
  };
}

async function importSpaceArchiveForUser(options = {}) {
  const username = normalizeEntityId(options.username);

  if (!username) {
    throw createShareError("Space import requires an authenticated user.", 401);
  }

  const mode = String(options.mode || "import").trim().toLowerCase();
  const archiveHandle = await extractValidatedSpaceArchive(options.payloadBuffer, {
    tempPrefix: "space-import-" + username,
    tmpDir: options.tmpDir
  });

  try {
    if (mode === "replace") {
      const destinationId = normalizeEntityId(options.targetSpaceId);

      if (!destinationId) {
        throw createShareError("Space replacement requires a target space id.", 400);
      }

      return await installExtractedSpaceIntoUser({
        destinationId,
        destinationTitle: archiveHandle.manifest.title || destinationId,
        manifest: archiveHandle.manifest,
        projectRoot: options.projectRoot,
        runtimeParams: options.runtimeParams,
        spaceRoot: archiveHandle.spaceRoot,
        username
      });
    }

    const destinationId = await createNextImportedSpaceId(options.projectRoot, username, options.runtimeParams);

    return await installExtractedSpaceIntoUser({
      destinationId,
      destinationTitle: destinationId,
      manifest: archiveHandle.manifest,
      projectRoot: options.projectRoot,
      runtimeParams: options.runtimeParams,
      spaceRoot: archiveHandle.spaceRoot,
      username
    });
  } finally {
    await removeExtractedSpaceArchive(archiveHandle);
  }
}

async function cloneHostedCloudShareToGuest(options = {}) {
  if (!areGuestUsersAllowed(options.runtimeParams)) {
    throw createShareError("Guest users are disabled on this server.", 404);
  }

  const shareToken = normalizeShareToken(options.shareToken);

  if (!shareToken) {
    throw createShareError("Invalid cloud-share token.", 404);
  }

  const archiveHandle = await extractValidatedSpaceArchive(options.payloadBuffer, {
    tempPrefix: "share-clone-" + shareToken,
    tmpDir: options.tmpDir
  });

  try {
    const guestAccount = createGuestUser(options.projectRoot, {
      runtimeParams: options.runtimeParams
    });
    const destinationId = await createNextImportedSpaceId(
      options.projectRoot,
      guestAccount.username,
      options.runtimeParams
    );
    const importedSpace = await installExtractedSpaceIntoUser({
      destinationId,
      destinationTitle: destinationId,
      manifest: archiveHandle.manifest,
      projectRoot: options.projectRoot,
      runtimeParams: options.runtimeParams,
      spaceRoot: archiveHandle.spaceRoot,
      username: guestAccount.username
    });
    await updateHostedCloudShareLastUsed(options.projectRoot, options.runtimeParams, shareToken);

    return {
      importedSpace,
      password: guestAccount.password,
      username: guestAccount.username
    };
  } finally {
    await removeExtractedSpaceArchive(archiveHandle);
  }
}

export {
  CLOUD_SHARE_MAX_BYTES,
  cloneHostedCloudShareToGuest,
  createHostedCloudShare,
  importSpaceArchiveForUser,
  normalizeCloudSharePublicBaseUrl,
  normalizeShareToken,
  readHostedCloudShareArchive,
  readHostedCloudShareMeta,
  updateHostedCloudShareLastUsed
};
