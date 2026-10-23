import fs from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

import { recordAppPathMutations } from "../customware/git_history.js";
import { ensureAuthDataDir, loadAuthKeys } from "./keys_manage.js";
import {
  USER_CRYPTO_FILENAME,
  normalizeUsername,
  readUserCryptoRecord,
  writeUserCryptoRecord
} from "./user_files.js";

const USER_CRYPTO_RECORD_VERSION = 1;
const USER_CRYPTO_SERVER_SHARE_DIRNAME = "user_crypto";
const USER_CRYPTO_SERVER_SHARE_AAD_PREFIX = "space-user-crypto-server-share-v1";
const USER_CRYPTO_SERVER_SHARE_IV_LENGTH = 12;
const USER_CRYPTO_SERVER_SHARE_STORAGE = "server-sealed-aes-256-gcm";
const USER_CRYPTO_SECRET_LENGTH = 32;
const USER_CRYPTO_STATUS_INVALIDATED = "invalidated";
const USER_CRYPTO_STATUS_MISSING = "missing";
const USER_CRYPTO_STATUS_READY = "ready";

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function normalizeBase64Url(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return "";
  }

  try {
    return decodeBase64Url(normalized).length > 0 ? normalized : "";
  } catch {
    return "";
  }
}

function normalizeIsoDate(value) {
  const normalized = String(value || "").trim();
  const parsedAt = Date.parse(normalized);
  return Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : "";
}

function normalizeKeyId(value) {
  const normalized = String(value || "").trim();
  return /^[A-Za-z0-9_-]{16,200}$/u.test(normalized) ? normalized : "";
}

function normalizePositiveInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : 0;
}

function buildUserCryptoProjectPath(username) {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    throw new Error(`Invalid username: ${String(username || "")}`);
  }

  return `/app/L2/${normalizedUsername}/metadata/${USER_CRYPTO_FILENAME}`;
}

function buildUserCryptoShareDir(projectRoot) {
  return path.join(ensureAuthDataDir(projectRoot), USER_CRYPTO_SERVER_SHARE_DIRNAME);
}

function buildUserCryptoShareFilePath(projectRoot, username) {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    throw new Error(`Invalid username: ${String(username || "")}`);
  }

  return path.join(buildUserCryptoShareDir(projectRoot), `${normalizedUsername}.json`);
}

function setPermissionsIfPossible(targetPath, mode) {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function ensureUserCryptoShareDir(projectRoot) {
  const shareDir = buildUserCryptoShareDir(projectRoot);
  fs.mkdirSync(shareDir, {
    mode: 0o700,
    recursive: true
  });
  setPermissionsIfPossible(shareDir, 0o700);
  return shareDir;
}

function createUserCryptoServerShare() {
  return encodeBase64Url(randomBytes(USER_CRYPTO_SECRET_LENGTH));
}

function normalizeUserCryptoRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }

  const source =
    record.user_crypto && typeof record.user_crypto === "object" && !Array.isArray(record.user_crypto)
      ? record.user_crypto
      : record;
  const status = String(source.status || "").trim().toLowerCase();
  const keyId = normalizeKeyId(source.key_id || source.keyId);
  const createdAt = normalizeIsoDate(source.created_at || source.createdAt);
  const updatedAt = normalizeIsoDate(source.updated_at || source.updatedAt);
  const invalidatedAt = normalizeIsoDate(source.invalidated_at || source.invalidatedAt);
  const passwordIterations = normalizePositiveInteger(
    source.password_iterations || source.passwordIterations
  );
  const passwordSalt = normalizeBase64Url(source.password_salt || source.passwordSalt);
  const serverShareCiphertext = normalizeBase64Url(
    source.server_share_ciphertext || source.serverShareCiphertext
  );
  const serverShareIv = normalizeBase64Url(source.server_share_iv || source.serverShareIv);
  const serverShareStorage = String(
    source.server_share_storage || source.serverShareStorage || ""
  )
    .trim()
    .toLowerCase();
  const serverShareTag = normalizeBase64Url(source.server_share_tag || source.serverShareTag);
  const version = Number(source.version) || USER_CRYPTO_RECORD_VERSION;

  if (status === USER_CRYPTO_STATUS_INVALIDATED) {
    return {
      createdAt,
      invalidatedAt,
      keyId,
      passwordIterations,
      passwordSalt,
      serverShareCiphertext,
      serverShareIv,
      serverShareStorage,
      serverShareTag,
      status,
      updatedAt,
      version,
      wrapIv: normalizeBase64Url(source.wrap_iv || source.wrapIv),
      wrapSalt: normalizeBase64Url(source.wrap_salt || source.wrapSalt),
      wrappedMasterKey: normalizeBase64Url(
        source.wrapped_master_key || source.wrappedMasterKey
      )
    };
  }

  if (status !== USER_CRYPTO_STATUS_READY) {
    return null;
  }

  const wrapIv = normalizeBase64Url(source.wrap_iv || source.wrapIv);
  const wrapSalt = normalizeBase64Url(source.wrap_salt || source.wrapSalt);
  const wrappedMasterKey = normalizeBase64Url(
    source.wrapped_master_key || source.wrappedMasterKey
  );

  if (!keyId || !passwordIterations || !passwordSalt || !wrapIv || !wrapSalt || !wrappedMasterKey) {
    return null;
  }

  return {
    createdAt,
    invalidatedAt,
    keyId,
    passwordIterations,
    passwordSalt,
    serverShareCiphertext,
    serverShareIv,
    serverShareStorage,
    serverShareTag,
    status,
    updatedAt,
    version,
    wrapIv,
    wrapSalt,
    wrappedMasterKey
  };
}

