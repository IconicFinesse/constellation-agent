import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { register } from "node:module";

import { parseSimpleYaml, serializeSimpleYaml } from "../app/L0/_all/modules/_core/framework/js/yaml-lite.js";
import {
  copyAppPath,
  mapFilesystemErrorToHttpError,
  writeAppFile,
  writeAppFiles
} from "../server/lib/customware/file_access.js";

/**
 * Regression coverage for BUG-003: a very long space or widget title must not be
 * used verbatim as a filesystem path component.
 *
 * Before the fix `slugifySegment()` had no length cap, so a ~300 character title
 * produced a ~300 byte directory name. NAME_MAX is 255 bytes, so `mkdirSync`
 * raised a raw `ENAMETOOLONG` with no `statusCode` and the API answered 500.
 *
 * Two halves are pinned here, independently:
 *   1) derived ids are capped at SPACE_ID_MAX_LENGTH while display titles keep
 *      their full text;
 *   2) a filesystem failure caused by the caller's path maps to a 4xx instead of
 *      a raw 500 at the file-access boundary.
 */

// The spaces modules import browser-style `/modules/...` specifiers.
register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const NAME_MAX_BYTES = 255;
const LONG_TITLE = "Very long space title ".repeat(15).trim();
const LONG_WIDGET_TITLE = "W".repeat(300);

function createStaticRuntimeParams(values = {}) {
  return {
    get(name, fallback = undefined) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
    }
  };
}

function createWatchdog() {
  return {
    getIndex(name) {
      return name === "path_index" ? Object.create(null) : Object.create(null);
    },
    getPaths() {
      return [];
    }
  };
}

// Copy/move resolve their source through the watchdog path index, so those paths
// need a real disk-backed index; writes do not consult it.
function createDiskWatchdog(projectRoot) {
  const appRoot = path.join(projectRoot, "app");
  const pathIndex = Object.create(null);
  const paths = [];

  function walk(absolutePath) {
    if (!fs.existsSync(absolutePath)) {
      return;
    }

    const stats = fs.statSync(absolutePath);
    const relativePath = path.relative(appRoot, absolutePath).replaceAll(path.sep, "/");
    const projectPath = relativePath
      ? `/app/${relativePath}${stats.isDirectory() ? "/" : ""}`
      : "/app/";

    paths.push(projectPath);
    pathIndex[projectPath] = {
      isDirectory: stats.isDirectory(),
      mtimeMs: Math.trunc(Number(stats.mtimeMs || 0)),
      sizeBytes: stats.isDirectory() ? 0 : Number(stats.size || 0)
    };

    if (!stats.isDirectory()) {
      return;
    }

    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      walk(path.join(absolutePath, entry.name));
    }
  }

  walk(appRoot);

  return {
    getIndex(name) {
      return name === "path_index" ? pathIndex : Object.create(null);
    },
    getPaths() {
      return [...paths];
    }
  };
}

function notFoundError(logicalPath) {
  const error = new Error(`Status 404: file not found (${logicalPath})`);
  error.status = 404;
  return error;
}

