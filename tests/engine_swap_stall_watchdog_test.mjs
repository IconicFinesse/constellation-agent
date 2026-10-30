// BUG-013: A TURN THAT STOPS MAKING PROGRESS MUST FAIL VISIBLY.
//
// THE DEFECT, measured on a beta tester's machine and not re-derived here: 43 requests
// and 43 responses, NONE left hanging; exactly ONE model call, which succeeded, then a
// dead stop before the second inference; last network activity at 18.1 s and then ~282
// SECONDS OF TOTAL SILENCE. No page error, no unhandled rejection, nothing in the console,
// the tab fully responsive. Saved history held ONE entry (the user prompt) and there was no
// engine-log record at all. The only cure was a page reload, and later messages in the same
// chat did not even land in history.
//
// WHAT THIS SUITE PINS. That the failure is no longer silent and no longer permanent:
//
//   A. NO ACTIVITY -> the window elapses and the turn FIRES: a committed user-facing
//      assistant message in saved history, a turn-log record whose outcome names the
//      stall, the session freed, the in-flight request aborted through the ONE existing
//      controller, and no message content in the log.
//   B. ACTIVITY -> NO FIRE, over a simulated duration far longer than the window. This is
//      the 108-second case: a real beta build took 108 s for its first step, and a
//      total-turn deadline would have killed it.
//   C. A HELD DESTRUCTIVE CALL -> NO FIRE, however long the consent wait. A human thinking
//      about a delete is not a stall.
//   D. A USER STOP still wins and settles `stopped`, never `stalled`.
//   E. ONE ABORT PATH: the fire aborts the very controller a user stop aborts, and the
//      stop path carries no watchdog reference.
//   F. The vocabulary is one vocabulary: the leaf's word equals the loop's, the session's
//      and the turn log's, and the endpoint's whitelists accept both the outcome and the
//      step.
//
// THE CLOCK IS FAKE. A watchdog whose tests sleep for its own 270-second window is a suite
// nobody runs, and a suite nobody runs is not evidence. `createFakeClock` drives virtual
// time, so the whole file finishes in milliseconds while every case exercises the REAL
// `turn-driver.js` code path: real arm/touch/disarm, real race, real commit.
//
// Hermetic: no network, no keys, no app-data writes, no real timers.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const DRIVER_PATH = new URL(
  "../app/L0/_all/modules/_core/framework/js/engine-swap/turn-driver.js",
  import.meta.url
);
const WATCHDOG_PATH = new URL(
  "../app/L0/_all/modules/_core/framework/js/engine-swap/stall-watchdog.js",
  import.meta.url
);
const ONSCREEN_STORE_PATH = new URL(
  "../app/L0/_all/modules/_core/onscreen_agent/store.js",
  import.meta.url
);

function readSource(path) {
  return readFileSync(path, "utf8");
}

// Comments are stripped before every structural scan: a rule stated in prose is not a rule
// the code obeys, and a scan that matches its own comment proves nothing.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^[ \t]*\/\/.*$/gmu, "");
}

