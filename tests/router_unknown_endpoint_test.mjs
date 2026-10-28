import assert from "node:assert/strict";
import test from "node:test";

import { createRequestHandler } from "../server/router/router.js";

// An `/api/<name>` that matches no registered module used to fall through every
// later prefix test into `handlePageRequest`, whose static handler answered
// `404 {"error":"File not found"}`. That names the wrong resource entirely: the
// file was fine, the ENDPOINT was missing. The router now answers an explicit
// unknown-endpoint error, while a real endpoint with a bad verb keeps its
// existing precise 405.

function createMockRequest(pathname, options = {}) {
  return {
    headers: {
      host: "localhost:3000",
      ...(options.headers || {})
    },
    method: options.method || "GET",
    url: pathname
  };
}

function createMockResponse() {
  let resolveResult = null;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const storedHeaders = {};

  const response = {
    headersSent: false,
    statusCode: null,
    writableEnded: false,
    getHeader(name) {
      return storedHeaders[name];
    },
    setHeader(name, value) {
      storedHeaders[name] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.headersSent = true;
      this.statusCode = statusCode;
      Object.assign(storedHeaders, headers);
    },
    end(body = "") {
      this.writableEnded = true;
      resolveResult({
        body: Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""),
        headers: { ...storedHeaders },
        statusCode: this.statusCode
      });
    }
  };

  return { response, result };
}

function createApiRegistry(endpointName, handlers) {
  return new Map([
    [
      endpointName,
      {
        allowAnonymous: false,
        endpointName,
        handlers
      }
    ]
  ]);
}

function createTestRequestHandler(handlers, options = {}) {
  return createRequestHandler({
    apiRegistry: createApiRegistry("example", handlers),
    auth: options.auth ?? null,
    host: "localhost",
    port: 3000,
    projectRoot: process.cwd(),
    projectVersion: "test"
  });
}

const AUTHENTICATED_AUTH = {
  async resolveUserFromCookies() {
    return {
      isAuthenticated: true,
      session: { id: "test-session" },
      sessionToken: "test-token",
      shouldClearSessionCookie: false,
      source: "session",
      username: "user"
    };
  }
};

test("an unknown API endpoint reports the endpoint, not a missing file", async () => {
  const requestHandler = createTestRequestHandler(
    { get: () => ({ ok: true }) },
    { auth: AUTHENTICATED_AUTH }
  );
  const { response, result } = createMockResponse();

  await requestHandler(createMockRequest("/api/nope_nope"), response);

  const payload = await result;
  assert.equal(payload.statusCode, 404);
  assert.deepEqual(JSON.parse(payload.body), {
    error: "Unknown API endpoint: nope_nope"
  });
  // An API-shaped response must carry the same CORS policy as its 405 sibling in
  // `handleApiModuleRequest`; the page layer that used to answer this path set none.
  assert.equal(payload.headers["Access-Control-Allow-Origin"], "*");
});

// The guard must not swallow anything that is genuinely a static path: only an
// exact `/api/<name>` shape takes the new branch.
test("non-endpoint paths still reach the page layer", async () => {
  const requestHandler = createTestRequestHandler(
    { get: () => ({ ok: true }) },
    { auth: AUTHENTICATED_AUTH }
  );
  const { response, result } = createMockResponse();

  await requestHandler(createMockRequest("/api/nope_nope/extra"), response);

  const payload = await result;
  assert.equal(payload.statusCode, 404);
  // The page layer's wording, NOT the endpoint wording: this path was never an
  // endpoint name, so the unknown-endpoint branch must not claim it.
  assert.deepEqual(JSON.parse(payload.body), {
    error: "File not found"
  });
});

// Unauthenticated callers must not gain an endpoint oracle: the new branch is
// auth-gated exactly like the neighbouring protected branches.
test("an unknown API endpoint is auth-gated", async () => {
  const requestHandler = createTestRequestHandler({ get: () => ({ ok: true }) });
  const { response, result } = createMockResponse();

  await requestHandler(createMockRequest("/api/nope_nope"), response);

  const payload = await result;
  assert.equal(payload.statusCode, 401);
  assert.deepEqual(JSON.parse(payload.body), {
    error: "Authentication required"
  });
});

// The sibling precision the new branch was modelled on must still hold.
test("a known endpoint with an unsupported verb still reports the verb", async () => {
  const requestHandler = createTestRequestHandler(
    { get: () => ({ ok: true }) },
    { auth: AUTHENTICATED_AUTH }
  );
  const { response, result } = createMockResponse();

  await requestHandler(createMockRequest("/api/example", { method: "DELETE" }), response);

  const payload = await result;
  assert.equal(payload.statusCode, 405);
  assert.deepEqual(JSON.parse(payload.body), {
    error: "Method DELETE is not supported for example"
  });
});
