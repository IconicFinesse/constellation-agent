import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  copyAppPath,
  copyAppPaths,
  moveAppPath,
  writeAppFile
} from "../server/lib/customware/file_access.js";
import { clearUserFolderSizeCache } from "../server/lib/customware/user_quota.js";

/**
 * Regression coverage for directory copies that used to poison their destination.
 *
 * Root cause: `copyAbsolutePath()` passed `errorOnExist: true` to `fs.cpSync` for
 * every copy, and directory destinations reach it with a trailing separator (that is
 * how `normalizeAppProjectPath()` marks a directory). On Node 24 that combination is
 * rejected by `cpSync`'s `onDir()` guard with `ERR_FS_CP_EEXIST` even when the
 * destination does not exist yet, because `cpSync` creates the destination directory
 * before it runs that check. Node 22 and older merged silently instead.
 *
 * Two consequences this suite pins: a plain directory copy fails on Node 24, and every
 * failed attempt leaves the empty directory `cpSync` created behind, so later attempts
 * hit an existing destination as well. The index guard cannot see any of that, because
 * it only consults the watchdog path index.
 *
 * These cases pin the disk-aware contract: absent destination copies, an existing
 * empty directory is replaced, a non-empty directory or a file is a 409 conflict
 * that stays untouched, single-file overwrites stay refused, and a failed copy
 * leaves no destination behind.
 */

const USERNAME = "alice";

function createStaticRuntimeParams(values = {}) {
  return {
    get(name, fallback = undefined) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
    }
  };
}

function collectProjectPaths(projectRoot) {
  const appRoot = path.join(projectRoot, "app");
  const output = [];

  function walk(absolutePath) {
    if (!fs.existsSync(absolutePath)) {
      return;
    }

    const stats = fs.statSync(absolutePath);
    const relativePath = path.relative(appRoot, absolutePath).replaceAll(path.sep, "/");
    const projectPath = relativePath
      ? `/app/${relativePath}${stats.isDirectory() ? "/" : ""}`
      : "/app/";

    output.push(projectPath);

    if (!stats.isDirectory()) {
      return;
    }

    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      walk(path.join(absolutePath, entry.name));
    }
  }

  walk(appRoot);
  return output.sort((left, right) => left.localeCompare(right));
}

// A real watchdog-shaped snapshot of the current tree. Copy validation consults this
// index, so a snapshot taken *before* a destination appears reproduces the reported
// stale-index case instead of being rejected by the index guard.
function createWatchdog(projectRoot) {
  const paths = collectProjectPaths(projectRoot);
  const pathIndex = Object.create(null);
  const appRoot = path.join(projectRoot, "app");

  for (const projectPath of paths) {
    const isDirectory = projectPath.endsWith("/");
    const relativePath = projectPath
      .slice("/app/".length)
      .replace(/\/$/u, "")
      .replaceAll("/", path.sep);
    const absolutePath = relativePath ? path.join(appRoot, relativePath) : appRoot;
    const stats = fs.statSync(absolutePath);

    pathIndex[projectPath] = {
      isDirectory,
      mtimeMs: Math.trunc(Number(stats.mtimeMs || 0)),
      sizeBytes: isDirectory ? 0 : Number(stats.size || 0)
    };
  }

  return {
    getIndex(name) {
      return name === "path_index" ? pathIndex : Object.create(null);
    },
    getPaths() {
      return [...paths];
    }
  };
}

function userAbsolutePath(projectRoot, relativePath = "") {
  return path.join(projectRoot, "app", "L2", USERNAME, relativePath);
}

function createProjectRoot() {
  clearUserFolderSizeCache();
  return fs.mkdtempSync(path.join(os.tmpdir(), "space-file-copy-directory-"));
}

// Writes one source tree plus the user root, the way a real onboarding copy has a
// template folder and an existing ~/spaces/ parent.
function createCopyFixture() {
  const projectRoot = createProjectRoot();
  const runtimeParams = createStaticRuntimeParams({ USER_FOLDER_SIZE_LIMIT_BYTES: 0 });

  writeAppFile({
    path: "~/spaces/",
    projectRoot,
    runtimeParams,
    username: USERNAME,
    watchdog: createWatchdog(projectRoot)
  });
  writeAppFile({
    content: "schema: 1\nid: demo\n",
    path: "~/templates/demo/space.yaml",
    projectRoot,
    runtimeParams,
    username: USERNAME,
    watchdog: createWatchdog(projectRoot)
  });
  writeAppFile({
    content: "schema: 1\nid: w1\n",
    path: "~/templates/demo/widgets/w1.yaml",
    projectRoot,
    runtimeParams,
    username: USERNAME,
    watchdog: createWatchdog(projectRoot)
  });

  return { projectRoot, runtimeParams };
}

