import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PASSWORD_SEAL_KEY_ENV_NAME,
  SESSION_HMAC_KEY_ENV_NAME,
  loadSupervisorAuthEnv
} from "../commands/lib/supervisor/auth_keys.js";
import { __test as userCommandTest } from "../commands/user.js";
import { PROJECT_ROOT } from "../server/config.js";
import { AUTH_DATA_DIR_ENV_NAME } from "../server/lib/auth/keys_manage.js";
import { createUser } from "../server/lib/auth/user_manage.js";
import { createRuntimeParams } from "../server/lib/utils/runtime_params.js";
import { createProvisionedUserCryptoRecord } from "../server/pages/res/user-crypto.js";
import { startServer } from "../server/server.js";

const MANAGED_ENV_NAMES = [
  AUTH_DATA_DIR_ENV_NAME,
  PASSWORD_SEAL_KEY_ENV_NAME,
  SESSION_HMAC_KEY_ENV_NAME,
  "CUSTOMWARE_PATH"
];

function buildAuthMessage({ challengeToken, clientNonce, serverNonce, username }) {
  return ["space-login-v1", username, clientNonce, serverNonce, challengeToken].join(":");
}

function createClientProof({ challenge, clientNonce, password, username }) {
  const saltedPassword = pbkdf2Sync(
    password,
    Buffer.from(String(challenge.salt || ""), "base64url"),
    Number(challenge.iterations),
    32,
    "sha256"
  );
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const authMessage = buildAuthMessage({
    challengeToken: challenge.challengeToken,
    clientNonce,
    serverNonce: challenge.serverNonce,
    username
  });
  const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();

  return Buffer.from(clientKey.map((byte, index) => byte ^ clientSignature[index])).toString(
    "base64url"
  );
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    body: options.body,
    headers: options.headers,
    method: options.method || "GET"
  });
  const bodyText = await response.text();

  return {
    body: bodyText ? JSON.parse(bodyText) : null,
    headers: response.headers,
    status: response.status
  };
}

