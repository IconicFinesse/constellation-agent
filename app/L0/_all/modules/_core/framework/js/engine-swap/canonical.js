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
export function createCanonicalToolCall({ arguments: rawArguments, id, name } = {}) {
  const normalizedName = normalizeText(name).trim();

  if (!normalizedName) {
    throw new Error("A canonical tool call requires a tool name.");
  }

  let argumentValues = {};
  let argumentText = "";

  if (typeof rawArguments === "string") {
    argumentText = rawArguments;
    argumentValues = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } else if (rawArguments && typeof rawArguments === "object") {
    argumentValues = rawArguments;
    argumentText = JSON.stringify(rawArguments);
  }

  return Object.freeze({
    arguments: argumentValues,
    argumentsJson: argumentText,
    id: normalizeText(id).trim() || `call_${normalizedName}`,
    name: normalizedName
  });
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

// Registry record -> OpenAI function tool. `strict` is only emitted when the
// resolved capability set says the provider honours strict schemas (D2).
export function toolRecordToOpenAiTool(record, { strict = false } = {}) {
  if (!record || typeof record !== "object" || !record.name) {
    throw new Error("A tool record with a name is required to build a tool definition.");
  }

  const definition = {
    function: {
      description: normalizeText(record.description),
      name: record.name,
      parameters: record.schema
    },
    type: "function"
  };

  if (strict === true) {
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
