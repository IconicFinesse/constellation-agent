// Closed error taxonomy for the dispatch pipeline (plan §3.4).
//
// Every tool-call failure is one of exactly five classes, and every class carries
// TWO faces:
//
//   message   - one human line, for the transcript and for us
//   retryHint - model-facing coaching: what to do differently on the next turn
//
// A prose-only error is a defect from here on. `coaching` is the exact text that
// travels back to the model as the tool result, so the taxonomy is not decoration:
// it is the retry contract.
//
// The classes are closed by construction. Adding a sixth means editing this file
// and the pipeline's single classification path, not sprinkling strings around.

export const DISPATCH_ERROR_CLASS = Object.freeze({
  API: "api",
  COERCION: "coercion",
  EXECUTION: "execution",
  POLICY: "policy",
  VALIDATION: "validation"
});

export const DISPATCH_ERROR_CLASSES = Object.freeze(Object.values(DISPATCH_ERROR_CLASS));

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

// One constructor for the whole taxonomy. Callers name the class and supply the
// two faces; nothing else is allowed to invent an error shape.
export function createDispatchError({
  callId = "",
  className,
  details = null,
  message = "",
  retryHint = "",
  tool = ""
} = {}) {
  const normalizedClass = normalizeText(className);

  if (!DISPATCH_ERROR_CLASSES.includes(normalizedClass)) {
    throw new Error(`Unknown dispatch error class: ${String(className || "")}`);
  }

  const humanLine = normalizeText(message) || `The ${normalizedClass} step rejected this call.`;
  const hint =
    normalizeText(retryHint) ||
    "Re-read the tool description and send one corrected call with complete arguments.";

  return Object.freeze({
    callId: normalizeText(callId),
    class: normalizedClass,
    // The exact model-facing text. One line of what happened, then how to retry.
    coaching: `${humanLine}\n${hint}`,
    details,
    hint,
    message: humanLine,
    tool: normalizeText(tool)
  });
}

// Fleet of thin factories so the pipeline reads as intent, not string assembly.
export function createValidationError({ callId, details = null, message = "", retryHint = "", tool = "" } = {}) {
  return createDispatchError({
    callId,
    className: DISPATCH_ERROR_CLASS.VALIDATION,
    details,
    message: message || "The tool arguments did not validate against the tool schema.",
    retryHint:
      retryHint ||
      "Send the call again with arguments that match the schema exactly: required fields present, correct types, enum values from the listed set, no extra fields.",
    tool
  });
}

export function createCoercionError({ callId, details = null, message = "", retryHint = "", tool = "" } = {}) {
  return createDispatchError({
    callId,
    className: DISPATCH_ERROR_CLASS.COERCION,
    details,
    message: message || "The tool arguments were the wrong shape and could not be safely coerced.",
    retryHint:
      retryHint ||
      "Send plain scalar values for scalar fields: a string for path, a number for line, a boolean for flags. Do not wrap a value in an extra object or array.",
    tool
  });
}

export function createExecutionError({ callId, details = null, message = "", retryHint = "", tool = "" } = {}) {
  return createDispatchError({
    callId,
    className: DISPATCH_ERROR_CLASS.EXECUTION,
    details,
    message: message || "The tool handler ran and returned an error.",
    retryHint:
      retryHint ||
      "Read the error text, fix the cause, and retry once. If the same error repeats, change approach instead of repeating the call.",
    tool
  });
}

export function createApiError({ callId, details = null, message = "", retryHint = "", tool = "" } = {}) {
  return createDispatchError({
    callId,
    className: DISPATCH_ERROR_CLASS.API,
    details,
    message: message || "The underlying app API rejected the call.",
    retryHint:
      retryHint ||
      "The path or permission is the likely problem. Check that the target exists and that it is inside your writable scope before retrying.",
    tool
  });
}

export function createPolicyError({ callId, details = null, message = "", retryHint = "", tool = "" } = {}) {
  return createDispatchError({
    callId,
    className: DISPATCH_ERROR_CLASS.POLICY,
    details,
    message: message || "A tool policy refused this call.",
    retryHint:
      retryHint ||
      "Do not repeat this exact call. Adjust the request to one call the policy permits, or answer the user in plain text.",
    tool
  });
}
