import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentServer } from "../server/app.js";
import { SERVER_TMP_DIR } from "../server/config.js";

const ARCHIVE_LARGE_BYTES = 12 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 5000;

async function postJson(browserUrl, pathname, body) {
  const response = await fetch(`${browserUrl}${pathname}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  return {
    body: await response.json(),
    status: response.status
  };
}

async function waitForEmptyDirectory(directoryPath) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const entries = await readdir(directoryPath);

    if (!entries.length) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return false;
}

test("folder downloads stage the ZIP archive in the runtime temp directory", async (testContext) => {
  const basePath = await mkdtemp(path.join(os.tmpdir(), "space-folder-download-"));
  const customwarePath = path.join(basePath, "customware");
  const runtimeTmpDir = path.join(basePath, "runtime-tmp");
  const previousAuthDataDir = process.env.SPACE_AUTH_DATA_DIR;
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

    if (previousAuthDataDir === undefined) {
      delete process.env.SPACE_AUTH_DATA_DIR;
    } else {
      process.env.SPACE_AUTH_DATA_DIR = previousAuthDataDir;
    }
  });

  await runtime.listen();

  const largeContent = randomBytes(ARCHIVE_LARGE_BYTES).toString("base64");
  const writeResult = await postJson(runtime.browserUrl, "/api/file_write", {
    content: largeContent,
    path: "~/space1/data.bin"
  });
  assert.equal(writeResult.status, 200);

  const nestedWriteResult = await postJson(runtime.browserUrl, "/api/file_write", {
    content: "nested",
    path: "~/space1/sub/note.txt"
  });
  assert.equal(nestedWriteResult.status, 200);

  const headResponse = await fetch(
    `${runtime.browserUrl}/api/folder_download?path=${encodeURIComponent("~/space1/")}`,
    { method: "HEAD" }
  );
  assert.equal(headResponse.status, 204);

  const bundleTmpEntriesBefore = new Set(await readdir(SERVER_TMP_DIR));
  const downloadUrl = `${runtime.browserUrl}/api/folder_download?path=${encodeURIComponent("~/space1/")}`;
  const downloadResponse = await fetch(downloadUrl);

  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get("content-type"), "application/zip");
  assert.match(
    String(downloadResponse.headers.get("content-disposition") || ""),
    /^attachment;.*space1\.zip/
  );

  // Read one chunk so the archive stream is flowing but not finished; the staged
  // ZIP then stays on disk while the staging directories are snapshotted below.
  const reader = downloadResponse.body.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);

  const stagedEntries = (await readdir(runtimeTmpDir)).filter((entry) => entry.endsWith(".zip"));
  const newBundleTmpEntries = (await readdir(SERVER_TMP_DIR)).filter(
    (entry) => entry.endsWith(".zip") && !bundleTmpEntriesBefore.has(entry)
  );

  // Drain the response before asserting so a failing staging check still lets the
  // server-side stream finish and the runtime shut down instead of hanging.
  const chunks = [Buffer.from(firstChunk.value)];

  while (true) {
    const nextChunk = await reader.read();

    if (nextChunk.done) {
      break;
    }

    chunks.push(Buffer.from(nextChunk.value));
  }

  const archiveBuffer = Buffer.concat(chunks);

  // The archive must be staged under the configured runtime temp directory, not
  // inside the bundled server/tmp tree that packaged desktop builds expose read-only.
  assert.equal(stagedEntries.length, 1);
  assert.deepEqual(newBundleTmpEntries, []);

  assert.equal(archiveBuffer.subarray(0, 4).toString("hex"), "504b0304");
  assert.ok(archiveBuffer.includes(Buffer.from("space1/data.bin")));
  assert.ok(archiveBuffer.includes(Buffer.from("space1/sub/note.txt")));

  assert.equal(await waitForEmptyDirectory(runtimeTmpDir), true);
});
