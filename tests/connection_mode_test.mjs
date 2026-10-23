import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CONNECTION_MODE,
  CONNECTION_MODE_ENV_NAME,
  CONNECTED_SERVER_URL_ENV_NAME,
  normalizeSavedConnection,
  normalizeSavedConnections,
  readConnectionRequestFromEnv,
  removeSavedConnection,
  resolveConnectionConfig,
  validateRemoteServerUrl
} = require("../packaging/desktop/connection_mode.js");

test("standalone is the default and needs no configuration", () => {
  const resolved = resolveConnectionConfig({});
  assert.equal(resolved.mode, CONNECTION_MODE.STANDALONE);
  assert.equal(resolved.url, "");
  assert.equal(resolved.error, "");
});

test("standalone wins even when a URL is supplied without connected mode", () => {
  const resolved = resolveConnectionConfig({ url: "https://constellation.example.com" });
  assert.equal(resolved.mode, CONNECTION_MODE.STANDALONE);
  assert.equal(resolved.url, "");
});

test("https remote servers are accepted and origin-normalized", () => {
  const validation = validateRemoteServerUrl("https://constellation.example.com/");
  assert.equal(validation.ok, true);
  assert.equal(validation.origin, "https://constellation.example.com");
  assert.equal(validation.error, "");
});

test("plain http remote servers are rejected; localhost dev targets are allowed", () => {
  const remote = validateRemoteServerUrl("http://192.0.2.10:3000");
  assert.equal(remote.ok, false);
  assert.match(remote.error, /https/i);

  const local = validateRemoteServerUrl("http://localhost:3000");
  assert.equal(local.ok, true);
  assert.equal(local.origin, "http://localhost:3000");

  const loopback = validateRemoteServerUrl("http://127.0.0.1:3000");
  assert.equal(loopback.ok, true);
});

test("embedded credentials and non-http schemes are rejected", () => {
  assert.equal(validateRemoteServerUrl("https://user:pass@example.com").ok, false);
  assert.equal(validateRemoteServerUrl("ftp://example.com").ok, false);
  assert.equal(validateRemoteServerUrl("not a url").ok, false);
  assert.equal(validateRemoteServerUrl("").ok, false);
});

test("saved connections keep their pinned origin and report origin changes", () => {
  const stable = normalizeSavedConnection({
    label: "My server",
    url: "https://constellation.example.com",
    origin: "https://constellation.example.com"
  });
  assert.equal(stable.label, "My server");
  assert.equal(stable.pinnedOriginChanged, false);

  const moved = normalizeSavedConnection({
    label: "Old name",
    url: "https://new-host.example.com",
    origin: "https://old-host.example.com"
  });
  assert.equal(moved.pinnedOriginChanged, true);
  assert.equal(moved.origin, "https://new-host.example.com");
});

test("saved connection lists dedupe by origin and drop invalid entries", () => {
  const list = normalizeSavedConnections([
    { label: "A", url: "https://a.example.com" },
    { label: "A duplicate", url: "https://a.example.com" },
    { label: "Bad", url: "http://insecure.example.com" },
    { label: "Local", url: "http://localhost:3000" }
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((entry) => entry.origin).sort(), [
    "http://localhost:3000",
    "https://a.example.com"
  ]);
});

test("connected mode with an explicit URL resolves to that server", () => {
  const resolved = resolveConnectionConfig({
    mode: "connected",
    url: "https://constellation.example.com"
  });
  assert.equal(resolved.mode, CONNECTION_MODE.CONNECTED);
  assert.equal(resolved.origin, "https://constellation.example.com");
  assert.equal(resolved.error, "");
});

test("connected mode falls back to the first saved connection", () => {
  const resolved = resolveConnectionConfig({
    mode: "connected",
    savedConnections: [{ label: "My server", url: "https://constellation.example.com" }]
  });
  assert.equal(resolved.mode, CONNECTION_MODE.CONNECTED);
  assert.equal(resolved.url, "https://constellation.example.com/");
  assert.equal(resolved.label, "My server");
});

test("connected mode without any saved server returns a clear error", () => {
  const resolved = resolveConnectionConfig({ mode: "connected" });
  assert.equal(resolved.mode, CONNECTION_MODE.CONNECTED);
  assert.equal(resolved.url, "");
  assert.match(resolved.error, /no saved remote server/i);
});

test("connected mode with an insecure URL refuses to resolve", () => {
  const resolved = resolveConnectionConfig({
    mode: "connected",
    url: "http://192.0.2.10:3000"
  });
  assert.equal(resolved.url, "");
  assert.match(resolved.error, /https/i);
});

test("a saved connection whose origin moved surfaces a review warning", () => {
  const resolved = resolveConnectionConfig({
    mode: "connected",
    savedConnections: [{
      label: "Pinned",
      url: "https://new-host.example.com",
      origin: "https://old-host.example.com"
    }]
  });
  assert.equal(resolved.mode, CONNECTION_MODE.CONNECTED);
  assert.match(resolved.error, /changed since it was saved/i);
});

test("env seam drives connected mode for the e2e harness", () => {
  assert.equal(readConnectionRequestFromEnv({}), null);

  const fromUrl = readConnectionRequestFromEnv({
    [CONNECTED_SERVER_URL_ENV_NAME]: "https://constellation.example.com"
  });
  assert.equal(fromUrl.mode, CONNECTION_MODE.CONNECTED);

  const fromMode = readConnectionRequestFromEnv({
    [CONNECTION_MODE_ENV_NAME]: "connected",
    [CONNECTED_SERVER_URL_ENV_NAME]: "https://constellation.example.com"
  });
  assert.equal(fromMode.mode, "connected");
  assert.equal(fromMode.url, "https://constellation.example.com");
});

test("removing a saved server drops only that origin", () => {
  const result = removeSavedConnection([
    { label: "Typo", url: "https://typo.example.com" },
    { label: "Good", url: "https://good.example.com" }
  ], "https://typo.example.com");
  assert.equal(result.removed, true);
  assert.deepEqual(result.connections.map((entry) => entry.origin), ["https://good.example.com"]);
});

test("removing an unknown origin changes nothing", () => {
  const result = removeSavedConnection([
    { label: "Good", url: "https://good.example.com" }
  ], "https://absent.example.com");
  assert.equal(result.removed, false);
  assert.equal(result.connections.length, 1);
});

test("removing with a blank origin is a no-op", () => {
  const result = removeSavedConnection([
    { label: "Good", url: "https://good.example.com" }
  ], "");
  assert.equal(result.removed, false);
  assert.equal(result.connections.length, 1);
});

test("removing invalid stored entries still normalizes the remainder", () => {
  const result = removeSavedConnection([
    { label: "Good", url: "https://good.example.com" },
    { label: "Local", url: "http://localhost:3000" },
    { label: "Bad", url: "http://insecure.example.com" }
  ], "https://good.example.com");
  assert.equal(result.removed, true);
  assert.deepEqual(result.connections.map((entry) => entry.origin), ["http://localhost:3000"]);
});
