// THE TRANSPORT BOUNDARY (P4a-2).
//
// WHY THIS SUITE EXISTS. The behaviour suites prove a tool turn still WORKS. They are
// structurally unable to prove that the transport became SURFACE-NEUTRAL, and that is the
// entire point of this lane: a second surface must be able to run a tool turn without
// importing another surface's internals. So this suite asserts the seam, in three parts:
//
//   PART 1 — STRUCTURE. The framework transport imports ONLY framework code, the framework
//   carries no surface default, and the surface module no longer holds a second copy of the
//   SSE parser. Scanned on COMMENT-STRIPPED code, because these files DOCUMENT the forbidden
//   shapes and a raw text scan would fire on the documentation of the rule.
//
//   PART 2 — BEHAVIOUR, driven through the REAL framework transport with a fake response:
//   `onPayload` reaches the assembler on BOTH reader callsites (the streaming one and the
//   buffered one — dropping it at either ended a whole streaming feature once), and
//   `onToolCallComplete` receives the ARGUMENTS, an empty stream still throws, and an abort
//   still aborts.
//
//   PART 3 — DELEGATION. The surface export keeps its name and signature and resolves ITS
//   OWN settings default, which is the one thing the framework deliberately does not own.
//
// Hermetic: a local `fetch` stub, the SHARED module-specifier loader, no network, no key,
// no app-data writes.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

globalThis.window = globalThis;
globalThis.location = new URL("http://127.0.0.1:3000/");
globalThis.space = {
  ...(globalThis.space && typeof globalThis.space === "object" ? globalThis.space : {}),
  extend: (_moduleRef, extensionTarget) => extensionTarget
};

const FRAMEWORK_DIR = new URL(
  "../app/L0/_all/modules/_core/framework/js/",
  import.meta.url
);
const API_URL = new URL(
  "../app/L0/_all/modules/_core/onscreen_agent/api.js",
  import.meta.url
);
const TRANSPORT_URL = new URL("engine-swap/tool-turn-transport.js", FRAMEWORK_DIR);

// Comments are stripped BEFORE any structural scan: these modules document the shapes they
// forbid, and documentation must never be mistaken for a defect.
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/^\s*\/\/.*$/gmu, " ");
}

function importSpecifiers(source) {
  return [...stripComments(source).matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
}

const SETTINGS = Object.freeze({
  apiEndpoint: "http://127.0.0.1:3000/v1/chat/completions",
  apiKey: "test-key-not-real",
  model: "test-model",
  provider: "openai"
});

function createChunkedReader(chunks) {
  let index = 0;

  return {
    async read() {
      if (index >= chunks.length) {
        return { done: true, value: undefined };
      }

      const value = new TextEncoder().encode(chunks[index]);

      index += 1;

      return { done: false, value };
    }
  };
}

function createStreamResponse(chunks) {
  return {
    body: { getReader: () => createChunkedReader(chunks) },
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : null)
    },
    ok: true,
    status: 200,
    text: async () => chunks.join("")
  };
}

function createJsonResponse(payload, contentType = "application/json") {
  return {
    body: null,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? contentType : null) },
    json: async () => payload,
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload)
  };
}

async function withFetch(t, respond, run) {
  const previous = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, init) => {
    requests.push({ init, url: String(url) });

    return respond(requests[requests.length - 1]);
  };

  t.after(() => {
    globalThis.fetch = previous;
  });

  return run(requests);
}

function requestBody() {
  return {
    messages: [{ content: "read my notes", role: "user" }],
    model: "test-model",
    stream: true,
    tools: [{ function: { name: "file_read" }, type: "function" }]
  };
}

function streamFrames() {
  return [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"file_read","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"~/notes.txt\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n"
  ];
}

// --- PART 1: STRUCTURE -------------------------------------------------------

