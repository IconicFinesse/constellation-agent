// Canonical internal action shape for the engine-swap transport layer.
//
// One shape rules every provider: OpenAI chat-completions (messages, tools,
// tool_calls, tool results). Provider specifics belong behind the per-provider
// adapters in `transports.js`, never in call sites and never in the registry.
//
// This module is pure data + pure transforms. It performs no I/O, no network
// calls, and no dispatch: P1 assembles and describes what Tier 1 *would* send.

export const CANONICAL_ROLE = Object.freeze({
  ASSISTANT: "assistant",
  SYSTEM: "system",
  TOOL: "tool",
  USER: "user"
});

export const TOOL_CALL_FINISH_REASON = Object.freeze({
  TOOL_CALLS: "tool_calls"
});

function normalizeText(value) {
  return value === undefined || value === null ? "" : String(value);
}

// A tool call in canonical form keeps the parsed argument object and the exact
// JSON string the provider contract carries on the wire. Argument fragments are
// strings until complete (plan §3.5) and are never parsed mid-flight.
//
// The raw string is authoritative. Parsing is best-effort CONVENIENCE for callers
// that want the object, never a gate: a malformed complete-args payload must reach
// the dispatch pipeline's validation stage and become a coaching error, not throw
// here and kill the whole turn. `argumentsParseError` records the failure so a
// caller can tell `{}`-because-empty from `{}`-because-unparseable.
export function createCanonicalToolCall({ arguments: rawArguments, id, name } = {}) {
  const normalizedName = normalizeText(name).trim();

  if (!normalizedName) {
    throw new Error("A canonical tool call requires a tool name.");
  }

  let argumentValues = {};
  let argumentText = "";
  let argumentParseError = null;

  if (typeof rawArguments === "string") {
    argumentText = rawArguments;

    if (rawArguments.trim()) {
      try {
        const parsed = JSON.parse(rawArguments);

        // Only a JSON object is a tool-call argument list; an array or scalar is
        // as malformed as broken JSON and is reported the same way.
        argumentValues = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        argumentParseError = String(error?.message || error);
      }
    }
  } else if (rawArguments && typeof rawArguments === "object") {
    argumentValues = Array.isArray(rawArguments) ? {} : rawArguments;
    argumentText = JSON.stringify(argumentValues);
  }

  const call = {
    arguments: argumentValues,
    argumentsJson: argumentText,
    id: normalizeText(id).trim() || `call_${normalizedName}`,
    name: normalizedName
  };

  if (argumentParseError) {
    call.argumentsParseError = argumentParseError;
  }

  return Object.freeze(call);
}

export function createCanonicalMessage({ content, name, role, toolCallId, toolCalls } = {}) {
  const normalizedRole = normalizeText(role).trim();

  if (!Object.values(CANONICAL_ROLE).includes(normalizedRole)) {
    throw new Error(`Unsupported canonical message role: ${String(role || "")}`);
  }

  const calls = Array.isArray(toolCalls) ? toolCalls.map((call) => createCanonicalToolCall(call)) : [];
  const message = {
    content: normalizeText(content),
    role: normalizedRole
  };

  if (normalizedRole === CANONICAL_ROLE.ASSISTANT && calls.length) {
    message.toolCalls = Object.freeze(calls);
  }

  if (normalizedRole === CANONICAL_ROLE.TOOL) {
    message.toolCallId = normalizeText(toolCallId).trim();

    if (!message.toolCallId) {
      throw new Error("A canonical tool result requires the originating tool call id.");
    }
  }

  if (name) {
    message.name = normalizeText(name).trim();
  }

  return Object.freeze(message);
}

export function createAssistantTextMessage(content) {
  return createCanonicalMessage({ content, role: CANONICAL_ROLE.ASSISTANT });
}

export function createAssistantToolCallMessage({ content = "", toolCalls } = {}) {
  return createCanonicalMessage({ content, role: CANONICAL_ROLE.ASSISTANT, toolCalls });
}

export function createToolResultMessage({ content, isError = false, toolCallId } = {}) {
  const message = createCanonicalMessage({ content, role: CANONICAL_ROLE.TOOL, toolCallId });

  return isError ? Object.freeze({ ...message, isError: true }) : message;
}

