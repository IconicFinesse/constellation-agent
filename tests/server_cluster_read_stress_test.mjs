#!/usr/bin/env node

import cluster from "node:cluster";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { startServer } from "../server/server.js";

const execFileAsync = promisify(execFile);
const DEFAULT_WORKERS = 4;
const DEFAULT_REQUESTS = 500;
const DEFAULT_CONCURRENCY = 64;
const DEFAULT_FILES_PER_DIRECTORY = 200;
const DEFAULT_USER_COUNT = 1;
const DEFAULT_SEED_FILES = 25;
const DEFAULT_MODULE_FILES_PER_USER = 4;
const DEFAULT_STARTUP_THRESHOLD_MS = 30_000;
const DEFAULT_MODE = "mixed";
const DEFAULT_CONNECTION_MODE = "close";

const MOD_FETCH_TARGETS = [
  "/modules/_core/framework/js/initFw.js",
  "/modules/_core/framework/js/moduleResolution.js",
  "/modules/_core/framework/css/index.css",
  "/modules/_core/onscreen_agent/store.js",
  "/modules/_core/skillset/skills.js"
];

const FILE_PATH_PATTERNS = [
  "modules/*/*/ext/panels/*.yaml",
  "modules/*/*/ext/skills/*/SKILL.md",
  "modules/*/*/**/*.js",
  "modules/*/*/**/*.css"
];

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = String(argv[index] || "");

    if (!entry.startsWith("--")) {
      continue;
    }

    const key = entry.slice(2).replace(/-/g, "_");
    const next = argv[index + 1];

    if (!next || String(next).startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function parseInteger(value, label, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Math.floor(Number(value));

  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }

  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected a boolean value, received "${value}".`);
}

function normalizeMode(value) {
  const mode = String(value || DEFAULT_MODE).trim().toLowerCase();

  if (["mod", "file-paths", "mixed"].includes(mode)) {
    return mode;
  }

  throw new Error(`Unsupported mode "${value}". Expected mod, file-paths, or mixed.`);
}

function normalizeConnectionMode(value) {
  const mode = String(value || DEFAULT_CONNECTION_MODE).trim().toLowerCase();

  if (["close", "keep-alive"].includes(mode)) {
    return mode;
  }

  throw new Error(`Unsupported connection mode "${value}". Expected close or keep-alive.`);
}

function createConnectionHeaders(connectionMode) {
  return connectionMode === "close"
    ? {
        connection: "close"
      }
    : {};
}

function summarizeWorkerHits(workerHits = {}) {
  return Object.entries(workerHits)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([workerNumber, count]) => `${workerNumber}:${count}`)
    .join(" ");
}

async function getClockTicksPerSecond() {
  try {
    const { stdout } = await execFileAsync("getconf", ["CLK_TCK"]);
    const ticks = Number(String(stdout || "").trim());
    return Number.isFinite(ticks) && ticks > 0 ? ticks : 100;
  } catch {
    return 100;
  }
}

async function readLinuxCpuTicks(pid) {
  try {
    const statText = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = statText
      .slice(statText.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);

    return Number(fields[11] || 0) + Number(fields[12] || 0);
  } catch {
    return null;
  }
}

async function readProcSnapshots(pids = []) {
  const entries = await Promise.all(
    pids.map(async (pid) => [pid, await readLinuxCpuTicks(pid)])
  );

  return Object.fromEntries(entries);
}

function computeProcessCpuMetrics(before = {}, after = {}, elapsedMs, clockTicksPerSecond) {
  const metrics = Object.create(null);

  for (const pid of Object.keys(after)) {
    const beforeTicks = Number(before[pid]);
    const afterTicks = Number(after[pid]);

    if (!Number.isFinite(beforeTicks) || !Number.isFinite(afterTicks)) {
      metrics[pid] = null;
      continue;
    }

    const cpuMs = ((afterTicks - beforeTicks) * 1000) / clockTicksPerSecond;
    metrics[pid] = {
      corePct: elapsedMs > 0 ? (cpuMs / elapsedMs) * 100 : 0,
      cpuMs
    };
  }

  return metrics;
}

async function ensureBenchmarkTree(customwarePath) {
  await fs.mkdir(path.join(customwarePath, "L2"), { recursive: true });
}

function createBenchmarkUsernames(userCount) {
  const normalizedUserCount = Math.max(1, Number(userCount) || 1);

  if (normalizedUserCount === 1) {
    return ["user"];
  }

  const remainingCount = normalizedUserCount - 1;
  const width = Math.max(4, String(remainingCount).length);
  const otherUsers = Array.from({ length: remainingCount }, (_, index) =>
    `user-${String(index + 1).padStart(width, "0")}`
  );

  return ["user", ...otherUsers];
}

async function seedBenchmarkFiles(
  customwarePath,
  seedCount,
  filesPerDirectory,
  moduleFilesPerUser,
  usernames = []
) {
  await ensureBenchmarkTree(customwarePath);

  const writes = [];

  for (const username of usernames) {
    const userRoot = path.join(customwarePath, "L2", username);
    const seedRoot = path.join(userRoot, "seed");
    const moduleRoot = path.join(userRoot, "modules", "readbench", username);

    writes.push(
      fs.mkdir(userRoot, { recursive: true }).then(() =>
        fs.writeFile(path.join(userRoot, "user.yaml"), `full_name: ${username}\n`)
      )
    );

    for (let index = 0; index < seedCount; index += 1) {
      const directoryPath = path.join(seedRoot, `d${Math.floor(index / filesPerDirectory)}`);
      const filePath = path.join(directoryPath, `f${index}.txt`);

      writes.push(
        fs
          .mkdir(directoryPath, { recursive: true })
          .then(() => fs.writeFile(filePath, `seed-${username}-${index}`))
      );
    }

    if (moduleFilesPerUser > 0) {
      writes.push(
        fs.mkdir(path.join(moduleRoot, "ext", "panels"), { recursive: true }).then(() =>
          fs.writeFile(
            path.join(moduleRoot, "ext", "panels", "panel.yaml"),
            `id: readbench-${username}\n`
          )
        )
      );
    }

    if (moduleFilesPerUser > 1) {
      writes.push(
        fs.mkdir(moduleRoot, { recursive: true }).then(() =>
          fs.writeFile(
            path.join(moduleRoot, "main.js"),
            `export const owner = ${JSON.stringify(username)};\n`
          )
        )
      );
    }

    if (moduleFilesPerUser > 2) {
      writes.push(
        fs.mkdir(moduleRoot, { recursive: true }).then(() =>
          fs.writeFile(path.join(moduleRoot, "style.css"), `.readbench-${username} { color: #123; }\n`)
        )
      );
    }

    if (moduleFilesPerUser > 3) {
      writes.push(
        fs.mkdir(path.join(moduleRoot, "ext", "skills", "bench"), { recursive: true }).then(() =>
          fs.writeFile(
            path.join(moduleRoot, "ext", "skills", "bench", "SKILL.md"),
            `# Readbench ${username}\n`
          )
        )
      );
    }
  }

  await Promise.all(writes);
}