test("the framework transport imports no surface, and carries no surface default", async () => {
  const source = await readFile(TRANSPORT_URL, "utf8");
  const specifiers = importSpecifiers(source);

  assert.ok(specifiers.length > 0, "the transport imports something, or this check is vacuous");

  for (const specifier of specifiers) {
    const isFramework =
      specifier.startsWith("/modules/_core/framework/js/") ||
      specifier.startsWith("./") ||
      specifier.startsWith("../");

    assert.ok(
      isFramework,
      `a framework transport may not import a surface (onscreen_agent/ or admin/): saw ${specifier}`
    );
  }

  const code = stripComments(source);

  // The settings default belongs to the CALLER. A framework default could silently
  // disagree with the surface's own, so the framework must not name one at all.
  assert.equal(
    /DEFAULT_ONSCREEN_AGENT_SETTINGS|DEFAULT_ADMIN_AGENT_SETTINGS/u.test(code),
    false,
    "the transport must not resolve a surface settings default"
  );

  // The other way this boundary dies: it still imports only framework code but starts
  // behaving differently per caller. A surface identity check is that failure.
  assert.equal(
    /\b(surface|onscreenAgent|admin)\s*(===|!==)\s*["'`a-zA-Z]/u.test(code),
    false,
    "the transport must never branch on which surface it serves"
  );
});

test("the surface module carries NO second SSE parser, and imports the framework one", async () => {
  const source = await readFile(API_URL, "utf8");
  const code = stripComments(source);

  // ONE parser, one copy. These definitions moving back into the surface is the drift
  // defect this extraction exists to remove, so their ABSENCE is the assertion.
  for (const forbidden of [
    "function parseEventBlock",
    "function pumpEventStreamText",
    "async function readStreamingResponse",
    "async function readBufferedResponse",
    "function throwResponseError",
    "function looksLikeEventStreamBody",
    "function createStreamingToolCallAssembler"
  ]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `the surface must not define its own copy: ${forbidden}`
    );
  }

  const specifiers = importSpecifiers(source);

  assert.ok(
    specifiers.includes("/modules/_core/framework/js/sse-stream.js"),
    "the surface imports the ONE shared reader instead of keeping a copy"
  );
  assert.ok(
    specifiers.includes("/modules/_core/framework/js/engine-swap/tool-turn-transport.js"),
    "the surface delegates the tool-turn transport to the framework"
  );
});

// --- PART 2: BEHAVIOUR of the real framework transport ------------------------

test("onPayload reaches the assembler on the STREAMING callsite", async (t) => {
  const { streamToolTurnTransport } = await import(TRANSPORT_URL.href);

  await withFetch(t, () => createStreamResponse(streamFrames()), async () => {
    const assembled = await streamToolTurnTransport({
      requestBody: requestBody(),
      settings: SETTINGS
    });

    // Four fragments assembled into ONE complete call: only possible if every raw payload
    // crossed the hook. A dropped `onPayload` here yields zero calls, not a wrong argument.
    assert.equal(assembled.toolCalls.length, 1);
    assert.equal(assembled.toolCalls[0].name, "file_read");
    assert.deepEqual(JSON.parse(assembled.toolCalls[0].arguments), { path: "~/notes.txt" });
    assert.equal(assembled.sawAnyPayload, true);
  });
});

test("onPayload reaches the assembler on the BUFFERED callsite too", async (t) => {
  const { streamToolTurnTransport } = await import(TRANSPORT_URL.href);
  const payload = {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "",
          tool_calls: [
            {
              function: { arguments: '{"path":"~/notes.txt"}', name: "file_read" },
              id: "call_b",
              type: "function"
            }
          ]
        }
      }
    ]
  };

  // A provider that ignored `stream: true` answers with one JSON body. The same assembler
  // must consume it, which requires the buffered reader to forward the payload as well.
  await withFetch(t, () => createJsonResponse(payload), async () => {
    const assembled = await streamToolTurnTransport({
      requestBody: requestBody(),
      settings: SETTINGS
    });

    assert.equal(assembled.toolCalls.length, 1);
    assert.equal(assembled.toolCalls[0].id, "call_b");
    assert.deepEqual(JSON.parse(assembled.toolCalls[0].arguments), { path: "~/notes.txt" });
  });
});

