import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  buildHistoryFilterPathspecs,
  buildBasicAuthHeader,
  COMMIT_HASH_PATTERN,
  createAvailableBackendResult,
  createUnavailableBackendResult,
  filterHistoryChangedFiles,
  filterHistoryFileEntries,
  getHistoryChangedFilePaths,
  normalizeGitRelativePath,
  normalizeHistoryIgnoredPaths,
  sanitizeRemoteUrl
} from "./shared.js";

const nativeLocalHistoryRepoQueues = new Map();

function createGitError(args, stderr, stdout) {
  const message = String(stderr || stdout || "git command failed").trim();
  return new Error(`git ${args.join(" ")} failed: ${message}`);
}

function runGit(projectRoot, args, { check = true, cwd = projectRoot } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    throw result.error;
  }

  if (check && result.status !== 0) {
    throw createGitError(args, result.stderr, result.stdout);
  }

  return result;
}

function runGitAsync(projectRoot, args, { check = true, cwd = projectRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (status) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const result = {
        status: Number.isInteger(status) ? status : 1,
        stderr,
        stdout
      };

      if (check && result.status !== 0) {
        reject(createGitError(args, result.stderr, result.stdout));
        return;
      }

      resolve(result);
    });
  });
}

function readGit(projectRoot, args, options) {
  return runGit(projectRoot, args, options).stdout.trim();
}

function tryReadGit(projectRoot, args, options) {
  const result = runGit(projectRoot, args, {
    ...options,
    check: false
  });

  return result.status === 0 ? result.stdout.trim() : null;
}

async function readGitAsync(projectRoot, args, options) {
  const result = await runGitAsync(projectRoot, args, options);
  return result.stdout.trim();
}

async function tryReadGitAsync(projectRoot, args, options) {
  const result = await runGitAsync(projectRoot, args, {
    ...options,
    check: false
  });

  return result.status === 0 ? result.stdout.trim() : null;
}

