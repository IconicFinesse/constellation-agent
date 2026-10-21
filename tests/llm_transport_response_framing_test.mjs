import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { register } from "node:module";
import test from "node:test";

// Browser modules import each other through the logical `/mod/...` app paths, so a tiny
// resolve hook maps those specifiers onto the firmware module root before any import runs.
const MODULE_ROOT_URL = new URL("../app/L0/_all/mod/", import.meta.url).href;

register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("/mod/")) {
    return { url: new URL(specifier.slice(5), ${JSON.stringify(MODULE_ROOT_URL)}).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`)}`,
  import.meta.url
);

const SPACE_ORIGIN = "http://127.0.0.1:3000";

globalThis.window = globalThis;
globalThis.location = new URL(`${SPACE_ORIGIN}/`);
globalThis.space = {
  extend: (moduleRef, extensionTarget) => extensionTarget
};

const SSE_COMPLETION_BODY = [
  'data: {"choices":[{"delta":{"content":"hello"}}]}',
  "",
  "data: [DONE]",
  "",
  ""
].join("\n");

const upstreamRequests = [];
let upstreamResponse = { status: 200, contentType: "application/json", body: "{}" };

const providerServer = http.createServer(async (req, res) => {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  upstreamRequests.push({
    body: Buffer.concat(chunks).toString("utf8"),
    headers: { ...req.headers },
    method: req.method,
    url: req.url
  });

  const headers = {};

  if (upstreamResponse.contentType) {
    headers["Content-Type"] = upstreamResponse.contentType;
  }

  res.writeHead(upstreamResponse.status, headers);
  res.end(upstreamResponse.body);
});

providerServer.listen(0, "127.0.0.1");
await once(providerServer, "listening");

const providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;

// Stand-in for the space-agent server: only `/api/proxy` is mounted, and it runs the
// real outbound transport so the test exercises the shipped proxy handler too.
const { proxyExternalRequest } = await import("../server/router/proxy.js");

const appServer = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, SPACE_ORIGIN);

  if (requestUrl.pathname === "/api/proxy") {
    await proxyExternalRequest(req, res, requestUrl);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

appServer.listen(0, "127.0.0.1");
await once(appServer, "listening");

const appServerPort = appServer.address().port;
const browserFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const rawUrl =
    input instanceof URL ? input.toString() : typeof input === "string" ? input : input?.url || "";
  const resolvedUrl = new URL(rawUrl, SPACE_ORIGIN);

  if (resolvedUrl.origin === SPACE_ORIGIN) {
    resolvedUrl.protocol = "http:";
    resolvedUrl.hostname = "127.0.0.1";
    resolvedUrl.port = String(appServerPort);
  }

  return browserFetch(resolvedUrl.toString(), init);
};

const { streamOnscreenAgentCompletion } = await import(
  "../app/L0/_all/mod/_core/onscreen_agent/api.js"
);
const { streamAdminAgentCompletion } = await import(
  "../app/L0/_all/mod/_core/admin/views/agent/api.js"
);

test.after(() => {
  providerServer.close();
  appServer.close();
});

function createApiSettings() {
  return {
    apiEndpoint: `${providerBaseUrl}/v1/chat/completions`,
    apiKey: "sk-test-not-a-real-key",
    model: "test/model",
    paramsText: "temperature:0.2",
    provider: "api",
    supportsVision: false
  };
}

function primeUpstream(nextResponse) {
  upstreamResponse = nextResponse;
  upstreamRequests.length = 0;
}

async function streamOnscreen({ settings = createApiSettings() } = {}) {
  let text = "";
  const responseMeta = await streamOnscreenAgentCompletion({
    messages: [{ role: "user", content: "hi" }],
    onDelta: (delta) => {
      text += delta;
    },
    promptInput: {
      requestMessages: [{ role: "user", content: "hi" }],
      systemPrompt: "system"
    },
    settings
  });

  return { responseMeta, text };
}

