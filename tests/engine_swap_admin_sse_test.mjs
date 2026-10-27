// Focused engine-swap P4a-3b coverage: admin's SSE reader family is IMPORTED, not copied.
//
// The defect this closes: `admin/views/agent/api.js` carried its own copy of the
// completion-body reader — event-block parse, streaming read, buffered read, the
// event-stream body sniff, the unsupported-body error, auth headers, and the text/
// delta extractors. P4a-2 moved that family into `framework/js/sse-stream.js` and made
// the onscreen surface import it, but admin kept its duplicate, which is the
// two-parser defect the campaign exists to remove: one behaviour, two implementations,
// guaranteed to drift.
//
// TWO KINDS OF CASE LIVE HERE, and they prove different things:
//
//   1. STRUCTURAL ABSENCE — the surface defines NONE of the fourteen functions and
//      imports them from the framework module. This is the guarantee that survives a
//      future edit: reintroducing any one copy is the same defect regardless of which.
//      These cases are RED on the base commit, where the copies exist.
//
//   2. BEHAVIOUR PARITY — the real exported `streamAdminAgentCompletion` still parses
//      exactly as before: same deltas, same ordering, same empty-stream shape, same
//      unsupported-body and HTTP error text, same abort propagation, same meta. These
//      cases are GREEN on the base commit BY DESIGN, because they assert INVARIANCE
//      that must hold on both trees. A green parity case here is not evidence the
//      consolidation happened; the absence cases are. A RED one would be a regression.
//
// `onPayload` IS DELIBERATELY NOT WIRED. The shared reader takes it as an optional
// fourth argument defaulting to null, and admin has no tool-call assembler — wiring
// one is the adoption lane (P4a-3c). The absence of that token is asserted here, and
// a behavioural case pins that a `tool_calls`-only payload still renders no text,
// which is what admin does today.
//
// Hermetic: no disk, no network, no DOM. Every case runs the REAL product function
// over a fake `fetch` response, so the assertions land on the code admin actually runs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const ADMIN_API_URL = new URL(
  "../app/L0/_all/modules/_core/admin/views/agent/api.js",
  import.meta.url
);
const SHARED_SSE_URL = new URL(
  "../app/L0/_all/modules/_core/framework/js/sse-stream.js",
  import.meta.url
);

// The fourteen functions admin used to define locally. Five were byte-identical
// helpers (the extractors and the meta bookkeeping), eight were the reader family
// itself, and `createHeaders` was the same body as `createApiRequestHeaders` under a
// shorter name — verified byte-for-byte before the swap, which is why it is included.
const CONSOLIDATED_FUNCTIONS = Object.freeze([
  "createApiRequestHeaders",
  "createCompletionResponseMeta",
  "createUnsupportedCompletionBodyError",
  "extractNonStreamingMessage",
  "extractStreamingDelta",
  "extractTextContent",
  "finalizeCompletionResponseMeta",
  "looksLikeEventStreamBody",
  "noteCompletionPayload",
  "parseEventBlock",
  "pumpEventStreamText",
  "readBufferedResponse",
  "readStreamingResponse",
  "throwResponseError"
]);

// `createHeaders` is the pre-consolidation name of `createApiRequestHeaders`; it must
// not come back either, or a future edit re-forks the header shape under the old name.
const RETIRED_LOCAL_NAMES = Object.freeze([...CONSOLIDATED_FUNCTIONS, "createHeaders"]);

function readSource(url) {
  return readFileSync(url, "utf8");
}

// Strip comments so prose about the consolidation can never satisfy — or defeat —
// a structural assertion. Deliberately simple: this only has to be reliable for
// `function NAME` and identifier scans, not a full ECMAScript lexer.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:\\])\/\/.*$/u, "$1"))
    .join("\n");
}