function serializeUserCryptoRecord(record) {
  const normalizedRecord = normalizeUserCryptoRecord(record);

  if (!normalizedRecord) {
    throw new Error("Invalid user crypto record.");
  }

  const serializedRecord = {
    version: USER_CRYPTO_RECORD_VERSION,
    status: normalizedRecord.status,
    key_id: normalizedRecord.keyId,
    updated_at: normalizedRecord.updatedAt || new Date().toISOString()
  };

  if (normalizedRecord.createdAt) {
    serializedRecord.created_at = normalizedRecord.createdAt;
  }

  if (normalizedRecord.invalidatedAt) {
    serializedRecord.invalidated_at = normalizedRecord.invalidatedAt;
  }

  if (normalizedRecord.passwordIterations) {
    serializedRecord.password_iterations = normalizedRecord.passwordIterations;
  }

  if (normalizedRecord.passwordSalt) {
    serializedRecord.password_salt = normalizedRecord.passwordSalt;
  }

  if (
    normalizedRecord.serverShareStorage === USER_CRYPTO_SERVER_SHARE_STORAGE &&
    normalizedRecord.serverShareCiphertext &&
    normalizedRecord.serverShareIv &&
    normalizedRecord.serverShareTag
  ) {
    serializedRecord.server_share_storage = normalizedRecord.serverShareStorage;
    serializedRecord.server_share_ciphertext = normalizedRecord.serverShareCiphertext;
    serializedRecord.server_share_iv = normalizedRecord.serverShareIv;
    serializedRecord.server_share_tag = normalizedRecord.serverShareTag;
  }

  if (normalizedRecord.wrapIv) {
    serializedRecord.wrap_iv = normalizedRecord.wrapIv;
  }

  if (normalizedRecord.wrapSalt) {
    serializedRecord.wrap_salt = normalizedRecord.wrapSalt;
  }

  if (normalizedRecord.wrappedMasterKey) {
    serializedRecord.wrapped_master_key = normalizedRecord.wrappedMasterKey;
  }

  return serializedRecord;
}

function getUserCryptoServerShareSealKey(authKeys) {
  const passwordSealKey = authKeys?.passwordSealKey;

  if (!Buffer.isBuffer(passwordSealKey) || passwordSealKey.length !== USER_CRYPTO_SECRET_LENGTH) {
    throw new Error("Password seal key is unavailable.");
  }

  return createHash("sha256")
    .update(USER_CRYPTO_SERVER_SHARE_AAD_PREFIX)
    .update(passwordSealKey)
    .digest();
}

function buildUserCryptoServerShareAad(record = {}) {
  return Buffer.from(
    JSON.stringify({
      keyId: String(record.keyId || ""),
      prefix: USER_CRYPTO_SERVER_SHARE_AAD_PREFIX,
      status: String(record.status || ""),
      version: Number(record.version) || USER_CRYPTO_RECORD_VERSION
    })
  );
}

function sealUserCryptoServerShare(serverShare, record, authKeys) {
  const normalizedServerShare = normalizeBase64Url(serverShare);

  if (decodeBase64Url(normalizedServerShare).length !== USER_CRYPTO_SECRET_LENGTH) {
    throw new Error("Invalid user crypto server share.");
  }

  const iv = randomBytes(USER_CRYPTO_SERVER_SHARE_IV_LENGTH);
  const cipher = createCipheriv(
    "aes-256-gcm",
    getUserCryptoServerShareSealKey(authKeys),
    iv
  );
  cipher.setAAD(buildUserCryptoServerShareAad(record));
  const ciphertext = Buffer.concat([
    cipher.update(decodeBase64Url(normalizedServerShare)),
    cipher.final()
  ]);

  return {
    serverShareCiphertext: encodeBase64Url(ciphertext),
    serverShareIv: encodeBase64Url(iv),
    serverShareStorage: USER_CRYPTO_SERVER_SHARE_STORAGE,
    serverShareTag: encodeBase64Url(cipher.getAuthTag())
  };
}

