import assert from "node:assert/strict";
import test from "node:test";

import {
  createCurrentSpaceModuleImporter,
  importCurrentSpaceModule,
  resolveCurrentSpaceModulePath
} from "../app/L0/_all/mod/_core/spaces/widget-import.js";

function resolveTestAppUrl(path) {
  if (path.startsWith("~/")) {
    return `/${path}`;
  }

  if (/^(L0|L1|L2)\//u.test(path)) {
    return `/${path}`;
  }

  if (path.startsWith("/app/")) {
    return resolveTestAppUrl(path.slice("/app/".length));
  }

  throw new Error(`Unsupported test app path: ${path}`);
}

test("resolveCurrentSpaceModulePath resolves current-space relative scripts", () => {
  assert.equal(
    resolveCurrentSpaceModulePath("scripts/utils.js", { spaceRootPath: "~/spaces/space-7/" }),
    "~/spaces/space-7/scripts/utils.js"
  );
  assert.equal(
    resolveCurrentSpaceModulePath("./scripts/utils.js", { spaceRootPath: "~/spaces/space-7/" }),
    "~/spaces/space-7/scripts/utils.js"
  );
  assert.equal(
    resolveCurrentSpaceModulePath("/scripts/utils.js", { spaceRootPath: "~/spaces/space-7/" }),
    "~/spaces/space-7/scripts/utils.js"
  );
});

test("resolveCurrentSpaceModulePath keeps explicit app-rooted paths", () => {
  assert.equal(
    resolveCurrentSpaceModulePath("~/spaces/space-7/scripts/utils.js", { spaceRootPath: "~/spaces/space-7/" }),
    "~/spaces/space-7/scripts/utils.js"
  );
  assert.equal(
    resolveCurrentSpaceModulePath("/~/spaces/space-7/scripts/utils.js", { spaceRootPath: "~/spaces/space-7/" }),
    "~/spaces/space-7/scripts/utils.js"
  );
  assert.equal(
    resolveCurrentSpaceModulePath("L0/_all/mod/demo.js", { spaceRootPath: "~/spaces/space-7/" }),
    "L0/_all/mod/demo.js"
  );
});

test("resolveCurrentSpaceModulePath rejects unsupported URL and traversal specifiers", () => {
  assert.throws(
    () => resolveCurrentSpaceModulePath("../secrets.js", { spaceRootPath: "~/spaces/space-7/" }),
    /may not escape the current space root/
  );
  assert.throws(
    () => resolveCurrentSpaceModulePath("https://example.com/demo.js", { spaceRootPath: "~/spaces/space-7/" }),
    /do not support URL specifiers/
  );
});

test("importCurrentSpaceModule loads a versioned current-space module URL", async () => {
  const calls = [];
  const importedNamespace = { answer: 42 };

  const result = await importCurrentSpaceModule("scripts/utils.js", {
    fileInfo: async (path) => {
      calls.push({ kind: "fileInfo", path });
      return {
        isDirectory: false,
        modifiedAt: "2026-04-18T20:10:00.000Z",
        path,
        size: 128
      };
    },
    importModule: async (moduleUrl) => {
      calls.push({ kind: "import", moduleUrl });
      return importedNamespace;
    },
    locationOrigin: "https://constellation-agent.local",
    resolveAppUrl: resolveTestAppUrl,
    spaceRootPath: "~/spaces/space-7/"
  });

  assert.equal(result, importedNamespace);
  assert.deepEqual(calls[0], {
    kind: "fileInfo",
    path: "~/spaces/space-7/scripts/utils.js"
  });

  const importedUrl = new URL(calls[1].moduleUrl);
  assert.equal(importedUrl.origin, "https://constellation-agent.local");
  assert.equal(importedUrl.pathname, "/~/spaces/space-7/scripts/utils.js");
  assert.equal(importedUrl.searchParams.get("v"), "2026-04-18T20:10:00.000Z:128");
});

test("createCurrentSpaceModuleImporter reuses the configured current-space root", async () => {
  const importer = createCurrentSpaceModuleImporter({
    fileInfo: async (path) => ({
      isDirectory: false,
      modifiedAt: "2026-04-18T20:15:00.000Z",
      path,
      size: 64
    }),
    importModule: async (moduleUrl) => ({ moduleUrl }),
    locationOrigin: "https://constellation-agent.local",
    resolveAppUrl: resolveTestAppUrl,
    spaceRootPath: "~/spaces/space-9/"
  });

  const result = await importer("scripts/store.js");
  const importedUrl = new URL(result.moduleUrl);

  assert.equal(importedUrl.pathname, "/~/spaces/space-9/scripts/store.js");
  assert.equal(importedUrl.searchParams.get("v"), "2026-04-18T20:15:00.000Z:64");
});