function readNativeGitAvailability(cwd) {
  const versionResult = spawnSync("git", ["--version"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (versionResult.error) {
    if (versionResult.error.code === "ENOENT") {
      return {
        available: false,
        reason: "native git is not installed or not on PATH"
      };
    }

    return {
      available: false,
      reason: versionResult.error.message
    };
  }

  if (versionResult.status !== 0) {
    return {
      available: false,
      reason: String(versionResult.stderr || versionResult.stdout || "git --version failed").trim()
    };
  }

  return {
    available: true
  };
}

function buildGitAuthConfigArgs(remoteUrl, authOptions = {}) {
  if (!/^https?:\/\//i.test(String(remoteUrl || "").trim())) {
    return [];
  }

  const authorizationHeader = buildBasicAuthHeader(remoteUrl, authOptions);

  if (!authorizationHeader) {
    return [];
  }

  return ["-c", `http.extraHeader=Authorization: ${authorizationHeader}`];
}

function tryReadRevision(projectRoot, revision) {
  const result = runGit(projectRoot, ["rev-parse", "--verify", "--quiet", revision], { check: false });
  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

function hasLocalBranch(projectRoot, branchName) {
  const result = runGit(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
    check: false
  });

  return result.status === 0;
}

async function hasGitHistoryCommits(repoRoot) {
  const result = await runGitAsync(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"], { check: false });
  return result.status === 0;
}

function runQueuedNativeLocalHistoryRepoTask(repoRoot, task) {
  const repoKey = path.resolve(String(repoRoot || ""));
  const previousBarrier = nativeLocalHistoryRepoQueues.get(repoKey) || Promise.resolve();
  const runPromise = previousBarrier.catch(() => {}).then(task);
  const nextBarrier = runPromise.then(
    () => undefined,
    () => undefined
  );

  nativeLocalHistoryRepoQueues.set(repoKey, nextBarrier);

  void nextBarrier.finally(() => {
    if (nativeLocalHistoryRepoQueues.get(repoKey) === nextBarrier) {
      nativeLocalHistoryRepoQueues.delete(repoKey);
    }
  });

  return runPromise;
}

function parseNativeNameStatusLines(fileLines = [], ignoredPaths = []) {
  return filterHistoryFileEntries(
    fileLines.map((line) => {
      const [status = "", firstPath = "", secondPath = ""] = String(line || "").split("\t");
      const normalizedStatus = status.trim().toUpperCase();
      const pathValue = normalizedStatus.startsWith("R") || normalizedStatus.startsWith("C") ? secondPath : firstPath;

      return {
        oldPath: normalizedStatus.startsWith("R") || normalizedStatus.startsWith("C") ? firstPath : "",
        path: pathValue,
        status: normalizedStatus
      };
    }),
    ignoredPaths
  );
}

function parseNativeHistoryLog(output, ignoredPaths = []) {
  const records = String(output || "")
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean);

  return records.map((record) => {
    const [headerLine = "", ...fileLines] = record.split("\n");
    const [hash = "", shortHash = "", timestamp = "", message = ""] = headerLine.split("\x00");
    const files = parseNativeNameStatusLines(
      fileLines.map((line) => line.trim()).filter(Boolean),
      ignoredPaths
    );

    return {
      changedFiles: getHistoryChangedFilePaths(files),
      files,
      hash,
      message,
      shortHash,
      timestamp
    };
  }).filter((entry) => entry.hash);
}

async function readStagedHistoryFiles(repoRoot) {
  return (await readGitAsync(repoRoot, ["diff", "--cached", "--name-only", "-z"]))
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function resolveHistoryCommit(repoRoot, commitHash) {
  const revision = await tryReadGitAsync(repoRoot, ["rev-parse", "--verify", `${commitHash}^{commit}`]);

  if (!revision) {
    throw new Error(`Git history commit not found: ${commitHash}`);
  }

  return revision;
}

function normalizeHistoryDiffPath(filePath) {
  const normalizedPath = normalizeGitRelativePath(filePath);

  if (!normalizedPath || normalizedPath.split("/").includes(".git")) {
    throw new Error("A valid history file path is required.");
  }

  return normalizedPath;
}

async function readHistoryHead(repoRoot) {
  return tryReadGitAsync(repoRoot, ["rev-parse", "--verify", "HEAD"]);
}

async function preserveHistoryHeadRef(repoRoot, reason = "snapshot") {
  const hash = await readHistoryHead(repoRoot);

  if (!hash) {
    return "";
  }

  const shortHash = await readGitAsync(repoRoot, ["rev-parse", "--short", hash]);
  const safeReason = String(reason || "snapshot").replace(/[^a-z0-9_-]+/giu, "-").replace(/^-|-$/gu, "") || "snapshot";
  const refName = `refs/space-history/${safeReason}/${Date.now()}-${shortHash}`;

  await runGitAsync(repoRoot, ["update-ref", refName, hash]);
  return refName;
}

async function readHistoryCommitFiles(repoRoot, commitHash, ignoredPaths = []) {
  const result = await runGitAsync(
    repoRoot,
    [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--find-renames",
      "--name-status",
      "-r",
      commitHash
    ],
    { check: false }
  );

  if (result.status !== 0) {
    return [];
  }

  return parseNativeNameStatusLines(
    result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
    ignoredPaths
  );
}

function invertHistoryFileEntry(entry) {
  const action = entry.action === "added"
    ? "deleted"
    : entry.action === "deleted"
      ? "added"
      : "modified";
  const status = entry.status?.startsWith("A")
    ? "D"
    : entry.status?.startsWith("D")
      ? "A"
      : entry.status || "M";

  return {
    ...entry,
    action,
    status
  };
}

function normalizeHistoryPreviewOperation(operation = "") {
  const normalizedOperation = String(operation || "").trim().toLowerCase();

  if (normalizedOperation === "revert") {
    return "revert";
  }

  return "travel";
}

async function readHistoryDiffFiles(repoRoot, fromHash, toHash, ignoredPaths = []) {
  const result = await runGitAsync(
    repoRoot,
    [
      "diff",
      "--name-status",
      "--find-renames",
      fromHash,
      toHash
    ],
    { check: false }
  );

  if (result.status !== 0) {
    return [];
  }

  return parseNativeNameStatusLines(
    result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
    ignoredPaths
  );
}

async function readHistoryDiffPatch(repoRoot, fromHash, toHash, filePath) {
  const result = await runGitAsync(
    repoRoot,
    [
      "diff",
      "--find-renames",
      "--patch",
      "--no-ext-diff",
      fromHash,
      toHash,
      "--",
      filePath
    ],
    { check: false }
  );

  return result.status === 0 ? result.stdout : "";
}

async function readRevertedCommitPatch(repoRoot, commitHash, filePath) {
  const result = await runGitAsync(
    repoRoot,
    [
      "show",
      "--format=",
      "--find-renames",
      "--patch",
      "--no-ext-diff",
      "-R",
      commitHash,
      "--",
      filePath
    ],
    { check: false }
  );

  return result.status === 0 ? result.stdout : "";
}

function hasRemoteBranch(projectRoot, remoteName, branchName) {
  const result = runGit(
    projectRoot,
    ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${branchName}`],
    { check: false }
  );

  return result.status === 0;
}

function readRemoteUrl(projectRoot, remoteName) {
  const result = runGit(projectRoot, ["config", "--local", "--get", `remote.${remoteName}.url`], {
    check: false
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

function readRemoteDefaultBranch(projectRoot, remoteName) {
  const result = runGit(projectRoot, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remoteName}/HEAD`], {
    check: false
  });

  if (result.status !== 0) {
    return null;
  }

  const remoteRef = result.stdout.trim();
  const prefix = `${remoteName}/`;
  if (!remoteRef.startsWith(prefix)) {
    return null;
  }

  return remoteRef.slice(prefix.length) || null;
}

export async function createNativeGitClient({ projectRoot }) {
  const availability = readNativeGitAvailability(projectRoot);
  if (!availability.available) {
    return createUnavailableBackendResult("native", availability.reason);
  }

  const client = {
    name: "native",
    label: "native git backend",

    async ensureCleanTrackedFiles() {
      const unstagedDiff = runGit(projectRoot, ["diff", "--quiet"], { check: false });
      if (unstagedDiff.status === 1) {
        throw new Error("Update refused because tracked files have unstaged changes. Commit or stash them first.");
      }
      if (unstagedDiff.status !== 0) {
        throw createGitError(["diff", "--quiet"], unstagedDiff.stderr, unstagedDiff.stdout);
      }

      const stagedDiff = runGit(projectRoot, ["diff", "--cached", "--quiet"], { check: false });
      if (stagedDiff.status === 1) {
        throw new Error(
          "Update refused because tracked files have staged changes. Commit, unstage, or stash them first."
        );
      }
      if (stagedDiff.status !== 0) {
        throw createGitError(["diff", "--cached", "--quiet"], stagedDiff.stderr, stagedDiff.stdout);
      }
    },

    async fetchRemote(remoteName, authOptions = {}) {
      const remoteUrl = authOptions.remoteUrl || readRemoteUrl(projectRoot, remoteName) || "";

      runGit(projectRoot, [
        ...buildGitAuthConfigArgs(remoteUrl, authOptions),
        "fetch",
        "--tags",
        remoteName
      ]);

      return {
        defaultBranch: readRemoteDefaultBranch(projectRoot, remoteName)
      };
    },

    async readCurrentBranch() {
      return readGit(projectRoot, ["branch", "--show-current"]) || null;
    },

    async hasLocalBranch(branchName) {
      return hasLocalBranch(projectRoot, branchName);
    },

    async hasRemoteBranch(remoteName, branchName) {
      return hasRemoteBranch(projectRoot, remoteName, branchName);
    },

    async readConfig(path) {
      const result = runGit(projectRoot, ["config", "--local", "--get", path], { check: false });
      if (result.status !== 0) {
        return null;
      }

      return result.stdout.trim() || null;
    },

    async writeConfig(path, value) {
      if (value === undefined) {
        runGit(projectRoot, ["config", "--local", "--unset-all", path], { check: false });
        return;
      }

      runGit(projectRoot, ["config", "--local", path, String(value)]);
    },

    async readHeadCommit() {
      return readGit(projectRoot, ["rev-parse", "HEAD"]);
    },

    async readShortCommit(revision = "HEAD") {
      return readGit(projectRoot, ["rev-parse", "--short", revision]);
    },

    async resolveTagRevision(tagName) {
      return tryReadRevision(projectRoot, `refs/tags/${tagName}^{commit}`);
    },

    async resolveCommitRevision(target, remoteName, authOptions = {}) {
      if (!COMMIT_HASH_PATTERN.test(target)) {
        return null;
      }

      let commitRevision = tryReadRevision(projectRoot, `${target}^{commit}`);
      if (commitRevision) {
        return commitRevision;
      }

      const remoteUrl = authOptions.remoteUrl || readRemoteUrl(projectRoot, remoteName) || "";

      runGit(
        projectRoot,
        [...buildGitAuthConfigArgs(remoteUrl, authOptions), "fetch", "--no-tags", remoteName, target],
        { check: false }
      );
      commitRevision = tryReadRevision(projectRoot, `${target}^{commit}`);

      return commitRevision || null;
    },

    async checkoutBranch(remoteName, branchName) {
      if (hasLocalBranch(projectRoot, branchName)) {
        runGit(projectRoot, ["switch", branchName]);
        return;
      }

      runGit(projectRoot, ["switch", "--create", branchName, "--track", `${remoteName}/${branchName}`]);
    },

    async fastForward(remoteName, branchName) {
      runGit(projectRoot, ["merge", "--ff-only", `${remoteName}/${branchName}`]);
    },

    async hardReset(revision) {
      runGit(projectRoot, ["reset", "--hard", revision]);
    },

    async checkoutDetached(revision) {
      runGit(projectRoot, ["checkout", "--detach", revision]);
    }
  };

  return createAvailableBackendResult("native", client);
}

export async function createNativeGitCloneClient({ targetDir }) {
  const availability = readNativeGitAvailability(path.dirname(targetDir));
  if (!availability.available) {
    return createUnavailableBackendResult("native", availability.reason);
  }

  const client = {
    name: "native",
    label: "native git backend",

    async cloneRepository({ authOptions = {}, remoteUrl, targetDir: cloneTargetDir }) {
      const sanitizedRemoteUrl = sanitizeRemoteUrl(remoteUrl);

      runGit(
        path.dirname(cloneTargetDir),
        [...buildGitAuthConfigArgs(remoteUrl, authOptions), "clone", sanitizedRemoteUrl, cloneTargetDir],
        {
          cwd: path.dirname(cloneTargetDir)
        }
      );
    }
  };

  return createAvailableBackendResult("native", client);
}

export async function createNativeGitHistoryClient({ repoRoot }) {
  const parentDir = path.dirname(path.resolve(String(repoRoot || "")));
  const availability = readNativeGitAvailability(parentDir);
  if (!availability.available) {
    return createUnavailableBackendResult("native", availability.reason);
  }

  const resolvedRepoRoot = path.resolve(String(repoRoot || ""));

  async function ensureHistoryRepository() {
    fs.mkdirSync(resolvedRepoRoot, { recursive: true });

    if (!fs.existsSync(path.join(resolvedRepoRoot, ".git"))) {
      await runGitAsync(resolvedRepoRoot, ["init"], {
        cwd: resolvedRepoRoot
      });
    }
  }

  const client = {
    name: "native",
    label: "native git backend",

    async ensureRepository() {
      return runQueuedNativeLocalHistoryRepoTask(resolvedRepoRoot, async () => {
        await ensureHistoryRepository();
      });
    },

    async commitAll(options = {}) {
      return runQueuedNativeLocalHistoryRepoTask(resolvedRepoRoot, async () => {
        await ensureHistoryRepository();
        await runGitAsync(resolvedRepoRoot, ["add", "-A", "--", "."]);
        const ignoredPaths = [...normalizeHistoryIgnoredPaths(options.ignoredPaths)];

        if (ignoredPaths.length > 0) {
          await runGitAsync(resolvedRepoRoot, ["rm", "--cached", "--ignore-unmatch", "--", ...ignoredPaths]);
        }

        const stagedFiles = await readStagedHistoryFiles(resolvedRepoRoot);
        const changedFiles = filterHistoryChangedFiles(stagedFiles, ignoredPaths);
        if (stagedFiles.length === 0) {
          return {
            backend: this.name,
            changedFiles: [],
            committed: false,
            hash: "",
            shortHash: ""
          };
        }

        await runGitAsync(resolvedRepoRoot, [
          "-c",
          `user.name=${String(options.authorName || "Constellation Agent")}`,
          "-c",
          `user.email=${String(options.authorEmail || "constellation-agent@local")}`,
          "commit",
          "--no-gpg-sign",
          "-m",
          String(options.message || "Update customware history")
        ]);

        const hash = await readGitAsync(resolvedRepoRoot, ["rev-parse", "HEAD"]);

        return {
          backend: this.name,
          changedFiles,
          committed: true,
          hash,
          shortHash: await readGitAsync(resolvedRepoRoot, ["rev-parse", "--short", hash])
        };
      });
    },

    async listCommits(options = {}) {
      return runQueuedNativeLocalHistoryRepoTask(resolvedRepoRoot, async () => {
        await ensureHistoryRepository();

        if (!(await hasGitHistoryCommits(resolvedRepoRoot))) {
          return {
            commits: [],
            currentHash: "",
            hasMore: false,
            limit: Math.max(1, Math.min(500, Number(options.limit) || 50)),
            offset: Math.max(0, Number(options.offset) || 0),
            total: 0
          };
        }

        const limit = Math.max(1, Math.min(500, Number(options.limit) || 50));
        const offset = Math.max(0, Number(options.offset) || 0);
        const pathspecs = buildHistoryFilterPathspecs(options.fileFilter);
        const result = await runGitAsync(
          resolvedRepoRoot,
          [
            "log",
            "HEAD",
            "--all",
            `--max-count=${limit + 1}`,
            `--skip=${offset}`,
            "--date=iso-strict",
            "--pretty=format:%x1e%H%x00%h%x00%cI%x00%s",
            "--find-renames",
            "--name-status",
            "--",
            ...pathspecs
          ],
          { check: false }
        );

        if (result.status !== 0) {
          return {
            commits: [],
            currentHash: (await readHistoryHead(resolvedRepoRoot)) || "",
            hasMore: false,
            limit,
            offset,
            total: 0
          };
        }

        const parsedCommits = parseNativeHistoryLog(result.stdout, options.ignoredPaths);
        const commits = await Promise.all(
          parsedCommits.slice(0, limit).map(async (commit) => {
            if (pathspecs.length === 0) {
              return commit;
            }

            const files = await readHistoryCommitFiles(resolvedRepoRoot, commit.hash, options.ignoredPaths);

            return {
              ...commit,
              changedFiles: getHistoryChangedFilePaths(files),
              files
            };
          })
        );
        const countResult = await runGitAsync(
          resolvedRepoRoot,
          [
            "rev-list",
            "--count",
            "HEAD",
            "--all",
            "--",
            ...pathspecs
          ],
          { check: false }
        );
        const total = countResult.status === 0
          ? Math.max(0, Number.parseInt(countResult.stdout.trim(), 10) || 0)
          : null;

        return {
          commits,
          currentHash: (await readHistoryHead(resolvedRepoRoot)) || "",
          hasMore: parsedCommits.length > limit,
          limit,
          offset,
          total
        };
      });
    },

    async getCommitDiff(options = {}) {
      return runQueuedNativeLocalHistoryRepoTask(resolvedRepoRoot, async () => {
        await ensureHistoryRepository();
        const hash = await resolveHistoryCommit(resolvedRepoRoot, String(options.commitHash || ""));
        const filePath = normalizeHistoryDiffPath(options.filePath || options.path || "");
        const showResult = await runGitAsync(
          resolvedRepoRoot,
          [
            "show",
            "--format=",
            "--find-renames",
            "--patch",
            "--no-ext-diff",
            hash,
            "--",
            filePath
          ],
          { check: false }
        );
        const files = await readHistoryCommitFiles(resolvedRepoRoot, hash, options.ignoredPaths);

        return {
          backend: this.name,
          file: files.find((entry) => entry.path === filePath || entry.oldPath === filePath) || {
            action: "modified",
            oldPath: "",
            path: filePath,
            status: "M"
          },
          hash,
          patch: showResult.status === 0 ? showResult.stdout : "",
          shortHash: await readGitAsync(resolvedRepoRoot, ["rev-parse", "--short", hash])
        };
      });
    },

    async previewOperation(options = {}) {
      return runQueuedNativeLocalHistoryRepoTask(resolvedRepoRoot, async () => {
        await ensureHistoryRepository();
        const operation = normalizeHistoryPreviewOperation(options.operation);
        const hash = await resolveHistoryCommit(resolvedRepoRoot, String(options.commitHash || ""));
        const currentHash = (await readHistoryHead(resolvedRepoRoot)) || "";
        const filePath = options.filePath ? normalizeHistoryDiffPath(options.filePath) : "";

        if (operation === "revert") {
          const files = (await readHistoryCommitFiles(resolvedRepoRoot, hash, options.ignoredPaths)).map(
            invertHistoryFileEntry
          );

          return {
            backend: this.name,
            changedFiles: getHistoryChangedFilePaths(files),
            currentHash,
            file: filePath
              ? files.find((entry) => entry.path === filePath || entry.oldPath === filePath) || null
              : null,
            files,
            hash,
            operation,
            patch: filePath ? await readRevertedCommitPatch(resolvedRepoRoot, hash, filePath) : "",
            shortHash: await readGitAsync(resolvedRepoRoot, ["rev-parse", "--short", hash])
          };
        }

        const files = currentHash
          ? await readHistoryDiffFiles(resolvedRepoRoot, currentHash, hash, options.ignoredPaths)
          : [];

        return {
          backend: this.name,
          changedFiles: getHistoryChangedFilePaths(files),
          currentHash,
          file: filePath
            ? files.find((entry) => entry.path === filePath || entry.oldPath === filePath) || null
            : null,
          files,
          hash,
          operation,
          patch: currentHash && filePath ? await readHistoryDiffPatch(resolvedRepoRoot, currentHash, hash, filePath) : "",
          shortHash: await readGitAsync(resolvedRepoRoot, ["rev-parse", "--short", hash])
        };
      });
    },

    async rollbackToCommit(options = {}) {
      return runQueuedNativeLocalHistoryRepoTask(resolvedRepoRoot, async () => {
        await ensureHistoryRepository();
        const hash = await resolveHistoryCommit(resolvedRepoRoot, String(options.commitHash || ""));
        const currentHash = await readHistoryHead(resolvedRepoRoot);

        if (currentHash && currentHash !== hash) {
          await preserveHistoryHeadRef(resolvedRepoRoot, "rollback");
        }

        await runGitAsync(resolvedRepoRoot, ["reset", "--hard", hash]);

        return {
          backend: this.name,
          hash,
          shortHash: await readGitAsync(resolvedRepoRoot, ["rev-parse", "--short", hash])
        };
      });
    },

    async revertCommit(options = {}) {
      return runQueuedNativeLocalHistoryRepoTask(resolvedRepoRoot, async () => {
        await ensureHistoryRepository();
        const hash = await resolveHistoryCommit(resolvedRepoRoot, String(options.commitHash || ""));
        await preserveHistoryHeadRef(resolvedRepoRoot, "revert");
        const result = await runGitAsync(
          resolvedRepoRoot,
          [
            "-c",
            `user.name=${String(options.authorName || "Constellation Agent")}`,
            "-c",
            `user.email=${String(options.authorEmail || "constellation-agent@local")}`,
            "revert",
            "--no-edit",
            "--no-gpg-sign",
            hash
          ],
          { check: false }
        );

        if (result.status !== 0) {
          await runGitAsync(resolvedRepoRoot, ["revert", "--abort"], { check: false });
          const error = createGitError(["revert", hash], result.stderr, result.stdout);
          error.statusCode = 409;
          throw error;
        }

        const nextHash = await readGitAsync(resolvedRepoRoot, ["rev-parse", "HEAD"]);

        return {
          backend: this.name,
          hash: nextHash,
          revertedHash: hash,
          shortHash: await readGitAsync(resolvedRepoRoot, ["rev-parse", "--short", nextHash])
        };
      });
    }
  };

  return createAvailableBackendResult("native", client);
}
