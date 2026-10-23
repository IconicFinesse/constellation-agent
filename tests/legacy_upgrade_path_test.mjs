import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../server/server.js";
import { AUTH_DATA_DIR_ENV_NAME, loadAuthKeys } from "../server/lib/auth/keys_manage.js";
import { createPasswordVerifier, openPasswordVerifierRecord, verifyPassword } from "../server/lib/auth/passwords.js";
import { hasAnyPasswordUser, readUserPasswordVerifier } from "../server/lib/auth/user_files.js";

// v1.1 renamed user home directories (`meta/` -> `metadata/`, `conf/` -> `config/`,
// `hist/` -> `history/`) and the module namespace (`mod/` -> `modules/`). An install
// created by v1.0.0 still stores everything under the old names, so the runtime must
// keep reading that state while writing only the new names. These assertions exist so
// a rename can never strand credentials, history, or installed modules again.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_USERNAME = "user";
const PASSWORD = "legacy-password-123";

async function createRuntime(runtimeParamOverrides) {
  return startServer({
    runtimeParamOverrides: {
      HOST: "127.0.0.1",
      PORT: "0",
      WORKERS: "1",
      ...runtimeParamOverrides
    }
  });
}

async function readJson(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    body: options.body,
    headers: options.headers,
    method: options.method || "GET"
  });
  const bodyText = await response.text();

  return {
    body: bodyText ? JSON.parse(bodyText) : null,
    bodyText,
    status: response.status
  };
}

async function writeFixtureFile(rootPath, relativePath, content) {
  const targetPath = path.join(rootPath, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
  return targetPath;
}

// Builds a tree shaped exactly like a v1.0.0 install: legacy directory names only.
async function createLegacyInstall(customwarePath) {
  const userRoot = path.join(customwarePath, "L2", LEGACY_USERNAME);

  await writeFixtureFile(userRoot, "user.yaml", "full_name: Legacy User\n");
  await writeFixtureFile(userRoot, "conf/dashboard.yaml", "theme: legacy-night\n");
  await writeFixtureFile(userRoot, "hist/onscreen-agent.json", '{"messages":["legacy-run"]}\n');
  await writeFixtureFile(
    userRoot,
    "mod/acme/demo/module.yaml",
    "name: demo\nauthor: acme\nversion: 1.0.0\n"
  );
  await writeFixtureFile(userRoot, "mod/acme/demo/ext/js/demo.js", "export const demo = true;\n");

  return userRoot;
}

test("legacy meta/ verifier keeps accounts discoverable and passwords verifiable", async (testContext) => {
  const customwarePath = await fs.mkdtemp(path.join(os.tmpdir(), "space-legacy-auth-"));
  const authDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "space-legacy-auth-keys-"));
  const originalAuthDataDir = process.env[AUTH_DATA_DIR_ENV_NAME];
  process.env[AUTH_DATA_DIR_ENV_NAME] = authDataDir;

  testContext.after(async () => {
    if (originalAuthDataDir === undefined) {
      delete process.env[AUTH_DATA_DIR_ENV_NAME];
    } else {
      process.env[AUTH_DATA_DIR_ENV_NAME] = originalAuthDataDir;
    }

    await fs.rm(authDataDir, { force: true, recursive: true });
    await fs.rm(customwarePath, { force: true, recursive: true });
  });

  const userRoot = await createLegacyInstall(customwarePath);
  const authKeys = loadAuthKeys(PROJECT_ROOT);
  const verifier = createPasswordVerifier(PASSWORD, authKeys);

  await writeFixtureFile(userRoot, "meta/password.json", `${JSON.stringify(verifier, null, 2)}\n`);

  const runtimeParams = {
    get(name, fallback) {
      return name === "CUSTOMWARE_PATH" ? customwarePath : fallback;
    }
  };

  assert.equal(
    hasAnyPasswordUser(PROJECT_ROOT, runtimeParams),
    true,
    "a legacy meta/password.json must still make the install look populated"
  );

  const legacyRecord = readUserPasswordVerifier(PROJECT_ROOT, LEGACY_USERNAME, runtimeParams);
  const openedRecord = openPasswordVerifierRecord(legacyRecord, authKeys);

  assert.ok(openedRecord, "the legacy sealed verifier must open with the same auth keys");
  assert.equal(verifyPassword(PASSWORD, openedRecord), true);
  assert.equal(verifyPassword("wrong-password", openedRecord), false);
});