function readTree(absoluteRoot) {
  const output = [];

  function walk(absolutePath, relativePath) {
    const stats = fs.statSync(absolutePath);

    if (!stats.isDirectory()) {
      output.push(relativePath);
      return;
    }

    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      walk(path.join(absolutePath, entry.name), relativePath ? `${relativePath}/${entry.name}` : entry.name);
    }
  }

  walk(absoluteRoot, "");
  return output.sort((left, right) => left.localeCompare(right));
}

// Two guards answer a copy conflict, in this order: the pre-existing path-index
// guard (a 4xx before any disk work) and the disk-aware layer added here (409).
// Indexed conflicts keep the index guard's status; disk-only conflicts, the ones the
// index cannot see, must be the explicit 409 that names the destination.
function assertConflictError(callback, destinationLabel, { expectedStatusCode = 409 } = {}) {
  assert.throws(callback, (error) => {
    if (expectedStatusCode === "client-error") {
      const statusCode = Number(error.statusCode);
      assert.ok(
        statusCode >= 400 && statusCode < 500,
        `expected a 4xx conflict, got ${statusCode}: ${error.message}`
      );
    } else {
      assert.equal(error.statusCode, expectedStatusCode);
    }

    assert.match(error.message, /Destination/u);
    assert.ok(
      error.message.includes(destinationLabel),
      `expected the conflict to name ${destinationLabel}, got: ${error.message}`
    );
    return true;
  });
}

function cleanup(projectRoot) {
  clearUserFolderSizeCache();
  fs.rmSync(projectRoot, { force: true, recursive: true });
}

test("directory copy into an absent destination succeeds", () => {
  const { projectRoot, runtimeParams } = createCopyFixture();
  const watchdog = createWatchdog(projectRoot);

  const result = copyAppPath({
    fromPath: "~/templates/demo/",
    toPath: "~/spaces/fresh/",
    projectRoot,
    runtimeParams,
    username: USERNAME,
    watchdog
  });

  assert.deepEqual(result, {
    fromPath: "L2/alice/templates/demo/",
    toPath: "L2/alice/spaces/fresh/"
  });
  assert.deepEqual(readTree(userAbsolutePath(projectRoot, "spaces/fresh")), [
    "space.yaml",
    "widgets/w1.yaml"
  ]);
  assert.equal(
    fs.readFileSync(userAbsolutePath(projectRoot, "spaces/fresh/widgets/w1.yaml"), "utf8"),
    "schema: 1\nid: w1\n"
  );
  cleanup(projectRoot);
});

test("directory copy into a leftover empty destination succeeds", () => {
  const { projectRoot, runtimeParams } = createCopyFixture();
  const watchdog = createWatchdog(projectRoot); // snapshot BEFORE the leftover exists
  const destinationPath = userAbsolutePath(projectRoot, "spaces/leftover");

  fs.mkdirSync(destinationPath);
  assert.deepEqual(fs.readdirSync(destinationPath), []);

  const result = copyAppPath({
    fromPath: "~/templates/demo/",
    toPath: "~/spaces/leftover/",
    projectRoot,
    runtimeParams,
    username: USERNAME,
    watchdog
  });

  assert.deepEqual(result, {
    fromPath: "L2/alice/templates/demo/",
    toPath: "L2/alice/spaces/leftover/"
  });
  assert.deepEqual(readTree(destinationPath), [
    "space.yaml",
    "widgets/w1.yaml"
  ]);
  cleanup(projectRoot);
});

// 2b. The watchdog may already have indexed the leftover; the copy contract must not
// depend on index freshness, so an indexed empty destination copies too.
test("directory copy into an indexed empty destination succeeds", () => {
  const { projectRoot, runtimeParams } = createCopyFixture();
  const destinationPath = userAbsolutePath(projectRoot, "spaces/indexed-empty");

  fs.mkdirSync(destinationPath);

  const watchdog = createWatchdog(projectRoot); // snapshot AFTER the leftover exists
  assert.ok(
    watchdog.getIndex("path_index")["L2/alice/spaces/indexed-empty/"] ||
      watchdog.getPaths().some((entry) => entry.endsWith("spaces/indexed-empty/")),
    "the fixture must make the leftover visible to the index guard"
  );

  const result = copyAppPath({
    fromPath: "~/templates/demo/",
    toPath: "~/spaces/indexed-empty/",
    projectRoot,
    runtimeParams,
    username: USERNAME,
    watchdog
  });

  assert.deepEqual(result, {
    fromPath: "L2/alice/templates/demo/",
    toPath: "L2/alice/spaces/indexed-empty/"
  });
  assert.deepEqual(readTree(destinationPath), [
    "space.yaml",
    "widgets/w1.yaml"
  ]);
  cleanup(projectRoot);
});