function countIndexedUserRoots(pathIndex = Object.create(null)) {
  const usernames = new Set();

  Object.keys(pathIndex || Object.create(null)).forEach((projectPath) => {
    const match = String(projectPath || "").match(/^\/app\/L2\/([^/]+)\/$/u);

    if (match?.[1]) {
      usernames.add(match[1]);
    }
  });

  return usernames.size;
}

async function startRuntimeWithMetrics(runtimeOverrides = {}) {
  const startedAt = performance.now();
  const primaryCpuStart = process.cpuUsage();
  const runtime = await startServer(runtimeOverrides);
  const elapsedMs = performance.now() - startedAt;
  const primaryCpuUsage = process.cpuUsage(primaryCpuStart);
  const pathIndex = runtime.watchdog?.getIndex?.("path_index") || Object.create(null);

  return {
    metrics: {
      indexedPathCount: Object.keys(pathIndex).length,
      indexedUserCount: countIndexedUserRoots(pathIndex),
      primaryCpuMs: (primaryCpuUsage.user + primaryCpuUsage.system) / 1000,
      startupElapsedMs: elapsedMs
    },
    runtime
  };
}

function createReadRequests(mode, requestCount, moduleFilesPerUser) {
  const userModuleTargets =
    moduleFilesPerUser > 1
      ? ["/modules/readbench/user/main.js"]
      : [];
  const modTargets = [...MOD_FETCH_TARGETS, ...userModuleTargets];

  return Array.from({ length: requestCount }, (_, index) => {
    if (mode === "file-paths") {
      return {
        index,
        operation: "file-paths"
      };
    }

    if (mode === "mod") {
      return {
        index,
        operation: "mod",
        path: modTargets[index % modTargets.length]
      };
    }

    if (index % 2 === 0) {
      return {
        index,
        operation: "mod",
        path: modTargets[Math.floor(index / 2) % modTargets.length]
      };
    }

    return {
      index,
      operation: "file-paths"
    };
  });
}

