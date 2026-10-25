import path from "node:path";

import {
  COMMIT_HASH_PATTERN,
  buildHttpAuthOptions,
  createAvailableBackendResult,
  createUnavailableBackendResult,
  filterHistoryChangedFiles,
  filterHistoryFileEntries,
  fs,
  getHistoryChangedFilePaths,
  isHistoryIgnoredPath,
  normalizeBranchName,
  normalizeGitRelativePath,
  normalizeHistoryIgnoredPaths,
  normalizeRemoteUrl,
  sanitizeRemoteUrl,
  shortenOid
} from "./shared.js";

const isomorphicLocalHistoryRepoQueues = new Map();
const isomorphicHistoryEntriesCache = new Map();
const isomorphicTreeCache = new Map();
const isomorphicCommitFilesCache = new Map();
const ISOMORPHIC_HISTORY_ENTRIES_CACHE_LIMIT = 32;
const ISOMORPHIC_TREE_CACHE_LIMIT = 256;
const ISOMORPHIC_COMMIT_FILES_CACHE_LIMIT = 512;

function runQueuedIsomorphicLocalHistoryRepoTask(repoRoot, task) {
  const repoKey = path.resolve(String(repoRoot || ""));
  const previousBarrier = isomorphicLocalHistoryRepoQueues.get(repoKey) || Promise.resolve();
  const runPromise = previousBarrier.catch(() => {}).then(task);
  const nextBarrier = runPromise.then(
    () => undefined,
    () => undefined
  );

  isomorphicLocalHistoryRepoQueues.set(repoKey, nextBarrier);

  void nextBarrier.finally(() => {
    if (isomorphicLocalHistoryRepoQueues.get(repoKey) === nextBarrier) {
      isomorphicLocalHistoryRepoQueues.delete(repoKey);
    }
  });

  return runPromise;
}

function touchIsomorphicCacheEntry(cache, key, value) {
  if (cache.has(key)) {
    cache.delete(key);
  }

  cache.set(key, value);
}

function trimIsomorphicCache(cache, limit) {
  while (cache.size > limit) {
    const oldestKey = cache.keys().next();

    if (oldestKey.done) {
      return;
    }

    cache.delete(oldestKey.value);
  }
}

function getCachedIsomorphicValue(cache, key, loadValue, limit) {
  if (cache.has(key)) {
    const cachedValue = cache.get(key);
    touchIsomorphicCacheEntry(cache, key, cachedValue);
    return cachedValue;
  }

  const valuePromise = Promise.resolve().then(loadValue);
  touchIsomorphicCacheEntry(cache, key, valuePromise);
  trimIsomorphicCache(cache, limit);

  void valuePromise.catch(() => {
    if (cache.get(key) === valuePromise) {
      cache.delete(key);
    }
  });

  return valuePromise;
}

function createIgnoredPathsCacheKey(ignoredPaths = []) {
  return [...normalizeHistoryIgnoredPaths(ignoredPaths)]
    .sort((left, right) => left.localeCompare(right))
    .join("\x1f");
}

function createIsomorphicRepoCacheKey(repoRoot, scope = "") {
  return `${path.resolve(String(repoRoot || ""))}:${scope}`;
}

function invalidateIsomorphicHistoryEntriesCache(repoRoot) {
  isomorphicHistoryEntriesCache.delete(createIsomorphicRepoCacheKey(repoRoot, "history"));
}

async function resolveIsomorphicModules() {
  try {
    const gitModule = await import("isomorphic-git");
    const httpModule = await import("isomorphic-git/http/node");
    const diff3Module = await import("diff3");

    return {
      diff3Merge: diff3Module.default || diff3Module,
      git: gitModule.default || gitModule,
      http: httpModule.default || httpModule
    };
  } catch (error) {
    throw new Error(error.message);
  }
}

function createRepoOptions(gitContext) {
  return {
    fs,
    dir: gitContext.dir,
    gitdir: gitContext.gitdir
  };
}

function createTargetRepoOptions(targetDir) {
  return {
    fs,
    dir: targetDir,
    gitdir: path.join(targetDir, ".git")
  };
}

function createHistoryRepoOptions(repoRoot) {
  return {
    fs,
    dir: repoRoot,
    gitdir: path.join(repoRoot, ".git")
  };
}

function isInternalGitPath(filePath) {
  return String(filePath || "").split(/[\\/]+/u).includes(".git");
}

function normalizeFetchedDefaultBranch(defaultBranch) {
  return normalizeBranchName(defaultBranch);
}

function isUnstagedMatrixRow([, head, workdir, stage]) {
  if (head === 0 && stage === 0) {
    return false;
  }

  return workdir !== stage;
}

function isStagedMatrixRow([, head, , stage]) {
  return !(head === stage || (head === 0 && stage === 0));
}

async function ensureIsomorphicRepository(git, repoRoot, repoOptions) {
  await fs.promises.mkdir(repoRoot, { recursive: true });

  if (!fs.existsSync(repoOptions.gitdir)) {
    await git.init({
      ...repoOptions,
      defaultBranch: "main"
    });
  }
}

