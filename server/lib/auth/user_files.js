import fs from "node:fs";

import {
  getAppPathRoots,
  normalizeEntityId,
  resolveProjectAbsolutePath
} from "../customware/layout.js";
import {
  parseSimpleYaml,
  serializeSimpleYaml
} from "../../../app/L0/_all/modules/_core/framework/js/yaml-lite.js";

const USER_META_DIRNAME = "metadata";
const USER_CONFIG_FILENAME = "user.yaml";
const USER_LOGINS_FILENAME = "logins.json";
const USER_PASSWORD_FILENAME = "password.json";
const USER_CRYPTO_FILENAME = "user_crypto.json";

function normalizeUsername(value) {
  return normalizeEntityId(value);
}

function buildUserProjectPath(username, relativePath = "") {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    throw new Error(`Invalid username: ${valueToText(username)}`);
  }

  const suffix = String(relativePath || "").replace(/^\/+/u, "");
  return suffix ? `/app/L2/${normalizedUsername}/${suffix}` : `/app/L2/${normalizedUsername}/`;
}

function buildUserAbsolutePath(projectRoot, username, relativePath = "", runtimeParams = null) {
  return resolveProjectAbsolutePath(
    projectRoot,
    buildUserProjectPath(username, relativePath),
    runtimeParams
  );
}

function valueToText(value) {
  return String(value || "");
}

function readTextFile(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

function readJsonObject(filePath, fallback = {}) {
  const sourceText = readTextFile(filePath, "").trim();

  if (!sourceText) {
    return { ...(fallback || {}) };
  }

  try {
    const parsed = JSON.parse(sourceText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { ...(fallback || {}) };
  } catch {
    return { ...(fallback || {}) };
  }
}

// A server with no password-bearing account cannot authenticate anyone. The public
// login shell and the login challenge use this to say so plainly instead of implying
// that the visitor mistyped a password. The scan stops at the first account that
// already has a verifier, so a populated instance answers after one directory entry.
function hasAnyPasswordUser(projectRoot, runtimeParams = null) {
  const roots = getAppPathRoots(projectRoot, runtimeParams);
  let entries;

  try {
    entries = fs.readdirSync(roots.l2Dir, {
      withFileTypes: true
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const passwordPath = buildUserAbsolutePath(
      projectRoot,
      entry.name,
      `${USER_META_DIRNAME}/${USER_PASSWORD_FILENAME}`,
      runtimeParams
    );

    if (fs.existsSync(passwordPath)) {
      return true;
    }
  }

  return false;
}

function readUserConfig(projectRoot, username, runtimeParams = null) {
  const filePath = buildUserAbsolutePath(projectRoot, username, USER_CONFIG_FILENAME, runtimeParams);
  const sourceText = readTextFile(filePath, "");
  return sourceText ? parseSimpleYaml(sourceText) : {};
}

function writeUserConfig(projectRoot, username, config, runtimeParams = null) {
  const filePath = buildUserAbsolutePath(projectRoot, username, USER_CONFIG_FILENAME, runtimeParams);
  fs.mkdirSync(buildUserAbsolutePath(projectRoot, username, "", runtimeParams), { recursive: true });
  fs.writeFileSync(filePath, serializeSimpleYaml(config), "utf8");
  return filePath;
}

function readUserPasswordVerifier(projectRoot, username, runtimeParams = null) {
  const filePath = buildUserAbsolutePath(
    projectRoot,
    username,
    `${USER_META_DIRNAME}/${USER_PASSWORD_FILENAME}`,
    runtimeParams
  );
  return readJsonObject(filePath, {});
}

function writeUserPasswordVerifier(projectRoot, username, verifier, runtimeParams = null) {
  const filePath = buildUserAbsolutePath(
    projectRoot,
    username,
    `${USER_META_DIRNAME}/${USER_PASSWORD_FILENAME}`,
    runtimeParams
  );
  fs.mkdirSync(buildUserAbsolutePath(projectRoot, username, USER_META_DIRNAME, runtimeParams), {
    recursive: true
  });
  fs.writeFileSync(filePath, `${JSON.stringify(verifier || {}, null, 2)}\n`, "utf8");
  return filePath;
}

function readUserLogins(projectRoot, username, runtimeParams = null) {
  const filePath = buildUserAbsolutePath(
    projectRoot,
    username,
    `${USER_META_DIRNAME}/${USER_LOGINS_FILENAME}`,
    runtimeParams
  );
  return readJsonObject(filePath, {});
}

function writeUserLogins(projectRoot, username, logins, runtimeParams = null) {
  const filePath = buildUserAbsolutePath(
    projectRoot,
    username,
    `${USER_META_DIRNAME}/${USER_LOGINS_FILENAME}`,
    runtimeParams
  );
  fs.mkdirSync(buildUserAbsolutePath(projectRoot, username, USER_META_DIRNAME, runtimeParams), {
    recursive: true
  });
  fs.writeFileSync(filePath, `${JSON.stringify(logins || {}, null, 2)}\n`, "utf8");
  return filePath;
}

function readUserCryptoRecord(projectRoot, username, runtimeParams = null) {
  const filePath = buildUserAbsolutePath(
    projectRoot,
    username,
    `${USER_META_DIRNAME}/${USER_CRYPTO_FILENAME}`,
    runtimeParams
  );
  return readJsonObject(filePath, {});
}

function writeUserCryptoRecord(projectRoot, username, record, runtimeParams = null) {
  const filePath = buildUserAbsolutePath(
    projectRoot,
    username,
    `${USER_META_DIRNAME}/${USER_CRYPTO_FILENAME}`,
    runtimeParams
  );
  fs.mkdirSync(buildUserAbsolutePath(projectRoot, username, USER_META_DIRNAME, runtimeParams), {
    recursive: true
  });
  fs.writeFileSync(filePath, `${JSON.stringify(record || {}, null, 2)}\n`, "utf8");
  return filePath;
}

function ensureUserStructure(projectRoot, username, runtimeParams = null) {
  const userDir = buildUserAbsolutePath(projectRoot, username, "", runtimeParams);
  const metaDir = buildUserAbsolutePath(projectRoot, username, USER_META_DIRNAME, runtimeParams);
  const modDir = buildUserAbsolutePath(projectRoot, username, "modules", runtimeParams);
  fs.mkdirSync(modDir, { recursive: true });
  fs.mkdirSync(metaDir, { recursive: true });
  return {
    metaDir,
    modDir,
    userDir
  };
}

export {
  USER_CONFIG_FILENAME,
  USER_CRYPTO_FILENAME,
  USER_LOGINS_FILENAME,
  USER_META_DIRNAME,
  USER_PASSWORD_FILENAME,
  buildUserAbsolutePath,
  buildUserProjectPath,
  ensureUserStructure,
  hasAnyPasswordUser,
  normalizeUsername,
  readUserConfig,
  readUserCryptoRecord,
  readUserLogins,
  readUserPasswordVerifier,
  writeUserConfig,
  writeUserCryptoRecord,
  writeUserLogins,
  writeUserPasswordVerifier
};