// Count the top-level arguments of every `name(...)` CALL in `source`. Skips the
// import list and any declaration (neither is followed by an argument list in the
// shape we care about), and skips string literals so a comma inside one cannot be
// miscounted. Deliberately small: it exists to answer one question, "was a fourth
// argument passed", not to be a parser.
function callArities(source, name) {
  const arities = [];
  const needle = `${name}(`;
  let from = 0;

  while (true) {
    const at = source.indexOf(needle, from);

    if (at === -1) {
      break;
    }

    from = at + needle.length;

    // Skip a declaration (`function name(`) and the import list entry (`  name,`).
    const before = source.slice(Math.max(0, at - 40), at);

    if (/function\s+$/u.test(before) || /export\s+/u.test(before)) {
      continue;
    }

    let depth = 0;
    let commas = 0;
    let hasContent = false;
    let quote = "";
    let index = at + needle.length - 1;

    for (; index < source.length; index += 1) {
      const ch = source[index];

      if (quote) {
        if (ch === quote) {
          quote = "";
        }

        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        hasContent = true;
        continue;
      }

      if (ch === "(") {
        depth += 1;
        continue;
      }

      if (ch === ")") {
        depth -= 1;

        if (depth === 0) {
          break;
        }

        continue;
      }

      if (depth === 1) {
        if (ch === ",") {
          commas += 1;
        } else if (!/\s/u.test(ch)) {
          hasContent = true;
        }
      }
    }

    arities.push(hasContent ? commas + 1 : 0);
  }

  return arities;
}

function installRuntime() {
  const runtime = {
    api: {
      async fileRead() {
        return { content: "[]" };
      },
      async fileWrite() {
        return { ok: true };
      }
    },
    config: {
      get(_name, fallback = undefined) {
        return fallback;
      }
    },
    extend(_meta, value) {
      return value;
    },
    fw: {
      createStore(_name, model) {
        return model;
      }
    },
    proxy: {
      buildUrl(url) {
        return url;
      }
    },
    utils: {
      userCrypto: {
        async decryptText(value) {
          return value;
        },
        async encryptText(value) {
          return value;
        }
      },
      yaml: {
        parse() {
          return {};
        },
        stringify() {
          return "";
        }
      }
    }
  };

  globalThis.space = runtime;
  globalThis.window = {
    addEventListener() {},
    cancelAnimationFrame() {},
    location: { href: "http://localhost/" },
    matchMedia() {
      return { addEventListener() {}, matches: false };
    },
    removeEventListener() {},
    requestAnimationFrame(callback) {
      callback(0);

      return 1;
    },
    space: runtime
  };
  globalThis.document = {
    addEventListener() {},
    body: { appendChild() {} },
    createElement() {
      return { appendChild() {}, classList: { add() {}, remove() {} }, setAttribute() {}, style: {} };
    },
    documentElement: { appendChild() {} },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    removeEventListener() {}
  };
  globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };

  return runtime;
}

installRuntime();

const adminApi = await import("/modules/_core/admin/views/agent/api.js");
const { streamAdminAgentCompletion } = adminApi;

const SETTINGS = Object.freeze({
  apiEndpoint: "https://api.example.test/v1/chat/completions",
  apiKey: "test-key",
  model: "test-model",
  paramsText: "",
  provider: "api",
  supportsVision: false
});

const PROMPT_CONTEXT = Object.freeze({ requestMessages: [], systemPrompt: "SYS" });

function headerMap(entries) {
  return {
    get(name) {
      return entries[String(name).toLowerCase()] ?? null;
    }
  };
}

const encode = (text) => new TextEncoder().encode(text);

function streamResponse({ chunks, contentType = "text/event-stream", abortAtRead = -1 }) {
  let index = 0;

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: headerMap({ "content-type": contentType }),
    body: {
      getReader() {
        return {
          async read() {
            if (index === abortAtRead) {
              const error = new Error("The operation was aborted.");

              error.name = "AbortError";
              throw error;
            }

            if (index >= chunks.length) {
              return { done: true, value: undefined };
            }

            const chunk = chunks[index++];

            return {
              done: false,
              value: typeof chunk === "string" ? encode(chunk) : chunk
            };
          }
        };
      }
    },
    async json() {
      throw new Error("json() is not expected on a streaming response");
    },
    async text() {
      throw new Error("text() is not expected on a streaming response");
    }
  };
}

function bufferedResponse({ body, contentType = "application/json", status = 200 }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 429 ? "Too Many Requests" : "Internal Server Error",
    headers: headerMap({ "content-type": contentType }),
    body: null,
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    }
  };
}

