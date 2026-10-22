import path from "node:path";
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const {
  PROJECT_ROOT,
  loadPackagingDependency
} = require("../packaging/scripts/tooling.js");

const HARNESS_ENTRY_PATH = path.join(PROJECT_ROOT, "tests", "browser_component_harness", "main.cjs");
const PARENT_IPC_ENV = "SPACE_BROWSER_COMPONENT_HARNESS_PARENT_IPC";
const OPEN_DEVTOOLS_ENV = "SPACE_BROWSER_COMPONENT_HARNESS_OPEN_DEVTOOLS";
const DEFAULT_HARNESS_TIMEOUT_MS = 10_000;

export function startHttpServer(requestHandler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(requestHandler);

    server.once("error", reject);
    server.listen(0, () => {
      resolve(server);
    });
  });
}

export async function stopHttpServer(server) {
  if (!server?.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function runBrowserHarnessCli(commands, { timeoutMs = 30_000 } = {}) {
  const child = spawn("node", ["tests/browser_component_harness_cli.mjs"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk || ""));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk || ""));
  });

  child.stdin.end(commands);

  try {
    const exitCode = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          resolve(code ?? 0);
        });
      }),
      delay(timeoutMs).then(() => {
        throw new Error(`browser_component_harness_cli timed out after ${timeoutMs}ms`);
      })
    ]);

    return {
      exitCode,
      stderr: stderrChunks.join(""),
      stdout: stdoutChunks.join("")
    };
  } finally {
    if (!child.killed && child.exitCode == null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(5_000)
      ]);
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGKILL");
      }
    }
  }
}

