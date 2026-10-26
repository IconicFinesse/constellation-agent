// Focused engine-swap P2 coverage for the onscreen store's Tier 1 duties.
//
// The loop/session suites prove the shared layer. This suite proves the SURFACE
// half of the two P2 audit findings that only a store can show:
//
//   [NON-BLOCKER] 1 — a second destructive hold must clear the first confirm bar.
//     Before the fix the branch nulled the session and the held messages but left
//     `engineSwapPendingHold` set, so the panel kept rendering a confirm bar whose
//     two buttons both returned early on `!session`. An affordance that lies about
//     being actionable is the defect; the assertion is that the reactive state is
//     nulled, not merely that a status line changed.
//
//   [NON-BLOCKER] 3 — Stop must end a running Tier 1 turn.
//     Before the fix the store passed no stop source into the session and the
//     tool-turn fetch carried no signal, so pressing Stop during a Tier 1 turn set
//     a flag nothing read and the user waited out the whole loop. This test presses
//     the REAL control (`store.requestStop()`) from inside the in-flight transport
//     call and asserts the turn ends at the next boundary with a legible stopped
//     state, no further dispatches, and no second request.
//
// Harness note (same false-green trap the store-wiring suite documents): the
// execution sandbox resolves `space` from the TARGET WINDOW, not from `globalThis`,
// so both are wired here.
//
// Hermetic: `fetch` is a canned response, the api surface is a stub, and no
// app-data write leaves the process (`persistHistory` is stubbed).

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

function createHarness() {
  const runtime = {
    api: {},
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
    }
  };

  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
    createElement() {
      return {
        classList: { add() {}, remove() {} },
        setAttribute() {},
        appendChild() {},
        style: {}
      };
    },
    body: { appendChild() {} },
    documentElement: { appendChild() {} }
  };
  globalThis.window = {
    // The execution sandbox and the proxy URL builder both read the window.
    space: runtime,
    console,
    addEventListener() {},
    removeEventListener() {},
    location: { href: "http://localhost/" },
    matchMedia() {
      return { addEventListener() {}, matches: false };
    }
  };
  globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.space = runtime;

  return runtime;
}

const runtime = createHarness();
const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");

// Every test stubs the two persistence/render seams: this suite is about state and
// transport behavior, never about disk or DOM.
function stubSurface(t) {
  const previous = {
    history: store.history,
    persistHistory: store.persistHistory,
    render: store.render,
    status: store.status
  };

  store.persistHistory = async () => {};
  store.render = () => {};

  t.after(() => {
    store.history = previous.history;
    store.persistHistory = previous.persistHistory;
    store.render = previous.render;
    store.status = previous.status;
  });
}

test("a second hold clears the first confirm bar instead of stranding it", async (t) => {
  stubSurface(t);

  const previousRun = store.runTier1ConversationTurn;

  t.after(() => {
    store.runTier1ConversationTurn = previousRun;
    store.engineSwapPendingHold = null;
    store.engineSwapTier1Session = null;
    store.engineSwapHeldMessages = null;
  });

  let cancelledNewSession = 0;

  // A hold is already on screen from an earlier turn...
  store.engineSwapPendingHold = { callId: "c-first", description: "delete ~/first.txt", tool: "file_delete" };
  store.engineSwapTier1Session = { cancelHeld() {} };
  store.engineSwapHeldMessages = [{ content: "stale held turn", role: "tool" }];

  // ...and a NEW turn produces another destructive call.
  store.runTier1ConversationTurn = async () => ({
    result: {
      answer: "",
      hold: { callId: "c-second", description: "delete ~/second.txt", tool: "file_delete" },
      messages: [
        {
          content: "",
          role: "assistant",
          toolCalls: [{ arguments: {}, id: "c-second", name: "file_delete" }]
        }
      ],
      status: "held"
    },
    session: {
      cancelHeld() {
        cancelledNewSession += 1;
      }
    }
  });

  const outcome = await store.runTier1TurnAndCommit(
    [{ content: "delete the other one too", id: "u2", role: "user" }],
    { messages: [{ content: "delete the other one too", id: "u2", role: "user" }] },
    { tier: "tier1" }
  );

  assert.equal(outcome, "complete");
  // The NEW hold is cancelled (one consent question at a time)...
  assert.equal(cancelledNewSession, 1, "the newer hold must be settled, not queued");
  // ...and the FIRST confirm bar goes with the session it belonged to.
  assert.equal(
    store.engineSwapPendingHold,
    null,
    "no confirm bar may survive with dead handlers behind it"
  );
  assert.equal(store.engineSwapTier1Session, null, "the session a confirm would call must be gone");
  assert.equal(store.engineSwapHeldMessages, null, "the held turn must not be resumable");
  assert.match(store.status, /finish it before starting another/u);
});

test("Stop ends a running Tier 1 turn at the boundary and reports a stopped state", async (t) => {
  stubSurface(t);

  const previousFetch = globalThis.fetch;
  const previousSendState = { isSending: store.isSending };
  const apiCalls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
    store.isSending = previousSendState.isSending;
    store.stopRequested = false;
    store.engineSwapPendingHold = null;
    store.engineSwapTier1Session = null;
    store.activeRequestController = null;
  });

  runtime.api.fileRead = async (...args) => {
    apiCalls.push(args);

    return { content: "hello" };
  };

  const fetchCalls = [];

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ init, url });

    // The user presses the real Stop control while the first turn is in flight.
    // `requestStop()` is the ONE mechanism the text path already owns: it sets the
    // flag and aborts the active request controller.
    store.isSending = true;
    store.requestStop();

    return {
      headers: { get: () => "application/json" },
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  {
                    function: { arguments: '{"path":"~/a.txt"}', name: "file_read" },
                    id: "call_1",
                    type: "function"
                  }
                ]
              }
            }
          ]
        })
    };
  };

  store.history = [];
  store.settings = {
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: "test-key",
    model: "gpt-x"
  };
  store.stopRequested = false;
  store.status = "";
  store.engineSwapPendingHold = null;
  store.engineSwapTier1Session = null;
  store.activeRequestController = null;

  const outcome = await store.runTier1TurnAndCommit(
    [{ content: "read my notes", id: "u1", role: "user" }],
    {
      messages: [
        { content: "You are a test agent.", role: "system" },
        { content: "read my notes", id: "u1", role: "user" }
      ]
    },
    { tier: "tier1" }
  );

  assert.equal(outcome, "stopped", "a stopped turn is its own outcome, never a silent completion");
  assert.match(store.status, /^Stopped:/u, "the ended state must name itself legibly");
  assert.equal(fetchCalls.length, 1, "no second request may go out after the stop");
  assert.equal(apiCalls.length, 1, "the in-flight call may finish; nothing after it executes");
  assert.ok(
    fetchCalls[0].init.signal,
    "the surface's abort signal must reach the tool-turn fetch"
  );
});
