// The dispatch pipeline (plan §3.4). Every tool call walks these stages IN ORDER:
//
//   1. schema validation      strict where the provider supports it
//   2. argument coercion      known-harmless slips repaired, rich wrong shapes rejected
//   3. risk classification    read / write / destructive -> a destructive call is held
//   4. execution              against the EXISTING handlers, never a new implementation
//   5. structured result      success payload, or a fixed-taxonomy error object
//
// Two properties are load-bearing and tested:
//
//   ORDER      a call that fails validation never reaches coercion; a call that
//              fails coercion never reaches a handler; a held call never reaches a
//              handler at all. `stages` on every outcome records what actually ran,
//              so the order is observable rather than asserted by comment.
//   ONE PLACE  all pipeline logic lives here in the shared layer. Surfaces import
//              and call; a surface that re-implements a stage is the BUG-007
//              anti-pattern this campaign exists to end.
//
// Handlers are the shipped capabilities. The file tools map onto the `space.api`
// shorthands (`api-client.js`), and `run_code` maps onto the execution context's
// single-block runner. Nothing here re-implements a file operation or an executor.

import {
  createApiError,
  createCoercionError,
  createExecutionError,
  createPolicyError,
  createValidationError
} from "./dispatch-errors.js";
import { coerceToolArguments } from "./dispatch-coercion.js";
import { formatValidationProblems, parseToolCallArguments, validateToolArguments } from "./dispatch-validation.js";
import { TOOL_RISK_CLASS } from "./tool-registry.js";

export const DISPATCH_STAGE = Object.freeze({
  COERCION: "coercion",
  EXECUTION: "execution",
  RISK: "risk",
  VALIDATION: "validation"
});

export const DISPATCH_OUTCOME = Object.freeze({
  ERROR: "error",
  HELD: "held",
  OK: "ok"
});

