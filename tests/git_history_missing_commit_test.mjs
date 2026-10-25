import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as diffEndpoint from "../server/api/git_history_diff.js";
import * as previewEndpoint from "../server/api/git_history_preview.js";
import * as revertEndpoint from "../server/api/git_history_revert.js";
import * as rollbackEndpoint from "../server/api/git_history_rollback.js";
import { writeAppFile } from "../server/lib/customware/file_access.js";
import { flushGitHistoryCommits } from "../server/lib/customware/git_history.js";

/**
 * Regression coverage for BUG-004: asking Git history about a commit the
 * repository does not contain is a missing resource, not a server fault.
 *
 * Before the fix both resolvers threw a bare `Error` with no `statusCode`, so
 * rollback, revert, preview, and diff all answered a redacted 500. A user hits
 * this through the UI every time the time-travel list holds a stale hash after
 * another rollback rewrote HEAD.
 *
 * The four endpoints are exercised through their real `post()` handlers, which
 * is what proves they inherit the status: their local
 * `rethrowGitHistoryHttpError` reads `error.statusCode` and defaults to 500.
 *
 * Malformed input ("banana") stays distinct from an unknown commit: 400 vs 404.
 */

const UNKNOWN_COMMIT = "a".repeat(40);
const MALFORMED_COMMIT = "banana";

function createRuntimeParams(values = {}) {
  return {
    get(name, fallback = undefined) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
    }
  };
}

function runGit(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function readRepositoryState(repoRoot) {
  return {
    head: runGit(repoRoot, ["rev-parse", "HEAD"]),
    commitCount: runGit(repoRoot, ["rev-list", "--count", "HEAD"]),
    log: runGit(repoRoot, ["log", "--format=%H %s"]),
    status: runGit(repoRoot, ["status", "--porcelain"])
  };
}

function createEndpointContext({ body, projectRoot, runtimeParams, username = "alice" }) {
  return {
    body,
    mutationSync: {
      async commitProjectPaths() {
        return undefined;
      }
    },
    params: {},
    projectRoot,
    runtimeParams,
    user: { username }
  };
}

async function expectCallFailure(callback) {
  try {
    await callback();
  } catch (error) {
    return error;
  }

  throw new Error("Expected the history call to fail, but it resolved.");
}

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "space-git-history-missing-commit-"));
const nativeRuntimeParams = createRuntimeParams({
  CUSTOMWARE_GIT_HISTORY: true,
  CUSTOMWARE_PATH: "",
  SINGLE_USER_APP: false
});
const isomorphicRuntimeParams = createRuntimeParams({
  CUSTOMWARE_GIT_HISTORY: true,
  CUSTOMWARE_PATH: "",
  GIT_BACKEND: "isomorphic",
  SINGLE_USER_APP: false
});

const userRepoRoot = path.join(projectRoot, "app", "L2", "alice");

test.before(async () => {
  writeAppFile({
    content: "one\n",
    path: "~/notes.txt",
    projectRoot,
    runtimeParams: nativeRuntimeParams,
    username: "alice"
  });

  const flushed = await flushGitHistoryCommits({ throwOnError: true });
  assert.ok(Array.isArray(flushed));
  assert.equal(fs.existsSync(path.join(userRepoRoot, ".git")), true);
});

test.after(() => {
  fs.rmSync(projectRoot, { force: true, recursive: true });
});

const ENDPOINTS = [
  ["rollback", rollbackEndpoint],
  ["revert", revertEndpoint],
  ["preview", previewEndpoint],
  ["diff", diffEndpoint]
];

const BACKENDS = [
  ["native", nativeRuntimeParams],
  ["isomorphic", isomorphicRuntimeParams]
];

for (const [backendLabel, runtimeParams] of BACKENDS) {
  for (const [operationLabel, endpoint] of ENDPOINTS) {
    test(`${backendLabel} ${operationLabel} answers 404 for a well-formed unknown commit`, async () => {
      const before = readRepositoryState(userRepoRoot);
      const error = await expectCallFailure(() =>
        endpoint.post(
          createEndpointContext({
            body: { commitHash: UNKNOWN_COMMIT, path: "~" },
            projectRoot,
            runtimeParams
          })
        )
      );

      // The endpoint rethrow helper preserves the resolver statusCode instead of
      // collapsing it to a 500.
      assert.equal(error.statusCode, 404);
      assert.match(error.message, /Git history commit not found/iu);
      assert.match(error.message, new RegExp(UNKNOWN_COMMIT, "u"));

      // A failed request must not touch the repository.
      assert.deepEqual(readRepositoryState(userRepoRoot), before);
    });
  }

  for (const [operationLabel, endpoint] of ENDPOINTS) {
    test(`${backendLabel} ${operationLabel} answers 400 for a malformed commit hash`, async () => {
      const before = readRepositoryState(userRepoRoot);
      const error = await expectCallFailure(() =>
        endpoint.post(
          createEndpointContext({
            body: { commitHash: MALFORMED_COMMIT, path: "~" },
            projectRoot,
            runtimeParams
          })
        )
      );

      assert.equal(error.statusCode, 400);
      assert.match(error.message, /A valid Git commit hash is required/u);
      // Malformed input is a distinct user mistake from an unknown commit.
      assert.notEqual(error.statusCode, 404);

      assert.deepEqual(readRepositoryState(userRepoRoot), before);
    });
  }
}

test("a known commit still works, so the 404 is not a blanket rejection", async () => {
  const head = runGit(userRepoRoot, ["rev-parse", "HEAD"]);
  const response = await diffEndpoint.post(
    createEndpointContext({
      body: { commitHash: head, filePath: "notes.txt", path: "~" },
      projectRoot,
      runtimeParams: nativeRuntimeParams
    })
  );

  assert.ok(response);
  assert.equal(response.path, "L2/alice/");
});

test("the malformed-hash rejection happens before any repository access", async () => {
  // Guard the ordering the fix relies on: invalid shape is a 400 from the shared
  // validator, so it never reaches a backend that would have reported 404.
  const error = await expectCallFailure(() =>
    rollbackEndpoint.post(
      createEndpointContext({
        body: { commitHash: MALFORMED_COMMIT, path: "~" },
        projectRoot,
        runtimeParams: nativeRuntimeParams
      })
    )
  );

  assert.equal(error.statusCode, 400);
  assert.doesNotMatch(error.message, /commit not found/iu);
});
