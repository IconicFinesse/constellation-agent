import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

import {
  parseSimpleYaml,
  serializeSimpleYaml
} from "../../../app/L0/_all/modules/_core/framework/js/yaml-lite.js";
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
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_MAX_COMMENT_BYTES = 65535;
const ZIP_UNIX_MODE_MASK = 0o170000;
const ZIP_UNIX_DIRECTORY_MODE = 0o040000;
const ZIP_UNIX_SYMLINK_MODE = 0o120000;

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

const ZIP_CRC32_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

function updateZipCrc32(crc, bytes) {
  let nextCrc = crc;

  for (let index = 0; index < bytes.length; index += 1) {
    nextCrc = ZIP_CRC32_TABLE[(nextCrc ^ bytes[index]) & 0xff] ^ (nextCrc >>> 8);
  }

  return nextCrc;
}

function readZipEndOfCentralDirectoryOffset(payloadBuffer) {
  const minimumOffset = Math.max(0, payloadBuffer.length - (ZIP_MAX_COMMENT_BYTES + 22));

  for (let offset = payloadBuffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (payloadBuffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }

  throw createInvalidZipError();
}

function createInvalidZipError() {
  return createShareError(
    "Share archive inspection failed. The uploaded file is not a valid ZIP archive.",
    400
  );
}

function readZipArchiveEntries(payloadBuffer) {
  if (!Buffer.isBuffer(payloadBuffer) || payloadBuffer.length === 0) {
    throw createShareError("Shared space archives must not be empty.", 400);
  }

  if (payloadBuffer.length < 22) {
    throw createInvalidZipError();
  }

  const eocdOffset = readZipEndOfCentralDirectoryOffset(payloadBuffer);
  const entryCount = payloadBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = payloadBuffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = payloadBuffer.readUInt32LE(eocdOffset + 16);

  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw createShareError(
      "Share archive inspection failed. ZIP64 archives are not supported.",
      400
    );
  }

  if (centralDirectoryOffset + centralDirectorySize > payloadBuffer.length) {
    throw createInvalidZipError();
  }

  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > payloadBuffer.length ||
      payloadBuffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw createInvalidZipError();
    }

    const flags = payloadBuffer.readUInt16LE(offset + 8);
    const compressionMethod = payloadBuffer.readUInt16LE(offset + 10);
    const crc32 = payloadBuffer.readUInt32LE(offset + 16);

    if ((flags & ZIP_ENCRYPTED_FLAG) !== 0) {
      throw createShareError(
        "Share archive extraction failed. Password-protected ZIP entries are not supported.",
        400
      );
    }

    const compressedSize = payloadBuffer.readUInt32LE(offset + 20);
    const uncompressedSize = payloadBuffer.readUInt32LE(offset + 24);
    const nameLength = payloadBuffer.readUInt16LE(offset + 28);
    const extraLength = payloadBuffer.readUInt16LE(offset + 30);
    const commentLength = payloadBuffer.readUInt16LE(offset + 32);
    const externalAttributes = payloadBuffer.readUInt32LE(offset + 38);
    const localHeaderOffset = payloadBuffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;

    if (nameStart + nameLength > payloadBuffer.length) {
      throw createInvalidZipError();
    }

    const name = payloadBuffer
      .subarray(nameStart, nameStart + nameLength)
      .toString((flags & ZIP_UTF8_FLAG) !== 0 ? "utf8" : "latin1")
      .replace(/\\/gu, "/");
    const unixMode = (externalAttributes >>> 16) & ZIP_UNIX_MODE_MASK;

    if (unixMode === ZIP_UNIX_SYMLINK_MODE) {
      throw createShareError("Shared space archives must not contain symbolic links.", 400);
    }

    entries.push({
      compressedSize,
      compressionMethod,
      crc32,
      isDirectory: name.endsWith("/") || unixMode === ZIP_UNIX_DIRECTORY_MODE,
      localHeaderOffset,
      name,
      uncompressedSize
    });

    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

function normalizeArchiveEntryName(value) {
  const normalizedEntry = String(value || "").replace(/\\/gu, "/").trim();

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
}

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw createShareError("Shared space archives must not be empty.", 400);
  }

  return entries.map((entry) => ({
    ...entry,
    name: normalizeArchiveEntryName(entry.name)
  }));
}

