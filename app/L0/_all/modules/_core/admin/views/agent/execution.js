import {
  appendExecutionTextBlock,
  buildExecutionSourceUrl,
  createExecutionResultLinesFormatter,
  createExecutionValueFormatters,
  EXECUTION_WINDOW_ALIAS_KEYS as WINDOW_ALIAS_KEYS,
  flattenExecutionMessageValue,
  formatExecutionLogArgs,
  isConstructable,
  normalizeExecutionSource
} from "/modules/_core/framework/js/execution-format.js";
import {
  collectExecutionFenceRegions as sharedCollectExecutionFenceRegions,
  countExecutionSeparators as sharedCountExecutionSeparators,
  extractExecuteBlocks as sharedExtractExecuteBlocks,
  findExecutableSeparatorIndex as sharedFindExecutableSeparatorIndex,
  hasInlineExecutionSeparator as sharedHasInlineExecutionSeparator
} from "/modules/_core/framework/js/execution-blocks.js";

export const EXECUTION_SEPARATOR = "_____javascript";

const EXECUTION_CONTEXT_KEY = "__spaceAdminAgentExecutionContext";
const SHARED_STATE_KEY = "__spaceAdminAgentSharedState";
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "dir", "table", "assert"];
const INTERNAL_SCOPE_KEYS = new Set(["__spaceScope", "__spaceWindow"]);
// The value-rendering family is NOT this file's any more (P4b-2c): it lives once in
// `framework/js/execution-format.js` and is instantiated below with THIS surface's
// `sourceURL` prefix. The prefix is the whole parameterization — it names the executed
// block's source url AND decides which stack frames a rendered error keeps, so promoting
// the family with a hardcoded prefix would have stripped one surface's frames.

function isLoadedAdminSkill(value) {
  return Boolean(value?.__spaceAdminSkill) && typeof value?.content === "string" && typeof value?.path === "string";
}

function formatLoadedSkillResultText(skill) {
  const responseText = typeof skill?.loadResponseText === "string" ? skill.loadResponseText.trim() : "";
  return responseText || String(skill?.content || "").trim();
}

// The ONE console-value formatter family, parameterized by this surface's identity.
const ADMIN_SOURCE_URL_PREFIX = "space-admin-agent-execute";

const {
  formatError,
  formatExecutionResultValue,
  formatExecutionValue,
  isLoadedSkill
} = createExecutionValueFormatters({
  isLoadedSkill: isLoadedAdminSkill,
  sourceUrlPrefix: ADMIN_SOURCE_URL_PREFIX
});

// Extraction and separator accounting live in the shared fence-aware module so
// the admin and onscreen surfaces cannot drift apart on the display/execute
// contract. A separator inside a fenced region is display text and never starts
// an execution; see framework/js/execution-blocks.js.
export function extractExecuteBlocks(content) {
  return sharedExtractExecuteBlocks(content, EXECUTION_SEPARATOR);
}

// Display helpers split a reply at the separator before rendering it. They use the
// shared fence-aware index so a fenced display that merely SHOWS the separator is never
// cut in half.
//
// These two delegations exist because the Tier 1 turn driver takes both as INJECTED
// seams (BUG-007 preventers): the driver never keeps its own copy of fence logic, and
// admin must hand it the same shared classifier onscreen hands it.
export function findExecutableSeparatorIndex(content) {
  return sharedFindExecutableSeparatorIndex(content, EXECUTION_SEPARATOR);
}

export function findExecutionFenceRegions(content) {
  return sharedCollectExecutionFenceRegions(content);
}

function createAsyncRunner(code) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction(
    "__agentExecution",
    `
      const __spaceScope = __agentExecution.scope
      const __spaceWindow = __agentExecution.targetWindow
      return await (async function () {
        with (__spaceScope) {
${code}
        }
      }).call(__spaceWindow)
    `
  );
}

function tryCreateAsyncRunner(code) {
  try {
    createAsyncRunner(code);
    return null;
  } catch (error) {
    return error;
  }
}