const frame = (payload) =>
  `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
const deltaFrame = (text) =>
  frame({ choices: [{ delta: { content: text }, finish_reason: null }] });

async function runTurn(response, { signal } = {}) {
  const deltas = [];
  let result = null;
  let caught = null;

  globalThis.fetch = async () => response;

  try {
    result = await streamAdminAgentCompletion({
      messages: [{ content: "hello", role: "user" }],
      onDelta: (delta) => deltas.push(delta),
      promptContext: PROMPT_CONTEXT,
      settings: SETTINGS,
      signal: signal ?? new AbortController().signal,
      systemPrompt: "SYS"
    });
  } catch (error) {
    caught = error;
  }

  return { caught, deltas, result };
}

// ---------------------------------------------------------------------------
// 1. STRUCTURAL ABSENCE — the copies must be gone, and the import must exist.
// ---------------------------------------------------------------------------

test("admin's api.js defines NONE of the consolidated reader functions", () => {
  const code = stripComments(readSource(ADMIN_API_URL));
  const offenders = RETIRED_LOCAL_NAMES.filter((name) =>
    new RegExp(`(?:^|[\\s;{}])(?:async\\s+)?function\\s+${name}\\s*\\(`, "mu").test(code)
  );

  assert.deepEqual(
    offenders,
    [],
    `admin must keep no local copy of the shared reader; found: ${offenders.join(", ")}`
  );
});

test("admin's api.js imports the reader family from the framework module", () => {
  const code = stripComments(readSource(ADMIN_API_URL));
  const importBlock = code.match(/import\s*\{[\s\S]*?\}\s*from\s*"([^"]+)";/gu) ?? [];
  const sharedImport = importBlock.find((block) =>
    block.includes("/modules/_core/framework/js/sse-stream.js")
  );

  assert.ok(sharedImport, "admin must import the shared SSE reader from the framework");

  for (const name of CONSOLIDATED_FUNCTIONS) {
    assert.match(
      sharedImport,
      new RegExp(`\\b${name}\\b`, "u"),
      `the shared import must bring in ${name}`
    );
  }
});

test("the shared reader stays the ONE definition of each function", () => {
  const shared = stripComments(readSource(SHARED_SSE_URL));

  for (const name of CONSOLIDATED_FUNCTIONS) {
    assert.match(
      shared,
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`, "u"),
      `sse-stream.js must still export ${name}`
    );
  }
});

// ---------------------------------------------------------------------------
// 2. onPayload IS NOT WIRED IN ADMIN.
// ---------------------------------------------------------------------------

test("admin's api.js never threads the onPayload hook", () => {
  const code = stripComments(readSource(ADMIN_API_URL));

  // Word-boundary-aware on purpose: `onPayload` is a literal SUBSTRING of
  // `noteCompletionPayload`, which is a legitimate import. A naive `/onPayload/`
  // scan reports that identifier and would make this case a false positive — the
  // mistake this suite made on its first run, caught by its own failure message.
  const standalone = code.match(/(?<![A-Za-z0-9_$])onPayload(?![A-Za-z0-9_$])/gu) ?? [];

  assert.deepEqual(
    standalone,
    [],
    "admin has no tool-call assembler, so it must not thread onPayload (that is the adoption lane)"
  );
});

test("no admin call site can reach the shared reader's payload parameter", () => {
  // The stronger form of the assertion above: the raw-payload hook must not reach
  // the reader under ANY name. The hook's POSITION differs per function, which is
  // exactly why this is a table and not one threshold:
  //
  //   readStreamingResponse(response, onDelta, onPayload)       hook THIRD
  //   readBufferedResponse(response, onDelta, onPayload)        hook THIRD
  //   pumpEventStreamText(bodyText, onDelta, meta, onPayload)   hook FOURTH
  //   parseEventBlock(eventBlock, onDelta, meta, onPayload)     hook FOURTH
  //
  // An earlier version of this case asserted a flat "three or fewer" against all
  // four, which silently could not see a third-argument hook on the two READERS —
  // including `readStreamingResponse`, the one admin actually calls. A seeded
  // mutation wiring the hook there survived that version; this table is the fix.
  const MAX_ARITY_WITHOUT_HOOK = Object.freeze({
    parseEventBlock: 3,
    pumpEventStreamText: 3,
    readBufferedResponse: 2,
    readStreamingResponse: 2
  });
  const code = stripComments(readSource(ADMIN_API_URL));
  const offenders = [];

  for (const [name, max] of Object.entries(MAX_ARITY_WITHOUT_HOOK)) {
    for (const argc of callArities(code, name)) {
      if (argc > max) {
        offenders.push(`${name} called with ${argc} arguments (max ${max} without the hook)`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `admin must not wire the payload hook; found: ${offenders.join(", ")}`
  );
});

// The scanner must be able to SEE a fourth argument, or the case above proves
// nothing. This is the same reasoning the campaign applies to seeded mutations.
test("the call-arity scanner detects a fourth argument when one exists", () => {
  const three = 'readStreamingResponse(response, onDelta, onPayload);';
  const four = 'readStreamingResponse(response, onDelta, meta, onPayload);';
  const nested = 'pumpEventStreamText(bodyText, onDelta, createCompletionResponseMeta("stream"));';

  assert.deepEqual(callArities(three, "readStreamingResponse"), [3]);
  assert.deepEqual(callArities(four, "readStreamingResponse"), [4]);
  assert.deepEqual(callArities(nested, "pumpEventStreamText"), [3]);

  // The position that mattered: the two READERS take the hook third, so the self
  // check must prove a two-argument call and a three-argument call are told apart.
  assert.deepEqual(callArities('readStreamingResponse(response, onDelta);', "readStreamingResponse"), [2]);
  assert.deepEqual(callArities('readBufferedResponse(response, onDelta);', "readBufferedResponse"), [2]);
  assert.deepEqual(
    callArities('readBufferedResponse(response, onDelta, (p) => p);', "readBufferedResponse"),
    [3]
  );
});

test("a tool_calls-only payload still renders no text on admin", async () => {
  // Today's behaviour: admin extracts TEXT and ignores tool_calls entirely. Wiring a
  // payload hook here would change nothing visible yet, but it would be the adoption
  // lane's job done early with no assembler to receive it.
  const { caught, deltas, result } = await runTurn(
    streamResponse({
      chunks: [
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { function: { arguments: "{\"path\":\"~/x.txt\"}", name: "file_read" }, id: "call_1", index: 0 }
                ]
              },
              finish_reason: null
            }
          ]
        }),
        frame("[DONE]")
      ]
    })
  );

  assert.equal(caught, null, "a tool_calls-only stream must not throw on admin");
  assert.deepEqual(deltas, [], "admin renders no text for a tool_calls-only payload");
  assert.equal(result.mode, "stream");
  assert.equal(result.payloadCount, 1);
  assert.equal(result.sawDoneMarker, true);
});

