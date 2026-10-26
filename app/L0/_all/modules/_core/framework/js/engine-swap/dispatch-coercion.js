// Step 2 of the dispatch pipeline: argument coercion.
//
// This generalizes the v1.2 boundary-doctor rule that stopped `fileWrite` from
// receiving `[object Object]`: a *known-harmless* shape slip is repaired, while a
// *richer wrong shape* is rejected before anything executes. The distinction is
// the whole point. Broad coercion of arbitrary objects would turn an intended
// append into an overwrite, which is silent data loss — worse than the original
// failure. So the repair table is closed and small, and everything outside it is
// an honest rejection.
//
// Rules are data so tests can enumerate them one by one:
//
//   unwrap-single-element-array  scalar field, value is [x]              -> x
//   numeric-string-to-number     number/integer field, value is "5"      -> 5
//   boolean-string-to-boolean    boolean field, value is "true"/"false"  -> true/false
//   lone-encoding-object         string field named encoding, {encoding} -> the string
//   null-drops-optional          optional field, value is null           -> key removed
//
// Anything else that is the wrong type stays wrong, and the pipeline reports a
// coercion error with a coaching hint instead of guessing.

export const COERCION_RULE = Object.freeze({
  BOOLEAN_STRING: "boolean-string-to-boolean",
  LONE_ENCODING_OBJECT: "lone-encoding-object-to-string",
  NULL_DROP: "null-drops-optional",
  NUMERIC_STRING: "numeric-string-to-number",
  UNWRAP_ARRAY: "unwrap-single-element-array"
});

// Human/test-readable catalogue of every repair this module will ever perform.
export const KNOWN_HARMLESS_SLIPS = Object.freeze([
  Object.freeze({
    example: { value: "42", field: "line" },
    rule: COERCION_RULE.NUMERIC_STRING,
    summary: "a number sent as a numeric string"
  }),
  Object.freeze({
    example: { value: "false", field: "recursive" },
    rule: COERCION_RULE.BOOLEAN_STRING,
    summary: "a boolean sent as \"true\" or \"false\""
  }),
  Object.freeze({
    example: { value: ["~/notes.txt"], field: "path" },
    rule: COERCION_RULE.UNWRAP_ARRAY,
    summary: "one scalar wrapped in a single-element array"
  }),
  Object.freeze({
    example: { value: { encoding: "utf8" }, field: "encoding" },
    rule: COERCION_RULE.LONE_ENCODING_OBJECT,
    summary: "a lone { encoding } object where the encoding string belongs"
  }),
  Object.freeze({
    example: { value: null, field: "recursive" },
    rule: COERCION_RULE.NULL_DROP,
    summary: "an explicit null for an optional field"
  })
]);

function normalizeTypes(property) {
  const raw = property?.type;

  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  }

  return raw ? [String(raw).trim().toLowerCase()] : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCleanNumericString(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

export function isValueOfType(value, types = []) {
  const normalized = Array.isArray(types) ? types : [types];

  if (!normalized.length) {
    return true; // Untyped property: nothing to check.
  }

  return normalized.some((type) => {
    switch (type) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "object":
        return isPlainObject(value);
      case "array":
        return Array.isArray(value);
      case "null":
        return value === null;
      default:
        return false;
    }
  });
}

// Can this value be repaired into one of `types` by a declared rule? Used by the
// validation stage to separate hard failures from coercible slips WITHOUT
// performing the repair (validation must not mutate anything).
export function canCoerceToTypes({ field = "", property = null, value } = {}) {
  const types = normalizeTypes(property);

  if (isValueOfType(value, types)) {
    return true;
  }

  if (value === null && types.some((type) => type !== "null" && type !== "object") && !types.includes("null")) {
    return true; // null-drops-optional / null for a scalar field
  }

  if (types.includes("number") || types.includes("integer")) {
    if (isCleanNumericString(value)) {
      return true;
    }
  }

  if (types.includes("boolean")) {
    if (value === "true" || value === "false") {
      return true;
    }
  }

  if (types.includes("string")) {
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
      return true;
    }

    if (String(field).toLowerCase().includes("encoding") && isPlainObject(value)) {
      const keys = Object.keys(value);
      return keys.length === 1 && keys[0] === "encoding" && typeof value.encoding === "string";
    }
  }

  return false;
}

function coerceScalar({ field, property, value }) {
  const types = normalizeTypes(property);

  if (isValueOfType(value, types)) {
    return { ok: true, rule: "", value };
  }

  if ((types.includes("number") || types.includes("integer")) && isCleanNumericString(value)) {
    const numeric = Number(value);

    if (types.includes("integer") && !Number.isInteger(numeric)) {
      return { ok: false, rule: "" };
    }

    return { ok: true, rule: COERCION_RULE.NUMERIC_STRING, value: numeric };
  }

  if (types.includes("boolean") && (value === "true" || value === "false")) {
    return { ok: true, rule: COERCION_RULE.BOOLEAN_STRING, value: value === "true" };
  }

  if (types.includes("string")) {
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
      return { ok: true, rule: COERCION_RULE.UNWRAP_ARRAY, value: value[0] };
    }

    if (String(field).toLowerCase().includes("encoding") && isPlainObject(value)) {
      const keys = Object.keys(value);

      if (keys.length === 1 && keys[0] === "encoding" && typeof value.encoding === "string") {
        return { ok: true, rule: COERCION_RULE.LONE_ENCODING_OBJECT, value: value.encoding };
      }
    }
  }

  return { ok: false, rule: "" };
}

// Applies every declared repair to one argument object. Pure: the input object is
// never mutated, and the returned object is new.
//
// Returns `{ arguments, applied, rejected }`. `rejected` names the fields whose
// shape could not be repaired; the pipeline turns each into a coercion error.
export function coerceToolArguments({ arguments: rawArguments = {}, schema = {} } = {}) {
  const source = isPlainObject(rawArguments) ? rawArguments : {};
  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const coerced = { ...source };
  const applied = [];
  const rejected = [];

  Object.keys(source).forEach((field) => {
    const property = properties[field] || null;
    const value = source[field];

    if (value === null && !required.includes(field)) {
      delete coerced[field];
      applied.push({ field, rule: COERCION_RULE.NULL_DROP });
      return;
    }

    if (!property) {
      return; // Unknown fields are a validation concern, not a coercion one.
    }

    const outcome = coerceScalar({ field, property, value });

    if (outcome.ok) {
      if (outcome.rule) {
        coerced[field] = outcome.value;
        applied.push({ field, rule: outcome.rule });
      }
      return;
    }

    rejected.push({ field, received: value, types: normalizeTypes(property) });
  });

  return Object.freeze({
    applied: Object.freeze(applied.map((entry) => Object.freeze(entry))),
    arguments: Object.freeze(coerced),
    rejected: Object.freeze(rejected.map((entry) => Object.freeze(entry)))
  });
}