function createConsoleRecorder(methodName, originalMethod, logs, targetWindow) {
  return (...args) => {
    if (methodName === "assert" && args[0]) {
      if (originalMethod) {
        originalMethod(...args);
      }

      return;
    }

    const logArgs = methodName === "assert" ? args.slice(1) : args;
    const text = formatExecutionLogArgs(logArgs, {
      formatFallback: (value, formatterOptions = {}) =>
        formatExecutionValue(value, {
          targetWindow: formatterOptions.targetWindow || targetWindow
        }),
      normalizeSpecialValue: (value) => {
        if (isLoadedSkill(value)) {
          return `[Loaded skill ${value.skillName || value.path}]`;
        }

        return undefined;
      },
      targetWindow
    });

    logs.push({
      level: methodName,
      text
    });

    if (!originalMethod) {
      return;
    }

    try {
      originalMethod(...args);
    } catch {
      // Ignore console implementation edge cases.
    }
  };
}

function patchConsole(targetWindow, logs) {
  if (!targetWindow.console) {
    return () => {};
  }

  const originalMethods = [];

  CONSOLE_METHODS.forEach((methodName) => {
    if (typeof targetWindow.console[methodName] !== "function") {
      return;
    }

    const originalMethod = targetWindow.console[methodName].bind(targetWindow.console);

    try {
      targetWindow.console[methodName] = createConsoleRecorder(methodName, originalMethod, logs, targetWindow);
      originalMethods.push([methodName, originalMethod]);
    } catch {
      // Ignore read-only console implementations.
    }
  });

  return () => {
    originalMethods.forEach(([methodName, originalMethod]) => {
      try {
        targetWindow.console[methodName] = originalMethod;
      } catch {
        // Ignore read-only console implementations.
      }
    });
  };
}


function getScopedWindowValue(targetWindow, key, boundWindowMethods) {
  const value = targetWindow[key];

  if (typeof value !== "function" || isConstructable(value)) {
    return value;
  }

  const cachedBoundMethod = boundWindowMethods.get(value);

  if (cachedBoundMethod) {
    return cachedBoundMethod;
  }

  const boundWindowMethod = value.bind(targetWindow);
  boundWindowMethods.set(value, boundWindowMethod);
  return boundWindowMethod;
}

function createExecutionScope(targetWindow, sharedState) {
  const boundWindowMethods = new WeakMap();

  return new Proxy(sharedState, {
    has(_target, key) {
      if (key === Symbol.unscopables) {
        return false;
      }

      return !(typeof key === "string" && INTERNAL_SCOPE_KEYS.has(key));
    },
    get(target, key) {
      if (key === Symbol.unscopables) {
        return undefined;
      }

      if (typeof key !== "string") {
        return Reflect.get(target, key);
      }

      if (WINDOW_ALIAS_KEYS.has(key)) {
        return targetWindow;
      }

      if (key === "document") {
        return targetWindow.document;
      }

      if (key === "console") {
        return targetWindow.console;
      }

      if (key === "space") {
        return targetWindow.space;
      }

      if (Reflect.has(target, key)) {
        return Reflect.get(target, key);
      }

      return getScopedWindowValue(targetWindow, key, boundWindowMethods);
    },
    set(target, key, value) {
      if (typeof key !== "string") {
        Reflect.set(target, key, value);
        return true;
      }

      if (key === "space" || WINDOW_ALIAS_KEYS.has(key) || key === "console" || key === "document") {
        return false;
      }

      if (Reflect.has(target, key)) {
        Reflect.set(target, key, value);
        return true;
      }

      if (key in targetWindow) {
        try {
          targetWindow[key] = value;
          return true;
        } catch {
          // Fall through to shared state when the window property is read-only.
        }
      }

      Reflect.set(target, key, value);
      return true;
    },
    deleteProperty(target, key) {
      if (Reflect.has(target, key)) {
        return Reflect.deleteProperty(target, key);
      }

      return true;
    }
  });
}




// The transcript SKELETON is the shared builder's (P4b-2c); what stays here is admin's
// FEATURE: a loaded admin skill IS the result, so it is painted (body plus provenance) and
// the builder stops instead of also painting a result block.
const formatExecutionResultLines = createExecutionResultLinesFormatter({
  appendSkillLines(lines, result) {
    if (!isLoadedSkill(result?.result)) {
      return false;
    }

    const loadedSkillResultText = formatLoadedSkillResultText(result.result);

    if (loadedSkillResultText) {
      appendExecutionTextBlock(lines, "result", loadedSkillResultText);
    }

    if (!result.result.loadResponseText) {
      lines.push(`skill path: ${result.result.path}`);
      lines.push("skill content:");
      lines.push(result.result.content);
    }

    return true;
  }
});

