import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { startServer } from "../server/server.js";
import { createProvisionedUserCryptoRecord } from "../server/pages/res/user-crypto.js";

const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_UTF8_FLAG = 0x0800;
const DEFAULT_FILE_MODE = 0o100644;
const SYMLINK_FILE_MODE = 0o120777;

function crc32Of(bytes) {
  return zlib.crc32(bytes) >>> 0;
}

function buildZipArchive(entries) {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(String(entry.name || ""), "utf8");
    const dataBytes = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ""), "utf8");
    const method = entry.stored ? ZIP_METHOD_STORED : ZIP_METHOD_DEFLATE;
    const payloadBytes = method === ZIP_METHOD_DEFLATE ? zlib.deflateRawSync(dataBytes) : dataBytes;
    const crc = crc32Of(dataBytes);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payloadBytes.length, 18);
    localHeader.writeUInt32LE(dataBytes.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBytes, payloadBytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payloadBytes.length, 20);
    centralHeader.writeUInt32LE(dataBytes.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(((entry.mode ?? DEFAULT_FILE_MODE) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralChunks.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + payloadBytes.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

function buildValidSpaceEntries(prefix = "") {
  return [
    {
      data: "id: demo-space\ntitle: Demo Space\n",
      name: prefix + "space.yaml"
    },
    {
      data: "renderer: html\ntitle: Hello\n",
      name: prefix + "widgets/hello.yaml"
    }
  ];
}

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

async function loginAsGuest(baseUrl) {
  const guestCreateResponse = await requestJson(baseUrl, "/api/guest_create", {
    body: "{}",
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  assert.equal(guestCreateResponse.status, 200);

  const username = guestCreateResponse.body.username;
  const password = guestCreateResponse.body.password;
  const clientNonce = randomBytes(18).toString("base64url");
  const challengeResponse = await requestJson(baseUrl, "/api/login_challenge", {
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

  const challenge = challengeResponse.body;
  const userCryptoProvisioning =
    challenge.userCrypto?.state === "missing" && challenge.userCrypto?.provisioningShare
      ? {
          record: (
            await createProvisionedUserCryptoRecord({
              password,
              serverShare: Buffer.from(String(challenge.userCrypto.provisioningShare), "base64url")
            })
          ).record
        }
      : null;
  const loginResponse = await requestJson(baseUrl, "/api/login", {
    body: JSON.stringify({
      challengeToken: challenge.challengeToken,
      clientProof: createClientProof({
        challenge,
        clientNonce,
        password,
        username
      }),
      ...(userCryptoProvisioning ? { userCryptoProvisioning } : {})
    }),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });
  const sessionCookie = loginResponse.headers.get("set-cookie") || "";

  assert.equal(loginResponse.status, 200);
  assert.ok(sessionCookie.includes("space_session="));

  return {
    cookie: sessionCookie.split(";")[0],
    username
  };
}

async function importArchive(baseUrl, cookie, archiveBytes) {
  return requestJson(baseUrl, "/api/space_import", {
    body: archiveBytes,
    headers: {
      "content-type": "application/zip",
      cookie
    },
    method: "POST"
  });
}

function assertInvalidArchiveRejection(result, label) {
  const message = String(result.body?.error || "");

  assert.equal(result.status, 400, `${label} must be rejected with 400, got ${result.status}: ${message}`);
  assert.match(message, /archive/i, `${label} rejection must name the archive problem, got: ${message}`);
  assert.doesNotMatch(
    message,
    /internal server error/i,
    `${label} must not surface the redacted router message, got: ${message}`
  );
}

test("space_import works without any external archive tool on PATH", async (testContext) => {
  const customwarePath = await fs.mkdtemp(path.join(os.tmpdir(), "space-import-no-tool-customware-"));
  const authDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "space-import-no-tool-auth-"));
  const emptyPathDir = await fs.mkdtemp(path.join(os.tmpdir(), "space-import-empty-path-"));
  const runtime = await createRuntime({
    ALLOW_GUEST_USERS: "true",
    CUSTOMWARE_PATH: customwarePath,
    SPACE_AUTH_DATA_DIR: authDataDir
  });
  const originalPath = process.env.PATH;

  testContext.after(async () => {
    process.env.PATH = originalPath;
    await runtime.close();
    await fs.rm(customwarePath, { force: true, recursive: true });
    await fs.rm(authDataDir, { force: true, recursive: true });
    await fs.rm(emptyPathDir, { force: true, recursive: true });
  });

  const { cookie } = await loginAsGuest(runtime.browserUrl);

  process.env.PATH = emptyPathDir;

  try {
    const importResult = await importArchive(
      runtime.browserUrl,
      cookie,
      buildZipArchive(buildValidSpaceEntries())
    );

    assert.equal(
      importResult.status,
      200,
      `valid archive import must not depend on external tools: ${importResult.status} ${JSON.stringify(importResult.body)}`
    );
    assert.equal(importResult.body?.spaceId, "imported-1");

    const corruptResult = await importArchive(
      runtime.browserUrl,
      cookie,
      Buffer.from("definitely not a zip archive", "utf8")
    );

    assertInvalidArchiveRejection(corruptResult, "non-zip payload without archive tools");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("space_import installs valid archives and rejects invalid archives with an explanatory 400", async (testContext) => {
  const customwarePath = await fs.mkdtemp(path.join(os.tmpdir(), "space-import-customware-"));
  const authDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "space-import-auth-"));
  const runtime = await createRuntime({
    ALLOW_GUEST_USERS: "true",
    CUSTOMWARE_PATH: customwarePath,
    SPACE_AUTH_DATA_DIR: authDataDir
  });

  testContext.after(async () => {
    await runtime.close();
    await fs.rm(customwarePath, { force: true, recursive: true });
    await fs.rm(authDataDir, { force: true, recursive: true });
  });

  const { cookie, username } = await loginAsGuest(runtime.browserUrl);
  const validArchive = buildZipArchive(buildValidSpaceEntries());

  const validImportResult = await importArchive(runtime.browserUrl, cookie, validArchive);

  assert.equal(
    validImportResult.status,
    200,
    `valid archive import failed: ${validImportResult.status} ${JSON.stringify(validImportResult.body)}`
  );
  assert.equal(validImportResult.body?.spaceId, "imported-1");

  const installedManifest = await fs.readFile(
    path.join(customwarePath, "L2", username, "spaces", "imported-1", "space.yaml"),
    "utf8"
  );

  assert.match(installedManifest, /id: imported-1/u);

  const nestedImportResult = await importArchive(
    runtime.browserUrl,
    cookie,
    buildZipArchive(buildValidSpaceEntries("nested-space/"))
  );

  assert.equal(
    nestedImportResult.status,
    200,
    `nested valid archive import failed: ${nestedImportResult.status} ${JSON.stringify(nestedImportResult.body)}`
  );
  assert.equal(nestedImportResult.body?.spaceId, "imported-2");

  const truncatedResult = await importArchive(
    runtime.browserUrl,
    cookie,
    validArchive.subarray(0, Math.max(1, Math.floor(validArchive.length / 2)))
  );

  assertInvalidArchiveRejection(truncatedResult, "truncated archive");

  const notAZipResult = await importArchive(
    runtime.browserUrl,
    cookie,
    Buffer.from("this is not a zip archive at all", "utf8")
  );

  assertInvalidArchiveRejection(notAZipResult, "non-zip payload");

  const damagedArchive = Buffer.from(validArchive);
  const firstNameLength = damagedArchive.readUInt16LE(26);
  const firstDataOffset = 30 + firstNameLength;

  damagedArchive[firstDataOffset + 2] = damagedArchive[firstDataOffset + 2] ^ 0xff;

  const damagedResult = await importArchive(runtime.browserUrl, cookie, damagedArchive);

  assertInvalidArchiveRejection(damagedResult, "byte-damaged archive");

  const emptyResult = await importArchive(runtime.browserUrl, cookie, Buffer.alloc(0));

  assertInvalidArchiveRejection(emptyResult, "empty payload");

  const traversalResult = await importArchive(
    runtime.browserUrl,
    cookie,
    buildZipArchive([
      ...buildValidSpaceEntries(),
      {
        data: "escaped",
        name: "../escaped.txt"
      }
    ])
  );

  assertInvalidArchiveRejection(traversalResult, "path traversal archive");

  const symlinkResult = await importArchive(
    runtime.browserUrl,
    cookie,
    buildZipArchive([
      ...buildValidSpaceEntries(),
      {
        data: "/etc/passwd",
        mode: SYMLINK_FILE_MODE,
        name: "widgets/link.yaml",
        stored: true
      }
    ])
  );

  assertInvalidArchiveRejection(symlinkResult, "symlink archive");
});