async function stageIsomorphicHistoryChanges(git, repoOptions, ignoredPaths = [], changedPathsHint = []) {
  const statusRows = await git.statusMatrix(repoOptions);
  const ignoredPathSet = normalizeHistoryIgnoredPaths(ignoredPaths);
  const changedFiles = new Set();

  for (const ignoredPath of ignoredPathSet) {
    try {
      await git.remove({
        ...repoOptions,
        filepath: ignoredPath
      });
    } catch {
      // Already untracked or absent. Future status handling skips ignored paths.
    }
  }

  for (const [filepath, head, workdir, stage] of statusRows) {
    if (!filepath || isInternalGitPath(filepath) || isHistoryIgnoredPath(filepath, ignoredPathSet)) {
      continue;
    }

    const workdirChanged = !(head === workdir || (head === 0 && workdir === 0));
    if (workdirChanged) {
      changedFiles.add(filepath);
    }

    if (workdir === 0) {
      if (head !== 0 || stage !== 0) {
        await git.remove({
          ...repoOptions,
          filepath
        });
      }
      continue;
    }

    if (stage !== workdir) {
      await git.add({
        ...repoOptions,
        filepath
      });
    }
  }

  await stageIsomorphicContentOnlyChanges(
    git,
    repoOptions,
    normalizeIsomorphicChangedPathsHint(changedPathsHint),
    ignoredPathSet,
    changedFiles
  );

  if (changedFiles.size === 0) {
    await stageIsomorphicContentOnlyChanges(
      git,
      repoOptions,
      statusRows.map(([filepath]) => filepath),
      ignoredPathSet,
      changedFiles
    );
  }

  return [...changedFiles].sort((left, right) => left.localeCompare(right));
}

async function tryReadIsomorphicBlobOid(git, repoOptions, ref, filepath) {
  try {
    const result = await git.readBlob({
      ...repoOptions,
      filepath,
      oid: ref
    });

    return result.oid || Buffer.from(result.blob || "").toString("base64");
  } catch {
    return null;
  }
}

async function readIsomorphicWorkdirBlobOid(git, repoOptions, filepath) {
  try {
    const object = await fs.promises.readFile(path.join(repoOptions.dir, filepath));
    const result = await git.hashBlob({ object });

    return result?.oid || null;
  } catch {
    return null;
  }
}

function normalizeIsomorphicChangedPathsHint(changedPathsHint = []) {
  return [...new Set(
    (Array.isArray(changedPathsHint) ? changedPathsHint : [changedPathsHint])
      .map((filepath) => normalizeGitRelativePath(filepath))
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));
}

async function stageIsomorphicContentOnlyChanges(
  git,
  repoOptions,
  candidatePaths = [],
  ignoredPathSet = new Set(),
  changedFiles = new Set()
) {
  const headHash = await readIsomorphicHistoryHead(git, repoOptions);

  if (!headHash) {
    return;
  }

  for (const filepath of normalizeIsomorphicChangedPathsHint(candidatePaths)) {
    if (changedFiles.has(filepath) || isInternalGitPath(filepath) || isHistoryIgnoredPath(filepath, ignoredPathSet)) {
      continue;
    }

    const [headBlobOid, workdirBlobOid] = await Promise.all([
      tryReadIsomorphicBlobOid(git, repoOptions, headHash, filepath),
      readIsomorphicWorkdirBlobOid(git, repoOptions, filepath)
    ]);

    if (!headBlobOid || !workdirBlobOid || headBlobOid === workdirBlobOid) {
      continue;
    }

    await git.add({
      ...repoOptions,
      filepath
    });
    changedFiles.add(filepath);
  }
}

function normalizeHistoryDiffPath(filePath) {
  const normalizedPath = normalizeGitRelativePath(filePath);

  if (!normalizedPath || normalizedPath.split("/").includes(".git")) {
    throw new Error("A valid history file path is required.");
  }

  return normalizedPath;
}

function normalizeHistoryPreviewOperation(operation = "") {
  return String(operation || "").trim().toLowerCase() === "revert" ? "revert" : "travel";
}

function createIsomorphicHistoryError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function describeIsomorphicBlobLabel(file) {
  return file?.oid ? shortenOid(file.oid) : "missing";
}

const ISOMORPHIC_MERGE_LINEBREAKS = /^.*(\r?\n|$)/gm;

function splitIsomorphicMergeLines(text = "") {
  return String(text || "").match(ISOMORPHIC_MERGE_LINEBREAKS) || [""];
}

function mergeIsomorphicRevertText(diff3Merge, currentText = "", targetText = "", parentText = "") {
  const result = diff3Merge(
    splitIsomorphicMergeLines(currentText),
    splitIsomorphicMergeLines(targetText),
    splitIsomorphicMergeLines(parentText)
  );
  let cleanMerge = true;
  let mergedText = "";

  for (const item of result) {
    if (item.ok) {
      mergedText += item.ok.join("");
      continue;
    }

    if (item.conflict) {
      cleanMerge = false;
    }
  }

  return {
    cleanMerge,
    mergedText
  };
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

function findHistoryFileEntry(files = [], filePath = "") {
  const normalizedPath = normalizeGitRelativePath(filePath);
  return files.find((entry) => entry.path === normalizedPath || entry.oldPath === normalizedPath) || null;
}

function splitPatchLines(text = "") {
  const normalized = String(text || "").replace(/\r\n/gu, "\n");

  if (!normalized) {
    return [];
  }

  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed ? trimmed.split("\n") : [];
}

function buildUnifiedDiffOperations(oldLines = [], newLines = []) {
  const dp = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? dp[oldIndex + 1][newIndex + 1] + 1
        : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  const operations = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      operations.push({
        line: oldLines[oldIndex],
        type: "context"
      });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (
      newIndex < newLines.length &&
      (oldIndex === oldLines.length || dp[oldIndex][newIndex + 1] >= dp[oldIndex + 1][newIndex])
    ) {
      operations.push({
        line: newLines[newIndex],
        type: "insert"
      });
      newIndex += 1;
      continue;
    }

    operations.push({
      line: oldLines[oldIndex],
      type: "delete"
    });
    oldIndex += 1;
  }

  return operations;
}