// Minimal filesystem-backed `globalThis.space` runtime: the spaces storage module
// only needs the `~/`-rooted file api plus YAML, and backing it with real files is
// what lets the suite assert on the directories actually created.
function createSpaceRuntime(userHome) {
  function toAbsolutePath(logicalPath) {
    const rawPath = String(logicalPath || "");

    if (!rawPath.startsWith("~/")) {
      throw new Error(`Unsupported space path in test runtime: ${rawPath}`);
    }

    return path.join(userHome, rawPath.slice(2));
  }

  function writeEntry(entry) {
    const absolutePath = toAbsolutePath(entry.path);

    if (String(entry.path).endsWith("/")) {
      fs.mkdirSync(absolutePath, { recursive: true });
      return { path: entry.path };
    }

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, String(entry.content ?? ""), "utf8");
    return { content: String(entry.content ?? ""), path: entry.path };
  }

  function readEntry(entry) {
    // The real runtime batch shape passes path strings, not `{ path }` objects.
    const logicalPath = typeof entry === "string" ? entry : entry.path;
    const absolutePath = toAbsolutePath(logicalPath);

    if (!fs.existsSync(absolutePath)) {
      throw notFoundError(logicalPath);
    }

    return { content: fs.readFileSync(absolutePath, "utf8"), path: logicalPath };
  }

  return {
    api: {
      async fileCopy(entries) {
        const list = Array.isArray(entries) ? entries : [entries];

        for (const entry of list) {
          fs.cpSync(toAbsolutePath(entry.fromPath), toAbsolutePath(entry.toPath), { recursive: true });
        }

        return {};
      },
      async fileDelete(target) {
        const list = Array.isArray(target) ? target : [target];

        for (const entry of list) {
          const logicalPath = typeof entry === "string" ? entry : entry.path;
          fs.rmSync(toAbsolutePath(logicalPath), { force: true, recursive: true });
        }

        return {};
      },
      async fileInfo(logicalPath) {
        const absolutePath = toAbsolutePath(logicalPath);

        if (!fs.existsSync(absolutePath)) {
          throw notFoundError(logicalPath);
        }

        return { path: logicalPath };
      },
      async fileList(logicalPath, recursive = false) {
        const absolutePath = toAbsolutePath(logicalPath);

        if (!fs.existsSync(absolutePath)) {
          throw notFoundError(logicalPath);
        }

        const basePath = String(logicalPath).endsWith("/") ? logicalPath : `${logicalPath}/`;
        const output = [];

        function walk(directoryAbsolutePath, currentLogicalPath) {
          for (const entry of fs.readdirSync(directoryAbsolutePath, { withFileTypes: true })) {
            const childAbsolutePath = path.join(directoryAbsolutePath, entry.name);
            const childLogicalPath = `${currentLogicalPath}${entry.name}${entry.isDirectory() ? "/" : ""}`;

            output.push(childLogicalPath);

            if (recursive && entry.isDirectory()) {
              walk(childAbsolutePath, childLogicalPath);
            }
          }
        }

        walk(absolutePath, basePath);
        return { paths: output };
      },
      async fileRead(target) {
        if (typeof target === "string") {
          return readEntry({ path: target });
        }

        if (Array.isArray(target?.files)) {
          return {
            files: target.files.map((entry) => readEntry(entry))
          };
        }

        return readEntry(target);
      },
      async fileWrite(target) {
        if (typeof target === "string") {
          fs.mkdirSync(toAbsolutePath(target), { recursive: true });
          return {};
        }

        if (Array.isArray(target?.files)) {
          return { files: target.files.map((entry) => writeEntry(entry)) };
        }

        return writeEntry(target);
      }
    },
    utils: {
      yaml: {
        parse(sourceText) {
          return parseSimpleYaml(sourceText);
        },
        stringify(source) {
          return serializeSimpleYaml(source);
        }
      }
    }
  };
}

const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "space-title-length-"));
globalThis.space = createSpaceRuntime(userHome);

const storage = await import("../app/L0/_all/modules/_core/spaces/storage.js");
const constants = await import("../app/L0/_all/modules/_core/spaces/constants.js");

test.after(() => {
  fs.rmSync(userHome, { force: true, recursive: true });
});

test("the shared id cap is exported from the spaces constants", () => {
  assert.equal(typeof constants.SPACE_ID_MAX_LENGTH, "number");
  assert.ok(constants.SPACE_ID_MAX_LENGTH > 0);
  assert.ok(constants.SPACE_ID_MAX_LENGTH < NAME_MAX_BYTES);
});

test("createSpace caps the derived directory id and keeps the full display title", async () => {
  const manifest = await storage.createSpace({ title: LONG_TITLE });

  assert.ok(manifest.id.length <= constants.SPACE_ID_MAX_LENGTH, `id too long: ${manifest.id.length}`);
  assert.equal(manifest.id.length, constants.SPACE_ID_MAX_LENGTH);
  assert.doesNotMatch(manifest.id, /^-|-$/u);

  // Display text is never capped.
  assert.equal(manifest.title, LONG_TITLE);

  const spaceRootPath = path.join(userHome, "spaces", manifest.id);
  assert.equal(fs.existsSync(spaceRootPath), true);

  const manifestText = fs.readFileSync(path.join(spaceRootPath, "space.yaml"), "utf8");
  const parsedManifest = parseSimpleYaml(manifestText);
  assert.equal(parsedManifest.title, LONG_TITLE);
  assert.equal(parsedManifest.id, manifest.id);
});

