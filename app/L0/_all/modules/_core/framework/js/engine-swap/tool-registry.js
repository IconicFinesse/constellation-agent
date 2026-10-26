// Tool-registry skeleton for the engine-swap layer.
//
// Tools are data, one registry shared by both surfaces (the execution-blocks.js
// precedent). A record is:
//
//   { name, description, schema (JSON Schema), riskClass,
//     handler (ref into existing space.api / runtime),
//     source: "builtin" | "module" | "mcp", deferrable }
//
// P1 duties are assembly only:
//   - deterministic visible-tool-list assembly as a pure function of
//     (config, model): canonical ordering, identical output for identical
//     input, because the list is half the cacheable prefix (plan §3.2)
//   - a dispatch-table stub that can never execute anything
//   - a per-tool stats record shape for later tuning
//
// What it must NOT do: dispatch. Nothing in this module calls a handler.
//
// Schema truth: every enum and argument name below was read from the live
// server code in this tree, not from prose. `ensureValidWriteOperation` in
// server/lib/customware/file_access.js defines the write-operation enum, and
// server/api/file_*.js define the accepted argument names. The P1 suite asserts
// those names against the server source so a silent drift fails the build.

import { stableStringify } from "./shadow-normalize.js";
import { resolveCapabilities } from "./capabilities.js";

export const TOOL_RISK_CLASS = Object.freeze({
  DESTRUCTIVE: "destructive",
  READ: "read",
  WRITE: "write"
});

export const TOOL_SOURCE = Object.freeze({
  BUILTIN: "builtin",
  MCP: "mcp",
  MODULE: "module"
});

// Verified against server/lib/customware/file_access.js:ensureValidWriteOperation.
export const WRITE_OPERATION_VALUES = Object.freeze(["replace", "append", "prepend", "insert"]);

// Verified against file_access.js:ensureValidWriteEncoding.
export const WRITE_ENCODING_VALUES = Object.freeze(["utf8", "base64"]);

export const READ_ENCODING_VALUES = Object.freeze(["utf8", "base64"]);

function jsonSchema({ properties = {}, required = [] } = {}) {
  return Object.freeze({
    additionalProperties: false,
    properties: Object.freeze(properties),
    required: Object.freeze(required),
    type: "object"
  });
}

const PATH_PROPERTY = Object.freeze({
  description: "App-rooted path, or ~ for the current user's own root.",
  type: "string"
});