function formatUnifiedRange(start, count) {
  if (count === 0) {
    return String(Math.max(0, start)) + ",0";
  }

  if (count === 1) {
    return String(start);
  }

  return String(start) + "," + String(count);
}

function buildUnifiedDiffBody(oldText = "", newText = "") {
  if (oldText === newText) {
    return "";
  }

  const operations = buildUnifiedDiffOperations(splitPatchLines(oldText), splitPatchLines(newText));
  const changedIndexes = operations
    .map((operation, index) => (operation.type === "context" ? -1 : index))
    .filter((index) => index >= 0);

  if (changedIndexes.length === 0) {
    return "";
  }

  const hunkRanges = [];
  let currentStart = -1;
  let currentEnd = -1;

  for (const changedIndex of changedIndexes) {
    const nextStart = Math.max(0, changedIndex - 3);
    const nextEnd = Math.min(operations.length, changedIndex + 4);

    if (currentStart === -1) {
      currentStart = nextStart;
      currentEnd = nextEnd;
      continue;
    }

    if (nextStart <= currentEnd) {
      currentEnd = Math.max(currentEnd, nextEnd);
      continue;
    }

    hunkRanges.push([currentStart, currentEnd]);
    currentStart = nextStart;
    currentEnd = nextEnd;
  }

  hunkRanges.push([currentStart, currentEnd]);

  const hunks = [];
  let cursor = 0;
  let oldLine = 1;
  let newLine = 1;

  for (const [start, end] of hunkRanges) {
    while (cursor < start) {
      const operation = operations[cursor];
      if (operation.type !== "insert") {
        oldLine += 1;
      }
      if (operation.type !== "delete") {
        newLine += 1;
      }
      cursor += 1;
    }

    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    let oldCount = 0;
    let newCount = 0;
    const bodyLines = [];

    for (let index = start; index < end; index += 1) {
      const operation = operations[index];
      const prefix = operation.type === "context" ? " " : operation.type === "delete" ? "-" : "+";
      bodyLines.push(prefix + operation.line);

      if (operation.type !== "insert") {
        oldCount += 1;
        oldLine += 1;
      }
      if (operation.type !== "delete") {
        newCount += 1;
        newLine += 1;
      }
    }

    cursor = end;
    const displayOldStart = oldCount === 0 ? hunkOldStart - 1 : hunkOldStart;
    const displayNewStart = newCount === 0 ? hunkNewStart - 1 : hunkNewStart;

    hunks.push(
      [
        "@@ -" + formatUnifiedRange(displayOldStart, oldCount) + " +" + formatUnifiedRange(displayNewStart, newCount) + " @@",
        ...bodyLines
      ].join("\n")
    );
  }

  return hunks.join("\n");
}

async function readIsomorphicHistoryHead(git, repoOptions) {
  try {
    return await git.resolveRef({
      ...repoOptions,
      ref: "HEAD"
    });
  } catch {
    return "";
  }
}

async function preserveIsomorphicHistoryHeadRef(git, repoOptions, reason = "snapshot") {
  const hash = await readIsomorphicHistoryHead(git, repoOptions);

  if (!hash) {
    return "";
  }

  const safeReason = String(reason || "snapshot").replace(/[^a-z0-9_-]+/giu, "-").replace(/^-|-$/gu, "") || "snapshot";
  const refName = "refs/space-history/" + safeReason + "/" + Date.now() + "-" + shortenOid(hash);

  await git.writeRef({
    ...repoOptions,
    force: true,
    ref: refName,
    value: hash
  });

  return refName;
}

async function resolveIsomorphicCommit(git, repoOptions, revision) {
  const value = String(revision || "").trim();

  if (!value) {
    throw createIsomorphicHistoryError("A valid Git commit hash is required.", 400);
  }

  try {
    if (COMMIT_HASH_PATTERN.test(value)) {
      return await git.expandOid({
        ...repoOptions,
        oid: value
      });
    }

    return await git.resolveRef({
      ...repoOptions,
      ref: value
    });
  } catch {
    // Well-formed hash that the repository does not know: a missing resource, not a
    // server fault. The shared rethrow helper preserves this statusCode.
    throw createIsomorphicHistoryError("Git history commit not found: " + value, 404);
  }
}

async function readIsomorphicTreeFilesFromTree(git, repoOptions, treeOid, prefix = "", output = new Map()) {
  const tree = await git.readTree({
    ...repoOptions,
    oid: treeOid
  });

  for (const entry of tree.tree || []) {
    const filepath = prefix ? prefix + "/" + entry.path : entry.path;
    if (!filepath || isInternalGitPath(filepath)) {
      continue;
    }

    if (entry.type === "tree") {
      await readIsomorphicTreeFilesFromTree(git, repoOptions, entry.oid, filepath, output);
      continue;
    }

    if (entry.type === "blob") {
      output.set(filepath, {
        mode: entry.mode,
        oid: entry.oid,
        path: filepath,
        type: entry.type
      });
    }
  }

  return output;
}