function createExecutionError(error) {
  return {
    message: error?.message || String(error),
    name: error?.name || "Error",
    stack: error?.stack || "",
    text: formatError(error)
  };
}

// A plan correction is a result, not a thrown error: it reaches the transcript
// through the same formatter as an execution failure, so the model sees the
// protocol correction on its next turn. This mirrors the onscreen surface.
function createPlanErrorResult(executionContext, message) {
  const error = new Error(message);
  error.name = "ExecutionPlanError";

  return {
    block: null,
    error: createExecutionError(error),
    logs: [],
    result: undefined,
    resultText: "",
    runId: executionContext.runCount,
    status: "error"
  };
}

function createExecutionOutputSnapshot(result) {
  return {
    outputLines: formatExecutionResultLines(result),
    status: typeof result?.status === "string" && result.status.trim() ? result.status.trim() : "done"
  };
}

export function createExecutionOutputSnapshots(results) {
  if (!Array.isArray(results) || !results.length) {
    return [];
  }

  return results.map((result) => createExecutionOutputSnapshot(result));
}

export function formatExecutionResultsMessage(results) {
  return createExecutionOutputSnapshots(results)
    .map((result) => result.outputLines.join("\n"))
    .join("\n\n")
    .trim();
}

export function createExecutionContext(options = {}) {
  const targetWindow = options.targetWindow || window;
  const existingContext = targetWindow[EXECUTION_CONTEXT_KEY];

  if (existingContext) {
    return existingContext;
  }

  const sharedState = targetWindow[SHARED_STATE_KEY] || Object.create(null);
  targetWindow[SHARED_STATE_KEY] = sharedState;

  const executionContext = {
    runCount: 0,
    sharedState,
    async execute(code) {
      const logs = [];
      const runId = executionContext.runCount + 1;
      const scope = createExecutionScope(targetWindow, sharedState);
      const restoreConsole = patchConsole(targetWindow, logs);
      const normalizedCode = normalizeExecutionSource(code);
      const runnableCode = `${normalizedCode}\n//# sourceURL=${buildExecutionSourceUrl(ADMIN_SOURCE_URL_PREFIX, runId)}`;
      const compileError = tryCreateAsyncRunner(runnableCode);

      let result;
      let error = compileError || null;

      executionContext.runCount = runId;

      if (!error) {
        try {
          const runner = createAsyncRunner(runnableCode);
          result = await runner({
            scope,
            targetWindow
          });
        } catch (runError) {
          error = runError;
        }
      }

      restoreConsole();

      return {
        error: error ? createExecutionError(error) : null,
        logs,
        result,
        resultText:
          error || result === undefined
            ? ""
            : formatExecutionResultValue(result, {
                targetWindow
              }),
        runId,
        status: error ? "error" : "success"
      };
    },
    async executeFromContent(content, options = {}) {
      const separatorCount = sharedCountExecutionSeparators(content, EXECUTION_SEPARATOR);

      if (separatorCount > 1) {
        return [
          createPlanErrorResult(
            executionContext,
            "Execution messages may contain _____javascript at most once, and it must appear on its own line."
          )
        ];
      }

      if (sharedHasInlineExecutionSeparator(content, EXECUTION_SEPARATOR)) {
        return [
          createPlanErrorResult(
            executionContext,
            "_____javascript must be on its own line. End the explanatory sentence, insert a newline, then place _____javascript alone on the next line."
          )
        ];
      }

      const blocks = extractExecuteBlocks(content);

      if (!blocks.length) {
        return [];
      }

      const results = [];

      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];

        if (typeof options.onBeforeBlock === "function") {
          await options.onBeforeBlock({
            block,
            code: block.code,
            index,
            total: blocks.length
          });
        }

        results.push({
          ...(await executionContext.execute(block.code)),
          block
        });
      }

      return results;
    },
    reset() {
      Object.keys(sharedState).forEach((key) => {
        delete sharedState[key];
      });

      executionContext.runCount = 0;
    }
  };

  targetWindow[EXECUTION_CONTEXT_KEY] = executionContext;
  return executionContext;
}
