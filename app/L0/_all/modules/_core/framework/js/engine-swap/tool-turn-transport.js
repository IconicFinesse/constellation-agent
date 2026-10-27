// THE TOOL-TURN TRANSPORT (P4a-2).
//
// Moved out of a surface module into the framework so a SECOND surface can run a tool
// turn without importing another surface's internals. This module is surface-neutral: it
// imports the shared completion-body reader and the proxy helper, and NOTHING from a
// surface (`onscreen_agent/`, `admin/`). There is no surface identity branch here and
// there must never be one — a per-surface branch would be a fork of the transport
// wearing a flag, which is the defect this extraction exists to remove.
//
// SETTINGS ARRIVE ALREADY RESOLVED. The surface owns its settings shape and its own
// defaults, so IT resolves them and passes the result in. A framework-level default here
// could silently disagree with the surface's, so there is none.
//
// One transport, two entry points:
//   - `streamToolTurnTransport` consumes the body incrementally and lets
//     `stream-assembly.js` accumulate `tool_calls` fragments per call index
//   - `completeToolTurnTransport` asks for one JSON body, for a provider or model that
//     will not stream; it is the fallback, not the contract
//
// Two provider deviations are handled explicitly rather than by hoping:
//   - the provider answers with one JSON body although streaming was requested: the same
//     assembler consumes that single payload and the turn proceeds
//   - the provider reports `finish_reason: "length"` (it stopped mid-output) or the
//     transport aborted: the assembled calls are marked incomplete, so nothing is
//     dispatched from a cut stream
//
// `onPayload` reaches the assembler on BOTH reader callsites. Dropping it at either one
// ended an entire streaming feature once; it is load-bearing.

import {
  createApiRequestHeaders,
  createUnsupportedCompletionBodyError,
  looksLikeEventStreamBody,
  readBufferedResponse,
  readStreamingResponse,
  throwResponseError
} from "/modules/_core/framework/js/sse-stream.js";
import * as proxyUrl from "/modules/_core/framework/js/proxy-url.js";
import { createStreamingToolCallAssembler } from "/modules/_core/framework/js/engine-swap/stream-assembly.js";

// Non-streamed completion used by the engine-swap Tier 1 tool loop.
//
// P2 shipped this as the ONLY tool-turn transport because the incremental reader
// extracted text deltas and dropped `tool_calls`. P3 replaced that boundary: a tool
// turn now streams and `streamToolTurnTransport` assembles fragments per call
// index. This function stays because a provider/model that ignores streaming still
// has to work, and because "ask for one body" remains the right move when a stream
// is unavailable — it is the fallback, not the contract.
//
// The shared engine-swap layer builds the request BODY (transports.js) and never
// fetches; this function owns the URL, the auth header, and the response parse,
// exactly as `streamCompletion` does for the streaming path.
export async function completeToolTurnTransport({ requestBody, settings, signal } = {}) {
    const effectiveSettings =
      settings && typeof settings === "object" ? settings : {};
    const apiEndpoint = String(effectiveSettings?.apiEndpoint || "").trim();

    if (!apiEndpoint) {
      throw new Error("Set an API endpoint before sending a message.");
    }

    if (!String(effectiveSettings?.apiKey || "").trim()) {
      throw new Error("Set an API key before sending a message.");
    }

    if (!String(effectiveSettings?.model || "").trim()) {
      throw new Error("Set a model before sending a message.");
    }

    if (!requestBody || typeof requestBody !== "object") {
      throw new Error("A tool turn requires an assembled request body.");
    }

    const response = await fetch(resolveToolTurnRequestUrl(apiEndpoint), {
      body: JSON.stringify(requestBody),
      headers: createApiRequestHeaders(String(effectiveSettings.apiKey || "").trim()),
      method: "POST",
      signal
    });

    if (!response.ok) {
      await throwResponseError(response);
    }

    const bodyText = await response.text();
    let payload;

    try {
      payload = JSON.parse(bodyText);
    } catch {
      // A tool turn asked for a single JSON body. An event stream here means the
      // provider ignored `stream: false`; report that plainly rather than parsing
      // half an event as a completion.
      if (looksLikeEventStreamBody(bodyText)) {
        throw new Error(
          "Tool turn expected one JSON completion but the provider streamed an event payload. " +
            "Disable streaming for this provider or wait for the streaming tool-call assembler."
        );
      }

      throw createUnsupportedCompletionBodyError(response, bodyText);
    }

    return payload;
}