function countPatternMatches(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return 0;
  }

  return Object.values(payload).reduce(
    (count, paths) => count + (Array.isArray(paths) ? paths.length : 0),
    0
  );
}

async function readModRequest(baseUrl, request, connectionMode) {
  const response = await fetch(new URL(request.path, baseUrl), {
    headers: createConnectionHeaders(connectionMode)
  });
  const responseBuffer = await response.arrayBuffer();

  if (response.status !== 200) {
    const responseText = Buffer.from(responseBuffer).toString("utf8");
    throw new Error(`Mod fetch ${request.path} failed with ${response.status}: ${responseText}`);
  }

  return {
    bytes: responseBuffer.byteLength,
    matches: 1,
    workerNumber: Number(response.headers.get("Space-Worker") || 0)
  };
}

async function readFilePathsRequest(baseUrl, connectionMode) {
  const response = await fetch(new URL("/api/file_paths", baseUrl), {
    body: JSON.stringify({
      maxLayer: 2,
      patterns: FILE_PATH_PATTERNS
    }),
    headers: {
      ...createConnectionHeaders(connectionMode),
      "content-type": "application/json"
    },
    method: "POST"
  });
  const responseText = await response.text();

  if (response.status !== 200) {
    throw new Error(`file_paths failed with ${response.status}: ${responseText}`);
  }

  const payload = JSON.parse(responseText);

  return {
    bytes: Buffer.byteLength(responseText),
    matches: countPatternMatches(payload),
    workerNumber: Number(response.headers.get("Space-Worker") || 0)
  };
}

async function readRequest(baseUrl, request, connectionMode) {
  if (request.operation === "mod") {
    return readModRequest(baseUrl, request, connectionMode);
  }

  return readFilePathsRequest(baseUrl, connectionMode);
}

function percentile(latenciesMs, fraction) {
  if (latenciesMs.length === 0) {
    return 0;
  }

  const index = Math.min(
    latenciesMs.length - 1,
    Math.floor((latenciesMs.length - 1) * fraction)
  );
  return latenciesMs[index];
}

async function runConcurrentReads(baseUrl, requests, concurrency, connectionMode) {
  let nextIndex = 0;
  const latenciesMs = [];
  const workerHits = new Map();
  const operationHits = new Map();
  let bytesRead = 0;
  let matches = 0;

  async function runner() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= requests.length) {
        return;
      }

      const request = requests[currentIndex];
      const startedAt = performance.now();
      const result = await readRequest(baseUrl, request, connectionMode);
      const latencyMs = performance.now() - startedAt;

      latenciesMs.push(latencyMs);
      bytesRead += result.bytes;
      matches += result.matches;
      workerHits.set(result.workerNumber, (workerHits.get(result.workerNumber) || 0) + 1);
      operationHits.set(request.operation, (operationHits.get(request.operation) || 0) + 1);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests.length) }, () => runner())
  );

  latenciesMs.sort((left, right) => left - right);

  return {
    bytesRead,
    matches,
    operationHits: Object.fromEntries(
      [...operationHits.entries()].sort(([left], [right]) => left.localeCompare(right))
    ),
    p50Ms: percentile(latenciesMs, 0.5),
    p95Ms: percentile(latenciesMs, 0.95),
    p99Ms: percentile(latenciesMs, 0.99),
    requestCount: requests.length,
    workerHits: Object.fromEntries(
      [...workerHits.entries()].sort(([left], [right]) => left - right)
    )
  };
}