async function readIsomorphicTreeFiles(git, repoOptions, repoRoot, ref) {
  if (!ref) {
    return new Map();
  }

  const hash = await resolveIsomorphicCommit(git, repoOptions, ref);
  const cacheKey = createIsomorphicRepoCacheKey(repoRoot, `tree:${hash}`);

  return getCachedIsomorphicValue(
    isomorphicTreeCache,
    cacheKey,
    async () => {
      const commit = await git.readCommit({
        ...repoOptions,
        oid: hash
      });

      return readIsomorphicTreeFilesFromTree(git, repoOptions, commit.commit.tree);
    },
    ISOMORPHIC_TREE_CACHE_LIMIT
  );
}

function createIsomorphicHistoryEntry(filepath, fromFile, toFile) {
  if (!fromFile && !toFile) {
    return null;
  }

  return {
    oldPath: "",
    path: filepath,
    status: !fromFile ? "A" : !toFile ? "D" : "M"
  };
}

function diffIsomorphicSnapshots(fromFiles, toFiles, ignoredPaths = []) {
  const filepaths = [...new Set([...fromFiles.keys(), ...toFiles.keys()])].sort((left, right) => left.localeCompare(right));
  const changedFiles = [];

  for (const filepath of filepaths) {
    const fromFile = fromFiles.get(filepath) || null;
    const toFile = toFiles.get(filepath) || null;

    if (!fromFile && !toFile) {
      continue;
    }

    if (!fromFile || !toFile || fromFile.oid !== toFile.oid) {
      changedFiles.push(createIsomorphicHistoryEntry(filepath, fromFile, toFile));
    }
  }

  return filterHistoryFileEntries(changedFiles, ignoredPaths);
}

async function readIsomorphicCommitInput(git, repoOptions, commitEntry) {
  if (typeof commitEntry === "string") {
    const hash = await resolveIsomorphicCommit(git, repoOptions, commitEntry);

    return {
      commit: await git.readCommit({
        ...repoOptions,
        oid: hash
      }),
      hash
    };
  }

  return {
    commit: commitEntry,
    hash: commitEntry.oid
  };
}

async function readIsomorphicCommitFiles(git, repoOptions, repoRoot, commitEntry, ignoredPaths = []) {
  const { commit, hash } = await readIsomorphicCommitInput(git, repoOptions, commitEntry);
  const ignoredPathsKey = createIgnoredPathsCacheKey(ignoredPaths);
  const cacheKey = createIsomorphicRepoCacheKey(repoRoot, `files:${hash}:${ignoredPathsKey}`);

  return getCachedIsomorphicValue(
    isomorphicCommitFilesCache,
    cacheKey,
    async () => {
      const parentOid = commit.commit.parent?.[0] || "";
      const [parentFiles, currentFiles] = await Promise.all([
        readIsomorphicTreeFiles(git, repoOptions, repoRoot, parentOid),
        readIsomorphicTreeFiles(git, repoOptions, repoRoot, hash)
      ]);

      return diffIsomorphicSnapshots(parentFiles, currentFiles, ignoredPaths);
    },
    ISOMORPHIC_COMMIT_FILES_CACHE_LIMIT
  );
}

async function createIsomorphicCommitListEntry(git, repoOptions, repoRoot, entry, ignoredPaths = []) {
  const files = await readIsomorphicCommitFiles(git, repoOptions, repoRoot, entry, ignoredPaths);

  return {
    changedFiles: getHistoryChangedFilePaths(files),
    files,
    hash: entry.oid,
    message: String(entry.commit.message || "").split("\n")[0],
    shortHash: shortenOid(entry.oid),
    timestamp: entry.commit.committer?.timestamp
      ? new Date(entry.commit.committer.timestamp * 1000).toISOString()
      : ""
  };
}

function matchesIsomorphicCommitFileFilter(commit, fileFilter = "") {
  const normalizedFilter = String(fileFilter || "").trim().toLowerCase();

  if (!normalizedFilter) {
    return true;
  }

  return commit.changedFiles.some((filePath) => filePath.toLowerCase().includes(normalizedFilter));
}

async function readIsomorphicBlobText(git, repoOptions, ref, filepath) {
  if (!ref || !filepath) {
    return "";
  }

  try {
    const result = await git.readBlob({
      ...repoOptions,
      filepath,
      oid: ref
    });

    return Buffer.from(result.blob || "").toString("utf8");
  } catch {
    return "";
  }
}

async function buildIsomorphicPatch({ git, repoOptions, oldFile, newFile, oldRef, newRef }) {
  if ((!oldFile && !newFile) || oldFile?.oid === newFile?.oid) {
    return "";
  }

  const filepath = newFile?.path || oldFile?.path || "";
  const [oldText, newText] = await Promise.all([
    oldFile ? readIsomorphicBlobText(git, repoOptions, oldRef, oldFile.path) : "",
    newFile ? readIsomorphicBlobText(git, repoOptions, newRef, newFile.path) : ""
  ]);
  const body = buildUnifiedDiffBody(oldText, newText);

  if (!body) {
    return "";
  }

  const oldLabel = oldFile ? "a/" + oldFile.path : "/dev/null";
  const newLabel = newFile ? "b/" + newFile.path : "/dev/null";

  return [
    "diff --git a/" + filepath + " b/" + filepath,
    "index " + shortenOid(oldFile?.oid || "0000000") + ".." + shortenOid(newFile?.oid || "0000000"),
    "--- " + oldLabel,
    "+++ " + newLabel,
    body
  ].join("\n");
}