// STREAMED tool turn (P3). This is the transport the Tier 1 loop uses now: the
// same fetch/auth/URL handling as `completeToolTurnTransport`, but the body is
// consumed incrementally and `stream-assembly.js` accumulates `tool_calls`
// fragments per call index. Argument fragments stay STRINGS until the stream says
// it is finished; nothing is parsed mid-flight, so a partial call can never be
// dispatched.
//
// Two provider deviations are handled explicitly rather than by hoping:
//   - the provider answers with one JSON body although streaming was requested:
//     the same assembler consumes that single payload and the turn proceeds
//   - the provider reports `finish_reason: "length"` (it stopped mid-output) or the
//     transport aborted: the assembled calls are marked incomplete AND the caller
//     sees `truncated`, so nothing is dispatched from a cut stream
//
// `onDelta` gets the text deltas so the surface can render prose while calls are
// still assembling. Rendering is optional; assembly is not.
export async function streamToolTurnTransport({
    onDelta = null,
    onToolCallComplete = null,
    requestBody,
    settings,
    signal
  } = {}) {
    const effectiveSettings =
      settings && typeof settings === "object" ? settings : {};
    const apiEndpoint = String(effectiveSettings?.apiEndpoint || "").trim();

    if (!apiEndpoint) {
      throw new Error("Set an API endpoint before sending a message.");
    }

    if (!String(effectiveSettings?.apiKey || "").trim()) {
      throw new Error("Set an API key before sending a message.");
    }

    if (!String(effectiveSettings?.model || "").trim()) {
      throw new Error("Set a model before sending a message.");
    }

    if (!requestBody || typeof requestBody !== "object") {
      throw new Error("A tool turn requires an assembled request body.");
    }

    const assembler = createStreamingToolCallAssembler();
    const response = await fetch(resolveToolTurnRequestUrl(apiEndpoint), {
      body: JSON.stringify(requestBody),
      headers: createApiRequestHeaders(String(effectiveSettings.apiKey || "").trim()),
      method: "POST",
      signal
    });

    if (!response.ok) {
      await throwResponseError(response);
    }

    const onPayload = (payload) => {
      assembler.applyPayload(payload);

      // PROVISIONAL CHIP HOOK (chat-surface polish, item 2). The surface wants to
      // paint a `running` chip as soon as a call's arguments COMPLETE, not only when
      // the turn ends. `finish()` is pure and non-mutating, so asking it mid-stream
      // reuses the ONE completeness owner instead of re-deriving a second verdict
      // beside it. The loop still dispatches from the FINAL assembled result; this
      // notification changes nothing about assembly or dispatch.
      if (typeof onToolCallComplete === "function") {
        let assembledNow = null;

        try {
          assembledNow = assembler.finish();
        } catch {
          assembledNow = null;
        }

        (assembledNow?.toolCalls || []).forEach((call) => {
          if (call.argumentsComplete !== true) {
            return;
          }

          try {
            // The ARGUMENTS travel with the notification. The chip must show the code the
            // model actually sent, and the assembler has it right here — the surface only
            // ever lacked the plumbing. The raw JSON string is passed exactly as the
            // provider sent it, so the shared history formatter parses it through the SAME
            // canonical writer the committed row uses (parity by construction, not by a
            // lookalike formatter).
            onToolCallComplete({ arguments: call.arguments, id: call.id, name: call.name });
          } catch {
            // Painting must never break assembly or dispatch.
          }
        });
      }
    };
    const deliver = (delta) => {
      try {
        onDelta?.(delta);
      } catch {
        // Rendering must never break assembly.
      }
    };

    // A missing `content-type` cannot veto the turn: the buffered reader already
    // sniffs an event-stream body, so an unlabelled response is handled, not failed.
    const contentType = String(response.headers?.get?.("content-type") || "");

    if (contentType.includes("text/event-stream") && response.body) {
      await readStreamingResponse(response, deliver, onPayload);
    } else {
      await readBufferedResponse(response, deliver, onPayload);
    }

    // `truncated` is not passed here: an abort surfaces as a thrown fetch error, and
    // a provider that stopped mid-output says so in `finish_reason`, which the
    // assembler reads itself. Inventing a truncation signal from a missing
    // end-marker would refuse healthy turns from providers that never send one.
    const assembled = assembler.finish();

    // A stream that delivered NO payload is a transport anomaly, and it must be a
    // legible error rather than an empty assistant turn (P3 audit N1): without this,
    // a silently-empty stream is indistinguishable from "the model answered nothing".
    if (assembled.sawAnyPayload === false) {
      throw new Error(
        "The streaming tool turn produced no completion payload. Check the provider's streaming support, then retry."
      );
    }

    return assembled;
}

function resolveToolTurnRequestUrl(apiEndpoint) {
  if (!proxyUrl.isProxyableExternalUrl(apiEndpoint)) {
    return apiEndpoint;
  }

  // `window` is absent under `node --test`; the proxy is a browser affordance, so
  // its absence falls through to the plain URL rather than throwing a ReferenceError.
  const browserWindow = typeof window === "undefined" ? null : window;

  if (browserWindow?.space?.proxy?.buildUrl) {
    return browserWindow.space.proxy.buildUrl(apiEndpoint);
  }

  return proxyUrl.buildProxyUrl(apiEndpoint);
}