// Plan §3.3 launch inventory, as data. `strictSchema` is the D2 strict-mode
// variant: every property required, optional ones nullable, no extras.
export const LAUNCH_TOOL_RECORDS = Object.freeze([
  Object.freeze({
    deferrable: false,
    description:
      "Read one app file by path. Returns { content, encoding, path }. Use ~ for the current user's own root.",
    handler: "space.api.fileRead",
    name: "file_read",
    riskClass: TOOL_RISK_CLASS.READ,
    schema: jsonSchema({
      properties: {
        encoding: Object.freeze({ enum: READ_ENCODING_VALUES, type: "string" }),
        path: PATH_PROPERTY
      },
      required: ["path"]
    }),
    source: TOOL_SOURCE.BUILTIN
  }),
  Object.freeze({
    deferrable: false,
    description:
      "List app paths under one directory. Returns { paths, access, path }. Set recursive for a full subtree walk.",
    handler: "space.api.fileList",
    name: "file_list",
    riskClass: TOOL_RISK_CLASS.READ,
    schema: jsonSchema({
      properties: {
        access: Object.freeze({ enum: ["read", "write"], type: "string" }),
        gitRepositories: Object.freeze({ type: "boolean" }),
        path: PATH_PROPERTY,
        recursive: Object.freeze({ type: "boolean" }),
        writableOnly: Object.freeze({ type: "boolean" })
      },
      required: ["path"]
    }),
    source: TOOL_SOURCE.BUILTIN
  }),
  Object.freeze({
    deferrable: false,
    description:
      "Write one app file. Defaults to whole-file replacement; operation may be replace, append, prepend, or insert. Insert takes exactly one of line, before, or after. Returns { bytesWritten, encoding, path }.",
    handler: "space.api.fileWrite",
    name: "file_write",
    riskClass: TOOL_RISK_CLASS.WRITE,
    schema: jsonSchema({
      properties: {
        after: Object.freeze({ description: "Insert after the first literal match of this text.", type: "string" }),
        before: Object.freeze({ description: "Insert before the first literal match of this text.", type: "string" }),
        content: Object.freeze({ type: "string" }),
        encoding: Object.freeze({ enum: WRITE_ENCODING_VALUES, type: "string" }),
        line: Object.freeze({ description: "1-based line to insert at.", minimum: 1, type: "integer" }),
        operation: Object.freeze({ enum: WRITE_OPERATION_VALUES, type: "string" }),
        path: PATH_PROPERTY
      },
      required: ["path", "content"]
    }),
    source: TOOL_SOURCE.BUILTIN
  }),
  Object.freeze({
    deferrable: false,
    description: "Delete one app file or folder by path. This is irreversible and is held for confirmation.",
    handler: "space.api.fileDelete",
    name: "file_delete",
    riskClass: TOOL_RISK_CLASS.DESTRUCTIVE,
    schema: jsonSchema({
      properties: {
        path: PATH_PROPERTY
      },
      required: ["path"]
    }),
    source: TOOL_SOURCE.BUILTIN
  }),
  Object.freeze({
    deferrable: false,
    description:
      "Run one JavaScript block against the Constellation Agent runtime. Composition, batching, DOM work, spaces, and self-verification live here. Return the value the caller needs; console output is captured separately.",
    handler: "space.runtime.executeCode",
    name: "run_code",
    riskClass: TOOL_RISK_CLASS.WRITE,
    riskClassNote:
      "run_code inherits the risk class of its contents only insofar as today's confirm-first norms apply; classifying arbitrary code is an explicit later problem (plan §5).",
    schema: jsonSchema({
      properties: {
        code: Object.freeze({ type: "string" }),
        intent: Object.freeze({ description: "One short line stating what this block is for.", type: "string" })
      },
      required: ["code"]
    }),
    source: TOOL_SOURCE.BUILTIN
  })
]);

// Strict-mode projection of a JSON Schema: OpenAI strict tools require every
// property to be listed in `required` and reject additional properties, so
// optional fields are widened to `[type, "null"]` instead of being omitted.
export function toStrictSchema(schema) {
  const properties = {};
  const sourceProperties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];

  Object.keys(sourceProperties).forEach((name) => {
    const property = { ...sourceProperties[name] };

    if (!required.includes(name)) {
      property.type = Array.isArray(property.type)
        ? [...new Set([...property.type, "null"])]
        : [property.type || "string", "null"];
    }

    properties[name] = Object.freeze(property);
  });

  return Object.freeze({
    additionalProperties: false,
    properties: Object.freeze(properties),
    required: Object.freeze(Object.keys(properties)),
    type: "object"
  });
}

function validateRecord(record) {
  const problems = [];

  if (!record || typeof record !== "object") {
    throw new Error("A tool record must be an object.");
  }

  if (!String(record.name || "").trim()) {
    problems.push("name");
  }

  if (!String(record.description || "").trim()) {
    problems.push("description");
  }

  if (!record.schema || typeof record.schema !== "object") {
    problems.push("schema");
  }

  if (!Object.values(TOOL_RISK_CLASS).includes(record.riskClass)) {
    problems.push("riskClass");
  }

  if (!String(record.handler || "").trim()) {
    problems.push("handler");
  }

  if (!Object.values(TOOL_SOURCE).includes(record.source)) {
    problems.push("source");
  }

  if (typeof record.deferrable !== "boolean") {
    problems.push("deferrable");
  }

  if (problems.length) {
    throw new Error(`Invalid tool record ${String(record.name || "(unnamed)")}: ${problems.join(", ")}`);
  }

  return record;
}

