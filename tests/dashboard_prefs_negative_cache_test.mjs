import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSimpleYaml,
  serializeSimpleYaml
} from "../app/L0/_all/modules/_core/framework/js/yaml-lite.js";

const yaml = {
  parse: (source) => parseSimpleYaml(String(source || "")),
  stringify: (value) => serializeSimpleYaml(value)
};

/**
 * Regression coverage for issue #15 (dashboard preference half).
 *
 * Root cause: loadDashboardPrefs() reads ~/config/dashboard.yaml and maps a
 * missing file to defaults, but it forgets that the file is missing. The
 * dashboard welcome panel and the topbar restore toggle both mount on the same
 * dashboard render and both call loadDashboardPrefs(), so a user who never saved
 * a preference pays a fresh 404 read on every dashboard visit.
 *
 * Scope note: this suite proves the module contract (repeat loads observe one
 * missing-file read). The claim that a live dashboard mount issues roughly two
 * 404s per visit is inspection-proven from the two call sites, not reproduced
 * here.
 */

const PREFS_MODULE_PATH = "../app/L0/_all/modules/_core/dashboard_welcome/dashboard-prefs.js";
let moduleLoadCounter = 0;

function loadFreshPrefsModule() {
  moduleLoadCounter += 1;

  return import(`${PREFS_MODULE_PATH}?case=${moduleLoadCounter}`);
}

function createMissingFileEnv() {
  const reads = [];

  globalThis.space = {
    api: {
      async fileRead(path) {
        reads.push(String(path || ""));
        throw new Error(`API file_read failed with status 404: Path not found: ${path}`);
      },
      async fileWrite() {
        throw new Error("fileWrite must not run in a missing-file case");
      }
    },
    utils: { yaml }
  };

  return { reads };
}

function createStoredFileEnv(initialContent = "") {
  const reads = [];
  const writes = [];
  let storedContent = initialContent;

  globalThis.space = {
    api: {
      async fileRead(path) {
        reads.push(String(path || ""));

        if (!storedContent) {
          throw new Error(`API file_read failed with status 404: Path not found: ${path}`);
        }

        return { content: storedContent, path: String(path || "") };
      },
      async fileWrite(path, content) {
        writes.push({ content, path });
        storedContent = String(content || "");
        return { path: String(path || "") };
      }
    },
    utils: { yaml }
  };

  return { reads, writes };
}

function installWindowStub() {
  globalThis.window = {
    addEventListener() {},
    dispatchEvent() {},
    removeEventListener() {}
  };
  globalThis.CustomEvent = class CustomEventStub {
    constructor(type, options = {}) {
      this.detail = options.detail;
      this.type = type;
    }
  };
}

test("repeated loads of a missing dashboard preference file read it once", async () => {
  const { reads } = createMissingFileEnv();
  const { loadDashboardPrefs } = await loadFreshPrefsModule();

  const firstPrefs = await loadDashboardPrefs();
  const secondPrefs = await loadDashboardPrefs();

  assert.deepEqual(firstPrefs, { welcomeHidden: false });
  assert.deepEqual(secondPrefs, { welcomeHidden: false });
  assert.equal(reads.length, 1, "the second load must reuse the known-missing state");
  assert.equal(reads[0], "~/config/dashboard.yaml");
});

test("saving a preference re-enables reading and exposes the saved value", async () => {
  const { reads } = createStoredFileEnv("");
  const { loadDashboardPrefs, setDashboardWelcomeHidden } = await loadFreshPrefsModule();

  installWindowStub();
  await loadDashboardPrefs();
  assert.equal(reads.length, 1);
  await loadDashboardPrefs();
  assert.equal(reads.length, 1, "missing-file state stays memoized before the save");

  const savedPrefs = await setDashboardWelcomeHidden(true);

  assert.deepEqual(savedPrefs, { welcomeHidden: true });

  const nextPrefs = await loadDashboardPrefs();

  assert.deepEqual(nextPrefs, { welcomeHidden: true });
  assert.equal(reads.length, 3, "the save read plus one real re-read after the write");
});

test("existing preference reads are never memoized", async () => {
  const { reads } = createStoredFileEnv("welcome_hidden: true\n");
  const { loadDashboardPrefs } = await loadFreshPrefsModule();

  const firstPrefs = await loadDashboardPrefs();
  const secondPrefs = await loadDashboardPrefs();

  assert.deepEqual(firstPrefs, { welcomeHidden: true });
  assert.deepEqual(secondPrefs, { welcomeHidden: true });
  assert.equal(reads.length, 2, "a present file must be read on every load");
});

test("non-missing read errors still propagate", async () => {
  const { loadDashboardPrefs } = await loadFreshPrefsModule();

  globalThis.space = {
    api: {
      async fileRead() {
        throw new Error("API file_read failed with status 500: internal error");
      },
      async fileWrite() {}
    },
    utils: { yaml }
  };

  await assert.rejects(
    () => loadDashboardPrefs(),
    /Unable to load dashboard settings: API file_read failed with status 500/u
  );
});
