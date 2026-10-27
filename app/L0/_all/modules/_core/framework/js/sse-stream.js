// THE ONE SSE / COMPLETION-BODY READER.
//
// Extracted from `onscreen_agent/api.js` (P4a-2) into the framework, because it knows
// nothing about any surface: it parses an OpenAI-compatible response body — a
// `text/event-stream`, or one buffered JSON completion — and reports text deltas plus
// every RAW payload. Two callers use these SAME functions, in ONE copy:
//
//   - a text turn (`streamOnscreenAgentCompletion`) renders `onDelta` strings
//   - a tool turn (`engine-swap/tool-turn-transport.js`) whose assembler needs the whole
//     delta object, because `tool_calls` fragments live outside `content`
//
// A SECOND PARSER ANYWHERE IS THE DEFECT THIS MODULE EXISTS TO PREVENT. `onPayload` is
// the seam that makes one parser serve both; dropping it at any callsite ends streaming
// tool calls silently (P3 audit blocker B1).

export function extractTextContent(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

export function extractStreamingDelta(payload) {
  const choice = payload.choices?.[0];

  if (!choice) {
    return "";
  }

  const delta = choice.delta || choice.message || {};
  return extractTextContent(delta.content || choice.text || "");
}

export function extractNonStreamingMessage(payload) {
  const choice = payload.choices?.[0];

  if (!choice) {
    return "";
  }

  const message = choice.message || {};
  return extractTextContent(message.content || choice.text || "");
}

export function createCompletionResponseMeta(mode) {
  return {
    finishReason: "",
    mode,
    payloadCount: 0,
    protocolObserved: false,
    sawDoneMarker: false,
    textChunkCount: 0,
    verifiedEmpty: false
  };
}

export function noteCompletionPayload(meta, payload, textChunk = "") {
  meta.payloadCount += 1;

  const finishReason = payload?.choices?.[0]?.finish_reason;

  if (!meta.finishReason && typeof finishReason === "string" && finishReason) {
    meta.finishReason = finishReason;
  }

  if (typeof textChunk === "string" && textChunk.trim()) {
    meta.textChunkCount += 1;
  }
}

export function finalizeCompletionResponseMeta(meta) {
  const protocolObserved = meta.mode === "standard" ? meta.payloadCount > 0 : meta.payloadCount > 0 || meta.sawDoneMarker;

  return {
    ...meta,
    protocolObserved,
    verifiedEmpty: protocolObserved && meta.textChunkCount === 0
  };
}

export async function throwResponseError(response) {
  const contentType = response.headers.get("content-type") || "";
  let detail = "";

  if (contentType.includes("application/json")) {
    try {
      const payload = await response.json();
      detail = payload.error?.message || payload.error || JSON.stringify(payload);
    } catch {
      detail = "Unable to parse JSON error body.";
    }
  } else {
    detail = await response.text();
  }

  throw new Error(`Chat request failed with status ${response.status}: ${detail || response.statusText}`);
}

export function createUnsupportedCompletionBodyError(response, bodyText) {
  const contentType = response.headers.get("content-type") || "unknown";
  const snippet = String(bodyText || "")
    .trim()
    .slice(0, 120)
    .replace(/\s+/gu, " ");

  return new Error(
    `Chat request returned status ${response.status} with an unsupported response body ` +
      `(content-type: ${contentType}). Expected an OpenAI-compatible JSON completion or a ` +
      `text/event-stream payload but received: ${snippet || "<empty body>"}`
  );
}

export function looksLikeEventStreamBody(bodyText) {
  return /^(?:data|event|id|retry):|^:/u.test(String(bodyText || "").trimStart());
}

// `onPayload` is the RAW-payload seam: the text path renders `onDelta` strings and
// needs nothing else, while the Tier 1 tool path (P3) needs the whole delta object
// because `tool_calls` fragments live outside `content`. One parser serves both — a
// second SSE parser would be the two-copies anti-pattern, and the text path is
// unaffected by the added hook.
export function pumpEventStreamText(bodyText, onDelta, meta, onPayload = null) {
  let buffer = String(bodyText || "");
  let boundary = buffer.indexOf("\n\n");

  while (boundary !== -1) {
    const eventBlock = buffer.slice(0, boundary).trim();
    buffer = buffer.slice(boundary + 2);

    if (eventBlock && parseEventBlock(eventBlock, onDelta, meta, onPayload)) {
      return finalizeCompletionResponseMeta(meta);
    }

    boundary = buffer.indexOf("\n\n");
  }

  const remaining = buffer.trim();

  if (remaining) {
    parseEventBlock(remaining, onDelta, meta);
  }

  return finalizeCompletionResponseMeta(meta);
}

export async function readBufferedResponse(response, onDelta, onPayload = null) {
  const bodyText = await response.text();

  if (looksLikeEventStreamBody(bodyText)) {
    return pumpEventStreamText(bodyText, onDelta, createCompletionResponseMeta("stream"), onPayload);
  }

  let payload;

  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw createUnsupportedCompletionBodyError(response, bodyText);
  }

  const meta = createCompletionResponseMeta("standard");
  const message = extractNonStreamingMessage(payload);

  noteCompletionPayload(meta, payload, message);

  // A provider that ignored `stream: true` still answers with complete calls, so
  // the assembler consumes the single payload and the turn proceeds. The honest
  // failure stays where it belongs: a provider that streams when asked NOT to.
  onPayload?.(payload);

  if (message) {
    onDelta(message);
  }

  return finalizeCompletionResponseMeta(meta);
}

export function parseEventBlock(eventBlock, onDelta, meta, onPayload = null) {
  const lines = eventBlock.split(/\r?\n/u);

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const value = line.slice(5).trim();

    if (!value) {
      continue;
    }

    if (value === "[DONE]") {
      meta.sawDoneMarker = true;
      return true;
    }

    const payload = JSON.parse(value);
    const delta = extractStreamingDelta(payload);

    noteCompletionPayload(meta, payload, delta);

    // The raw payload reaches the tool-call assembler BEFORE any text rendering:
    // one SSE frame can carry both a text delta and a `tool_calls` fragment, and
    // the assembler is the only consumer that understands the second half.
    onPayload?.(payload);

    if (delta) {
      onDelta(delta);
    }
  }

  return false;
}

export async function readStreamingResponse(response, onDelta, onPayload = null) {
  const meta = createCompletionResponseMeta("stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), {
      stream: !done
    });

    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const eventBlock = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);

      // `onPayload` is forwarded on BOTH callsites. Dropping it here was the P3
      // audit blocker B1: the assembler then never saw a `tool_calls` fragment on a
      // real streaming provider, so the turn ended as a blank answer.
      if (eventBlock && parseEventBlock(eventBlock, onDelta, meta, onPayload)) {
        return finalizeCompletionResponseMeta(meta);
      }

      boundary = buffer.indexOf("\n\n");
    }

    if (done) {
      const remaining = buffer.trim();

      if (remaining) {
        parseEventBlock(remaining, onDelta, meta, onPayload);
      }

      return finalizeCompletionResponseMeta(meta);
    }
  }
}

export function createApiRequestHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}