function buildScenarioAnalysis(result) {
  const primaryMetrics = result.processCpu?.[String(result.primaryPid)] || null;
  const workerMetrics = Object.entries(result.processCpu || {})
    .filter(([pid]) => Number(pid) !== result.primaryPid)
    .map(([, metrics]) => metrics)
    .filter(Boolean);
  const maxWorkerCorePct = workerMetrics.reduce(
    (current, metrics) => Math.max(current, Number(metrics?.corePct || 0)),
    0
  );

  if (result.mode === "file-paths") {
    return "Pattern listing scans indexed paths and applies access plus glob filters on the serving process.";
  }

  if (result.mode === "mod") {
    return "Module fetch resolution reads readable file-index shards, then streams the selected file.";
  }

  if (primaryMetrics && primaryMetrics.corePct >= 80 && maxWorkerCorePct <= 25) {
    return "Primary-bound mixed read workload.";
  }

  return "Mixed read workload split between module fetch and pattern listing paths.";
}

async function runScenario({
  clockTicksPerSecond,
  concurrency,
  connectionMode,
  filesPerDirectory,
  mode,
  moduleFilesPerUser,
  requests,
  seedFiles,
  startupThresholdMs,
  userCount,
  workers
}) {
  const customwarePath = await fs.mkdtemp(path.join(os.tmpdir(), "space-cluster-read-stress-"));
  const usernames = createBenchmarkUsernames(userCount);
  const requestTargets = createReadRequests(mode, requests, moduleFilesPerUser);
  const runtimeParamOverrides = {
    CUSTOMWARE_GIT_HISTORY: "false",
    CUSTOMWARE_PATH: customwarePath,
    CUSTOMWARE_WATCHDOG: "true",
    HOST: "127.0.0.1",
    PORT: "0",
    SINGLE_USER_APP: "true",
    WORKERS: String(workers)
  };
  let runtime = null;
  let primaryCpuStart = process.cpuUsage();

  try {
    await seedBenchmarkFiles(
      customwarePath,
      seedFiles,
      filesPerDirectory,
      moduleFilesPerUser,
      usernames
    );

    const startupResult = await startRuntimeWithMetrics({
      runtimeParamOverrides
    });
    runtime = startupResult.runtime;

    const workerPids = Object.values(cluster.workers || {})
      .map((worker) => worker?.process?.pid)
      .filter((pid) => Number.isFinite(pid));
    const expectedWorkerPids = workers > 1 ? workers : 0;

    if (workerPids.length !== expectedWorkerPids) {
      throw new Error(`Expected ${expectedWorkerPids} worker processes, started ${workerPids.length}.`);
    }

    const trackedPids = [process.pid, ...workerPids];
    const procCpuBefore = await readProcSnapshots(trackedPids);

    primaryCpuStart = process.cpuUsage();
    const startedAt = performance.now();
    const readResults = await runConcurrentReads(
      runtime.browserUrl,
      requestTargets,
      concurrency,
      connectionMode
    );
    const elapsedMs = performance.now() - startedAt;
    const primaryCpuUsage = process.cpuUsage(primaryCpuStart);
    const procCpuAfter = await readProcSnapshots(trackedPids);
    const processCpu = computeProcessCpuMetrics(
      procCpuBefore,
      procCpuAfter,
      elapsedMs,
      clockTicksPerSecond
    );
    const reachedWorkerCount = Object.keys(readResults.workerHits).length;

    if (workers > 1 && readResults.requestCount >= workers * 2 && reachedWorkerCount < 2) {
      throw new Error(`Expected reads to reach multiple workers, observed ${reachedWorkerCount}.`);
    }

    const result = {
      analysis: "",
      bytesRead: readResults.bytesRead,
      concurrency,
      connectionMode,
      elapsedMs,
      filesPerDirectory,
      matches: readResults.matches,
      mode,
      moduleFilesPerUser,
      operationHits: readResults.operationHits,
      p50Ms: readResults.p50Ms,
      p95Ms: readResults.p95Ms,
      p99Ms: readResults.p99Ms,
      primaryCpuMs: (primaryCpuUsage.user + primaryCpuUsage.system) / 1000,
      primaryPid: process.pid,
      processCpu,
      requests: readResults.requestCount,
      seedFiles,
      startup: {
        ...startupResult.metrics,
        timedOut: startupResult.metrics.startupElapsedMs > startupThresholdMs
      },
      throughputPerSec: readResults.requestCount / (elapsedMs / 1000),
      totalSeedFiles: (seedFiles + moduleFilesPerUser + 1) * usernames.length,
      userCount: usernames.length,
      workerHits: readResults.workerHits,
      workerPids,
      workers
    };

    result.analysis = buildScenarioAnalysis(result);

    return result;
  } finally {
    if (runtime) {
      await runtime.close();
    }

    await fs.rm(customwarePath, { force: true, recursive: true });
  }
}