function openUserCryptoServerShare(record, authKeys) {
  if (
    !record ||
    record.serverShareStorage !== USER_CRYPTO_SERVER_SHARE_STORAGE ||
    !record.serverShareCiphertext ||
    !record.serverShareIv ||
    !record.serverShareTag
  ) {
    return "";
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getUserCryptoServerShareSealKey(authKeys),
      decodeBase64Url(record.serverShareIv)
    );
    decipher.setAAD(buildUserCryptoServerShareAad(record));
    decipher.setAuthTag(decodeBase64Url(record.serverShareTag));
    const serverShare = Buffer.concat([
      decipher.update(decodeBase64Url(record.serverShareCiphertext)),
      decipher.final()
    ]);

    return serverShare.length === USER_CRYPTO_SECRET_LENGTH ? encodeBase64Url(serverShare) : "";
  } catch {
    return "";
  }
}

function readUserCryptoServerShare(projectRoot, username, options = {}) {
  const filePath = buildUserCryptoShareFilePath(projectRoot, username);
  const runtimeParams = options.runtimeParams || null;
  const record = normalizeUserCryptoRecord(
    options.record || readUserCryptoRecord(projectRoot, username, runtimeParams)
  );

  try {
    setPermissionsIfPossible(filePath, 0o600);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const serverShare = normalizeBase64Url(parsed?.server_share || parsed?.serverShare);
    return decodeBase64Url(serverShare).length === USER_CRYPTO_SECRET_LENGTH ? serverShare : "";
  } catch (error) {
    if (error.code !== "ENOENT") {
      return "";
    }
  }

  if (!record || record.status !== USER_CRYPTO_STATUS_READY) {
    return "";
  }

  return openUserCryptoServerShare(record, loadAuthKeys(projectRoot));
}

function writeUserCryptoServerShare(projectRoot, username, serverShare) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedServerShare = normalizeBase64Url(serverShare);

  if (!normalizedUsername) {
    throw new Error(`Invalid username: ${String(username || "")}`);
  }

  if (decodeBase64Url(normalizedServerShare).length !== USER_CRYPTO_SECRET_LENGTH) {
    throw new Error("Invalid user crypto server share.");
  }

  ensureUserCryptoShareDir(projectRoot);
  const filePath = buildUserCryptoShareFilePath(projectRoot, normalizedUsername);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        server_share: normalizedServerShare,
        updated_at: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    {
      encoding: "utf8",
      mode: 0o600
    }
  );
  setPermissionsIfPossible(filePath, 0o600);
  return filePath;
}

function deleteUserCryptoServerShare(projectRoot, username) {
  const filePath = buildUserCryptoShareFilePath(projectRoot, username);

  try {
    fs.rmSync(filePath, {
      force: true
    });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function buildClientUserCryptoRecord(record) {
  const normalizedRecord = normalizeUserCryptoRecord(record);

  if (!normalizedRecord) {
    return null;
  }

  return serializeUserCryptoRecord(normalizedRecord);
}

function getUserCryptoState(projectRoot, username, runtimeParams = null) {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    return {
      keyId: "",
      record: null,
      status: USER_CRYPTO_STATUS_MISSING
    };
  }

  const record = normalizeUserCryptoRecord(
    readUserCryptoRecord(projectRoot, normalizedUsername, runtimeParams)
  );
  const serverShare = readUserCryptoServerShare(projectRoot, normalizedUsername, {
    record,
    runtimeParams
  });

  if (record?.status === USER_CRYPTO_STATUS_INVALIDATED) {
    return {
      keyId: record.keyId,
      record,
      status: USER_CRYPTO_STATUS_INVALIDATED
    };
  }

  if (record?.status === USER_CRYPTO_STATUS_READY && serverShare) {
    return {
      keyId: record.keyId,
      record,
      status: USER_CRYPTO_STATUS_READY
    };
  }

  if (record?.status === USER_CRYPTO_STATUS_READY) {
    return {
      keyId: record.keyId,
      record,
      status: USER_CRYPTO_STATUS_INVALIDATED
    };
  }

  return {
    keyId: record?.keyId || "",
    record,
    status: USER_CRYPTO_STATUS_MISSING
  };
}

function writeReadyUserCryptoRecord(projectRoot, username, record, options = {}) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedRecord = normalizeUserCryptoRecord(record);
  const runtimeParams = options.runtimeParams || null;

  if (!normalizedUsername) {
    throw new Error(`Invalid username: ${String(username || "")}`);
  }

  if (!normalizedRecord || normalizedRecord.status !== USER_CRYPTO_STATUS_READY) {
    throw new Error("A ready user crypto record is required.");
  }

  const authKeys = loadAuthKeys(projectRoot);
  const existingRecord = normalizeUserCryptoRecord(
    readUserCryptoRecord(projectRoot, normalizedUsername, runtimeParams)
  );
  const serverShare =
    normalizeBase64Url(options.serverShare) ||
    readUserCryptoServerShare(projectRoot, normalizedUsername, {
      record: existingRecord,
      runtimeParams
    });
  const now = new Date().toISOString();
  const sealedServerShare = serverShare
    ? sealUserCryptoServerShare(serverShare, normalizedRecord, authKeys)
    : null;
  writeUserCryptoRecord(
    projectRoot,
    normalizedUsername,
    serializeUserCryptoRecord({
      ...normalizedRecord,
      createdAt: normalizedRecord.createdAt || now,
      serverShareCiphertext: sealedServerShare?.serverShareCiphertext || "",
      serverShareIv: sealedServerShare?.serverShareIv || "",
      serverShareStorage: sealedServerShare?.serverShareStorage || "",
      serverShareTag: sealedServerShare?.serverShareTag || "",
      updatedAt: now
    }),
    runtimeParams
  );
  recordAppPathMutations(
    {
      projectRoot,
      runtimeParams
    },
    [buildUserCryptoProjectPath(normalizedUsername)]
  );

  return {
    keyId: normalizedRecord.keyId,
    projectPath: buildUserCryptoProjectPath(normalizedUsername),
    username: normalizedUsername
  };
}

