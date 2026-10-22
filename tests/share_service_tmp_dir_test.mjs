import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import archiver from "archiver";

import { createAgentServer } from "../server/app.js";
import { SERVER_TMP_DIR } from "../server/config.js";

const UNZIP_SHIM_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const args = process.argv.slice(2);
const archivePath = args.find((arg) => arg.endsWith(".zip"));
const archive = fs.readFileSync(archivePath);
const eocdOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const entryCount = archive.readUInt16LE(eocdOffset + 10);
let cursor = archive.readUInt32LE(eocdOffset + 16);
const entries = [];

for (let index = 0; index < entryCount; index += 1) {
  const method = archive.readUInt16LE(cursor + 10);
  const compressedSize = archive.readUInt32LE(cursor + 20);
  const nameLength = archive.readUInt16LE(cursor + 28);
  const extraLength = archive.readUInt16LE(cursor + 30);
  const commentLength = archive.readUInt16LE(cursor + 32);
  const localHeaderOffset = archive.readUInt32LE(cursor + 42);
  const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
  entries.push({ compressedSize, localHeaderOffset, method, name });
  cursor += 46 + nameLength + extraLength + commentLength;
}

function readEntryData(entry) {
  const nameLength = archive.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const rawData = archive.subarray(dataStart, dataStart + entry.compressedSize);
  return entry.method === 0 ? rawData : zlib.inflateRawSync(rawData);
}

if (args[0] === "-Z1") {
  for (const entry of entries) {
    console.log(entry.name);
  }

  process.exit(0);
}

const destinationIndex = args.indexOf("-d");
const destinationDir = args[destinationIndex + 1];

for (const entry of entries) {
  const targetPath = path.join(destinationDir, entry.name);

  if (entry.name.endsWith("/")) {
    fs.mkdirSync(targetPath, { recursive: true });
    continue;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, readEntryData(entry));
}
`;

async function buildShareArchive() {
  const archive = archiver("zip", { store: true });
  const chunks = [];

  archive.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  archive.append(Buffer.from("id: demo\ntitle: Demo space\n"), { name: "demo/space.yaml" });
  archive.append(Buffer.from("renderer: text\n"), { name: "demo/widgets/main.yaml" });
  archive.append(randomBytes(256), { name: "demo/assets/sample.bin" });

  const completed = new Promise((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  await archive.finalize();
  await completed;

  return Buffer.concat(chunks);
}

async function readDirectoryNames(directoryPath) {
  return readdir(directoryPath).catch(() => []);
}

test("share imports stage archive extraction in the resolved runtime temp directory", async (testContext) => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "space-share-import-"));
  const customwarePath = path.join(basePath, "customware");
  const shimDir = path.join(basePath, "bin");
  const shimPath = path.join(shimDir, "unzip");
  const runtimeTmpDir = path.join(basePath, "runtime-tmp");
  const previousAuthDataDir = process.env.SPACE_AUTH_DATA_DIR;
  const previousPath = process.env.PATH || "";

  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(shimPath, UNZIP_SHIM_SOURCE, "utf8");
  fs.chmodSync(shimPath, 0o755);
  process.env.PATH = `${shimDir}${path.delimiter}${previousPath}`;
  process.env.SPACE_AUTH_DATA_DIR = path.join(basePath, "server-data");

  const runtime = await createAgentServer({
    runtimeParamOverrides: {
      CUSTOMWARE_PATH: customwarePath,
      PORT: "0",
      SINGLE_USER_APP: "true"
    },
    tmpDir: runtimeTmpDir
  });

  testContext.after(async () => {
    await runtime.close();
    await rm(basePath, { force: true, recursive: true });
    process.env.PATH = previousPath;

    if (previousAuthDataDir === undefined) {
      delete process.env.SPACE_AUTH_DATA_DIR;
    } else {
      process.env.SPACE_AUTH_DATA_DIR = previousAuthDataDir;
    }
  });

  await runtime.listen();

  const bundleTmpEntriesBefore = new Set(await readDirectoryNames(SERVER_TMP_DIR));

  // The bootstrap already ensures the configured runtime temp root exists, so it is
  // removed here. A share import must create its own staging directory through the
  // resolved runtime temp root; a hardcoded fallback leaves this path missing.
  await rm(runtimeTmpDir, { force: true, recursive: true });
  assert.equal(fs.existsSync(runtimeTmpDir), false);

  const archiveBuffer = await buildShareArchive();
  const importResponse = await fetch(`${runtime.browserUrl}/api/space_import`, {
    body: archiveBuffer,
    headers: {
      "content-type": "application/zip"
    },
    method: "POST"
  });
  const importResult = await importResponse.json();

  assert.equal(importResponse.status, 200);
  assert.equal(importResult.spaceId, "imported-1");

  const installedRoot = path.join(customwarePath, "L2", "user", "spaces", "imported-1");
  assert.equal(fs.existsSync(path.join(installedRoot, "space.yaml")), true);
  assert.equal(fs.existsSync(path.join(installedRoot, "widgets", "main.yaml")), true);
  assert.equal(fs.existsSync(path.join(installedRoot, "data")), true);

  // Staging ran under the configured runtime temp root when its extraction helper
  // created that root again on the fly.
  assert.equal(fs.existsSync(runtimeTmpDir), true);

  // Nothing may be staged inside the bundled server/tmp tree, which packaged
  // read-only install layouts cannot write to.
  const bundleTmpEntriesAfter = await readDirectoryNames(SERVER_TMP_DIR);
  const newBundleTmpEntries = bundleTmpEntriesAfter.filter((entry) => !bundleTmpEntriesBefore.has(entry));

  assert.deepEqual(newBundleTmpEntries, []);
});