// The app's module specifiers are `/modules/...` URLs resolved by the loader; anything the
// driver touches at import time that expects a browser is stubbed here, exactly as the
// turn-driver boundary suite does.
function installBrowserStubs() {
  const runtime = {
    api: {},
    configValues: new Map(),
    config: {
      get(name, fallback = undefined) {
        return runtime.configValues.has(name) ? runtime.configValues.get(name) : fallback;
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
      return { classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {}, style: {} };
    },
    body: { appendChild() {} },
    documentElement: { appendChild() {} }
  };
  globalThis.window = {
    space: runtime,
    console,
    addEventListener() {},
    removeEventListener() {},
    location: { href: "http://127.0.0.1:3000/" },
    matchMedia() {
      return { addEventListener() {}, matches: false };
    },
    requestAnimationFrame(callback) {
      return setTimeout(() => callback(0), 0);
    },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout
  };
  globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.space = runtime;

  return runtime;
}

installBrowserStubs();

const STALL = await import(
  "/modules/_core/framework/js/engine-swap/stall-watchdog.js"
);
const { createTier1TurnDriver } = await import(
  "/modules/_core/framework/js/engine-swap/turn-driver.js"
);

const WINDOW_MS = STALL.STALL_WATCHDOG_WINDOW_MS;
const OBSERVED_MAX_WAIT_MS = STALL.STALL_WATCHDOG_OBSERVED_MAX_LEGITIMATE_WAIT_MS;

// -----------------------------------------------------------------------------------------
// VIRTUAL TIME. `now`, `schedule` and `cancel` are the three seams the watchdog takes, so a
// fake clock needs nothing else: no monkey-patching of globals, and the production default
// (real timers) stays completely untouched.
// -----------------------------------------------------------------------------------------
function createFakeClock(start = 1000) {
  let now = start;
  let sequence = 0;
  const timers = new Map();

  function nextDue(target) {
    let best = null;

    for (const timer of timers.values()) {
      if (timer.at > target) {
        continue;
      }

      if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) {
        best = timer;
      }
    }

    return best;
  }

  return {
    now() {
      return now;
    },
    schedule(handler, delayMs) {
      sequence += 1;
      const id = sequence;

      timers.set(id, { at: now + Math.max(0, Number(delayMs) || 0), handler, id });

      return id;
    },
    cancel(handle) {
      timers.delete(handle);
    },
    pendingCount() {
      return timers.size;
    },
    // Runs every timer due within `ms`, in due order, letting the promise machinery settle
    // between them. This is what makes an interleaving test real: the turn's own scheduled
    // work and the watchdog's window advance against the same clock.
    async advanceAsync(ms) {
      const target = now + Math.max(0, Number(ms) || 0);

      for (;;) {
        const due = nextDue(target);

        if (!due) {
          break;
        }

        timers.delete(due.id);
        now = Math.max(now, due.at);
        due.handler();
        await flushMicrotasks();
      }

      now = target;
      await flushMicrotasks();
    },
    // A promise resolved by the fake clock, so a scripted turn can `sleep` in virtual time.
    sleep(ms) {
      return new Promise((resolve) => {
        this.schedule(resolve, ms);
      });
    }
  };
}

async function flushMicrotasks(rounds = 30) {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

// The driver arms its watchdog after a couple of awaits (the prompt shape), so a test must
// let the turn reach `arm()` before it can move the clock. Looping on `pendingCount()` is
// honest: it waits for the timer the PRODUCT scheduled rather than for a fixed guess.
async function waitUntilArmed(clock, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    await flushMicrotasks(6);

    if (clock.pendingCount() > 0) {
      return true;
    }
  }

  return false;
}

// -----------------------------------------------------------------------------------------
// A recording surface. Every hook the commit path uses is captured, and `history` is real
// mutable state so a later turn can be driven over exactly what the stall left behind.
// -----------------------------------------------------------------------------------------
function createRecordingSurface({ hold = null } = {}) {
  const calls = [];
  const state = { controller: null, history: [], hold, status: "" };

  return {
    calls,
    state,
    getActiveRequestController() {
      return state.controller;
    },
    getPendingHold() {
      return state.hold;
    },
    maybeShowCompactStreamingAssistantBubble() {},
    async persistHistory(options) {
      calls.push({ name: "persistHistory", options });
    },
    render() {
      calls.push({ name: "render" });
    },
    reportError(context, error) {
      calls.push({ name: "reportError", context, error });
    },
    scheduleEngineSwapChipRender() {},
    scheduleStreamingMessageRender() {},
    setActiveRequestController(controller) {
      state.controller = controller;
    },
    setHistory(history) {
      state.history = history;
    },
    setPendingHold(next) {
      state.hold = next;
    },
    setStatus(text) {
      state.status = text;
      calls.push({ name: "setStatus", text });
    },
    setStreamingAssistantStatus() {},
    showCompactAssistantReplyBubble() {}
  };
}

// The turn log's transport. Records every emitted record so the suite can assert the stall
// is in the owner's trail -- and that no message text rode along with it.
function createRecordingRuntime(records) {
  return {
    api: {
      engineLogWrite(record) {
        records.push(record);

        return Promise.resolve();
      }
    }
  };
}