test("onToolCallComplete receives the ARGUMENTS the model actually sent", async (t) => {
  const { streamToolTurnTransport } = await import(TRANSPORT_URL.href);
  const completions = [];

  await withFetch(t, () => createStreamResponse(streamFrames()), async () => {
    await streamToolTurnTransport({
      onToolCallComplete: (call) => completions.push(call),
      requestBody: requestBody(),
      settings: SETTINGS
    });
  });

  // The COUNT is deliberately not asserted here. The transport notifies on every payload that
  // carries a complete call, so a trailing `finish_reason` frame repeats the same call — that
  // is pre-existing behaviour on the base commit, verified there, and the STORE dedupes by
  // call id. Pinning "exactly one" would encode a contract this extraction never had, and
  // changing the counts would be a behaviour change, which this lane forbids.
  assert.ok(completions.length >= 1, "a completed call notifies at least once");

  for (const completion of completions) {
    assert.equal(completion.name, "file_read");
    assert.equal(completion.id, "call_a");
    // The RAW JSON string, exactly as the provider sent it: the chip parses it through the
    // same canonical writer the committed row uses.
    assert.equal(typeof completion.arguments, "string");
    assert.deepEqual(JSON.parse(completion.arguments), { path: "~/notes.txt" });
  }
});

test("an empty stream still throws instead of returning an empty turn", async (t) => {
  const { streamToolTurnTransport } = await import(TRANSPORT_URL.href);

  await withFetch(t, () => createStreamResponse([""]), async () => {
    await assert.rejects(
      () => streamToolTurnTransport({ requestBody: requestBody(), settings: SETTINGS }),
      /produced no completion payload/u
    );
  });
});

test("an abort still aborts: the caller signal reaches fetch and the failure propagates", async (t) => {
  const { streamToolTurnTransport } = await import(TRANSPORT_URL.href);
  const controller = new AbortController();
  const seen = [];

  await withFetch(
    t,
    () => {
      controller.abort();

      const error = new Error("The operation was aborted.");
      error.name = "AbortError";

      throw error;
    },
    async () => {
      await assert.rejects(
        () =>
          streamToolTurnTransport({
            requestBody: requestBody(),
            settings: SETTINGS,
            signal: controller.signal
          }),
        (error) => error.name === "AbortError"
      );
    }
  );

  // The signal is handed to fetch, not swallowed: an in-flight tool request is CUT, which is
  // the stop contract the surface relies on.
  const previous = globalThis.fetch;

  try {
    globalThis.fetch = async (_url, init) => {
      seen.push(init?.signal);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };

    await assert.rejects(() =>
      streamToolTurnTransport({
        requestBody: requestBody(),
        settings: SETTINGS,
        signal: controller.signal
      })
    );
  } finally {
    globalThis.fetch = previous;
  }

  assert.equal(seen[0], controller.signal, "the caller's own signal object reaches fetch");
});

test("the framework resolves no default: missing settings fail loudly, they do not borrow one", async (t) => {
  const { streamToolTurnTransport } = await import(TRANSPORT_URL.href);

  // With no settings the framework has nothing to send. If a framework-level default existed
  // it would silently post to someone else's endpoint, which is exactly what must not happen.
  await withFetch(t, () => createJsonResponse({}), async () => {
    await assert.rejects(
      () => streamToolTurnTransport({ requestBody: requestBody() }),
      /Set an API endpoint/u
    );
  });
});

// --- PART 3: DELEGATION from the surface -------------------------------------

test("the surface export keeps its name and signature, and supplies its OWN default", async () => {
  const api = await import(API_URL.href);

  assert.equal(typeof api.streamOnscreenAgentToolTurn, "function");
  assert.equal(typeof api.completeOnscreenAgentToolTurn, "function");

  // Called with no settings the SURFACE resolves `DEFAULT_ONSCREEN_AGENT_SETTINGS`, whose
  // shipped endpoint is non-empty; the framework then has a real endpoint to reject the
  // missing key on. That ordering is the proof the default moved to the caller rather than
  // disappearing: without it the failure would be "Set an API endpoint".
  await assert.rejects(
    () => api.streamOnscreenAgentToolTurn({ requestBody: requestBody() }),
    /Set an API key/u
  );
});