function provisionUserCrypto(projectRoot, username, options = {}) {
  const normalizedUsername = normalizeUsername(username);
  const runtimeParams = options.runtimeParams || null;
  const record = options.record;
  const serverShare = String(options.serverShare || "").trim() || createUserCryptoServerShare();

  if (!normalizedUsername) {
    throw new Error(`Invalid username: ${String(username || "")}`);
  }

  const writeResult = writeReadyUserCryptoRecord(projectRoot, normalizedUsername, record, {
    serverShare,
    runtimeParams
  });
  writeUserCryptoServerShare(projectRoot, normalizedUsername, serverShare);
  return writeResult;
}

function invalidateUserCryptoRecord(projectRoot, username, options = {}) {
  const normalizedUsername = normalizeUsername(username);
  const runtimeParams = options.runtimeParams || null;
  const currentRecord = normalizeUserCryptoRecord(
    readUserCryptoRecord(projectRoot, normalizedUsername, runtimeParams)
  );
  const removedServerShare = deleteUserCryptoServerShare(projectRoot, normalizedUsername);

  if (!normalizedUsername) {
    throw new Error(`Invalid username: ${String(username || "")}`);
  }

  if (!currentRecord && !removedServerShare) {
    return {
      changed: false,
      username: normalizedUsername
    };
  }

  const now = new Date().toISOString();
  const {
    serverShareCiphertext: _serverShareCiphertext,
    serverShareIv: _serverShareIv,
    serverShareStorage: _serverShareStorage,
    serverShareTag: _serverShareTag,
    ...recordWithoutServerShare
  } = currentRecord || {};
  writeUserCryptoRecord(
    projectRoot,
    normalizedUsername,
    serializeUserCryptoRecord({
      ...recordWithoutServerShare,
      createdAt: currentRecord?.createdAt || now,
      invalidatedAt: now,
      keyId: currentRecord?.keyId || "",
      status: USER_CRYPTO_STATUS_INVALIDATED,
      updatedAt: now,
      version: USER_CRYPTO_RECORD_VERSION
    }),
    runtimeParams
  );
  recordAppPathMutations(
    {
      projectRoot,
      runtimeParams
    },
    [buildUserCryptoProjectPath(normalizedUsername)]
  );

  return {
    changed: true,
    projectPath: buildUserCryptoProjectPath(normalizedUsername),
    username: normalizedUsername
  };
}

function deleteUserCryptoArtifacts(projectRoot, username) {
  return deleteUserCryptoServerShare(projectRoot, username);
}

export {
  USER_CRYPTO_RECORD_VERSION,
  USER_CRYPTO_SECRET_LENGTH,
  USER_CRYPTO_STATUS_INVALIDATED,
  USER_CRYPTO_STATUS_MISSING,
  USER_CRYPTO_STATUS_READY,
  buildClientUserCryptoRecord,
  createUserCryptoServerShare,
  deleteUserCryptoArtifacts,
  getUserCryptoState,
  normalizeUserCryptoRecord,
  provisionUserCrypto,
  readUserCryptoServerShare,
  serializeUserCryptoRecord,
  invalidateUserCryptoRecord,
  writeReadyUserCryptoRecord
};
