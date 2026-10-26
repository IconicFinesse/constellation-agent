// Step 1 of the dispatch pipeline: schema validation.
//
// Mechanical, deterministic, and deliberately a small subset of JSON Schema —
// exactly the keywords the launch tool schemas actually use:
//
//   type, properties, required, enum, additionalProperties, minimum
//
// A full JSON Schema implementation would be a dependency and a spec to track.
// The schemas are ours, the subset is stated here, and the registry suite pins
// the inventory so a schema drift is a build failure rather than a mystery
// rejection at runtime.
//
// Strict semantics: providers that honour strict schemas send every property as
// required with optional ones nullable (`toStrictSchema`). The validator treats a
// property list that came from that projection exactly as it would treat a
// hand-written `required` list — nullable types carry `null` in `type`, so the
// two agree by construction.
//
// Validation never coerces and never executes. A value that is the wrong shape but
// repairable by a declared coercion rule is reported as `coercible`, not as a hard
// failure, so the pipeline can run coercion next and report the true first error.

import { canCoerceToTypes, isValueOfType } from "./dispatch-coercion.js";

function normalizeTypes(property) {
  const raw = property?.type;

  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  }

  return raw ? [String(raw).trim().toLowerCase()] : [];
}

function isMissing(value) {
  return value === undefined;
}

// Validates one parsed argument object against one tool schema.
//
// Returns `{ ok, problems, coercible, typeMismatches }`:
//   ok              - the arguments satisfy the schema as-is
//   problems        - STRUCTURAL failures: missing required, unknown field, bad
//                     enum value, below minimum
//   typeMismatches  - fields whose type is wrong (repairable or not)
//   coercible       - the subset of typeMismatches a declared rule can repair
//
// Ownership split, deliberately: this stage owns STRUCTURE, the coercion stage owns
// TYPE SHAPE. If validation rejected every wrong type itself, coercion's rejection
// path would be dead code behind a validation error, and the pipeline could never
// report the more precise coercion class. `ok` is true only when both buckets are
// empty; the pipeline fails on `problems` and hands `typeMismatches` to coercion.
export function validateToolArguments({ arguments: rawArguments = {}, schema = {} } = {}) {
  const problems = [];
  const coercible = [];
  const typeMismatches = [];
  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const additionalAllowed = schema?.additionalProperties !== false;

  if (!rawArguments || typeof rawArguments !== "object" || Array.isArray(rawArguments)) {
    return Object.freeze({
      coercible: Object.freeze([]),
      ok: false,
      problems: Object.freeze([{ field: "(arguments)", problem: "expected one object of named arguments" }]),
      typeMismatches: Object.freeze([])
    });
  }

  required.forEach((field) => {
    if (isMissing(rawArguments[field])) {
      problems.push({ field, problem: "is required but was not sent" });
    }
  });

  Object.keys(rawArguments).forEach((field) => {
    const value = rawArguments[field];

    if (isMissing(value)) {
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(properties, field)) {
      if (!additionalAllowed) {
        problems.push({ field, problem: "is not a field of this tool" });
      }
      return;
    }

    const property = properties[field];
    const types = normalizeTypes(property);

    if (isValueOfType(value, types)) {
      // Enum membership only applies to the values that survived the type check.
      if (Array.isArray(property.enum) && !property.enum.includes(value)) {
        problems.push({
          field,
          problem: `must be one of ${property.enum.map((entry) => JSON.stringify(entry)).join(", ")}`
        });
      }

      if ((types.includes("number") || types.includes("integer")) && typeof property.minimum === "number") {
        if (value < property.minimum) {
          problems.push({ field, problem: `must be at least ${property.minimum}` });
        }
      }

      return;
    }

    // Not the declared type. Type shape belongs to the COERCION stage, not here:
    // coercion repairs the known-harmless slips and rejects the rest, which is the
    // only way its rejection path is reachable rather than dead code behind a
    // validation error. Validation keeps ownership of structure (required fields,
    // unknown fields, enum membership, minimums).
    const repairable = canCoerceToTypes({ field, property, value });

    typeMismatches.push({ coercible: repairable, field, received: value, types });

    if (repairable) {
      coercible.push({ field, received: value, types });
    }
  });

  return Object.freeze({
    coercible: Object.freeze(coercible.map((entry) => Object.freeze(entry))),
    ok: problems.length === 0 && typeMismatches.length === 0,
    problems: Object.freeze(problems.map((entry) => Object.freeze(entry))),
    typeMismatches: Object.freeze(typeMismatches.map((entry) => Object.freeze(entry)))
  });
}

// Short, model-readable description of a rejected value. Never dumps a whole
// payload into a coaching line.
export function describeValue(value) {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `an array of ${value.length}`;
  }

  if (typeof value === "object") {
    return `an object with keys ${Object.keys(value).slice(0, 5).join(", ") || "(none)"}`;
  }

  if (typeof value === "string") {
    const trimmed = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return `the string ${JSON.stringify(trimmed)}`;
  }

  return `${typeof value} ${String(value)}`;
}

// Formats validation problems into one human line plus one coaching hint. Kept
// here so both faces of the error are derived from the same problem list.
export function formatValidationProblems(problems) {
  const list = Array.isArray(problems) ? problems : [];

  if (!list.length) {
    return { message: "", retryHint: "" };
  }

  const message = `Invalid arguments: ${list.map((entry) => `${entry.field} ${entry.problem}`).join("; ")}.`;
  const fields = [...new Set(list.map((entry) => entry.field))].join(", ");

  return {
    message,
    retryHint: `Resend the call with corrected ${fields}${list.length > 1 ? " (all of them)" : ""}. Use only the fields the tool schema lists.`
  };
}

// Parses the raw arguments string a provider carries on the wire. A fragment or
// malformed JSON is a validation failure, never a dispatch: plan §3.5 says a call
// dispatches only when its arguments are complete and valid JSON.
export function parseToolCallArguments(rawArguments) {
  if (rawArguments === undefined || rawArguments === null || rawArguments === "") {
    return Object.freeze({ ok: true, value: Object.freeze({}) });
  }

  if (typeof rawArguments === "object") {
    return Object.freeze({ ok: true, value: rawArguments });
  }

  if (typeof rawArguments !== "string") {
    return Object.freeze({
      ok: false,
      problem: `arguments must be a JSON object string, received ${typeof rawArguments}`
    });
  }

  try {
    const parsed = JSON.parse(rawArguments);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Object.freeze({ ok: false, problem: "arguments must parse to one JSON object" });
    }

    return Object.freeze({ ok: true, value: parsed });
  } catch (error) {
    return Object.freeze({
      ok: false,
      problem: `arguments were not valid JSON (${error?.message || "parse error"})`
    });
  }
}