// ---------------------------------------------------------------------------
// 3. BEHAVIOUR PARITY — GREEN on base by design; a red here is a regression.
// ---------------------------------------------------------------------------

test("text deltas keep their order across chunk boundaries", async () => {
  const { caught, deltas } = await runTurn(
    streamResponse({
      chunks: [
        // splits the JSON token itself
        'data: {"choices":[{"delta":{"con',
        'tent":"Hello"},"finish_reason":null}]}\n\n',
        deltaFrame(" world"),
        frame("[DONE]")
      ]
    })
  );

  assert.equal(caught, null);
  assert.deepEqual(deltas, ["Hello", " world"]);
});

test("two frames arriving in one chunk are both rendered in order", async () => {
  const { deltas } = await runTurn(
    streamResponse({ chunks: [deltaFrame("A") + deltaFrame("B") + frame("[DONE]")] })
  );

  assert.deepEqual(deltas, ["A", "B"]);
});

test("finish_reason length without [DONE] still reports the reason", async () => {
  const { deltas, result } = await runTurn(
    streamResponse({
      chunks: [
        deltaFrame("partial"),
        frame({ choices: [{ delta: {}, finish_reason: "length" }] })
      ]
    })
  );

  assert.deepEqual(deltas, ["partial"]);
  assert.equal(result.finishReason, "length");
  assert.equal(result.sawDoneMarker, false);
});

test("a late frame after [DONE] is not rendered", async () => {
  const { deltas, result } = await runTurn(
    streamResponse({ chunks: [deltaFrame("first"), frame("[DONE]") + deltaFrame("LATE")] })
  );

  assert.deepEqual(deltas, ["first"], "the [DONE] marker ends the stream");
  assert.equal(result.sawDoneMarker, true);
});

test("a buffered JSON completion renders its message once", async () => {
  const { deltas, result } = await runTurn(
    bufferedResponse({ body: JSON.stringify({ choices: [{ message: { content: "buffered reply" } }] }) })
  );

  assert.deepEqual(deltas, ["buffered reply"]);
  assert.equal(result.mode, "standard");
  assert.equal(result.verifiedEmpty, false);
});

test("an empty buffered content is an honest verified-empty turn", async () => {
  const { deltas, result } = await runTurn(
    bufferedResponse({ body: JSON.stringify({ choices: [{ message: { content: "" } }] }) })
  );

  assert.deepEqual(deltas, []);
  assert.equal(result.verifiedEmpty, true);
  assert.equal(result.textChunkCount, 0);
});