test("directory copy into a non-empty destination is a conflict", () => {
  const { projectRoot, runtimeParams } = createCopyFixture();

  writeAppFile({
    content: "keep-me\n",
    path: "~/spaces/taken/space.yaml",
    projectRoot,
    runtimeParams,
    username: USERNAME,
    watchdog: createWatchdog(projectRoot)
  });

  const watchdog = createWatchdog(projectRoot);
  const destinationPath = userAbsolutePath(projectRoot, "spaces/taken");

  assertConflictError(
    () =>
      copyAppPath({
        fromPath: "~/templates/demo/",
        toPath: "~/spaces/taken/",
        projectRoot,
        runtimeParams,
        username: USERNAME,
        watchdog
      }),
    "L2/alice/spaces/taken/"
  );

  assert.deepEqual(fs.readdirSync(destinationPath), ["space.yaml"]);
  assert.equal(fs.readFileSync(path.join(destinationPath, "space.yaml"), "utf8"), "keep-me\n");
  cleanup(projectRoot);
});

test("directory copy onto an existing file is a conflict", () => {
  const { projectRoot, runtimeParams } = createCopyFixture();
  const watchdog = createWatchdog(projectRoot);
  const destinationPath = userAbsolutePath(projectRoot, "spaces/blocked");

  fs.writeFileSync(destinationPath, "i am not a folder\n");

  assertConflictError(
    () =>
      copyAppPath({
        fromPath: "~/templates/demo/",
        toPath: "~/spaces/blocked/",
        projectRoot,
        runtimeParams,
        username: USERNAME,
        watchdog
      }),
    "L2/alice/spaces/blocked/"
  );

  assert.equal(fs.readFileSync(destinationPath, "utf8"), "i am not a folder\n");
  cleanup(projectRoot);
});

test("single-file copy onto an existing file is refused", () => {
  const { projectRoot, runtimeParams } = createCopyFixture();

  writeAppFile({
    content: "original\n",
    path: "~/spaces/existing.yaml",
    projectRoot,
    runtimeParams,
    username: USERNAME,
    watchdog: createWatchdog(projectRoot)
  });

  assert.throws(
    () =>
      copyAppPath({
        fromPath: "~/templates/demo/space.yaml",
        toPath: "~/spaces/existing.yaml",
        projectRoot,
        runtimeParams,
        username: USERNAME,
        watchdog: createWatchdog(projectRoot)
      }),
    (error) => {
      assert.ok(Number(error.statusCode) >= 400 && Number(error.statusCode) < 500);
      assert.match(error.message, /existing\.yaml/u);
      return true;
    }
  );

  assert.equal(
    fs.readFileSync(userAbsolutePath(projectRoot, "spaces/existing.yaml"), "utf8"),
    "original\n"
  );
  cleanup(projectRoot);
});

test("single-file copy onto a disk-only file is a conflict", () => {
  const { projectRoot, runtimeParams } = createCopyFixture();
  const watchdog = createWatchdog(projectRoot);
  const destinationPath = userAbsolutePath(projectRoot, "spaces/late.yaml");

  fs.writeFileSync(destinationPath, "late original\n");

  assertConflictError(
    () =>
      copyAppPath({
        fromPath: "~/templates/demo/space.yaml",
        toPath: "~/spaces/late.yaml",
        projectRoot,
        runtimeParams,
        username: USERNAME,
        watchdog
      }),
    "L2/alice/spaces/late.yaml"
  );

  assert.equal(fs.readFileSync(destinationPath, "utf8"), "late original\n");
  cleanup(projectRoot);
});

test("a failed copy leaves no destination directory behind", () => {
  const { projectRoot, runtimeParams } = createCopyFixture();
  const watchdog = createWatchdog(projectRoot);
  const destinationPath = userAbsolutePath(projectRoot, "spaces/interrupted");
  const realCopy = fs.cpSync;
  let injected = false;

  // The failure must happen after Node has created the destination, otherwise the
  // leftover assert is vacuous. Filtering on the first child does exactly that.
  fs.cpSync = (source, destination, options = {}) =>
    realCopy(source, destination, {
      ...options,
      filter: (candidate) => {
        if (candidate === source || candidate === destination) {
          return true;
        }

        if (!injected) {
          injected = true;
          throw new Error("injected mid-copy failure");
        }

        return true;
      }
    });

  try {
    assert.throws(
      () =>
        copyAppPath({
          fromPath: "~/templates/demo/",
          toPath: "~/spaces/interrupted/",
          projectRoot,
          runtimeParams,
          username: USERNAME,
          watchdog
        }),
      /injected mid-copy failure/u
    );
  } finally {
    fs.cpSync = realCopy;
    clearUserFolderSizeCache();
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(destinationPath), false);
  cleanup(projectRoot);
});