export function createUserMessage(content) {
  return createCanonicalMessage({ content, role: CANONICAL_ROLE.USER });
}

export function createSystemMessage(content) {
  return createCanonicalMessage({ content, role: CANONICAL_ROLE.SYSTEM });
}

// Canonical -> OpenAI wire shape. The only transformation is the JSON string
// for arguments and the `tool_calls` casing OpenAI requires.
export function canonicalMessagesToOpenAi(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map((message) => {
    const wireMessage = {
      content: message.content,
      role: message.role
    };

    if (message.role === CANONICAL_ROLE.ASSISTANT && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      wireMessage.tool_calls = message.toolCalls.map((call) => ({
        function: {
          arguments: call.argumentsJson,
          name: call.name
        },
        id: call.id,
        type: "function"
      }));
    }

    if (message.role === CANONICAL_ROLE.TOOL) {
      wireMessage.tool_call_id = message.toolCallId;
    }

    if (message.name) {
      wireMessage.name = message.name;
    }

    return wireMessage;
  });
}

// Strict-mode projection of a JSON Schema: OpenAI strict tools require every
// property to be listed in `required` and reject additional properties, so
// optional fields are widened to `[type, "null"]` instead of being omitted.
//
// This is a canonical -> wire transform, so it lives here and nowhere else. The
// tool registry re-exports it as part of its public surface; a second copy of
// this rule is the two-copies anti-pattern the campaign exists to end.
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

      // Strict mode requires every property, so an optional enum'd field with a
      // null-less enum would have no legal sendable value. The widened type and
      // the enum must agree, or the schema is a dead end for the model.
      if (Array.isArray(property.enum) && !property.enum.includes(null)) {
        property.enum = [...property.enum, null];
      }
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

// Tool definition -> OpenAI function tool. Accepts BOTH shapes that exist in the
// product:
//
//   record shape    { name, description, schema, riskClass, handler, ... }
//   assembled shape { name, description, parameters, riskClass, strict }
//
// `assembleVisibleToolList` produces the assembled shape and `buildRequest` used
// to read only `record.schema`, so the per-session visible list arrived at the
// transport with `parameters: undefined` (audit-2 finding 2). Both shapes compose
// here now, which is the one seam that makes registry output POSTable.
//
// Strict widening is applied HERE, not left to the caller: a `strict: true`
// definition whose `required` omits optional properties and whose optional enum
// carries no null is a dead end for the model (audit-2 finding 1).
export function toolRecordToOpenAiTool(record, { strict = false } = {}) {
  if (!record || typeof record !== "object" || !record.name) {
    throw new Error("A tool record with a name is required to build a tool definition.");
  }

  const sourceSchema = record.parameters && typeof record.parameters === "object" ? record.parameters : record.schema;
  const strictRequested = strict === true || record.strict === true;
  const parameters = strictRequested ? toStrictSchema(sourceSchema) : sourceSchema;

  if (parameters === undefined) {
    throw new Error(`Tool record ${String(record.name)} carries no parameter schema.`);
  }

  const definition = {
    function: {
      description: normalizeText(record.description),
      name: record.name,
      parameters
    },
    type: "function"
  };

  if (strictRequested) {
    definition.function.strict = true;
  }

  return Object.freeze(definition);
}

// OpenAI response -> canonical calls. Preserves the raw argument string so a
// later phase can dispatch only on complete, valid JSON (plan §3.5).
export function openAiToolCallsToCanonical(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.map((call) =>
    createCanonicalToolCall({
      arguments: call?.function?.arguments ?? "",
      id: call?.id,
      name: call?.function?.name
    })
  );
}

export const CANONICAL_TURN_IDLE = Object.freeze({
  finishReason: "",
  hasToolCalls: false
});

export function describeCanonicalTurn(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const toolCallCount = list.reduce(
    (total, message) => total + (Array.isArray(message.toolCalls) ? message.toolCalls.length : 0),
    0
  );

  return Object.freeze({
    finishReason: toolCallCount ? TOOL_CALL_FINISH_REASON.TOOL_CALLS : "",
    hasToolCalls: toolCallCount > 0,
    messageCount: list.length,
    toolCallCount
  });
}