test("an empty stream is verified empty rather than an error", async () => {
  const { caught, deltas, result } = await runTurn(streamResponse({ chunks: [] }));

  assert.equal(caught, null);
  assert.deepEqual(deltas, []);
  assert.equal(result.payloadCount, 0);
  assert.equal(result.protocolObserved, false);
  assert.equal(result.verifiedEmpty, false);
});

test("an unsupported body raises the shared unsupported-body error text", async () => {
  const { caught } = await runTurn(
    bufferedResponse({ body: "<<not json or sse>>", contentType: "text/plain" })
  );

  assert.ok(caught, "an unsupported body must throw");
  assert.match(caught.message, /unsupported response body/u);
  assert.match(caught.message, /content-type: text\/plain/u);
  assert.match(caught.message, /<<not json or sse>>/u);
});

test("HTTP 500 JSON errors surface the provider message", async () => {
  const { caught } = await runTurn(
    bufferedResponse({ body: JSON.stringify({ error: { message: "server exploded" } }), status: 500 })
  );

  assert.match(caught.message, /status 500: server exploded/u);
});

test("HTTP 429 text errors surface the body text", async () => {
  const { caught } = await runTurn(
    bufferedResponse({ body: "rate limited", contentType: "text/plain", status: 429 })
  );

  assert.match(caught.message, /status 429: rate limited/u);
});

test("unparseable JSON error bodies report the parse fallback", async () => {
  const { caught } = await runTurn(bufferedResponse({ body: "{broken", status: 500 }));

  assert.match(caught.message, /Unable to parse JSON error body/u);
});

test("an unlabelled SSE body is sniffed and parsed", async () => {
  const { deltas } = await runTurn(
    bufferedResponse({ body: deltaFrame("sniffed") + frame("[DONE]"), contentType: "text/plain" })
  );

  assert.deepEqual(deltas, ["sniffed"]);
});

test("a trailing frame without a terminator is still parsed", async () => {
  const { deltas } = await runTurn(
    streamResponse({
      chunks: [
        deltaFrame("A"),
        'data: {"choices":[{"delta":{"content":"tail"},"finish_reason":null}]}'
      ]
    })
  );

  assert.deepEqual(deltas, ["A", "tail"]);
});

test("an abort during the stream propagates with its own error", async () => {
  const { caught, deltas } = await runTurn(
    streamResponse({ abortAtRead: 1, chunks: [deltaFrame("before-abort")] })
  );

  assert.deepEqual(deltas, ["before-abort"], "deltas delivered before the abort stay delivered");
  assert.ok(caught, "an abort must reach the caller");
  assert.equal(caught.name, "AbortError");
});

test("a declared event-stream with no body fails loudly", async () => {
  const { caught } = await runTurn({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: headerMap({ "content-type": "text/event-stream" }),
    body: null,
    async json() {
      return {};
    },
    async text() {
      return "";
    }
  });

  assert.equal(caught.message, "Streaming response body is not available.");
});

test("event: and id: prefixes do not swallow their data lines", async () => {
  const { deltas } = await runTurn(
    streamResponse({
      chunks: [
        'event: message\n' + deltaFrame("with-event"),
        'id: 42\n' + deltaFrame("with-id"),
        frame("[DONE]")
      ]
    })
  );

  assert.deepEqual(deltas, ["with-event", "with-id"]);
});

test("array content parts concatenate in order", async () => {
  const { deltas } = await runTurn(
    streamResponse({
      chunks: [
        frame({
          choices: [
            { delta: { content: [{ text: "A", type: "text" }, "B", { text: "C" }] }, finish_reason: null }
          ]
        }),
        frame("[DONE]")
      ]
    })
  );

  assert.deepEqual(deltas, ["ABC"]);
});

test("an empty choices array yields no delta and does not throw", async () => {
  const { deltas, result } = await runTurn(
    streamResponse({ chunks: [frame({ choices: [] }), deltaFrame("after-empty"), frame("[DONE]")] })
  );

  assert.deepEqual(deltas, ["after-empty"]);
  assert.equal(result.payloadCount, 2);
});

test("multi-byte UTF-8 split across reads decodes intact", async () => {
  const full = encode(deltaFrame("héllo-😀-世界") + frame("[DONE]"));
  // Split inside a 2-byte (é), a 4-byte (😀) and a 3-byte (世) sequence.
  const chunks = [
    full.slice(0, 20),
    full.slice(20, 21),
    full.slice(21, 34),
    full.slice(34, 35),
    full.slice(35)
  ];
  const { deltas } = await runTurn(streamResponse({ chunks }));

  assert.deepEqual(deltas, ["héllo-😀-世界"]);
});