test("a failing batch surfaces and leaves no empty leftovers", () => {
  const { projectRoot, runtimeParams } = createCopyFixture();

  // A batch may not repeat one source, so the failing entry gets its own tree.
  writeAppFile({
    content: "schema: 1\nid: other\n",
    path: "~/templates/other/space.yaml",
    projectRoot,
    runtimeParams,
    username: USERNAME,
    watchdog: createWatchdog(projectRoot)
  });

  const watchdog = createWatchdog(projectRoot);
  const firstDestination = userAbsolutePath(projectRoot, "spaces/batch-first");
  const failedDestination = userAbsolutePath(projectRoot, "spaces/batch-second");
  const realCopy = fs.cpSync;

  fs.cpSync = (source, destination, options = {}) => {
    // Directory destinations keep a trailing separator, so compare the stripped path.
    if (String(destination).replace(/[\\/]+$/u, "").endsWith("batch-second")) {
      return realCopy(source, destination, {
        ...options,
        filter: (candidate) => {
          if (candidate === source || candidate === destination) {
            return true;
          }

          throw new Error("injected batch failure");
        }
      });
    }

    return realCopy(source, destination, options);
  };

  try {
    assert.throws(
      () =>
        copyAppPaths({
          entries: [
            { fromPath: "~/templates/demo/", toPath: "~/spaces/batch-first/" },
            { fromPath: "~/templates/other/", toPath: "~/spaces/batch-second/" }
          ],
          projectRoot,
          runtimeParams,
          username: USERNAME,
          watchdog
        }),
      /injected batch failure/u
    );
  } finally {
    fs.cpSync = realCopy;
    clearUserFolderSizeCache();
  }

  assert.deepEqual(readTree(firstDestination), ["space.yaml", "widgets/w1.yaml"]);
  assert.equal(fs.existsSync(failedDestination), false);
  cleanup(projectRoot);
});

// 7. A move that falls back to copy across devices inherits the same protection.
test("the EXDEV move fallback inherits the copy destination protection", () => {
  const { projectRoot, runtimeParams } = createCopyFixture();

  writeAppFile({
    content: "schema: 1\nid: other\n",
    path: "~/templates/other/space.yaml",
    projectRoot,
    runtimeParams,
    username: USERNAME,
    watchdog: createWatchdog(projectRoot)
  });

  const emptyDestination = userAbsolutePath(projectRoot, "spaces/moved-empty");
  const takenDestination = userAbsolutePath(projectRoot, "spaces/moved-taken");
  const watchdog = createWatchdog(projectRoot);

  // Disk-only content: the index cannot see it, so the guard defers and the fallback
  // copy layer is the only thing standing between the move and the existing folder.
  fs.mkdirSync(takenDestination);
  fs.writeFileSync(path.join(takenDestination, "space.yaml"), "keep-me\n");

  const realRenameSync = fs.renameSync;

  // Force the EXDEV branch of moveAbsolutePath(): the fallback copy must not merge
  // into existing content and must not be tripped by an empty destination.
  fs.renameSync = () => {
    const error = new Error("cross-device link not permitted");
    error.code = "EXDEV";
    throw error;
  };

  try {
    // 7a. empty destination: the fallback copy replaces it and the source is removed
    const moved = moveAppPath({
      fromPath: "~/templates/demo/",
      toPath: "~/spaces/moved-empty/",
      projectRoot,
      runtimeParams,
      username: USERNAME,
      watchdog
    });

    assert.deepEqual(moved, {
      fromPath: "L2/alice/templates/demo/",
      toPath: "L2/alice/spaces/moved-empty/"
    });
    assert.deepEqual(readTree(emptyDestination), ["space.yaml", "widgets/w1.yaml"]);
    assert.equal(fs.existsSync(userAbsolutePath(projectRoot, "templates/demo")), false);

    // 7b. non-empty destination: the fallback copy is a conflict and nothing moves
    assertConflictError(
      () =>
        moveAppPath({
          fromPath: "~/templates/other/",
          toPath: "~/spaces/moved-taken/",
          projectRoot,
          runtimeParams,
          username: USERNAME,
          // The stale snapshot keeps the index guard out of the way so the EXDEV
          // fallback copy is the layer that has to refuse the existing content.
          watchdog
        }),
      "L2/alice/spaces/moved-taken/"
    );

    assert.deepEqual(fs.readdirSync(takenDestination), ["space.yaml"]);
    assert.equal(fs.readFileSync(path.join(takenDestination, "space.yaml"), "utf8"), "keep-me\n");
    // A refused move must not consume its source either.
    assert.equal(fs.existsSync(userAbsolutePath(projectRoot, "templates/other")), true);
  } finally {
    fs.renameSync = realRenameSync;
    clearUserFolderSizeCache();
  }

  cleanup(projectRoot);
});
