import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const {
  PROJECT_ROOT,
  loadPackagingDependency
} = require("../packaging/scripts/tooling.js");

const HARNESS_ENTRY_PATH = path.join(PROJECT_ROOT, "tests", "browser_component_harness", "main.cjs");
const RESULT_PREFIX = "[desktop-browser-harness-result] ";
const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;

function createError(message, details = null) {
  const error = new Error(message);
  if (details && typeof details === "object") {
    error.details = details;
  }
  return error;
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
    throw createError("No DISPLAY is set and Xvfb is not installed.");
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

  throw createError("Xvfb exited before the standalone browser harness could start.");
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

function parseHarnessResult(output) {
  const lines = String(output || "")
    .split(/\r?\n/u)
    .filter(Boolean);
  const resultLine = [...lines].reverse().find((line) => line.startsWith(RESULT_PREFIX));
  if (!resultLine) {
    return null;
  }

  return JSON.parse(resultLine.slice(RESULT_PREFIX.length));
}

export async function runDesktopBrowserHarnessTest({
  openDevTools = false,
  scenario = "novinkyConsent",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  verbose = false
} = {}) {
  const electronBinary = loadPackagingDependency("electron");
  const display = await startVirtualDisplay();
  const stdoutChunks = [];
  const stderrChunks = [];

  const child = spawn(electronBinary, [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    HARNESS_ENTRY_PATH
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DISPLAY: display.display,
      SPACE_BROWSER_COMPONENT_HARNESS_SCENARIO: scenario,
      SPACE_BROWSER_COMPONENT_HARNESS_OPEN_DEVTOOLS: openDevTools ? "1" : ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout?.on("data", (chunk) => {
    const text = String(chunk || "");
    stdoutChunks.push(text);
    if (verbose && text) {
      process.stdout.write(text);
    }
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk || "");
    stderrChunks.push(text);
    if (verbose && text) {
      process.stderr.write(text);
    }
  });

  try {
    const exitCode = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          resolve(code ?? 0);
        });
      }),
      delay(timeoutMs).then(() => {
        throw createError("Standalone desktop browser harness timed out.", {
          timeoutMs
        });
      })
    ]);

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");
    const result = parseHarnessResult(`${stdout}\n${stderr}`);

    if (exitCode !== 0) {
      throw createError("Standalone desktop browser harness Electron run failed.", {
        exitCode,
        result,
        stderr,
        stdout
      });
    }

    if (!result || result.success !== true) {
      throw createError("Standalone desktop browser harness Electron run did not produce a success result.", {
        result,
        stderr,
        stdout
      });
    }

    return result;
  } finally {
    if (!child.killed && child.exitCode == null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(5000)
      ]);
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGKILL");
      }
    }

    await stopVirtualDisplay(display);
  }
}