test("duplicate and over-capped titles still derive distinct ids through the suffix path", async () => {
  const first = await storage.createSpace({ title: "beach" });
  const duplicate = await storage.createSpace({ title: "beach" });

  assert.equal(first.id, "beach");
  assert.equal(duplicate.id, "beach-2");

  // Two spaces sharing an over-long title collide on the capped base id, so the
  // suffix has to be appended AFTER the cap. This is why the cap leaves headroom.
  const collisionTitle = `Suffix collision space ${LONG_TITLE}`;
  const cappedFirst = await storage.createSpace({ title: collisionTitle });
  const cappedSecond = await storage.createSpace({ title: collisionTitle });

  assert.ok(cappedFirst.id.length <= constants.SPACE_ID_MAX_LENGTH);
  assert.equal(cappedSecond.id, `${cappedFirst.id}-2`);
  assert.notEqual(cappedSecond.id, cappedFirst.id);
  // Base cap + suffix must still be a legal single path component.
  assert.ok(Buffer.byteLength(cappedSecond.id, "utf8") < NAME_MAX_BYTES);

  assert.equal(fs.existsSync(path.join(userHome, "spaces", cappedFirst.id)), true);
  assert.equal(fs.existsSync(path.join(userHome, "spaces", cappedSecond.id)), true);
});

test("installExampleSpace caps the id derived from an over-long title", async () => {
  const sourcePath = "~/templates/example-space/";
  const sourceRoot = path.join(userHome, "templates", "example-space");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "space.yaml"),
    serializeSimpleYaml({ id: "example-space", schema: "spaces/v2", title: "Example Space" }),
    "utf8"
  );

  const installTitle = `Installed example space ${LONG_TITLE}`;
  const installed = await storage.installExampleSpace({ sourcePath, title: installTitle });

  assert.ok(installed.id.length <= constants.SPACE_ID_MAX_LENGTH, `id too long: ${installed.id.length}`);
  assert.equal(installed.title, installTitle);
  assert.equal(fs.existsSync(path.join(userHome, "spaces", installed.id)), true);
});

test("widget ids derived from an over-long title are capped while the widget name is not", async () => {
  const space = await storage.createSpace({ title: "widget host" });
  const result = await storage.upsertWidget({
    html: '<div class="demo"></div>',
    spaceId: space.id,
    title: LONG_WIDGET_TITLE
  });

  assert.ok(
    result.widgetId.length <= constants.SPACE_ID_MAX_LENGTH,
    `widget id too long: ${result.widgetId.length}`
  );
  assert.equal(result.widgetId.length, constants.SPACE_ID_MAX_LENGTH);

  const widgetFilePath = path.join(userHome, "spaces", space.id, "widgets", `${result.widgetId}.yaml`);
  assert.equal(fs.existsSync(widgetFilePath), true);

  const widgetYaml = parseSimpleYaml(fs.readFileSync(widgetFilePath, "utf8"));
  assert.equal(widgetYaml.name, LONG_WIDGET_TITLE);
  assert.equal(widgetYaml.id, result.widgetId);
});

