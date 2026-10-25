import { createIsomorphicGitHistoryClient } from "./isomorphic_handler.js";
import { createNativeGitHistoryClient } from "./native_handler.js";
import { COMMIT_HASH_PATTERN, resolveRequestedGitBackend } from "./shared.js";

const HISTORY_BACKEND_FACTORIES = {
  native: createNativeGitHistoryClient,
  isomorphic: createIsomorphicGitHistoryClient
};

const DEFAULT_HISTORY_BACKEND_ORDER = ["native", "isomorphic"];
const REQUIRED_HISTORY_METHODS = [
  "ensureRepository",
  "commitAll",
  "listCommits",
  "getCommitDiff",
  "previewOperation",
  "rollbackToCommit",
  "revertCommit"
];

function buildUnavailableBackendMessage(attempts) {
  return attempts
    .map((attempt) => `${attempt.name}: ${attempt.reason}`)
    .join("; ");
}

function resolveHistoryBackendOrder(options = {}) {
  const requestedBackend = resolveRequestedGitBackend(options);

  return {
    backendOrder: requestedBackend ? [requestedBackend] : DEFAULT_HISTORY_BACKEND_ORDER,
    requestedBackend
  };
}

function assertGitHistoryClient(client, backendName = "unknown") {
  if (!client || typeof client !== "object") {
    throw new Error(`Git history backend "${backendName}" returned an invalid client.`);
  }

  if (typeof client.name !== "string" || !client.name.trim()) {
    throw new Error(`Git history backend "${backendName}" did not provide a valid client name.`);
  }

  if (typeof client.label !== "string" || !client.label.trim()) {
    throw new Error(`Git history backend "${backendName}" did not provide a valid client label.`);
  }

  for (const methodName of REQUIRED_HISTORY_METHODS) {
    if (typeof client[methodName] !== "function") {
      throw new Error(`Git history backend "${backendName}" is missing required method "${methodName}".`);
    }
  }
}

function normalizeHistoryLimit(value, fallback = 50) {
  return Math.max(1, Math.min(500, Number(value) || fallback));
}

function normalizeHistoryOffset(value) {
  return Math.max(0, Number(value) || 0);
}

function normalizeCommitHash(value) {
  const commitHash = String(value || "").trim();

  if (!COMMIT_HASH_PATTERN.test(commitHash)) {
    // Malformed input is a different user mistake from an unknown commit (404):
    // reject it as a 400 at this single validation boundary shared by every
    // git-history operation and both backends.
    const error = new Error("A valid Git commit hash is required.");
    error.statusCode = 400;
    throw error;
  }

  return commitHash;
}

async function createLocalGitHistoryClient({ repoRoot, runtimeParams, backendName, env } = {}) {
  const { backendOrder, requestedBackend } = resolveHistoryBackendOrder({
    backendName,
    env,
    runtimeParams
  });
  const attempts = [];

  for (const backendName of backendOrder) {
    const result = await HISTORY_BACKEND_FACTORIES[backendName]({ repoRoot });
    attempts.push(result);

    if (result.available) {
      assertGitHistoryClient(result.client, backendName);
      return result.client;
    }
  }

  const message = buildUnavailableBackendMessage(attempts);
  if (requestedBackend) {
    throw new Error(`Requested git backend "${requestedBackend}" is not available for local history: ${message}`);
  }

  throw new Error(`Local Git history could not initialize a Git backend: ${message}`);
}

export {
  createLocalGitHistoryClient,
  normalizeCommitHash,
  normalizeHistoryLimit,
  normalizeHistoryOffset
};