async function readIsomorphicFileDiff(git, repoOptions, repoRoot, fromRef, toRef, filePath) {
  const normalizedPath = normalizeHistoryDiffPath(filePath);
  const [fromFiles, toFiles] = await Promise.all([
    readIsomorphicTreeFiles(git, repoOptions, repoRoot, fromRef),
    readIsomorphicTreeFiles(git, repoOptions, repoRoot, toRef)
  ]);
  const fromFile = fromFiles.get(normalizedPath) || null;
  const toFile = toFiles.get(normalizedPath) || null;

  return {
    file: filterHistoryFileEntries([createIsomorphicHistoryEntry(normalizedPath, fromFile, toFile)])[0] || {
      action: "modified",
      oldPath: "",
      path: normalizedPath,
      status: "M"
    },
    patch: await buildIsomorphicPatch({
      git,
      newFile: toFile,
      newRef: toRef,
      oldFile: fromFile,
      oldRef: fromRef,
      repoOptions
    })
  };
}

async function listIsomorphicRefs(git, repoOptions, filepath) {
  try {
    return await git.listRefs({
      ...repoOptions,
      filepath
    });
  } catch {
    return [];
  }
}

async function readAllIsomorphicHistoryEntries(git, repoOptions, repoRoot) {
  const cacheKey = createIsomorphicRepoCacheKey(repoRoot, "history");

  return getCachedIsomorphicValue(
    isomorphicHistoryEntriesCache,
    cacheKey,
    async () => {
      const refs = new Set();
      const [heads, historyRefs] = await Promise.all([
        listIsomorphicRefs(git, repoOptions, "refs/heads"),
        listIsomorphicRefs(git, repoOptions, "refs/space-history")
      ]);

      refs.add("HEAD");
      heads.forEach((ref) => refs.add("refs/heads/" + ref));
      historyRefs.forEach((ref) => refs.add("refs/space-history/" + ref));

      const orderedRefs = [...refs];
      const logEntriesByRef = await Promise.all(
        orderedRefs.map(async (ref) => {
          try {
            return await git.log({
              ...repoOptions,
              ref
            });
          } catch {
            return [];
          }
        })
      );

      const entriesByHash = new Map();
      let sortIndex = 0;

      for (const entries of logEntriesByRef) {
        for (const entry of entries) {
          if (!entriesByHash.has(entry.oid)) {
            entriesByHash.set(entry.oid, {
              entry,
              sortIndex
            });
          }

          sortIndex += 1;
        }
      }

      return [...entriesByHash.values()]
        .sort((left, right) => {
          const leftTimestamp = Number(left.entry.commit.committer?.timestamp) || 0;
          const rightTimestamp = Number(right.entry.commit.committer?.timestamp) || 0;

          if (leftTimestamp !== rightTimestamp) {
            return rightTimestamp - leftTimestamp;
          }

          return left.sortIndex - right.sortIndex;
        })
        .map(({ entry }) => entry);
    },
    ISOMORPHIC_HISTORY_ENTRIES_CACHE_LIMIT
  );
}

async function applyIsomorphicFileWrites(repoRoot, operations = []) {
  for (const operation of operations) {
    const absolutePath = path.join(repoRoot, operation.filepath);

    if (operation.type === "delete") {
      await fs.promises.rm(absolutePath, {
        force: true
      });
      continue;
    }

    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, operation.content, "utf8");
  }
}