function printHumanSummary(settings, result) {
  const primaryProcessCpu = result.processCpu?.[String(result.primaryPid)] || null;

  process.stdout.write("Clustered Read Stress Test\n");
  process.stdout.write(
    `mode=${settings.mode} workers=${settings.workers} requests=${settings.requests} concurrency=${settings.concurrency} connection=${settings.connectionMode}\n`
  );
  process.stdout.write(
    `users=${settings.userCount} seedFilesPerUser=${settings.seedFiles} moduleFilesPerUser=${settings.moduleFilesPerUser} startupThresholdMs=${settings.startupThresholdMs}\n\n`
  );
  process.stdout.write(
    [
      `startup=${result.startup.startupElapsedMs.toFixed(1)}ms${result.startup.timedOut ? " (exceeds threshold)" : ""}`,
      `elapsed=${result.elapsedMs.toFixed(1)}ms`,
      `throughput=${result.throughputPerSec.toFixed(1)} req/s`,
      `latency p50=${result.p50Ms.toFixed(1)}ms p95=${result.p95Ms.toFixed(1)}ms p99=${result.p99Ms.toFixed(1)}ms`,
      `primaryCpu=${result.primaryCpuMs.toFixed(1)}ms${primaryProcessCpu ? ` (${primaryProcessCpu.corePct.toFixed(1)}% core)` : ""}`,
      `bytes=${result.bytesRead}`,
      `matches=${result.matches}`,
      `indexedPaths=${result.startup.indexedPathCount}`,
      `indexedUsers=${result.startup.indexedUserCount}`,
      `workerHits=${summarizeWorkerHits(result.workerHits)}`,
      `operations=${Object.entries(result.operationHits)
        .map(([operation, count]) => `${operation}:${count}`)
        .join(" ")}`,
      `analysis=${result.analysis}`
    ].join(" | ") + "\n"
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workers = parseInteger(args.workers, "workers", DEFAULT_WORKERS);
  const requests = parseInteger(args.requests, "requests", DEFAULT_REQUESTS);
  const concurrency = parseInteger(args.concurrency, "concurrency", DEFAULT_CONCURRENCY);
  const filesPerDirectory = parseInteger(
    args.files_per_directory,
    "files-per-directory",
    DEFAULT_FILES_PER_DIRECTORY
  );
  const jsonOnly = parseBoolean(args.json, false);
  const mode = normalizeMode(args.mode);
  const connectionMode = normalizeConnectionMode(args.connection);
  const moduleFilesPerUser = parseInteger(
    args.module_files_per_user,
    "module-files-per-user",
    DEFAULT_MODULE_FILES_PER_USER
  );
  const seedFiles = parseInteger(args.seed_files, "seed-files", DEFAULT_SEED_FILES);
  const startupThresholdMs = parseInteger(
    args.startup_threshold_ms,
    "startup-threshold-ms",
    DEFAULT_STARTUP_THRESHOLD_MS
  );
  const userCount = parseInteger(args.user_count, "user-count", DEFAULT_USER_COUNT);

  if (workers < 1) {
    throw new Error("workers must be at least 1.");
  }

  if (
    requests <= 0 ||
    concurrency <= 0 ||
    filesPerDirectory <= 0 ||
    moduleFilesPerUser < 0 ||
    seedFiles < 0 ||
    userCount <= 0
  ) {
    throw new Error(
      "requests, concurrency, files-per-directory, and user-count must be positive, while seed-files and module-files-per-user must be non-negative."
    );
  }

  const clockTicksPerSecond = await getClockTicksPerSecond();
  const settings = {
    clockTicksPerSecond,
    concurrency,
    connectionMode,
    filesPerDirectory,
    mode,
    moduleFilesPerUser,
    requests,
    seedFiles,
    startupThresholdMs,
    userCount,
    workers
  };
  const result = await runScenario({
    clockTicksPerSecond,
    concurrency,
    connectionMode,
    filesPerDirectory,
    mode,
    moduleFilesPerUser,
    requests,
    seedFiles,
    startupThresholdMs,
    userCount,
    workers
  });

  if (!jsonOnly) {
    printHumanSummary(settings, result);
    process.stdout.write("\n");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        result,
        settings
      },
      null,
      2
    )}\n`
  );
}

await main();
