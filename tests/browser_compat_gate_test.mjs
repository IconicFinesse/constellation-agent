import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatePath = path.join(projectRoot, "server", "pages", "res", "browser-compat.js");

// The gate reads real browser globals at import time, so each probe runs in its own
// process where crypto, isSecureContext, storage, and the injected meta config can be
// stubbed to match a plain-HTTP LAN browser without touching the checkout.
const HARNESS_SOURCE = String.raw`
const params = JSON.parse(process.env.PROBE_PARAMS || "{}");
const cryptoMode = process.env.PROBE_CRYPTO || "limited";

globalThis.isSecureContext = process.env.PROBE_SECURE === "true";

if (cryptoMode === "none") {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
} else if (cryptoMode === "limited") {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues(view) { return view; } }
  });
}

const storage = new Map();
globalThis.sessionStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  removeItem(key) { storage.delete(key); },
  setItem(key, value) { storage.set(key, String(value)); }
};
globalThis.MutationObserver = class { disconnect() {} observe() {} };
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0);
globalThis.matchMedia = () => ({ matches: false });

const target = {
  html: "",
  get innerHTML() { return this.html; },
  set innerHTML(value) { this.html = String(value); },
  removeAttribute() {},
  setAttribute() {}
};

globalThis.document = {
  body: { setAttribute() {} },
  querySelector(selector) {
    if (selector === "[data-space-browser-compat-target]") {
      return target;
    }

    const match = /data-space-param="([A-Z0-9_]+)"/.exec(String(selector));
    const entry = match ? params[match[1]] : null;

    if (!entry) {
      return null;
    }

    return { content: String(entry.content), dataset: { spaceType: String(entry.type || "text") } };
  },
  querySelectorAll() { return []; }
};

await import(process.env.PROBE_GATE_URL);

const result = await globalThis.SpaceBrowserCompatibility.check();
process.stdout.write(JSON.stringify({ html: target.html, result }));
`;

let harnessPathPromise;

async function getHarnessPath() {
  if (!harnessPathPromise) {
    harnessPathPromise = (async () => {
      const harnessDir = await fs.mkdtemp(path.join(os.tmpdir(), "space-browser-compat-gate-"));
      const harnessPath = path.join(harnessDir, "gate_probe.mjs");
      await fs.writeFile(harnessPath, HARNESS_SOURCE, "utf8");
      return harnessPath;
    })();
  }

  return harnessPathPromise;
}

test.after(async () => {
  if (!harnessPathPromise) {
    return;
  }

  const harnessPath = await harnessPathPromise;
  await fs.rm(path.dirname(harnessPath), { force: true, recursive: true });
});

async function probeGate({ crypto = "limited", params = {}, secure = false } = {}) {
  const harnessPath = await getHarnessPath();
  const gateUrl = `${pathToFileURL(gatePath).href}?probe=${Math.random().toString(36).slice(2)}`;
  const { stdout } = await execFileAsync(process.execPath, [harnessPath], {
    env: {
      ...process.env,
      PROBE_CRYPTO: crypto,
      PROBE_GATE_URL: gateUrl,
      PROBE_PARAMS: JSON.stringify(params),
      PROBE_SECURE: secure ? "true" : "false"
    },
    timeout: 60_000
  });

  return JSON.parse(stdout);
}

test("multi-user shells block plain-HTTP sessions without crypto.subtle and name the single-user escape hatch", async () => {
  const { html, result } = await probeGate();

  assert.equal(result.ok, false);

  const problem = result.missing.find((entry) => entry.id === "web-crypto");
  assert.ok(problem, "expected a web-crypto problem");
  assert.match(problem.detail, /Password login and user crypto require crypto\.subtle\./u);
  assert.match(problem.detail, /not running in a secure context/u);
  assert.match(problem.detail, /HTTPS or localhost/u);
  assert.match(problem.detail, /SINGLE_USER_APP=true/u);

  assert.match(html, /Browser Not Supported/u);
  assert.match(html, /HTTPS or localhost/u);
  assert.match(html, /SINGLE_USER_APP=true/u);
});

test("single-user runtime passes the public-shell gate without crypto.subtle on plain HTTP", async () => {
  const { result } = await probeGate({
    params: { SINGLE_USER_APP: { content: "true", type: "boolean" } }
  });

  assert.deepEqual(result, { missing: [], ok: true });
});

test("single-user runtime still blocks when crypto.getRandomValues is missing", async () => {
  const { html, result } = await probeGate({
    crypto: "none",
    params: { SINGLE_USER_APP: { content: "true", type: "boolean" } }
  });

  assert.equal(result.ok, false);

  const problem = result.missing.find((entry) => entry.id === "web-crypto");
  assert.ok(problem, "expected a web-crypto problem");
  assert.match(problem.detail, /crypto\.getRandomValues/u);
  assert.doesNotMatch(problem.detail, /crypto\.subtle/u);
  assert.match(problem.detail, /not running in a secure context/u);

  assert.doesNotMatch(html, /SINGLE_USER_APP/u);
});

test("secure multi-user contexts report only the crypto.subtle contract that is actually missing", async () => {
  const { result } = await probeGate({ secure: true });

  assert.equal(result.ok, false);

  const problem = result.missing.find((entry) => entry.id === "web-crypto");
  assert.ok(problem, "expected a web-crypto problem");
  assert.equal(problem.detail, "Password login and user crypto require crypto.subtle.");
});