export async function createIsomorphicGitClient({ gitContext }) {
  let modules;
  try {
    modules = await resolveIsomorphicModules();
  } catch (error) {
    return createUnavailableBackendResult("isomorphic", error.message);
  }

  const { diff3Merge, git, http } = modules;
  const repoOptions = createRepoOptions(gitContext);

  async function resolveRemoteTransport(remoteName, authOptions = {}) {
    const remoteUrl = await git.getConfig({
      ...repoOptions,
      path: `remote.${remoteName}.url`
    });

    if (!remoteUrl) {
      throw new Error(`Git remote ${remoteName} is not configured.`);
    }

    const transportUrl = normalizeRemoteUrl(remoteUrl);
    return {
      remoteUrl,
      transportUrl,
      ...buildHttpAuthOptions(remoteUrl, authOptions)
    };
  }

  const client = {
    name: "isomorphic",
    label: "isomorphic-git backend",

    async ensureCleanTrackedFiles() {
      const statusRows = await git.statusMatrix({
        ...repoOptions
      });

      if (statusRows.some(isUnstagedMatrixRow)) {
        throw new Error("Update refused because tracked files have unstaged changes. Commit or stash them first.");
      }

      if (statusRows.some(isStagedMatrixRow)) {
        throw new Error("Update refused because tracked files have staged changes. Commit, unstage, or stash them first.");
      }
    },

    async fetchRemote(remoteName, authOptions = {}) {
      const transport = await resolveRemoteTransport(remoteName, authOptions);
      const result = await git.fetch({
        ...repoOptions,
        http,
        remote: remoteName,
        url: transport.transportUrl,
        tags: true,
        ...(transport.onAuth ? { onAuth: transport.onAuth } : {})
      });

      return {
        defaultBranch: normalizeFetchedDefaultBranch(result.defaultBranch)
      };
    },

    async readCurrentBranch() {
      return (await git.currentBranch({
        ...repoOptions,
        test: true
      })) || null;
    },

    async hasLocalBranch(branchName) {
      const branches = await git.listBranches(repoOptions);
      return branches.includes(branchName);
    },

    async hasRemoteBranch(remoteName, branchName) {
      const branches = await git.listBranches({
        ...repoOptions,
        remote: remoteName
      });

      return branches.includes(branchName);
    },

    async readConfig(path) {
      const value = await git.getConfig({
        ...repoOptions,
        path
      });

      return value == null ? null : String(value).trim() || null;
    },

    async writeConfig(path, value) {
      await git.setConfig({
        ...repoOptions,
        path,
        value
      });
    },

    async readHeadCommit() {
      return git.resolveRef({
        ...repoOptions,
        ref: "HEAD"
      });
    },

    async readShortCommit(revision = "HEAD") {
      let oid = revision;

      if (!COMMIT_HASH_PATTERN.test(revision) || revision.length < 40) {
        oid = await git.resolveRef({
          ...repoOptions,
          ref: revision
        });
      } else {
        oid = await git.expandOid({
          ...repoOptions,
          oid: revision
        });
      }

      return shortenOid(oid);
    },

    async resolveTagRevision(tagName) {
      try {
        const tagOid = await git.resolveRef({
          ...repoOptions,
          ref: `refs/tags/${tagName}`
        });
        const { oid } = await git.readCommit({
          ...repoOptions,
          oid: tagOid
        });

        return oid;
      } catch {
        return null;
      }
    },

    async resolveCommitRevision(target) {
      if (!COMMIT_HASH_PATTERN.test(target)) {
        return null;
      }

      try {
        const oid = await git.expandOid({
          ...repoOptions,
          oid: target
        });

        await git.readCommit({
          ...repoOptions,
          oid
        });

        return oid;
      } catch {
        return null;
      }
    },

    async checkoutBranch(remoteName, branchName) {
      await git.checkout({
        ...repoOptions,
        remote: remoteName,
        ref: branchName,
        force: true,
        track: true
      });
    },

    async fastForward(remoteName, branchName) {
      const localRef = `refs/heads/${branchName}`;
      const remoteRef = `refs/remotes/${remoteName}/${branchName}`;
      const localOid = await git.resolveRef({
        ...repoOptions,
        ref: localRef
      });
      const remoteOid = await git.resolveRef({
        ...repoOptions,
        ref: remoteRef
      });

      if (localOid === remoteOid) {
        return;
      }

      const canFastForward = await git.isDescendent({
        ...repoOptions,
        oid: remoteOid,
        ancestor: localOid
      });

      if (!canFastForward) {
        throw new Error(`Could not fast-forward ${branchName} to ${remoteName}/${branchName}.`);
      }

      await git.writeRef({
        ...repoOptions,
        ref: localRef,
        value: remoteOid,
        force: true
      });

      await git.checkout({
        ...repoOptions,
        ref: branchName,
        force: true
      });
    },

    async hardReset(revision) {
      const currentBranch = await git.currentBranch({
        ...repoOptions,
        test: true
      });

      if (currentBranch) {
        await git.writeRef({
          ...repoOptions,
          ref: `refs/heads/${currentBranch}`,
          value: revision,
          force: true
        });

        await git.checkout({
          ...repoOptions,
          ref: currentBranch,
          force: true
        });
        return;
      }

      await git.writeRef({
        ...repoOptions,
        ref: "HEAD",
        value: revision,
        force: true,
        symbolic: false
      });

      await git.checkout({
        ...repoOptions,
        force: true
      });
    },

    async checkoutDetached(revision) {
      await git.writeRef({
        ...repoOptions,
        ref: "HEAD",
        value: revision,
        force: true,
        symbolic: false
      });

      await git.checkout({
        ...repoOptions,
        force: true
      });
    }
  };

  return createAvailableBackendResult("isomorphic", client);
}

export async function createIsomorphicGitCloneClient() {
  let modules;
  try {
    modules = await resolveIsomorphicModules();
  } catch (error) {
    return createUnavailableBackendResult("isomorphic", error.message);
  }

  const { git, http } = modules;
  const client = {
    name: "isomorphic",
    label: "isomorphic-git backend",

    async cloneRepository({ authOptions = {}, remoteUrl, targetDir }) {
      const repoOptions = createTargetRepoOptions(targetDir);
      const transportUrl = normalizeRemoteUrl(remoteUrl);
      const auth = buildHttpAuthOptions(remoteUrl, authOptions);

      await fs.promises.mkdir(targetDir, { recursive: true });
      await git.clone({
        ...repoOptions,
        http,
        remote: "origin",
        url: transportUrl,
        ...(auth.onAuth ? { onAuth: auth.onAuth } : {})
      });

      await git.setConfig({
        ...repoOptions,
        path: "remote.origin.url",
        value: sanitizeRemoteUrl(remoteUrl)
      });
    }
  };

  return createAvailableBackendResult("isomorphic", client);
}