function createInputs({ clock, runTier1Turn, records, stopRequested = () => false }) {
  const runtime = createRecordingRuntime(records);

  return {
    createStreamingAssistantMessage: () => ({ content: "", id: "", role: "assistant", streaming: true }),
    envelopeMarkers: { USER: "_____user" },
    executionContext: () => null,
    executionOutputOverrides: () => ({}),
    fenceRegions: () => [],
    findSeparatorIndex: () => -1,
    isFrameworkFollowUpKind: () => false,
    parseParams: () => ({}),
    runTier1Turn,
    runtime: () => runtime,
    separator: "_____javascript",
    settings: () => ({
      apiEndpoint: "https://example.test/v1",
      apiKey: "test-key-not-real",
      model: "test-model",
      paramsText: ""
    }),
    shapeSystemPrompt: async ({ promptText }) => promptText,
    stallWatchdogClock: () => clock,
    stopRequested,
    streamToolTurn: async () => ({ text: "", toolCalls: [] })
  };
}

const REQUEST_MESSAGES = [{ content: "build the thing", id: "u1", role: "user" }];
const PREPARED = { messages: [{ content: "build the thing", role: "user" }] };
const PLAN = { tier: "tier1" };

function stalledTurnShape(silenceMs = WINDOW_MS) {
  return {
    correctiveRetry: false,
    result: { answer: "", messages: [], stall: { silenceMs, windowMs: WINDOW_MS }, status: "stalled", turns: [] },
    session: null,
    stall: { silenceMs, windowMs: WINDOW_MS },
    wireHygiene: { changed: false },
    wireMessageCount: 1
  };
}

// -----------------------------------------------------------------------------------------
// F. ONE VOCABULARY, AND A WINDOW CHOSEN FROM THE EVIDENCE.
// -----------------------------------------------------------------------------------------
test("the stall word is one vocabulary across the leaf, the loop, the session and the log", async () => {
  const { TOOL_TURN_STOP_REASON } = await import(
    "/modules/_core/framework/js/engine-swap/tool-turn-loop.js"
  );
  const { TIER1_TURN_STATUS } = await import(
    "/modules/_core/framework/js/engine-swap/tier1-session.js"
  );
  const { TURN_LOG_OUTCOME, TURN_LOG_STEP_TYPE } = await import(
    "/modules/_core/framework/js/engine-swap/turn-log.js"
  );

  assert.equal(STALL.STALLED_TURN_STATUS, "stalled", "the leaf's word");
  assert.equal(TOOL_TURN_STOP_REASON.STALLED, STALL.STALLED_TURN_STATUS, "the loop's reason");
  assert.equal(TIER1_TURN_STATUS.STALLED, STALL.STALLED_TURN_STATUS, "the session's status");
  assert.equal(TURN_LOG_OUTCOME.STALLED, STALL.STALLED_TURN_STATUS, "the logged outcome");
  assert.equal(TURN_LOG_STEP_TYPE.STALLED, "stalled", "the logged step");

  // The mirror rule from `turn-log.js` still holds value for value after the addition, so
  // the two vocabularies cannot drift while the import graph stays inert.
  assert.deepEqual({ ...TURN_LOG_OUTCOME }, { ...TOOL_TURN_STOP_REASON });
});

test("the window clears the largest legitimate wait with margin and still catches the wedge", () => {
  assert.ok(OBSERVED_MAX_WAIT_MS >= 108000, "the measured 108 s first step is recorded as a number");
  assert.ok(
    WINDOW_MS > OBSERVED_MAX_WAIT_MS * 2,
    `the window (${WINDOW_MS}ms) must clear the 108 s first step with real margin`
  );
  assert.ok(WINDOW_MS < 282000, `and stay below the ${282}s wedge it exists to catch`);
});

test("the server whitelists accept the stalled outcome and the stalled step", async () => {
  const endpoint = await import("../server/api/engine_log.js");

  assert.ok(endpoint.OUTCOMES.includes("stalled"), "an outcome the endpoint rejects would 400 the write");
  assert.ok(endpoint.STEP_TYPES.includes("stalled"), "an unknown step type rejects the whole record");
  // ADDITIVE ONLY: every word that was accepted before is still accepted.
  for (const outcome of ["answered", "display-refused", "error", "held", "iteration-cap", "stopped"]) {
    assert.ok(endpoint.OUTCOMES.includes(outcome), outcome);
  }
});