test("legacy home directories and modules are readable while writes stay on the new names", async (testContext) => {
  const customwarePath = await fs.mkdtemp(path.join(os.tmpdir(), "space-legacy-home-"));
  const userRoot = await createLegacyInstall(customwarePath);
  const runtime = await createRuntime({
    CUSTOMWARE_PATH: customwarePath,
    SINGLE_USER_APP: "true"
  });

  testContext.after(async () => {
    await runtime.close();
    await fs.rm(customwarePath, { force: true, recursive: true });
  });

  const configRead = await readJson(runtime.browserUrl, "/api/file_read", {
    body: JSON.stringify({ path: "~/config/dashboard.yaml" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  assert.equal(configRead.status, 200);
  assert.equal(configRead.body?.content, "theme: legacy-night\n");

  const historyRead = await readJson(runtime.browserUrl, "/api/file_read", {
    body: JSON.stringify({ path: "~/history/onscreen-agent.json" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  assert.equal(historyRead.status, 200);
  assert.equal(historyRead.body?.content, '{"messages":["legacy-run"]}\n');

  const moduleList = await readJson(
    runtime.browserUrl,
    "/api/module_list?area=l2_self",
    { method: "GET" }
  );

  assert.equal(moduleList.status, 200);
  // `module_list` returns a bare array: the admin modules view consumes the
  // response with `Array.isArray(result)`, and the handler returns the list
  // directly. Read that shape instead of assuming an envelope, and pin it so a
  // future shape change cannot silently empty this discovery assertion.
  assert.ok(
    Array.isArray(moduleList.body),
    `module_list must return a bare array, saw: ${JSON.stringify(moduleList.body)}`
  );
  const moduleIds = moduleList.body.map((entry) => entry.requestPath);
  assert.ok(
    moduleIds.includes("/modules/acme/demo"),
    `legacy mod/acme/demo must be discovered, saw: ${JSON.stringify(moduleIds)}`
  );

  const writeResponse = await readJson(runtime.browserUrl, "/api/file_write", {
    body: JSON.stringify({ content: "theme: new-day\n", path: "~/config/dashboard.yaml" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  assert.equal(writeResponse.status, 200);

  const newConfigPath = path.join(userRoot, "config", "dashboard.yaml");
  assert.equal(await fs.readFile(newConfigPath, "utf8"), "theme: new-day\n");
  assert.equal(
    await fs.readFile(path.join(userRoot, "conf", "dashboard.yaml"), "utf8"),
    "theme: legacy-night\n",
    "a write through the new name must not modify the legacy directory"
  );
  await assert.rejects(
    fs.access(path.join(userRoot, "metadata")),
    "writing one new-name path must not create unrelated legacy-named directories"
  );

  const preferNewRead = await readJson(runtime.browserUrl, "/api/file_read", {
    body: JSON.stringify({ path: "~/config/dashboard.yaml" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  assert.equal(preferNewRead.status, 200);
  assert.equal(
    preferNewRead.body?.content,
    "theme: new-day\n",
    "when both names exist the new path must win"
  );
});

test("legacy metadata directory is never created by new-name writes", async (testContext) => {
  const customwarePath = await fs.mkdtemp(path.join(os.tmpdir(), "space-legacy-meta-"));
  const userRoot = await createLegacyInstall(customwarePath);
  const runtime = await createRuntime({
    CUSTOMWARE_PATH: customwarePath,
    SINGLE_USER_APP: "true"
  });

  testContext.after(async () => {
    await runtime.close();
    await fs.rm(customwarePath, { force: true, recursive: true });
  });

  const writeResponse = await readJson(runtime.browserUrl, "/api/file_write", {
    body: JSON.stringify({ content: "notes\n", path: "~/metadata/notes.txt" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  assert.equal(writeResponse.status, 200);
  assert.equal(await fs.readFile(path.join(userRoot, "metadata", "notes.txt"), "utf8"), "notes\n");
  await assert.rejects(
    fs.access(path.join(userRoot, "meta")),
    "new-name writes must not materialize the legacy meta/ directory"
  );
});