async function streamAdmin({ settings = createApiSettings() } = {}) {
  let text = "";
  const responseMeta = await streamAdminAgentCompletion({
    messages: [{ role: "user", content: "hi" }],
    onDelta: (delta) => {
      text += delta;
    },
    promptContext: {
      requestMessages: [{ role: "user", content: "hi" }],
      systemPrompt: "system"
    },
    settings,
    systemPrompt: "system"
  });

  return { responseMeta, text };
}

test("chat requests reach the configured endpoint through the proxy with OpenAI transport shape", async () => {
  primeUpstream({
    body: JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
    contentType: "application/json",
    status: 200
  });

  const { responseMeta, text } = await streamOnscreen();

  assert.equal(text, "hello");
  assert.equal(responseMeta.mode, "standard");
  assert.equal(upstreamRequests.length, 1);

  const [upstreamRequest] = upstreamRequests;

  assert.equal(upstreamRequest.method, "POST");
  assert.equal(upstreamRequest.url, "/v1/chat/completions");
  assert.equal(upstreamRequest.headers.authorization, "Bearer sk-test-not-a-real-key");
  assert.match(upstreamRequest.headers["content-type"], /application\/json/u);

  const parsedBody = JSON.parse(upstreamRequest.body);

  assert.equal(parsedBody.model, "test/model");
  assert.equal(parsedBody.stream, true);
  assert.equal(parsedBody.temperature, 0.2);
  assert.ok(Array.isArray(parsedBody.messages));
});

test("OpenRouter-style text/event-stream completions stay on the streaming reader", async () => {
  primeUpstream({ body: SSE_COMPLETION_BODY, contentType: "text/event-stream", status: 200 });

  const { responseMeta, text } = await streamOnscreen();

  assert.equal(text, "hello");
  assert.equal(responseMeta.mode, "stream");
  assert.equal(responseMeta.sawDoneMarker, true);
});

test("SSE completions labeled text/plain are still parsed as a stream", async () => {
  primeUpstream({ body: SSE_COMPLETION_BODY, contentType: "text/plain; charset=utf-8", status: 200 });

  const { responseMeta, text } = await streamOnscreen();

  assert.equal(text, "hello");
  assert.equal(responseMeta.mode, "stream");
  assert.equal(responseMeta.sawDoneMarker, true);
});

test("SSE completions without a content-type header are still parsed as a stream", async () => {
  primeUpstream({ body: SSE_COMPLETION_BODY, contentType: "", status: 200 });

  const { responseMeta, text } = await streamOnscreen();

  assert.equal(text, "hello");
  assert.equal(responseMeta.mode, "stream");
});

test("admin chat applies the same tolerant framing to mislabeled SSE", async () => {
  primeUpstream({ body: SSE_COMPLETION_BODY, contentType: "text/plain", status: 200 });

  const { responseMeta, text } = await streamAdmin();

  assert.equal(text, "hello");
  assert.equal(responseMeta.mode, "stream");
});

test("non-JSON completion bodies raise an actionable error instead of a raw parse failure", async () => {
  primeUpstream({
    body: "<!doctype html><html><body>space agent shell</body></html>",
    contentType: "text/html",
    status: 200
  });

  await assert.rejects(streamOnscreen(), (error) => {
    assert.doesNotMatch(error.message, /Unexpected token|JSON\.parse/u);
    assert.match(error.message, /status 200/u);
    assert.match(error.message, /text\/html/u);
    assert.match(error.message, /unsupported response body/iu);
    return true;
  });
});

test("HTTP error responses keep the upstream provider detail", async () => {
  primeUpstream({
    body: JSON.stringify({ error: { message: "bad key" } }),
    contentType: "application/json",
    status: 401
  });

  await assert.rejects(streamOnscreen(), (error) => {
    assert.match(error.message, /status 401/u);
    assert.match(error.message, /bad key/u);
    return true;
  });
});