// -----------------------------------------------------------------------------------------
// A. NO ACTIVITY -> IT FIRES, VISIBLY, ONCE.
// -----------------------------------------------------------------------------------------
test("A turn with no activity fires: a committed message, a logged outcome, and a freed session", async () => {
  const clock = createFakeClock();
  const records = [];
  const surface = createRecordingSurface();
  const driver = createTier1TurnDriver({
    inputs: createInputs({
      clock,
      records,
      // A turn that never settles: the measured wedge. Nothing is answered and nothing
      // rejects -- exactly the shape no `catch` can reach.
      runTier1Turn: () => new Promise(() => {})
    }),
    surface
  });

  const pending = driver.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.ok(await waitUntilArmed(clock), "the watchdog must arm before the first model call");

  // Nothing at all happens for a full window. One millisecond past it, the turn must end.
  await clock.advanceAsync(WINDOW_MS - 1);

  assert.equal(clock.pendingCount() > 0, true, "just short of the window the turn is still waiting");

  await clock.advanceAsync(2);

  const outcome = await pending;

  assert.equal(outcome, "stalled", "the surface is told the turn stalled, not that it completed");

  // 1. THE COMMITTED, USER-FACING MESSAGE. Reload-safe because it is a real history entry
  //    in the SAME plain assistant shape a normal reply uses.
  const committed = surface.state.history;
  const notice = committed.at(-1);

  assert.ok(notice, "history must gain an entry, not stay at the user's prompt");
  assert.equal(notice.role, "assistant");
  assert.equal(notice.kind, "turn-notice", "a distinct tag, so a gate settle cannot retire it");
  assert.deepEqual(
    Object.keys(notice).sort(),
    ["attachments", "content", "id", "kind", "role"],
    "the shared plain-assistant shape, with no bespoke fields"
  );
  assert.match(notice.content, /stopped responding/u);
  assert.match(notice.content, /ended/u);
  assert.match(notice.content, /retry/u, "the user is told what to do next");
  assert.ok(notice.id, "it has a real id, so the renderer treats it as a message");
  assert.equal(committed[0].content, "build the thing", "the user's own turn is kept");
  assert.equal(committed.length, 2, "one user entry plus the explanation, and nothing invented");

  // It is PERSISTED immediately: a coalesced write can be lost by the teardown a wedged
  // tab invites, which is the whole point of the entry.
  const persist = surface.calls.filter((call) => call.name === "persistHistory").at(-1);

  assert.equal(persist?.options?.immediate, true, "the notice is flushed immediately");
  assert.match(surface.state.status, /Stalled/u, "the status line says so too");
  assert.ok(
    surface.calls.some((call) => call.name === "render"),
    "the surface repaints, so the sentence is on screen without a reload"
  );

  // 2. THE TURN-LOG RECORD. Started AND finished, sharing one turn id, so a deliberate
  //    stall is distinguishable from a wedge that took the tab down with it.
  const finished = records.filter((record) => record.status === "finished");

  assert.equal(finished.length, 1, "one finished record for the stalled turn");
  assert.equal(finished[0].outcome, "stalled", "the outcome NAMES the stall");

  const started = records.filter((record) => record.status === "started");

  assert.equal(started.length, 1, "the start record shipped in P7-1 is still written");
  assert.equal(started[0].turnId, finished[0].turnId, "the pair is readable as one turn");

  const steps = finished[0].steps.filter((step) => step.type === "stalled");

  assert.equal(steps.length, 1, "exactly one stalled step");
  assert.equal(steps[0].windowMs, WINDOW_MS, "the window that decided it is recorded");
  assert.ok(steps[0].silenceMs >= WINDOW_MS, "and how long nothing arrived");

  // PRIVACY: the owner pastes this log into a chat. Not one message byte may ride along.
  const serialized = JSON.stringify(records);

  assert.equal(serialized.includes("build the thing"), false, "no request content in the trail");

  // 3. THE SESSION IS FREED: nothing is held and no controller is left installed.
  assert.equal(driver.state.engineSwapTier1Session, null, "the abandoned session is not retained");
  assert.equal(driver.state.engineSwapHeldMessages, null);
  assert.equal(surface.state.hold, null);
  assert.equal(surface.state.controller, null, "the abort controller is released");
});

