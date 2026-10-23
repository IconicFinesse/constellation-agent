import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { startServer } from "../server/server.js";
import { AUTH_DATA_DIR_ENV_NAME } from "../server/lib/auth/keys_manage.js";
import { createUser } from "../server/lib/auth/user_manage.js";
import { createRuntimeParams } from "../server/lib/utils/runtime_params.js";

// A fresh multi-user install has no accounts and no in-browser signup, so the only
// supported bootstrap path is `node space user create`. These assertions pin the
// contract that makes that state legible instead of leaving the first visitor with a
// misleading "Invalid username or password" for an account that never existed.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIRST_RUN_HINT = "node space user create";

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

async function requestJson(baseUrl, pathname, options = {}) {
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

async function postChallenge(baseUrl, username) {
  return requestJson(baseUrl, "/api/login_challenge", {
    body: JSON.stringify({
      clientNonce: randomBytes(18).toString("base64url"),
      username
    }),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });
}

function readHasUsersMeta(html) {
  const match = String(html || "").match(
    /<meta name="space-config" data-space-param="HAS_USERS" data-space-type="boolean" content="(true|false)" \/>/u
  );

  return match ? match[1] : "";
}

test("first run reports no accounts until a CLI user exists, then authenticates that user", async (testContext) => {
  const customwarePath = await fs.mkdtemp(path.join(os.tmpdir(), "space-first-run-customware-"));
  const authDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "space-first-run-auth-"));
  const originalAuthDataDir = process.env[AUTH_DATA_DIR_ENV_NAME];
  process.env[AUTH_DATA_DIR_ENV_NAME] = authDataDir;

  const runtime = await createRuntime({
    CUSTOMWARE_PATH: customwarePath
  });

  testContext.after(async () => {
    await runtime.close();

    if (originalAuthDataDir === undefined) {
      delete process.env[AUTH_DATA_DIR_ENV_NAME];
    } else {
      process.env[AUTH_DATA_DIR_ENV_NAME] = originalAuthDataDir;
    }

    await fs.rm(customwarePath, { force: true, recursive: true });
    await fs.rm(authDataDir, { force: true, recursive: true });
  });

  // 1. Empty instance: the shell is told there are no accounts, and the challenge
  //    explains the bootstrap path rather than blaming the visitor's password.
  const emptyLoginResponse = await fetch(new URL("/login", runtime.browserUrl), {
    redirect: "manual"
  });
  const emptyLoginHtml = await emptyLoginResponse.text();

  assert.equal(emptyLoginResponse.status, 200);
  assert.equal(readHasUsersMeta(emptyLoginHtml), "false");

  const emptyChallenge = await postChallenge(runtime.browserUrl, "admin");

  assert.equal(emptyChallenge.status, 401);
  assert.match(String(emptyChallenge.body?.error || ""), /has no accounts yet/u);
  assert.match(String(emptyChallenge.body?.error || ""), /node space user create/u);

  // 2. Create the CLI user the same way `node space user create` does: the verifier
  //    is sealed against the canonical auth-key store the runtime already loaded.
  const runtimeParams = await createRuntimeParams(PROJECT_ROOT, {
    env: {
      ...process.env,
      CUSTOMWARE_PATH: customwarePath
    }
  });

  const username = "admin";
  const password = "first-run-password-123";
  createUser(PROJECT_ROOT, username, password, {
    fullName: "Brauk",
    runtimeParams
  });

  // 3. Populated instance: the shell flips to the normal password form and the
  //    created account gets a real challenge.
  const populatedLoginResponse = await fetch(new URL("/login", runtime.browserUrl), {
    redirect: "manual"
  });
  const populatedLoginHtml = await populatedLoginResponse.text();

  assert.equal(populatedLoginResponse.status, 200);
  assert.equal(readHasUsersMeta(populatedLoginHtml), "true");

  const knownChallenge = await postChallenge(runtime.browserUrl, username);

  assert.equal(knownChallenge.status, 200);
  assert.ok(knownChallenge.body?.challengeToken);

  // 4. Once accounts exist the response must stay generic, so the endpoint cannot be
  //    used to enumerate which usernames are real.
  const unknownChallenge = await postChallenge(runtime.browserUrl, "nobody-here");

  assert.equal(unknownChallenge.status, 401);
  assert.equal(unknownChallenge.body?.error, "Invalid username or password.");
  assert.equal(String(unknownChallenge.body?.error || "").includes(FIRST_RUN_HINT), false);
});