// The registry itself. Records are validated once at construction, and the
// visible list is derived from (config, model) only.
export function createToolRegistry({ records = LAUNCH_TOOL_RECORDS, version = "1" } = {}) {
  const frozenRecords = Object.freeze(records.map((record) => Object.freeze(validateRecord(record))));
  const byName = new Map(frozenRecords.map((record) => [record.name, record]));

  return Object.freeze({
    get(name) {
      return byName.get(String(name || "").trim()) || null;
    },
    names: Object.freeze(frozenRecords.map((record) => record.name)),
    records: frozenRecords,
    version
  });
}

// Canonical ordering: alphabetical by tool name. This is the ordering rule that
// makes the assembled list identical across sessions of the same config.
export function canonicalToolOrder(records) {
  return [...records].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

// Small deterministic non-cryptographic digest for the assembled prefix. The
// artifact contract hashes code and args with SHA-256; this digest only needs to
// prove "same config + same model -> same bytes", so FNV-1a is enough and stays
// synchronous.
export function hashAssembledList(tools) {
  const text = stableStringify(tools);
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

function resolveEnabledNames(registry, config = {}) {
  const requested = Array.isArray(config.enabledTools) ? config.enabledTools.map((name) => String(name).trim()) : null;
  const names = requested && requested.length ? requested : registry.names;

  return [...new Set(names)].filter((name) => registry.get(name));
}

// THE assembly function. Pure: same (config, model) in, identical list, order,
// and hash out. Session-varying data never enters here (plan §3.2).
export function assembleVisibleToolList({ config = {}, model = "", registry = null } = {}) {
  const activeRegistry = registry || createToolRegistry();
  const capabilities = resolveCapabilities({
    model,
    provider: config.provider || config.providerKey,
    apiEndpoint: config.apiEndpoint
  });

  if (!capabilities.flags.tools) {
    return Object.freeze({
      capabilities,
      hash: hashAssembledList([]),
      names: Object.freeze([]),
      tools: Object.freeze([])
    });
  }

  const records = canonicalToolOrder(
    resolveEnabledNames(activeRegistry, config).map((name) => activeRegistry.get(name))
  );
  const tools = records.map((record) =>
    Object.freeze({
      description: record.description,
      name: record.name,
      parameters: capabilities.flags.tools_strict ? toStrictSchema(record.schema) : record.schema,
      riskClass: record.riskClass,
      strict: capabilities.flags.tools_strict
    })
  );

  return Object.freeze({
    capabilities,
    hash: hashAssembledList(tools),
    names: Object.freeze(tools.map((tool) => tool.name)),
    tools: Object.freeze(tools)
  });
}

// Dispatch-table stub. It exists so P2 has a shape to fill, and it can never
// execute anything in P1: every dispatch resolves to a stub result.
export function createDispatchTableStub({ registry = null } = {}) {
  const activeRegistry = registry || createToolRegistry();
  const table = new Map(
    activeRegistry.records.map((record) => [
      record.name,
      Object.freeze({
        handler: record.handler,
        name: record.name,
        riskClass: record.riskClass
      })
    ])
  );

  return Object.freeze({
    has(name) {
      return table.has(String(name || "").trim());
    },
    names: Object.freeze([...table.keys()].sort()),
    // P1 has no dispatch. This is the honest answer, not an error to catch.
    dispatch(name) {
      const entry = table.get(String(name || "").trim());

      if (!entry) {
        return Object.freeze({ dispatched: false, reason: "unregistered-tool", tool: String(name || "") });
      }

      return Object.freeze({ dispatched: false, reason: "p1-dispatch-stub", tool: entry.name });
    },
    size: table.size
  });
}

// Per-tool stats shape for later tuning. Pure bookkeeping, no I/O.
export function createToolStats() {
  const counters = new Map();

  function row(name) {
    if (!counters.has(name)) {
      counters.set(name, { calls: 0, errors: 0 });
    }

    return counters.get(name);
  }

  return Object.freeze({
    recordCall(name) {
      row(String(name || "").trim()).calls += 1;
    },
    recordError(name) {
      row(String(name || "").trim()).errors += 1;
    },
    snapshot() {
      const snapshot = {};

      [...counters.keys()].sort().forEach((name) => {
        snapshot[name] = { ...counters.get(name) };
      });

      return snapshot;
    }
  });
}