export async function createIsomorphicGitHistoryClient({ repoRoot }) {
  let modules;
  try {
    modules = await resolveIsomorphicModules();
  } catch (error) {
    return createUnavailableBackendResult("isomorphic", error.message);
  }

  const { diff3Merge, git } = modules;
  const resolvedRepoRoot = path.resolve(String(repoRoot || ""));
  const repoOptions = createHistoryRepoOptions(resolvedRepoRoot);

  async function ensureHistoryRepository() {
    await ensureIsomorphicRepository(git, resolvedRepoRoot, repoOptions);
  }

  function runTask(task) {
    return runQueuedIsomorphicLocalHistoryRepoTask(resolvedRepoRoot, task);
  }

  try {
    await ensureHistoryRepository();
  } catch (error) {
    return createUnavailableBackendResult("isomorphic", error.message);
  }

  const client = {
    name: "isomorphic",
    label: "isomorphic-git backend",

    async ensureRepository() {
      return runTask(async () => {
        await ensureHistoryRepository();
      });
    },

    async commitAll(options = {}) {
      return runTask(async () => {
        await ensureHistoryRepository();

        const ignoredPaths = [...normalizeHistoryIgnoredPaths(options.ignoredPaths)];
        const stagedFiles = await stageIsomorphicHistoryChanges(
          git,
          repoOptions,
          ignoredPaths,
          options.changedPathsHint
        );
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

        const hash = await git.commit({
          ...repoOptions,
          author: {
            email: String(options.authorEmail || "constellation-agent@local"),
            name: String(options.authorName || "Constellation Agent")
          },
          committer: {
            email: String(options.authorEmail || "constellation-agent@local"),
            name: String(options.authorName || "Constellation Agent")
          },
          message: String(options.message || "Update customware history")
        });
        invalidateIsomorphicHistoryEntriesCache(resolvedRepoRoot);

        return {
          backend: this.name,
          changedFiles,
          committed: true,
          hash,
          shortHash: shortenOid(hash)
        };
      });
    },

    async listCommits(options = {}) {
      return runTask(async () => {
        await ensureHistoryRepository();

        const limit = Math.max(1, Math.min(500, Number(options.limit) || 50));
        const offset = Math.max(0, Number(options.offset) || 0);
        let entries;

        try {
          entries = await readAllIsomorphicHistoryEntries(git, repoOptions, resolvedRepoRoot);
        } catch {
          return {
            commits: [],
            currentHash: "",
            hasMore: false,
            limit,
            offset,
            total: 0
          };
        }

        if (!entries.length) {
          return {
            commits: [],
            currentHash: "",
            hasMore: false,
            limit,
            offset,
            total: 0
          };
        }

        const fileFilter = String(options.fileFilter || "").trim().toLowerCase();

        if (!fileFilter) {
          const pageEntries = entries.slice(offset, offset + limit);
          const [currentHash, commits] = await Promise.all([
            readIsomorphicHistoryHead(git, repoOptions),
            Promise.all(
              pageEntries.map((entry) => createIsomorphicCommitListEntry(git, repoOptions, resolvedRepoRoot, entry, options.ignoredPaths))
            )
          ]);

          return {
            commits,
            currentHash,
            hasMore: entries.length > offset + limit,
            limit,
            offset,
            total: entries.length
          };
        }

        const currentHashPromise = readIsomorphicHistoryHead(git, repoOptions);
        const commits = [];
        let matchedCount = 0;
        let hasMore = false;

        for (const entry of entries) {
          const commit = await createIsomorphicCommitListEntry(git, repoOptions, resolvedRepoRoot, entry, options.ignoredPaths);

          if (!matchesIsomorphicCommitFileFilter(commit, fileFilter)) {
            continue;
          }

          if (matchedCount < offset) {
            matchedCount += 1;
            continue;
          }

          if (commits.length < limit) {
            commits.push(commit);
            matchedCount += 1;
            continue;
          }

          hasMore = true;
          matchedCount += 1;
          break;
        }

        return {
          commits,
          currentHash: await currentHashPromise,
          hasMore,
          limit,
          offset,
          total: hasMore ? null : matchedCount
        };
      });
    },

    async getCommitDiff(options = {}) {
      return runTask(async () => {
        await ensureHistoryRepository();

        const hash = await resolveIsomorphicCommit(git, repoOptions, String(options.commitHash || ""));
        const commit = await git.readCommit({
          ...repoOptions,
          oid: hash
        });
        const parentOid = commit.commit.parent?.[0] || "";
        const diff = await readIsomorphicFileDiff(
          git,
          repoOptions,
          resolvedRepoRoot,
          parentOid,
          hash,
          options.filePath || options.path || ""
        );

        return {
          backend: this.name,
          file: diff.file,
          hash,
          patch: diff.patch,
          shortHash: shortenOid(hash)
        };
      });
    },

    async previewOperation(options = {}) {
      return runTask(async () => {
        await ensureHistoryRepository();

        const operation = normalizeHistoryPreviewOperation(options.operation);
        const hash = await resolveIsomorphicCommit(git, repoOptions, String(options.commitHash || ""));
        const commit = await git.readCommit({
          ...repoOptions,
          oid: hash
        });
        const currentHash = await readIsomorphicHistoryHead(git, repoOptions);
        const filePath = options.filePath ? normalizeHistoryDiffPath(options.filePath) : "";

        if (operation === "revert") {
          const files = (await readIsomorphicCommitFiles(git, repoOptions, resolvedRepoRoot, commit, options.ignoredPaths)).map(
            invertHistoryFileEntry
          );
          const diff = filePath
            ? await readIsomorphicFileDiff(git, repoOptions, resolvedRepoRoot, hash, commit.commit.parent?.[0] || "", filePath)
            : { patch: "" };

          return {
            backend: this.name,
            changedFiles: getHistoryChangedFilePaths(files),
            currentHash,
            file: filePath ? findHistoryFileEntry(files, filePath) : null,
            files,
            hash,
            operation,
            patch: diff.patch,
            shortHash: shortenOid(hash)
          };
        }

        const files = currentHash
          ? diffIsomorphicSnapshots(
              ...(await Promise.all([
                readIsomorphicTreeFiles(git, repoOptions, resolvedRepoRoot, currentHash),
                readIsomorphicTreeFiles(git, repoOptions, resolvedRepoRoot, hash)
              ])),
              options.ignoredPaths
            )
          : [];
        const diff = currentHash && filePath
          ? await readIsomorphicFileDiff(git, repoOptions, resolvedRepoRoot, currentHash, hash, filePath)
          : { patch: "" };

        return {
          backend: this.name,
          changedFiles: getHistoryChangedFilePaths(files),
          currentHash,
          file: filePath ? findHistoryFileEntry(files, filePath) : null,
          files,
          hash,
          operation,
          patch: diff.patch,
          shortHash: shortenOid(hash)
        };
      });
    },

    async rollbackToCommit(options = {}) {
      return runTask(async () => {
        await ensureHistoryRepository();

        const hash = await resolveIsomorphicCommit(git, repoOptions, String(options.commitHash || ""));
        await git.readCommit({
          ...repoOptions,
          oid: hash
        });

        const currentHash = await readIsomorphicHistoryHead(git, repoOptions);
        if (currentHash && currentHash !== hash) {
          await preserveIsomorphicHistoryHeadRef(git, repoOptions, "rollback");
        }

        const currentBranch = await git.currentBranch({
          ...repoOptions,
          test: true
        });

        if (currentBranch) {
          await git.writeRef({
            ...repoOptions,
            force: true,
            ref: "refs/heads/" + currentBranch,
            value: hash
          });

          await git.checkout({
            ...repoOptions,
            force: true,
            ref: currentBranch
          });
        } else {
          await git.writeRef({
            ...repoOptions,
            force: true,
            ref: "HEAD",
            symbolic: false,
            value: hash
          });

          await git.checkout({
            ...repoOptions,
            force: true
          });
        }

        return {
          backend: this.name,
          hash,
          shortHash: shortenOid(hash)
        };
      });
    },

    async revertCommit(options = {}) {
      return runTask(async () => {
        await ensureHistoryRepository();

        const hash = await resolveIsomorphicCommit(git, repoOptions, String(options.commitHash || ""));
        const commit = await git.readCommit({
          ...repoOptions,
          oid: hash
        });
        const parentOid = commit.commit.parent?.[0] || "";
        const currentHash = await readIsomorphicHistoryHead(git, repoOptions);

        if (!currentHash) {
          throw createIsomorphicHistoryError("Commit revert requires a current Git HEAD.", 409);
        }

        const [currentFiles, targetFiles, parentFiles, files] = await Promise.all([
          readIsomorphicTreeFiles(git, repoOptions, resolvedRepoRoot, currentHash),
          readIsomorphicTreeFiles(git, repoOptions, resolvedRepoRoot, hash),
          readIsomorphicTreeFiles(git, repoOptions, resolvedRepoRoot, parentOid),
          readIsomorphicCommitFiles(git, repoOptions, resolvedRepoRoot, commit, options.ignoredPaths)
        ]);
        const operations = await Promise.all(
          files.map(async (file) => {
            const currentFile = currentFiles.get(file.path) || null;
            const targetFile = targetFiles.get(file.path) || null;
            const parentFile = parentFiles.get(file.path) || null;
            const [currentText, targetText, parentText] = await Promise.all([
              currentFile ? readIsomorphicBlobText(git, repoOptions, currentHash, file.path) : "",
              targetFile ? readIsomorphicBlobText(git, repoOptions, hash, file.path) : "",
              parentFile ? readIsomorphicBlobText(git, repoOptions, parentOid, file.path) : ""
            ]);
            const mergedRevert = mergeIsomorphicRevertText(diff3Merge, currentText, targetText, parentText);

            if (!mergedRevert.cleanMerge) {
              throw createIsomorphicHistoryError(
                "Commit revert cannot apply cleanly for " + file.path +
                  " with the isomorphic-git backend. HEAD " + shortenOid(currentHash) +
                  " has blob " + describeIsomorphicBlobLabel(currentFile) +
                  ", commit " + shortenOid(hash) +
                  " has blob " + describeIsomorphicBlobLabel(targetFile) +
                  ", and revert wants parent blob " + describeIsomorphicBlobLabel(parentFile) + ".",
                409
              );
            }

            if (!parentFile) {
              return {
                filepath: file.path,
                type: "delete"
              };
            }

            return {
              content: mergedRevert.mergedText,
              filepath: file.path,
              type: "write"
            };
          })
        );

        await preserveIsomorphicHistoryHeadRef(git, repoOptions, "revert");
        await applyIsomorphicFileWrites(resolvedRepoRoot, operations);

        const stagedFiles = await stageIsomorphicHistoryChanges(git, repoOptions, options.ignoredPaths);
        if (stagedFiles.length === 0) {
          throw createIsomorphicHistoryError("Commit revert produced no changes.", 409);
        }

        const summary = String(commit.commit.message || "").split("\n")[0].trim();
        const nextHash = await git.commit({
          ...repoOptions,
          author: {
            email: String(options.authorEmail || "constellation-agent@local"),
            name: String(options.authorName || "Constellation Agent")
          },
          committer: {
            email: String(options.authorEmail || "constellation-agent@local"),
            name: String(options.authorName || "Constellation Agent")
          },
          message: summary ? `Revert "${summary}"` : "Revert " + shortenOid(hash)
        });
        invalidateIsomorphicHistoryEntriesCache(resolvedRepoRoot);

        return {
          backend: this.name,
          hash: nextHash,
          revertedHash: hash,
          shortHash: shortenOid(nextHash)
        };
      });
    }
  };

  return createAvailableBackendResult("isomorphic", client);
}