test("after a fire, the NEXT turn on the same driver runs normally", async () => {
  const clock = createFakeClock();
  const records = [];
  const surface = createRecordingSurface();
  let hang = true;

  const driver = createTier1TurnDriver({
    inputs: createInputs({
      clock,
      records,
      // The stub returns the wire it started from PLUS the reply, which is what the real
      // loop does (it only ever appends to `initialHistory`). A stub that returned the
      // reply alone would make the commit's tail slice empty and the reply disappear.
      runTier1Turn: (request) =>
        hang
          ? new Promise(() => {})
          : Promise.resolve({
              result: {
                answer: "all done",
                messages: [
                  ...(request.initialMessages || []),
                  { content: "all done", role: "assistant" }
                ],
                status: "answered",
                turns: []
              },
              session: {}
            })
    }),
    surface
  });

  const first = driver.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.ok(await waitUntilArmed(clock));
  await clock.advanceAsync(WINDOW_MS + 1);
  assert.equal(await first, "stalled");

  // THE WHOLE POINT. Under the defect the only cure was a reload; here the very next turn
  // is answered, on the same driver, over the history the stall left behind.
  hang = false;

  const second = await driver.runTier1TurnAndCommit(
    [...surface.state.history],
    PREPARED,
    PLAN
  );

  assert.equal(second, "complete", "a new message is answered normally");
  assert.match(surface.state.history.at(-1).content, /all done/u);
  assert.equal(
    surface.state.history.filter((entry) => entry.kind === "turn-notice").length,
    1,
    "the stall notice stays, and no second one is invented"
  );
  assert.equal(records.filter((record) => record.outcome === "stalled").length, 1);
});

// -----------------------------------------------------------------------------------------
// B. ACTIVITY -> NO FIRE, HOWEVER LONG THE TURN RUNS.
// -----------------------------------------------------------------------------------------
test("a slow but ALIVE turn never fires, over a simulated duration far longer than the window", async () => {
  const clock = createFakeClock();
  const records = [];
  const surface = createRecordingSurface();
  let events = 0;

  const driver = createTier1TurnDriver({
    inputs: createInputs({
      clock,
      records,
      // The 108-second shape, generalized: a real build's first step took 108 s to APPEAR
      // and this turn keeps working for 12 virtual minutes with a sign of life every 60 s.
      runTier1Turn: async (request) => {
        for (let step = 0; step < 12; step += 1) {
          await clock.sleep(60000);
          events += 1;
          request.onEvent({ iteration: step, text: "working", toolCalls: [], type: "assistant-turn" });
        }

        return {
          result: {
            answer: "built it",
            messages: [{ content: "built it", role: "assistant" }],
            status: "answered",
            turns: []
          },
          session: {}
        };
      }
    }),
    surface
  });

  const pending = driver.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.ok(await waitUntilArmed(clock));

  for (let round = 0; round < 12; round += 1) {
    await clock.advanceAsync(60000);
  }

  const outcome = await pending;

  assert.equal(events, 12, "the turn really did run 12 virtual minutes");
  assert.equal(720000 > WINDOW_MS * 2, true, "which is far longer than the window");
  assert.equal(outcome, "complete", "slow-but-alive is never killed: the 108 s case survives");
  assert.equal(
    surface.state.history.some((entry) => entry.kind === "turn-notice"),
    false,
    "no stall notice is committed for a healthy turn"
  );
  assert.equal(records.filter((record) => record.outcome === "stalled").length, 0);
});