test("file_write to an over-long final path component answers 4xx, not a raw 500", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "space-long-path-write-"));
  const runtimeParams = createStaticRuntimeParams({ CUSTOMWARE_PATH: "", SINGLE_USER_APP: false });
  const overLongName = "x".repeat(NAME_MAX_BYTES + 45);

  try {
    assert.throws(
      () =>
        writeAppFiles({
          files: [{ content: "too long\n", path: `~/${overLongName}` }],
          projectRoot,
          runtimeParams,
          username: "alice",
          watchdog: createWatchdog()
        }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "ENAMETOOLONG");
        assert.match(error.message, /too long/iu);
        assert.match(error.message, new RegExp(`x{${NAME_MAX_BYTES}}`, "u"));
        return true;
      }
    );

    // The failing write left nothing behind.
    assert.equal(fs.existsSync(path.join(projectRoot, "app", "L2", "alice", overLongName)), false);
  } finally {
    fs.rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("the same mapping is wired at the copy boundary, not only the write boundary", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "space-long-copy-"));
  const runtimeParams = createStaticRuntimeParams({ CUSTOMWARE_PATH: "", SINGLE_USER_APP: false });
  const overLongName = "y".repeat(NAME_MAX_BYTES + 45);

  try {
    writeAppFile({
      content: "source\n",
      path: "~/source.txt",
      projectRoot,
      runtimeParams,
      username: "alice",
      watchdog: createWatchdog()
    });

    // The index is built after the source exists, as the real watchdog would have it.
    const watchdog = createDiskWatchdog(projectRoot);

    assert.throws(
      () =>
        copyAppPath({
          fromPath: "~/source.txt",
          projectRoot,
          runtimeParams,
          toPath: `~/${overLongName}`,
          username: "alice",
          watchdog
        }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "ENAMETOOLONG");
        assert.match(error.message, /too long/iu);
        return true;
      }
    );

    // The refused copy left no destination behind and the source is intact.
    assert.equal(fs.existsSync(path.join(projectRoot, "app", "L2", "alice", overLongName)), false);
    assert.equal(
      fs.readFileSync(path.join(projectRoot, "app", "L2", "alice", "source.txt"), "utf8"),
      "source\n"
    );
  } finally {
    fs.rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("a normal write through the same boundary still succeeds", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "space-normal-write-"));
  const runtimeParams = createStaticRuntimeParams({ CUSTOMWARE_PATH: "", SINGLE_USER_APP: false });

  try {
    writeAppFile({
      content: "fine\n",
      path: "~/notes.txt",
      projectRoot,
      runtimeParams,
      username: "alice",
      watchdog: createWatchdog()
    });

    assert.equal(
      fs.readFileSync(path.join(projectRoot, "app", "L2", "alice", "notes.txt"), "utf8"),
      "fine\n"
    );
  } finally {
    fs.rmSync(projectRoot, { force: true, recursive: true });
  }
});

test("the filesystem mapper uses the documented status table", () => {
  const projectRoot = path.join(os.tmpdir(), "space-mapper-root");
  const targetPath = path.join(projectRoot, "app", "L2", "alice", "notes.txt");

  function createFsError(code, errorPath) {
    const error = new Error(`${code}: simulated, open '${errorPath}'`);
    error.code = code;
    error.path = errorPath;
    return error;
  }

  const cases = [
    ["ENAMETOOLONG", 400],
    ["EACCES", 403],
    ["EPERM", 403],
    ["ENOSPC", 507],
    ["EMFILE", 500],
    ["ENFILE", 500]
  ];

  for (const [code, expectedStatus] of cases) {
    const mapped = mapFilesystemErrorToHttpError(createFsError(code, targetPath), {
      projectRoot,
      requestedAbsolutePath: targetPath,
      requestedPath: "~/notes.txt"
    });

    if (expectedStatus === 500) {
      assert.equal(mapped.statusCode, undefined, `${code} must stay unmapped`);
    } else {
      assert.equal(mapped.statusCode, expectedStatus, `${code} mapped wrong`);
    }
  }

  // The raw OS wording survives, which is what makes the failure legible.
  const renamed = mapFilesystemErrorToHttpError(createFsError("ENAMETOOLONG", targetPath), {
    projectRoot,
    requestedAbsolutePath: targetPath,
    requestedPath: "~/notes.txt"
  });
  assert.match(renamed.message, /ENAMETOOLONG/u);
  assert.match(renamed.message, /Entry name too long/iu);

  // A permission failure on the project root itself is operator configuration and
  // must stay a 500 instead of blaming the caller.
  const rootFailure = mapFilesystemErrorToHttpError(createFsError("EACCES", projectRoot), {
    projectRoot,
    requestedAbsolutePath: targetPath,
    requestedPath: "~/notes.txt"
  });
  assert.equal(rootFailure.statusCode, undefined);
});