function createRequestId() {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `browser-component-harness-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function commandExists(command) {
  return await new Promise((resolve) => {
    execFile("bash", ["-lc", `command -v ${command} || true`], (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }

      resolve(String(stdout || "").trim());
    });
  });
}

async function startVirtualDisplay() {
  const existingDisplay = String(process.env.DISPLAY || "").trim();
  if (existingDisplay) {
    return {
      display: existingDisplay,
      process: null
    };
  }

  const displayBinary = await commandExists("Xvfb");
  if (!displayBinary) {
    throw new Error("No DISPLAY is set and Xvfb is not installed.");
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const displayNumber = 90 + Math.floor(Math.random() * 400);
    const display = `:${displayNumber}`;
    const xvfb = spawn(displayBinary, [
      display,
      "-screen",
      "0",
      "1440x900x24",
      "-nolisten",
      "tcp"
    ], {
      stdio: "ignore"
    });

    await delay(1000);

    if (xvfb.exitCode == null) {
      return {
        display,
        process: xvfb
      };
    }
  }

  throw new Error("Xvfb exited before the browser component harness could start.");
}

async function stopVirtualDisplay(display) {
  const xvfb = display?.process;
  if (!xvfb || xvfb.killed) {
    return;
  }

  xvfb.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => {
      xvfb.once("exit", resolve);
    }),
    delay(5000)
  ]);
}

function spawnBrowserHarness(display, { openDevTools = false } = {}) {
  const electronBinary = loadPackagingDependency("electron");
  return spawn(electronBinary, [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    HARNESS_ENTRY_PATH
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DISPLAY: display.display,
      [OPEN_DEVTOOLS_ENV]: openDevTools ? "1" : "",
      [PARENT_IPC_ENV]: "1"
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
}

async function waitForHarnessReady(child, timeoutMs = DEFAULT_HARNESS_TIMEOUT_MS) {
  return await new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error(`Harness did not become ready within ${timeoutMs}ms.`));
    }, timeoutMs);

    const handleMessage = (payload = {}) => {
      if (String(payload?.type || "") !== "ready") {
        return;
      }

      cleanup();
      if (payload?.error) {
        reject(new Error(String(payload.error.message || "Harness failed to become ready.")));
        return;
      }

      resolve(payload?.probe ?? null);
    };

    const handleExit = (code) => {
      cleanup();
      reject(new Error(`Harness exited before becoming ready (code ${code ?? 0}).`));
    };

    const cleanup = () => {
      globalThis.clearTimeout(timer);
      child.off("message", handleMessage);
      child.off("exit", handleExit);
    };

    child.on("message", handleMessage);
    child.on("exit", handleExit);
  });
}

export async function startBrowserHarness({
  openDevTools = false,
  timeoutMs = DEFAULT_HARNESS_TIMEOUT_MS
} = {}) {
  const display = await startVirtualDisplay();
  const child = spawnBrowserHarness(display, {
    openDevTools
  });
  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout?.on("data", (chunk) => {
    stdoutChunks.push(String(chunk || ""));
  });
  child.stderr?.on("data", (chunk) => {
    stderrChunks.push(String(chunk || ""));
  });

  try {
    const probe = await waitForHarnessReady(child, timeoutMs);
    return {
      child,
      display,
      probe,
      stderrChunks,
      stdoutChunks
    };
  } catch (error) {
    await stopBrowserHarness({
      child,
      display,
      stderrChunks,
      stdoutChunks
    });
    throw error;
  }
}

export async function sendBrowserHarnessCommand(harness, command, args = [], {
  timeoutMs = DEFAULT_HARNESS_TIMEOUT_MS
} = {}) {
  const child = harness?.child;
  if (!child) {
    throw new Error("Browser harness is not running.");
  }

  const requestId = createRequestId();

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(`Harness command "${command}" timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const handleMessage = (payload = {}) => {
      if (String(payload?.type || "") !== "command_result" || String(payload?.requestId || "") !== requestId) {
        return;
      }

      settled = true;
      cleanup();
      if (payload?.ok === false) {
        const error = new Error(String(payload?.error?.message || `Harness command "${command}" failed.`));
        error.code = payload?.error?.code ?? null;
        error.details = payload?.error?.details ?? null;
        error.payload = payload?.error ?? null;
        reject(error);
        return;
      }

      resolve(payload?.result ?? null);
    };

    const handleExit = (code) => {
      settled = true;
      cleanup();
      reject(new Error(`Harness exited while waiting for "${command}" (code ${code ?? 0}).`));
    };

    const handleError = (error) => {
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error || `Harness command "${command}" failed.`)));
    };

    const cleanup = () => {
      globalThis.clearTimeout(timer);
      child.off("message", handleMessage);
      child.off("exit", handleExit);
      child.off("error", handleError);
    };

    child.on("message", handleMessage);
    child.on("exit", handleExit);
    child.on("error", handleError);

    if (!child.connected) {
      cleanup();
      reject(new Error(`Harness IPC channel is closed before "${command}" could be sent.`));
      return;
    }

    child.send({
      args,
      command,
      requestId,
      type: "command"
    }, (error) => {
      if (!error || settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    });
  });
}

export function readBrowserHarnessLogs(harness) {
  return {
    stderr: Array.isArray(harness?.stderrChunks) ? harness.stderrChunks.join("") : "",
    stdout: Array.isArray(harness?.stdoutChunks) ? harness.stdoutChunks.join("") : ""
  };
}

export async function stopBrowserHarness(harness, {
  forceAfterMs = 5000
} = {}) {
  const child = harness?.child;
  const display = harness?.display;

  try {
    if (child && child.exitCode == null && !child.killed) {
      const exitPromise = new Promise((resolve) => {
        child.once("exit", resolve);
      });

      if (child.connected) {
        try {
          child.send({
            args: [],
            command: "quit",
            requestId: createRequestId(),
            type: "command"
          });
        } catch {
          child.kill("SIGTERM");
        }
      } else {
        child.kill("SIGTERM");
      }

      await Promise.race([
        exitPromise,
        delay(forceAfterMs)
      ]);

      if (child.exitCode == null && !child.killed) {
        child.kill("SIGTERM");
        await Promise.race([
          exitPromise,
          delay(5000)
        ]);
      }

      if (child.exitCode == null && !child.killed) {
        child.kill("SIGKILL");
      }
    }
  } finally {
    await stopVirtualDisplay(display);
  }
}