test("a single 108-second silence between steps does not fire", async () => {
  const clock = createFakeClock();
  const records = [];
  const surface = createRecordingSurface();

  const driver = createTier1TurnDriver({
    inputs: createInputs({
      clock,
      records,
      runTier1Turn: async (request) => {
        await clock.sleep(OBSERVED_MAX_WAIT_MS);
        request.onEvent({ iteration: 0, text: "done thinking", toolCalls: [], type: "assistant-turn" });

        return {
          result: {
            answer: "ok",
            messages: [{ content: "ok", role: "assistant" }],
            status: "answered",
            turns: []
          },
          session: {}
        };
      }
    }),
    surface
  });

  const pending = driver.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.ok(await waitUntilArmed(clock));
  await clock.advanceAsync(OBSERVED_MAX_WAIT_MS);

  assert.equal(await pending, "complete", "the measured 108 s first step is legitimate work");
});

// -----------------------------------------------------------------------------------------
// C. A HELD DESTRUCTIVE CALL IS NOT A STALL.
// -----------------------------------------------------------------------------------------
test("a held destructive call never fires, however long the human takes", async () => {
  const clock = createFakeClock();
  const records = [];
  const hold = { callId: "c1", path: "/tmp/x.txt", tool: "file_delete" };
  const surface = createRecordingSurface({ hold });
  const driver = createTier1TurnDriver({
    inputs: createInputs({ clock, records, runTier1Turn: () => new Promise(() => {}) }),
    surface
  });

  // The hold is surface state, so the watchdog reads the SAME affordance the confirm bar
  // reads. It is consulted at fire time, not remembered from a paired call.
  surface.state.hold = hold;

  const pending = driver.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.ok(await waitUntilArmed(clock));

  // A consent question can legitimately last many minutes while somebody thinks about
  // deleting a file. Four windows is a deliberately absurd wait.
  for (let round = 0; round < 4; round += 1) {
    await clock.advanceAsync(WINDOW_MS + 1000);
    await flushMicrotasks();
  }

  assert.equal(clock.pendingCount() > 0, true, "the watchdog re-armed instead of firing");
  assert.equal(
    surface.state.history.some((entry) => entry.kind === "turn-notice"),
    false,
    "no stall sentence is committed while a decision is pending"
  );

  // And the exemption is DERIVED: the moment the hold settles, silence counts again.
  surface.state.hold = null;
  await clock.advanceAsync(WINDOW_MS + 1);

  assert.equal(await pending, "stalled", "once nothing is pending, silence is a stall again");
});

test("a held turn leaves NO timer armed while the store waits for consent", async () => {
  const clock = createFakeClock();
  const records = [];
  const surface = createRecordingSurface();
  const hold = { callId: "c1", path: "/tmp/x.txt", tool: "file_delete" };
  const driver = createTier1TurnDriver({
    inputs: createInputs({
      clock,
      records,
      runTier1Turn: async () => ({
        result: {
          answer: "",
          hold,
          messages: [],
          status: "held",
          turns: []
        },
        session: { cancelHeld() {} }
      })
    }),
    surface
  });

  const outcome = await driver.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.equal(outcome, "complete", "a hold ends the turn normally, waiting for the human");
  assert.equal(
    clock.pendingCount(),
    0,
    "the watchdog is DISARMED at turn end, so no timer can fire into a consent wait"
  );
  assert.equal(driver.state.engineSwapTier1Session === null, false, "the session is kept for the confirm");
  assert.equal(surface.state.hold?.tool, "file_delete", "and the confirm bar has its question");

  // Even advancing far past the window changes nothing: nothing is scheduled at all.
  await clock.advanceAsync(WINDOW_MS * 3);

  assert.equal(clock.pendingCount(), 0);
  assert.equal(
    surface.state.history.some((entry) => entry.kind === "turn-notice"),
    false,
    "no stall sentence is ever committed over a pending consent question"
  );
});

