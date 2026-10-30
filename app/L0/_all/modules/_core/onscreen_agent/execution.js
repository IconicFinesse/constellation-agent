import { ONSCREEN_SKILL_LOAD_HOOK_KEY } from "./skills.js";
import {
  ONSCREEN_AGENT_EXECUTION_SEPARATOR,
  stripTrailingExecutionArtifacts
} from "./turn-boundary.js";
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

export const EXECUTION_SEPARATOR = ONSCREEN_AGENT_EXECUTION_SEPARATOR;

const EXECUTION_CONTEXT_KEY = "__spaceOnscreenAgentExecutionContext";
const SHARED_STATE_KEY = "__spaceOnscreenAgentSharedState";
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "dir", "table", "assert"];
const INTERNAL_SCOPE_KEYS = new Set(["__spaceScope", "__spaceWindow"]);
// The value-rendering family is NOT this file's any more (P4b-2c): it lives once in
// `framework/js/execution-format.js` and is instantiated below with THIS surface's
// `sourceURL` prefix. That prefix is the whole parameterization — it names the executed
// block's source url AND decides which stack frames a rendered error keeps, so a hardcoded
// prefix in the shared module would have stripped one surface's frames.
function isLoadedOnscreenSkill(value) {
  return Boolean(value?.__spaceSkill) && typeof value?.content === "string" && typeof value?.path === "string";
}

function collectLoadedSkills(result) {
  const loadedSkills = [];
  const seen = new Set();

  const addSkill = (skill) => {
    if (!isLoadedOnscreenSkill(skill)) {
      return;
    }

    const identity = `${String(skill.filePath || "")}|${skill.path}`;

    if (seen.has(identity)) {
      return;
    }

    seen.add(identity);
    loadedSkills.push(skill);
  };

  if (Array.isArray(result?.loadedSkills)) {
    result.loadedSkills.forEach((skill) => addSkill(skill));
  }

  addSkill(result?.result);
  return loadedSkills;
}

function formatLoadedSkillResultText(skill) {
  const responseText = typeof skill?.loadResponseText === "string" ? skill.loadResponseText.trim() : "";
  return responseText || String(skill?.content || "").trim();
}

// The ONE console-value formatter family, parameterized by this surface's identity.
const ONSCREEN_SOURCE_URL_PREFIX = "space-onscreen-agent-execute";

const {
  formatError,
  formatExecutionResultValue,
  formatExecutionValue,
  isLoadedSkill
} = createExecutionValueFormatters({
  isLoadedSkill: isLoadedOnscreenSkill,
  sourceUrlPrefix: ONSCREEN_SOURCE_URL_PREFIX
});

export { formatExecutionResultValue };

// Extraction and separator accounting live in the shared fence-aware module so
// the onscreen and admin surfaces cannot drift apart on the display/execute
// contract. A separator inside a fenced region is display text and never starts
// an execution; see framework/js/execution-blocks.js.
export function extractExecuteBlocks(content) {
  return sharedExtractExecuteBlocks(content, EXECUTION_SEPARATOR);
}

// Display helpers split a reply at the separator before rendering it. They use
// this so a fenced display that merely shows the separator is never cut in half.
export function findExecutableSeparatorIndex(content) {
  return sharedFindExecutableSeparatorIndex(content, EXECUTION_SEPARATOR);
}

// Fence REGIONS, re-exported for the same reason: the display-form detector needs to
// know what was fenced, and a second copy of fence logic is the BUG-007 anti-pattern.
// Display text is never an execution, so the detector must ask exactly this module.
export function findExecutionFenceRegions(content) {
  return sharedCollectExecutionFenceRegions(content);
}

function countExecutionSeparators(content) {
  return sharedCountExecutionSeparators(content, EXECUTION_SEPARATOR);
}

function hasInlineExecutionSeparator(content) {
  return sharedHasInlineExecutionSeparator(content, EXECUTION_SEPARATOR);
}

export function createExecutionPlanError(message) {
  const error = new Error(message);
  error.name = "ExecutionPlanError";
  return error;
}

export const validateOnscreenAgentExecutionBlockPlan = globalThis.space.extend(
  import.meta,
  async function validateOnscreenAgentExecutionBlockPlan(context = {}) {
    return {
      ...context,
      code: normalizeExecutionSource(context?.code ?? context?.block?.code),
      errors: Array.isArray(context?.errors) ? [...context.errors] : []
    };
  }
);

function coerceExecutionPlanError(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Error) {
    if (!value.name) {
      value.name = "ExecutionPlanError";
    }

    return value;
  }

  if (typeof value === "string") {
    return createExecutionPlanError(value);
  }

  const message = typeof value?.message === "string" ? value.message.trim() : "";

  if (!message) {
    return null;
  }

  const error = new Error(message);
  error.name = typeof value?.name === "string" && value.name ? value.name : "ExecutionPlanError";
  return error;
}

