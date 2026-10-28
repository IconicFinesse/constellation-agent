// Fixtures for the P5-1 prefix-digest suite.
//
// They drive the REAL session (`createTier1Session`) so the digest compared across
// turns is the digest of bodies the session actually built -- not a hand-populated
// descriptor that could agree with itself while the product drifts.
//
// The two-turn driver is a genuine two-request turn cycle: turn 1 returns a tool
// call whose arguments never completed, which the loop refuses WITHOUT dispatching
// (it appends a coaching message and iterates), so turn 2 is a real second request
// through the same session with a longer message list. Nothing executes, no network
// is touched, and the property under test -- the shared prefix does not move while
// the message list grows -- is exercised exactly as it happens in production.

import { createTier1Session } from "../app/L0/_all/modules/_core/framework/js/engine-swap/tier1-session.js";

export const DEMO_SYSTEM = "you are a test assistant.\n\nrules:\n- answer plainly.";

// A head with a system message and an EARLIER user/assistant exchange, so the
// "edited earlier message" control has something before the newest turn to edit.
export const DEMO_HEAD = Object.freeze([
  Object.freeze({ content: DEMO_SYSTEM, role: "system" }),
  Object.freeze({ content: "earlier question", role: "user" }),
  Object.freeze({ content: "earlier answer", role: "assistant" })
]);

export const DEMO_TOOLS = Object.freeze([
  Object.freeze({ description: "read a file", name: "file_read", parameters: { a: 1, type: "object" } }),
  Object.freeze({ description: "write a file", name: "file_write", parameters: { b: 2, type: "object" } })
]);

// A provider whose capabilities allow tools, so the assembled tool list is real.
const SETTINGS = Object.freeze({
  apiEndpoint: "https://api.synthetic.new/v1/chat/completions",
  model: "DeepSeek-V4.1-Flash-1017",
  providerKey: "synthetic"
});

function refusalTurn(id = "call_refused") {
  return {
    finishReason: "tool_calls",
    text: "",
    toolCalls: [
      {
        arguments: "{\"path\":", // never completes
        argumentsComplete: false,
        id,
        name: "file_read"
      }
    ]
  };
}

function answerTurn(text = "the answer") {
  return { finishReason: "stop", text, toolCalls: [] };
}

function makeSession({ digests = null, replies }) {
  let session = null;
  let call = 0;

  session = createTier1Session({
    apiEndpoint: SETTINGS.apiEndpoint,
    model: SETTINGS.model,
    providerKey: SETTINGS.providerKey,
    sendCompletion: async () => {
      // `buildTurnRequest` ran before this call, so the digest already describes the
      // request being sent -- record it here to compare REAL consecutive turns.
      if (digests) {
        digests.push(session.lastPrefixDigest?.digest || "");
      }

      const reply = replies[Math.min(call, replies.length - 1)];
      call += 1;

      return reply;
    },
    systemPrompt: DEMO_SYSTEM,
    userContent: "current question"
  });

  return session;
}

// Two consecutive turns of ONE session. The loop iterates because the first reply's
// call had incomplete arguments, which is refused without dispatch.
export async function twoTurnDigests() {
  const digests = [];
  const session = makeSession({ digests, replies: [refusalTurn(), answerTurn()] });

  await session.run();

  return {
    first: digests[0] || "",
    second: digests[1] || "",
    turnCount: digests.length
  };
}

// One real session turn, exposing the request the transport was handed.
export async function buildSessionRequestBody() {
  const session = makeSession({ replies: [answerTurn()] });

  await session.run();

  return { digest: session.lastPrefixDigest, request: session.lastRequest };
}

// The cache-usage fixtures are the CAPTURED provider shapes, not invented ones.
export const USAGE_FIXTURES = Object.freeze({
  // NeuralWatt, cold/second call recorded live as `prompt_tokens_details: null`.
  neuralwattCold: Object.freeze({
    completion_tokens: 114,
    prompt_tokens: 7538,
    prompt_tokens_details: null,
    total_tokens: 7652
  }),
  // NeuralWatt, second identical-prefix call: 7,424 of 7,538 cached.
  neuralwattWarm: Object.freeze({
    completion_tokens: 114,
    prompt_tokens: 7538,
    prompt_tokens_details: Object.freeze({ cached_tokens: 7424 }),
    total_tokens: 7652
  }),
  // Synthetic, cold call: nothing cached yet, 7,424 created for later reuse.
  syntheticCold: Object.freeze({
    completion_tokens: 114,
    created_cache_tokens: 7424,
    prompt_tokens: 7538,
    prompt_tokens_details: Object.freeze({ cached_tokens: 0 }),
    total_tokens: 7652
  })
});