// -----------------------------------------------------------------------------------------
// D. A USER STOP STILL WINS.
// -----------------------------------------------------------------------------------------
test("a user stop during the wait settles `stopped`, never `stalled`", async () => {
  const clock = createFakeClock();
  const records = [];
  const surface = createRecordingSurface();
  let stopped = false;
  let turnShouldStop = false;

  const driver = createTier1TurnDriver({
    inputs: createInputs({
      clock,
      records,
      stopRequested: () => stopped,
      // The real session catches an aborted transport and reports `stopped`; this stub has
      // the same shape, so the assertion is about the driver and not about a thrown promise.
      runTier1Turn: async () => {
        while (!turnShouldStop) {
          await clock.sleep(1000);
        }

        return { result: { answer: "", messages: [], status: "stopped", turns: [] }, session: {} };
      }
    }),
    surface
  });

  const pending = driver.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.ok(await waitUntilArmed(clock));

  // Thirty seconds in -- long before the window -- the user presses stop.
  await clock.advanceAsync(30000);
  stopped = true;
  turnShouldStop = true;
  await clock.advanceAsync(1000);

  assert.equal(await pending, "stopped", "the user's own answer is reported as a stop");
  assert.match(surface.state.status, /Stopped/u);
  assert.equal(
    surface.state.history.some((entry) => entry.kind === "turn-notice"),
    false,
    "a user stop is not a stall and must not be explained as one"
  );
  assert.equal(records.filter((record) => record.outcome === "stalled").length, 0);
});

// -----------------------------------------------------------------------------------------
// D2. THE HARD CASE THE ABORT CANNOT REACH: a wedge with NO request in flight.
//
// This is why the stop check lives in the stall settle and not only in the loop. The fire
// aborts the controller, and the loop turns an aborted transport into `stopped` -- but the
// measured wedge had already finished its one model call, so there was nothing in flight
// for the abort to cut and no promise that would ever resolve. If the human pressed stop
// during that silence, reporting it as a STALL would blame the engine for a turn they
// ended. The window elapsing with a stop already requested must therefore settle
// `stopped`, and this case drives exactly that shape.
// -----------------------------------------------------------------------------------------
test("a stop requested during an unreachable wedge settles `stopped`, not `stalled`", async () => {
  const clock = createFakeClock();
  const records = [];
  const surface = createRecordingSurface();
  let stopped = false;

  const driver = createTier1TurnDriver({
    inputs: createInputs({
      clock,
      records,
      stopRequested: () => stopped,
      // NEVER settles and never rejects: an abort has nothing to cut here.
      runTier1Turn: () => new Promise(() => {})
    }),
    surface
  });

  const pending = driver.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.ok(await waitUntilArmed(clock));

  // The user presses stop mid-silence. The abort reaches no fetch, because there is none.
  stopped = true;
  await clock.advanceAsync(WINDOW_MS + 1);

  assert.equal(await pending, "stopped", "the human ended the turn; that is a stop, not a stall");
  assert.match(surface.state.status, /Stopped/u);
  assert.equal(
    surface.state.history.some((entry) => entry.kind === "turn-notice"),
    false,
    "no stall sentence is committed over a turn the user stopped"
  );
  assert.equal(records.filter((record) => record.outcome === "stalled").length, 0);
  assert.equal(records.filter((record) => record.outcome === "stopped").length, 1);
});