function collectExecutionPlanErrors(validationResult) {
  const collected = [];

  if (Array.isArray(validationResult?.errors)) {
    collected.push(...validationResult.errors);
  }

  if (validationResult?.error != null) {
    collected.push(validationResult.error);
  }

  if (!collected.length && (validationResult instanceof Error || typeof validationResult === "string")) {
    collected.push(validationResult);
  }

  return collected.map((value) => coerceExecutionPlanError(value)).filter(Boolean);
}

async function resolveExecutionBlockPlanError(block) {
  const validationResult = await validateOnscreenAgentExecutionBlockPlan({
    block,
    code: normalizeExecutionSource(block?.code),
    errors: []
  });
  return collectExecutionPlanErrors(validationResult)[0] || null;
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
    } catch (error) {
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
    } catch (error) {
      // Ignore read-only console implementations.
    }
  });

  return () => {
    originalMethods.forEach(([methodName, originalMethod]) => {
      try {
        targetWindow.console[methodName] = originalMethod;
      } catch (error) {
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

// SCOPE-GUARDED DELETION (BUG-014) — A GUARDRAIL, NOT A SECURITY BOUNDARY.
//
// THE DEFECT. The destructive-confirmation gate guards the typed `file_delete` tool and
// nothing else, so a delete written as one step inside a bigger `run_code` job executed
// instantly with no confirmation. Saved histories show 7 of 9 multi-step deletes taking
// exactly that path, every one of them reaching the file layer as
// `space.api.fileDelete(...)` in generated code.
//
// WHY THE SHARED CLIENT IS NOT TOUCHED. `space.api` is a page-wide singleton
// (`framework/js/runtime.js` `createApiClient`) and `space.api.fileDelete` has seven
// first-party callers with no gate and no session — the human Files delete dialog among
// them. Requiring consent on the shared client would break the product's own delete UI.
// So the REAL client keeps its behaviour and only the `run_code` scope gets a facade.
//
// WHAT THIS DOES AND DOES NOT DO. Generated code reaches this scope through
// `with (__spaceScope)`, so `space.api.fileDelete(...)` inside an execution now fails
// loudly and names the gated tool to use instead. That is the model's natural batched
// path and it is the path every observed ungated delete took. It is NOT a boundary:
// the executed block runs in this realm, so code that deliberately goes around the
// facade — `globalThis.space.api.fileDelete(...)`, a saved reference read before the
// guard, `window.space`, a raw backend call — still reaches the unguarded client. Say
// that plainly; do not claim this closes the path.
const RUN_CODE_DELETE_REFUSAL_CODE = "run_code_delete_refused";

// Model-facing coaching, matching the tone of `formatHeldToolResult` in
// `engine-swap/destructive-gate.js` and the write-argument guard in
// `framework/js/api-client.js`: name the mistake, name what was NOT done, and name the
// exact next move that works.
export function formatRunCodeDeleteRefusal() {
  return [
    "not permitted: deleting files from inside run_code is refused.",
    "Nothing was deleted. Use the typed file_delete tool instead: it takes the path (or the paths) explicitly and it asks the user to confirm before anything is removed.",
    "Do not look for another way to delete from code. Deleting around this guard removes the confirmation step, and the user has not agreed to that."
  ].join("\n");
}

function createRefusingFileDelete() {
  return function fileDelete() {
    const error = new Error(formatRunCodeDeleteRefusal());
    error.name = "RunCodeDeleteRefusedError";
    error.code = RUN_CODE_DELETE_REFUSAL_CODE;
    throw error;
  };
}

const refusingFileDelete = createRefusingFileDelete();

// The `run_code` scope's own `space` facade. Everything delegates to the real runtime
// object EXCEPT `api.fileDelete`, which always throws: one path, an array of paths, a
// `{ paths: [...] }` batch, a `files` array, or anything else delete-shaped. The refusal
// is argument-blind on purpose — a shape table is a bypass waiting to be discovered, and
// the typed tool is the only delete the user has consented to.
//
// Both facades are Proxies over the real objects, so a key added to the runtime after
// this is built still resolves, and every method keeps its own identity and closure —
// `space.api.fileWrite({ operation: "append" })` from inside code behaves exactly as it
// does today.
export function createRunCodeSpaceFacade(realSpace) {
  if (!realSpace || (typeof realSpace !== "object" && typeof realSpace !== "function")) {
    return realSpace;
  }

  const realApi = realSpace.api;
  const apiFacade = new Proxy(
    realApi && (typeof realApi === "object" || typeof realApi === "function") ? realApi : {},
    {
      get(target, key) {
        if (key === "fileDelete") {
          return refusingFileDelete;
        }

        return Reflect.get(target, key);
      }
    }
  );

  return new Proxy(realSpace, {
    get(target, key) {
      if (key === "api") {
        return apiFacade;
      }

      return Reflect.get(target, key);
    }
  });
}

function createExecutionScope(targetWindow, sharedState) {
  const boundWindowMethods = new WeakMap();
  let spaceFacade = null;

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
        // Built once per scope so repeated reads inside one executed block see the same
        // facade object; the real `targetWindow.space` is only ever read, never written.
        if (!spaceFacade) {
          spaceFacade = createRunCodeSpaceFacade(targetWindow.space);
        }

        return spaceFacade;
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
        } catch (error) {
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




// The transcript SKELETON is the shared builder's (P4b-2c). What stays here is onscreen's
// FEATURE: several skills may be collected in one run (painted in order, separated by a blank
// line) and a stripped-artifact note follows the body. The skill list is resolved ONCE and
// handed to every predicate, so the block and the empty notice cannot disagree about it.
const formatExecutionResultLines = createExecutionResultLinesFormatter({
  resolveSkills: collectLoadedSkills,
  appendSkillLines(lines, result, skills) {
    skills.forEach((skill, index) => {
      const loadedSkillResultText = formatLoadedSkillResultText(skill);

      if (!loadedSkillResultText) {
        return;
      }

      if (index > 0) {
        lines.push("");
      }

      lines.push(loadedSkillResultText);
    });

    return false;
  },
  suppressResultBlock: (result) => isLoadedOnscreenSkill(result?.result),
  suppressEmptyNotice: (result, skills) => Boolean(skills && skills.length),
  appendExtraLines(lines, result) {
    if (Array.isArray(result?.removedArtifactLines) && result.removedArtifactLines.length) {
      lines.push(
        `note: removed trailing non-JavaScript line${result.removedArtifactLines.length > 1 ? "s" : ""}: ${result.removedArtifactLines.join(", ")}`
      );
    }
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
      const loadedSkills = [];
      const runId = executionContext.runCount + 1;
      const scope = createExecutionScope(targetWindow, sharedState);
      const restoreConsole = patchConsole(targetWindow, logs);
      const previousSkillLoadHook = targetWindow[ONSCREEN_SKILL_LOAD_HOOK_KEY];
      const normalizedCode = normalizeExecutionSource(code);
      let runnableCode = `${normalizedCode}\n//# sourceURL=${buildExecutionSourceUrl(ONSCREEN_SOURCE_URL_PREFIX, runId)}`;
      let compileError = tryCreateAsyncRunner(runnableCode);
      let removedArtifactLines = [];

      if (compileError) {
        const stripped = stripTrailingExecutionArtifacts(normalizedCode);

        if (stripped.removed.length) {
          const strippedRunnableCode = `${stripped.code}\n//# sourceURL=${buildExecutionSourceUrl(ONSCREEN_SOURCE_URL_PREFIX, runId)}`;
          const strippedCompileError = tryCreateAsyncRunner(strippedRunnableCode);

          if (!strippedCompileError) {
            runnableCode = strippedRunnableCode;
            compileError = null;
            removedArtifactLines = stripped.removed.map((line) => line.trim()).filter(Boolean);
          }
        }
      }

      let result;
      let error = compileError || null;

      executionContext.runCount = runId;

      try {
        targetWindow[ONSCREEN_SKILL_LOAD_HOOK_KEY] = (skill) => {
          if (isLoadedOnscreenSkill(skill)) {
            loadedSkills.push(skill);
          }

          if (typeof previousSkillLoadHook === "function") {
            previousSkillLoadHook(skill);
          }
        };
      } catch (hookError) {
        // Ignore read-only globals. The returned result path still works when available.
      }

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

      try {
        if (previousSkillLoadHook === undefined) {
          delete targetWindow[ONSCREEN_SKILL_LOAD_HOOK_KEY];
        } else {
          targetWindow[ONSCREEN_SKILL_LOAD_HOOK_KEY] = previousSkillLoadHook;
        }
      } catch (hookError) {
        // Ignore read-only globals.
      }

      return {
        error: error ? createExecutionError(error) : null,
        loadedSkills,
        logs,
        removedArtifactLines,
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
      const blocks = extractExecuteBlocks(content);
      const separatorCount = countExecutionSeparators(content);

      if (separatorCount > 1) {
        return [{
          block: null,
          error: createExecutionError(
            createExecutionPlanError(
              "Execution messages may contain _____javascript at most once, and it must appear on its own line."
            )
          ),
          loadedSkills: [],
          logs: [],
          result: undefined,
          resultText: "",
          runId: executionContext.runCount,
          status: "error"
        }];
      }

      if (hasInlineExecutionSeparator(content)) {
        return [{
          block: null,
          error: createExecutionError(
            createExecutionPlanError(
              "_____javascript must be on its own line. End the explanatory sentence, insert a newline, then place _____javascript alone on the next line."
            )
          ),
          loadedSkills: [],
          logs: [],
          result: undefined,
          resultText: "",
          runId: executionContext.runCount,
          status: "error"
        }];
      }

      if (!blocks.length) {
        return [];
      }

      const results = [];

      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        const planError = await resolveExecutionBlockPlanError(block);

        if (typeof options.onBeforeBlock === "function") {
          await options.onBeforeBlock({
            block,
            code: block.code,
            index,
            total: blocks.length
          });
        }

        if (planError) {
          results.push({
            block,
            error: createExecutionError(planError),
            loadedSkills: [],
            logs: [],
            result: undefined,
            resultText: "",
            runId: executionContext.runCount,
            status: "error"
          });
          continue;
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
