import assert from "node:assert/strict";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { FILE_INDEX_AREA } from "../server/runtime/state_areas.js";
import { handleModuleRequest } from "../server/router/mod_handler.js";
import { handlePageRequest } from "../server/router/pages_handler.js";

const ROOT_DIR = path.resolve(new URL("..", import.meta.url).pathname);
const PROJECT_ROOT = ROOT_DIR;
const PAGES_DIR = path.join(ROOT_DIR, "server", "pages");

function createMockResponse() {
  let resolveResult = null;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const chunks = [];

  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    }
  });

  response.headers = null;
  response.headersSent = false;
  response.statusCode = null;
  response.writeHead = function writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = { ...headers };
    this.headersSent = true;
  };
  response.once("finish", () => {
    resolveResult({
      body: Buffer.concat(chunks).toString("utf8"),
      headers: response.headers || {},
      statusCode: response.statusCode
    });
  });

  return { response, result };
}

function assertNoStoreHeaders(headers = {}) {
  assert.equal(headers["Cache-Control"], "no-store, max-age=0, must-revalidate");
  assert.equal(headers.Expires, "0");
  assert.equal(headers.Pragma, "no-cache");
}

function createModuleStateSystem(projectPath) {
  const shardValue = {
    [projectPath]: { kind: "file" }
  };

  return {
    getAreaValues() {
      return {};
    },
    getValue(area, id) {
      if (area === FILE_INDEX_AREA && id === "L0") {
        return shardValue;
      }

      return null;
    }
  };
}

test("module assets are served with no-store headers", async () => {
  const { response, result } = createMockResponse();

  handleModuleRequest(response, "/mod/_core/framework/js/initFw.js", {
    headers: {},
    projectRoot: PROJECT_ROOT,
    requestUrl: new URL("http://localhost:3000/mod/_core/framework/js/initFw.js"),
    runtimeParams: null,
    stateSystem: createModuleStateSystem("/app/L0/_all/mod/_core/framework/js/initFw.js"),
    username: "user"
  });

  const payload = await result;
  assert.equal(payload.statusCode, 200);
  assert.match(payload.body, /initializeRuntime|registerAlpineMagic/u);
  assertNoStoreHeaders(payload.headers);
});

test("page shells are served with no-store headers", async () => {
  const { response, result } = createMockResponse();

  await handlePageRequest(response, new URL("http://localhost:3000/"), {
    auth: null,
    pagesDir: PAGES_DIR,
    projectVersion: "test-version",
    requestContext: { user: { isAuthenticated: true } },
    runtimeParams: null
  });

  const payload = await result;
  assert.equal(payload.statusCode, 200);
  assert.ok(payload.body.includes("<title>Space Agent</title>"));
  assertNoStoreHeaders(payload.headers);
});

test("public page resources are served with no-store headers", async () => {
  const { response, result } = createMockResponse();

  await handlePageRequest(response, new URL("http://localhost:3000/pages/res/browser-compat.js"), {
    auth: null,
    pagesDir: PAGES_DIR,
    requestContext: null,
    runtimeParams: null
  });

  const payload = await result;
  assert.equal(payload.statusCode, 200);
  assert.match(payload.body, /browser compatibility|browser-compat/u);
  assertNoStoreHeaders(payload.headers);
});