// Argument adapters: how a validated, coerced argument object becomes the call the
// EXISTING handler actually takes. Keyed by handler ref so the mapping travels with
// the capability, not with the surface and not with the tool's marketing name.
//
// Each entry is a pure function `(args) => callArgs`; it runs only after validation
// and coercion succeeded, so it can assume the argument types are correct.
const HANDLER_ARGUMENT_ADAPTERS = Object.freeze({
  "space.api.fileDelete": (args) => [args.path],
  "space.api.fileList": (args) => [
    args.path,
    {
      access: args.access,
      gitRepositories: args.gitRepositories,
      recursive: args.recursive,
      writableOnly: args.writableOnly
    }
  ],
  "space.api.fileRead": (args) => [args.path, args.encoding],
  "space.api.fileWrite": (args) => [
    {
      content: args.content,
      encoding: args.encoding,
      line: args.line,
      operation: args.operation,
      path: args.path,
      after: args.after,
      before: args.before
    }
  ],
  "/modules/_core/onscreen_agent/execution.js#execute": (args) => [args.code]
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactRecord(object) {
  const output = {};

  Object.keys(object || {}).forEach((key) => {
    if (object[key] !== undefined) {
      output[key] = object[key];
    }
  });

  return output;
}

// The api shorthands reject with Error objects that carry the server's message.
// Distinguishing an `api` rejection from an `execution` failure matters to the
// model's retry: a permission or path problem is fixed differently from a bug.
function isApiRejection(error) {
  const message = String(error?.message || "");

  return /^(?:File|Path|Access|Permission|Invalid|Unsupported|Not)\b/u.test(message) ||
    /\bnot found\b|\bdenied\b|\bforbidden\b|\boutside\b|\bunsupported\b/iu.test(message);
}

// The single constructor for the pipeline. Dependencies are injected so the module
// stays pure enough to test without a browser:
//
//   api                  the live `space.api` surface (shorthands)
//   executionContext     anything with `execute(code)`
//   gate                 the destructive hold gate
//   registry             the tool registry (records carry riskClass + handler)
//   stats                per-tool counters (optional)
//   logger               `{ warn }` (optional)
export function createDispatchPipeline({
  api = null,
  executionContext = null,
  gate = null,
  logger = null,
  registry = null,
  stats = null
} = {}) {
  if (!registry) {
    throw new Error("The dispatch pipeline requires a tool registry.");
  }

  function resolveHandler(record) {
    const ref = String(record?.handler || "").trim();

    if (!ref) {
      return null;
    }

    if (ref.startsWith("space.api.")) {
      const method = ref.slice("space.api.".length);
      const fn = api && typeof api[method] === "function" ? api[method] : null;

      return fn ? { adapter: HANDLER_ARGUMENT_ADAPTERS[ref] || null, fn, kind: "api", ref } : null;
    }

    if (ref.startsWith("/modules/") && ref.includes("#execute") && executionContext) {
      return {
        adapter: HANDLER_ARGUMENT_ADAPTERS[ref] || null,
        fn: (code) => executionContext.execute(code),
        kind: "execution",
        ref
      };
    }

    return null;
  }

  // One call, all stages, in order. Returns a frozen outcome; never throws.
  async function dispatchToolCall({ argumentsJson = "", callId = "", name = "" } = {}) {
    const stages = [];
    const record = registry.get(name);

    // Unregistered tool: a validation-class failure. There is no schema to check
    // against, so this is the first and only stage that runs.
    if (!record) {
      stages.push(DISPATCH_STAGE.VALIDATION);

      return Object.freeze({
        call: Object.freeze({ arguments: Object.freeze({}), callId: String(callId || ""), name: String(name || "") }),
        error: createValidationError({
          callId,
          details: { reason: "unregistered-tool" },
          message: `No tool named ${JSON.stringify(String(name || ""))} exists in this session's tool list.`,
          retryHint: `Call one of ${registry.names.join(", ")} instead, or answer in plain text.`,
          tool: name
        }),
        stages: Object.freeze(stages),
        status: DISPATCH_OUTCOME.ERROR
      });
    }

    const schema = record.schema;
    const call = { arguments: Object.freeze({}), callId: String(callId || ""), name: record.name };

    // --- 1. validation -------------------------------------------------------
    stages.push(DISPATCH_STAGE.VALIDATION);
    const parsed = parseToolCallArguments(argumentsJson);

    if (!parsed.ok) {
      return Object.freeze({
        call: Object.freeze(call),
        error: createValidationError({
          callId,
          details: { reason: "malformed-arguments-json", problem: parsed.problem },
          message: `${record.name} was not executed: ${parsed.problem}.`,
          retryHint: "Send the arguments as one complete, valid JSON object. Do not truncate it or wrap it in prose.",
          tool: record.name
        }),
        stages: Object.freeze(stages),
        status: DISPATCH_OUTCOME.ERROR
      });
    }

    const validation = validateToolArguments({ arguments: parsed.value, schema });

    if (validation.problems.length) {
      const formatted = formatValidationProblems(validation.problems);

      return Object.freeze({
        call: Object.freeze({ ...call, arguments: Object.freeze({ ...parsed.value }) }),
        error: createValidationError({
          callId,
          details: { problems: validation.problems },
          message: formatted.message,
          retryHint: formatted.retryHint,
          tool: record.name
        }),
        stages: Object.freeze(stages),
        status: DISPATCH_OUTCOME.ERROR
      });
    }

    // --- 2. coercion ---------------------------------------------------------
    stages.push(DISPATCH_STAGE.COERCION);
    const coercion = coerceToolArguments({ arguments: parsed.value, schema });

    if (coercion.rejected.length) {
      const fields = coercion.rejected.map((entry) => entry.field).join(", ");

      return Object.freeze({
        call: Object.freeze({ ...call, arguments: Object.freeze({ ...parsed.value }) }),
        error: createCoercionError({
          callId,
          details: { rejected: coercion.rejected },
          message: `The shape of ${fields} could not be repaired safely.`,
          retryHint: `Send ${fields} as ${coercion.rejected
            .map((entry) => `${entry.field}: ${entry.types.join(" or ")}`)
            .join(", ")}. Do not wrap scalars in objects.`,
          tool: record.name
        }),
        stages: Object.freeze(stages),
        status: DISPATCH_OUTCOME.ERROR
      });
    }

    const coercedArguments = coercion.arguments;

    // A repaired value must still satisfy the STRUCTURAL rules. `line: "3"`
    // becomes 3 and passes; a coerced value that landed on a bad enum or below a
    // minimum must not execute just because it arrived by repair.
    const revalidated = validateToolArguments({ arguments: coercedArguments, schema });

    if (revalidated.problems.length) {
      const formatted = formatValidationProblems(revalidated.problems);

      return Object.freeze({
        call: Object.freeze({ ...call, arguments: Object.freeze({ ...coercedArguments }) }),
        error: createValidationError({
          callId,
          details: { problems: revalidated.problems, stage: "post-coercion" },
          message: formatted.message,
          retryHint: formatted.retryHint,
          tool: record.name
        }),
        stages: Object.freeze(stages),
        status: DISPATCH_OUTCOME.ERROR
      });
    }

    const dispatchedCall = Object.freeze({ ...call, arguments: coercedArguments });

    // --- 3. risk -------------------------------------------------------------
    stages.push(DISPATCH_STAGE.RISK);

    if (record.riskClass === TOOL_RISK_CLASS.DESTRUCTIVE) {
      if (!gate) {
        // No gate wired means no consent affordance exists. Refusing is the only
        // honest answer: executing a destructive call unheld would be worse.
        return Object.freeze({
          call: dispatchedCall,
          error: createPolicyError({
            callId,
            details: { reason: "destructive-without-gate" },
            message: `${record.name} is destructive and no confirmation gate is available in this session.`,
            retryHint: "Do not retry. Tell the user that this deletion needs confirmation and that it is unavailable right now.",
            tool: record.name
          }),
          stages: Object.freeze(stages),
          status: DISPATCH_OUTCOME.ERROR
        });
      }

      // Held, not failed. The model must be told which of the two happened.
      const hold = gate.hold({
        arguments: coercedArguments,
        callId,
        description: `${record.name} ${JSON.stringify(compactRecord(coercedArguments))}`,
        tool: record.name
      });

      return Object.freeze({
        call: dispatchedCall,
        hold,
        stages: Object.freeze(stages),
        status: DISPATCH_OUTCOME.HELD
      });
    }

    // --- 4. execution --------------------------------------------------------
    stages.push(DISPATCH_STAGE.EXECUTION);
    const handler = resolveHandler(record);

    if (!handler) {
      return Object.freeze({
        call: dispatchedCall,
        error: createExecutionError({
          callId,
          details: { reason: "handler-unresolved", handler: record.handler },
          message: `${record.name} has no resolvable handler in this session (${record.handler}).`,
          retryHint: "Do not retry this tool. Use another tool, or explain in plain text that it is unavailable.",
          tool: record.name
        }),
        stages: Object.freeze(stages),
        status: DISPATCH_OUTCOME.ERROR
      });
    }

    stats?.recordCall?.(record.name);

    try {
      const callArgs = handler.adapter ? handler.adapter(coercedArguments) : [coercedArguments];
      const result = await handler.fn(...callArgs);

      // An execution-context result carries an `error` field rather than throwing.
      if (handler.kind === "execution" && result && typeof result === "object" && result.error) {
        stats?.recordError?.(record.name);

        return Object.freeze({
          call: dispatchedCall,
          error: createExecutionError({
            callId,
            details: { execution: result.error },
            message: String(result.error.message || "The code block failed."),
            retryHint: "Read the error, fix the code, and send one corrected run_code call. Do not resend the same code.",
            tool: record.name
          }),
          result,
          stages: Object.freeze(stages),
          status: DISPATCH_OUTCOME.ERROR
        });
      }

      return Object.freeze({
        call: dispatchedCall,
        result,
        stages: Object.freeze(stages),
        status: DISPATCH_OUTCOME.OK
      });
    } catch (error) {
      stats?.recordError?.(record.name);
      const factory = isApiRejection(error) ? createApiError : createExecutionError;

      try {
        logger?.warn?.(`[engine-swap] ${record.name} failed:`, error?.message || error);
      } catch {
        // Logging must never break a turn.
      }

      return Object.freeze({
        call: dispatchedCall,
        error: factory({
          callId,
          details: { reason: "handler-threw", error: String(error?.message || error) },
          message: String(error?.message || error || `${record.name} failed.`),
          tool: record.name
        }),
        stages: Object.freeze(stages),
        status: DISPATCH_OUTCOME.ERROR
      });
    }
  }

  // A confirmed hold re-enters the pipeline at the execution stage: validation,
  // coercion and risk already happened and must not run twice (a second coercion
  // pass could hide the fact that the arguments the human saw are the arguments
  // that execute).
  async function executeConfirmedHold(hold) {
    const record = registry.get(hold?.tool || "");

    if (!record) {
      return Object.freeze({
        call: Object.freeze({ arguments: Object.freeze({}), callId: String(hold?.callId || ""), name: String(hold?.tool || "") }),
        error: createValidationError({
          callId: hold?.callId,
          message: "The held tool is no longer registered in this session.",
          retryHint: "Do not retry. Tell the user the tool is unavailable.",
          tool: hold?.tool
        }),
        stages: Object.freeze([DISPATCH_STAGE.VALIDATION]),
        status: DISPATCH_OUTCOME.ERROR
      });
    }

    const handler = resolveHandler(record);
    const call = Object.freeze({
      arguments: Object.freeze({ ...(hold?.arguments || {}) }),
      callId: String(hold?.callId || ""),
      name: record.name
    });

    if (!handler) {
      return Object.freeze({
        call,
        error: createExecutionError({
          callId: hold?.callId,
          details: { reason: "handler-unresolved", handler: record.handler },
          message: `${record.name} has no resolvable handler in this session.`,
          retryHint: "Do not retry. Tell the user it is unavailable.",
          tool: record.name
        }),
        stages: Object.freeze([DISPATCH_STAGE.EXECUTION]),
        status: DISPATCH_OUTCOME.ERROR
      });
    }

    stats?.recordCall?.(record.name);

    try {
      const callArgs = handler.adapter ? handler.adapter(call.arguments) : [call.arguments];
      const result = await handler.fn(...callArgs);

      return Object.freeze({
        call,
        result,
        stages: Object.freeze([DISPATCH_STAGE.EXECUTION]),
        status: DISPATCH_OUTCOME.OK
      });
    } catch (error) {
      stats?.recordError?.(record.name);
      const factory = isApiRejection(error) ? createApiError : createExecutionError;

      return Object.freeze({
        call,
        error: factory({
          callId: hold?.callId,
          details: { reason: "handler-threw", error: String(error?.message || error) },
          message: String(error?.message || error || `${record.name} failed.`),
          tool: record.name
        }),
        stages: Object.freeze([DISPATCH_STAGE.EXECUTION]),
        status: DISPATCH_OUTCOME.ERROR
      });
    }
  }

  return Object.freeze({
    dispatchToolCall,
    executeConfirmedHold,
    // Exposed for the registry/transport composition test and for surfaces that
    // need to explain a refusal without dispatching.
    resolveHandler
  });
}

// Structured result -> the text that travels back to the model as a tool result.
// Success carries the payload as compact JSON (a model reads it fine and it stays
// one message); an error carries the coaching text, which is already two lines.
export function formatToolResultForModel(outcome) {
  if (!outcome) {
    return "error: no dispatch outcome was produced.";
  }

  if (outcome.status === DISPATCH_OUTCOME.ERROR) {
    return `error (${outcome.error?.class || "execution"}): ${outcome.error?.coaching || "unknown failure"}`;
  }

  if (outcome.status === DISPATCH_OUTCOME.HELD) {
    return `held: ${outcome.hold?.description || outcome.call?.name || "the action"} is waiting for the user's confirmation in the chat.`;
  }

  const payload = outcome.result;

  if (payload === undefined) {
    return "ok: the tool returned no value.";
  }

  try {
    return `ok: ${JSON.stringify(payload)}`;
  } catch {
    return `ok: ${String(payload)}`;
  }
}
