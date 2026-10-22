import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../server/server.js";

// Issue #49: plain-HTTP LAN browsers have no crypto.subtle, so the public-shell
// compatibility gate lets single-user runtime through. These assertions pin the
// server-side contract that escape hatch depends on: /enter stays reachable with
// SINGLE_USER_APP exposed to the shell, password login stays out of the path, and
// multi-user runtime still routes the launcher through /login.
const originalAuthDataDir = process.env.SPACE_AUTH_DATA_DIR;
let authDataDir = "";

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

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test.before(async () => {
  authDataDir = await createTempDir("space-auth-data-single-user-");
  process.env.SPACE_AUTH_DATA_DIR = authDataDir;
});

test.after(async () => {
  if (originalAuthDataDir === undefined) {
    delete process.env.SPACE_AUTH_DATA_DIR;
  } else {
    process.env.SPACE_AUTH_DATA_DIR = originalAuthDataDir;
  }

  if (authDataDir) {
    await fs.rm(authDataDir, { force: true, recursive: true });
  }
});

test("single-user runtime reaches /enter on plain HTTP without password login", async (testContext) => {
  const customwarePath = await createTempDir("space-single-user-launcher-");
  const runtime = await createRuntime({
    CUSTOMWARE_PATH: customwarePath,
    SINGLE_USER_APP: "true"
  });

  testContext.after(async () => {
    await runtime.close();
    await fs.rm(customwarePath, { force: true, recursive: true });
  });

  const enterResponse = await fetch(new URL("/enter", runtime.browserUrl), { redirect: "manual" });
  const enterHtml = await enterResponse.text();

  assert.equal(enterResponse.status, 200);
  assert.match(
    enterHtml,
    /<meta name="space-config" data-space-param="SINGLE_USER_APP" data-space-type="boolean" content="true" \/>/u
  );

  const loginResponse = await fetch(new URL("/login", runtime.browserUrl), { redirect: "manual" });

  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.get("location"), "/");

  const loginCheckResponse = await fetch(new URL("/api/login_check", runtime.browserUrl));
  const loginCheckBody = await loginCheckResponse.json();

  assert.equal(loginCheckResponse.status, 200);
  assert.equal(loginCheckBody.authenticated, true);
  assert.equal(loginCheckBody.username, "user");
});

test("multi-user runtime keeps the launcher behind password login", async (testContext) => {
  const customwarePath = await createTempDir("space-multi-user-launcher-");
  const runtime = await createRuntime({
    CUSTOMWARE_PATH: customwarePath
  });

  testContext.after(async () => {
    await runtime.close();
    await fs.rm(customwarePath, { force: true, recursive: true });
  });

  const enterResponse = await fetch(new URL("/enter", runtime.browserUrl), { redirect: "manual" });

  assert.equal(enterResponse.status, 302);
  assert.equal(enterResponse.headers.get("location"), "/login");

  const loginResponse = await fetch(new URL("/login", runtime.browserUrl), { redirect: "manual" });
  const loginHtml = await loginResponse.text();

  assert.equal(loginResponse.status, 200);
  assert.match(
    loginHtml,
    /<meta name="space-config" data-space-param="SINGLE_USER_APP" data-space-type="boolean" content="false" \/>/u
  );
});