// -----------------------------------------------------------------------------------------
// E. ONE ABORT PATH, AND IT IS THE EXISTING ONE.
// -----------------------------------------------------------------------------------------
test("the fire aborts the SAME controller a user stop aborts, and there is only one abort site", async () => {
  const clock = createFakeClock();
  const records = [];
  const surface = createRecordingSurface();
  const driver = createTier1TurnDriver({
    inputs: createInputs({ clock, records, runTier1Turn: () => new Promise(() => {}) }),
    surface
  });

  const pending = driver.runTier1TurnAndCommit(REQUEST_MESSAGES, PREPARED, PLAN);

  assert.ok(await waitUntilArmed(clock));

  const controller = surface.state.controller;

  assert.ok(controller instanceof AbortController, "the turn installs the real controller");
  assert.equal(controller.signal.aborted, false, "nothing is aborted before the window elapses");

  await clock.advanceAsync(WINDOW_MS + 1);
  await pending;

  assert.equal(
    controller.signal.aborted,
    true,
    "the in-flight request is cut through the SAME controller `requestStop()` aborts"
  );

  const driverCode = stripComments(readSource(DRIVER_PATH));
  const abortSites = driverCode.match(/\.abort\(\)/gu) || [];

  assert.deepEqual(abortSites, [".abort()"], "exactly ONE abort site: no second stop path");
  assert.equal(/setInterval\s*\(/u.test(driverCode), false, "no polling loop was introduced");

  // The user's stop path is untouched: it still aborts the active controller and carries no
  // watchdog reference, so the watchdog can neither block nor duplicate it.
  const storeCode = stripComments(readSource(ONSCREEN_STORE_PATH));
  const requestStop = storeCode.slice(storeCode.indexOf("requestStop()"));
  const body = requestStop.slice(0, requestStop.indexOf("openSettingsDialog()"));

  assert.match(body, /activeRequestController\?\.abort\(\)/u, "the stop still aborts the request");
  assert.equal(/watchdog|stall/iu.test(body), false, "and knows nothing about the watchdog");
});

test("the watchdog leaf stays dependency-free, and the driver ships no surface identity", () => {
  const leaf = stripComments(readSource(WATCHDOG_PATH));

  assert.equal(/^\s*import\s/mu.test(leaf), false, "no imports: inserting it into the store's graph stays inert");
  assert.match(leaf, /export function createStallWatchdog/u);
  assert.match(leaf, /export function formatStallMessage/u);

  const driverCode = stripComments(readSource(DRIVER_PATH));

  assert.equal(/surface\s*===\s*"(admin|onscreen)"/u.test(driverCode), false);
  assert.match(driverCode, /createStallWatchdog\(/u, "the driver really builds one per turn");
  assert.match(driverCode, /watchdog\.disarm\(\)/u, "and disarms it on every exit");
});

// -----------------------------------------------------------------------------------------
// THE SURFACE HALF: the real store commits the notice and stops the series.
// -----------------------------------------------------------------------------------------
test("the real onscreen store commits the stall notice and ends the submission series", async () => {
  const { onscreenAgent: store } = await import("/modules/_core/onscreen_agent/store.js");
  const persisted = [];
  let renders = 0;

  // The conversation turn is a REPLACEABLE seam on the surface by design (the driver's
  // composition thunks call through the store), so a stalled turn can be driven through
  // the real commit path with no transport at all.
  store.runTier1ConversationTurn = async () => stalledTurnShape();
  store.persistHistory = async (options = {}) => {
    persisted.push(options);
  };
  store.render = () => {
    renders += 1;
  };
  store.history = [{ content: "build the thing", id: "u1", role: "user" }];
  store.engineSwapPendingHold = null;
  store.engineSwapTier1Session = { cancelHeld() {}, fake: true };

  const outcome = await store.runTier1TurnAndCommit(
    [{ content: "build the thing", id: "u1", role: "user" }],
    PREPARED,
    PLAN
  );

  assert.equal(outcome, "stalled");

  const notice = store.history.at(-1);

  assert.equal(notice.kind, "turn-notice", "the real store's history carries the sentence");
  assert.match(notice.content, /stopped responding/u);
  assert.equal(persisted.at(-1)?.immediate, true, "flushed, so a reload still explains the turn");
  assert.ok(renders > 0);
  assert.equal(store.engineSwapTier1Session, null, "the dead session is dropped");
  assert.equal(store.engineSwapPendingHold, null);

  // THE SERIES STOPS. `stalled` must not fall through the queued-message path or be
  // overwritten by a `Ready.` status: the sentence the driver committed is the failure.
  store.render = () => {};
  store.focusInput = () => {};
  store.runConversationLoop = async () => "stalled";

  // `runSubmissionSeries` has no return value: the state it leaves behind IS its contract.
  const statusBefore = "Stalled: the turn stopped responding and was ended. You can retry.";

  store.status = statusBefore;
  // `hasQueuedSubmission` is a getter over `queuedSubmissions`, so the queue is seeded
  // through the field the product actually reads.
  store.queuedSubmissions = [{ attachments: [], content: "next one", id: "u3" }];
  await store.runSubmissionSeries({ attachments: [], content: "x", id: "u2" });

  assert.equal(store.status, statusBefore, "the stall sentence is not overwritten by `Ready.`");
  assert.equal(store.isSending, false, "the chat is free for the next message");
  assert.equal(
    store.queuedSubmissions.length,
    1,
    "a queued message is NOT sent into a chat whose last turn stalled"
  );
});