function snapshotEnv() {
  return new Map(MANAGED_ENV_NAMES.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot) {
  for (const [name, value] of snapshot) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function clearAuthEnv() {
  delete process.env[AUTH_DATA_DIR_ENV_NAME];
  delete process.env[PASSWORD_SEAL_KEY_ENV_NAME];
  delete process.env[SESSION_HMAC_KEY_ENV_NAME];
  delete process.env.CUSTOMWARE_PATH;
}

async function startRuntime(customwarePath) {
  return startServer({
    runtimeParamOverrides: {
      CUSTOMWARE_PATH: customwarePath,
      HOST: "127.0.0.1",
      PORT: "0",
      WORKERS: "1"
    }
  });
}

// Mirrors `node space user create`: the CLI seals the verifier with the canonical
// backend auth-key store, never with a supervisor-private store.
async function createCliUser({ authDataDir, customwarePath, password, username }) {
  process.env[AUTH_DATA_DIR_ENV_NAME] = authDataDir;

  const runtimeParams = await createRuntimeParams(PROJECT_ROOT, {
    env: {
      ...process.env,
      CUSTOMWARE_PATH: customwarePath
    }
  });

  try {
    return createUser(PROJECT_ROOT, username, password, { runtimeParams });
  } finally {
    delete process.env[AUTH_DATA_DIR_ENV_NAME];
  }
}

function encodeTestKey(byteValue) {
  return Buffer.alloc(32, byteValue).toString("base64url");
}

test("divergent injected auth keys log a specific seal-failure diagnostic while the challenge stays generic", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "space-auth-key-mismatch-"));
  const customwarePath = path.join(tempRoot, "customware");
  const authDataDir = path.join(tempRoot, "cli-auth-data");
  const username = "cli-sealed-user";
  const password = "cli-sealed-password-123";
  const envSnapshot = snapshotEnv();

  t.after(async () => {
    restoreEnv(envSnapshot);
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  clearAuthEnv();
  await createCliUser({ authDataDir, customwarePath, password, username });

  // The supervisor injects a *different* key pair, so the sealed verifier cannot be opened.
  process.env[PASSWORD_SEAL_KEY_ENV_NAME] = encodeTestKey(9);
  process.env[SESSION_HMAC_KEY_ENV_NAME] = encodeTestKey(10);

  const runtime = await startRuntime(customwarePath);
  t.after(() => runtime.close());

  const logs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    logs.push(args.map((value) => String(value)).join(" "));
  };

  let challengeResponse;

  try {
    challengeResponse = await requestJson(runtime.browserUrl, "/api/login_challenge", {
      body: JSON.stringify({
        clientNonce: randomBytes(18).toString("base64url"),
        username
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(challengeResponse.status, 401);
  assert.equal(challengeResponse.body?.error, "Invalid username or password.");

  const sealDiagnostics = logs.filter(
    (line) => line.includes(username) && /seal/i.test(line)
  );

  assert.equal(
    sealDiagnostics.length > 0,
    true,
    `expected a seal-failure operator diagnostic naming ${username}, got: ${JSON.stringify(logs)}`
  );
  assert.equal(sealDiagnostics.join("\n").includes("process.env"), true);
});

test("CLI warns before sealing with env-injected keys that every serve process must share", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "space-auth-key-cli-env-"));
  const envSnapshot = snapshotEnv();

  t.after(async () => {
    restoreEnv(envSnapshot);
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  clearAuthEnv();
  process.env[AUTH_DATA_DIR_ENV_NAME] = path.join(tempRoot, "auth-data");
  process.env[PASSWORD_SEAL_KEY_ENV_NAME] = encodeTestKey(11);
  process.env[SESSION_HMAC_KEY_ENV_NAME] = encodeTestKey(12);

  const warnings = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((value) => String(value)).join(" "));
  };

  try {
    userCommandTest.reportAuthKeySourceWarnings(PROJECT_ROOT);
  } finally {
    console.warn = originalConsoleWarn;
  }

  const warningText = warnings.join("\n");

  assert.equal(warningText.includes(PASSWORD_SEAL_KEY_ENV_NAME), true);
  assert.equal(warningText.includes("Invalid username or password"), true);
});

test("CLI warns about a differing legacy supervisor auth-key store", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "space-auth-key-cli-legacy-"));
  const projectRoot = path.join(tempRoot, "project");
  const authDataDir = path.join(projectRoot, "auth-data");
  const legacyKeysPath = path.join(projectRoot, "supervisor", "auth", "auth_keys.json");
  const envSnapshot = snapshotEnv();

  t.after(async () => {
    restoreEnv(envSnapshot);
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  clearAuthEnv();
  process.env[AUTH_DATA_DIR_ENV_NAME] = authDataDir;

  await fs.mkdir(path.dirname(legacyKeysPath), { recursive: true });
  await fs.mkdir(authDataDir, { recursive: true });
  await fs.writeFile(
    legacyKeysPath,
    `${JSON.stringify(
      {
        password_seal_key: encodeTestKey(13),
        session_hmac_key: encodeTestKey(14)
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(authDataDir, "auth_keys.json"),
    `${JSON.stringify(
      {
        password_seal_key: encodeTestKey(15),
        session_hmac_key: encodeTestKey(16)
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const warnings = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((value) => String(value)).join(" "));
  };

  try {
    userCommandTest.reportAuthKeySourceWarnings(projectRoot);
  } finally {
    console.warn = originalConsoleWarn;
  }

  const warningText = warnings.join("\n");

  assert.equal(warningText.includes(legacyKeysPath), true);
  assert.equal(warningText.includes("re-sealed"), true);
});

test("supervise warns when injected keys differ from the canonical store and stays quiet when they match", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "space-auth-key-supervise-"));
  const projectRoot = path.join(tempRoot, "project");
  const authDataDir = path.join(projectRoot, "auth-data");
  const envSnapshot = snapshotEnv();

  t.after(async () => {
    restoreEnv(envSnapshot);
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  clearAuthEnv();
  await fs.mkdir(authDataDir, { recursive: true });
  await fs.writeFile(
    path.join(authDataDir, "auth_keys.json"),
    `${JSON.stringify(
      {
        password_seal_key: encodeTestKey(17),
        session_hmac_key: encodeTestKey(18)
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const mismatch = await loadSupervisorAuthEnv({
    env: {
      [AUTH_DATA_DIR_ENV_NAME]: authDataDir,
      [PASSWORD_SEAL_KEY_ENV_NAME]: encodeTestKey(19),
      [SESSION_HMAC_KEY_ENV_NAME]: encodeTestKey(20)
    },
    projectRoot,
    stateDir: path.join(tempRoot, "supervisor")
  });

  assert.equal(mismatch.source, "process.env");
  assert.equal(mismatch.warning.includes(PASSWORD_SEAL_KEY_ENV_NAME), true);
  assert.equal(mismatch.warning.includes(path.join(authDataDir, "auth_keys.json")), true);

  const matching = await loadSupervisorAuthEnv({
    env: {
      [AUTH_DATA_DIR_ENV_NAME]: authDataDir,
      [PASSWORD_SEAL_KEY_ENV_NAME]: encodeTestKey(17),
      [SESSION_HMAC_KEY_ENV_NAME]: encodeTestKey(18)
    },
    projectRoot,
    stateDir: path.join(tempRoot, "supervisor")
  });

  assert.equal(matching.source, "process.env");
  assert.equal(matching.warning, "");
});

test("CLI-created user logs in under supervisor-injected canonical keys", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "space-auth-key-shared-"));
  const customwarePath = path.join(tempRoot, "customware");
  const authDataDir = path.join(tempRoot, "cli-auth-data");
  const username = "cli-shared-user";
  const password = "cli-shared-password-123";
  const envSnapshot = snapshotEnv();

  t.after(async () => {
    restoreEnv(envSnapshot);
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  clearAuthEnv();
  await createCliUser({ authDataDir, customwarePath, password, username });

  const supervisorAuth = await loadSupervisorAuthEnv({
    env: { [AUTH_DATA_DIR_ENV_NAME]: authDataDir },
    projectRoot: PROJECT_ROOT,
    stateDir: path.join(tempRoot, "supervisor")
  });

  process.env[PASSWORD_SEAL_KEY_ENV_NAME] = supervisorAuth.env[PASSWORD_SEAL_KEY_ENV_NAME];
  process.env[SESSION_HMAC_KEY_ENV_NAME] = supervisorAuth.env[SESSION_HMAC_KEY_ENV_NAME];

  const runtime = await startRuntime(customwarePath);
  t.after(() => runtime.close());

  const clientNonce = randomBytes(18).toString("base64url");
  const challengeResponse = await requestJson(runtime.browserUrl, "/api/login_challenge", {
    body: JSON.stringify({
      clientNonce,
      username
    }),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  assert.equal(challengeResponse.status, 200);
  assert.ok(challengeResponse.body?.challengeToken);

  const provisionedUserCrypto = await createProvisionedUserCryptoRecord({
    password,
    serverShare: decodeBase64Url(challengeResponse.body.userCrypto.provisioningShare)
  });

  const loginResponse = await requestJson(runtime.browserUrl, "/api/login", {
    body: JSON.stringify({
      challengeToken: challengeResponse.body.challengeToken,
      clientProof: createClientProof({
        challenge: challengeResponse.body,
        clientNonce,
        password,
        username
      }),
      userCryptoProvisioning: {
        record: provisionedUserCrypto.record
      }
    }),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body?.authenticated, true);
  assert.equal(loginResponse.body?.username, username);
  assert.match(loginResponse.headers.get("set-cookie") || "", /space_session=/u);
});