function readArchiveEntryRange(payloadBuffer, entry) {
  const localHeaderOffset = Number(entry.localHeaderOffset);

  if (
    !Number.isInteger(localHeaderOffset) ||
    localHeaderOffset < 0 ||
    localHeaderOffset + 30 > payloadBuffer.length ||
    payloadBuffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE
  ) {
    throw createShareError(
      "Share archive extraction failed. The uploaded archive entry data is invalid.",
      400
    );
  }

  const nameLength = payloadBuffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = payloadBuffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + Number(entry.compressedSize || 0);

  if (dataStart < 0 || dataEnd > payloadBuffer.length) {
    throw createShareError(
      "Share archive extraction failed. The uploaded archive is truncated.",
      400
    );
  }

  return payloadBuffer.subarray(dataStart, dataEnd);
}

function createArchiveEntryVerifier(entry) {
  const expectedSize =
    Number.isInteger(entry.uncompressedSize) && entry.uncompressedSize > 0
      ? entry.uncompressedSize
      : 0;
  const expectedCrc =
    Number.isInteger(entry.crc32) && entry.crc32 >= 0 ? entry.crc32 : null;
  let crc = 0xffffffff;
  let writtenBytes = 0;

  return {
    push(chunk) {
      writtenBytes += chunk.length;

      if (expectedSize > 0 && writtenBytes > expectedSize) {
        throw createShareError(
          "Share archive extraction failed. The uploaded archive data is corrupt.",
          400
        );
      }

      crc = updateZipCrc32(crc, chunk);
      return chunk;
    },
    verify() {
      if (expectedSize > 0 && writtenBytes !== expectedSize) {
        throw createShareError(
          "Share archive extraction failed. The uploaded archive data is corrupt.",
          400
        );
      }

      if (expectedCrc !== null && ((crc ^ 0xffffffff) >>> 0) !== expectedCrc) {
        throw createShareError(
          "Share archive extraction failed. The uploaded archive data is corrupt.",
          400
        );
      }
    }
  };
}

async function writeArchiveEntryToFile(payloadBuffer, entry, targetPath) {
  const compressedBytes = readArchiveEntryRange(payloadBuffer, entry);
  const verifier = createArchiveEntryVerifier(entry);
  const source = Readable.from([compressedBytes]);
  const verifyStream = new Transform({
    transform(chunk, encoding, callback) {
      try {
        callback(null, verifier.push(chunk));
      } catch (error) {
        callback(error);
      }
    }
  });
  const stages = [source];

  if (entry.compressionMethod === ZIP_METHOD_DEFLATE) {
    stages.push(zlib.createInflateRaw());
  } else if (entry.compressionMethod !== ZIP_METHOD_STORED) {
    throw createShareError(
      "Share archive extraction failed. The uploaded archive uses an unsupported compression method.",
      400
    );
  }

  stages.push(verifyStream, fs.createWriteStream(targetPath));

  try {
    await pipeline(...stages);
  } catch (error) {
    if (error && error.statusCode) {
      throw error;
    }

    throw createShareError(
      "Share archive extraction failed. The uploaded archive data is corrupt.",
      400
    );
  }

  verifier.verify();
}

async function extractArchiveToDirectory(payloadBuffer, entries, targetDir) {
  for (const entry of entries) {
    const entryPath = path.resolve(targetDir, entry.name.replace(/\/+$/u, ""));

    if (entryPath !== targetDir && !entryPath.startsWith(targetDir + path.sep)) {
      throw createShareError("Shared space archive contains an unsafe path.", 400);
    }

    if (entry.isDirectory) {
      await fsp.mkdir(entryPath, { recursive: true });
      continue;
    }

    await fsp.mkdir(path.dirname(entryPath), { recursive: true });
    await writeArchiveEntryToFile(payloadBuffer, entry, entryPath);
  }
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

  if (!Buffer.isBuffer(payloadBuffer)) {
    throw createShareError(
      "Shared space imports require the raw ZIP archive bytes.",
      400
    );
  }

  const entries = validateArchiveEntries(readZipArchiveEntries(payloadBuffer));
  const archiveDir = createUniqueTempDir(options.tempPrefix || "share-archive", options.tmpDir);
  const extractionDir = path.join(archiveDir, "extracted");

  try {
    await fsp.mkdir(extractionDir, { recursive: true });

    try {
      await extractArchiveToDirectory(payloadBuffer, entries, extractionDir);
    } catch (error) {
      if (error && error.statusCode) {
        throw error;
      }

      throw createShareError(
        "Share archive extraction failed. The uploaded archive could not be extracted.",
        400
      );
    }

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
