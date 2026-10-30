// THE NO-PROGRESS WATCHDOG (BUG-013). A turn that stops making progress must FAIL
// VISIBLY instead of hanging in silence forever.
//
// THE DEFECT, MEASURED. A live beta wedge: 43 requests, 43 responses, none hanging;
// exactly ONE model call, which succeeded, then a dead stop before the second
// inference. Last network activity at 18.1 s, then ~282 SECONDS OF TOTAL SILENCE. No
// page error, no unhandled rejection, nothing in the console, the tab fully responsive.
// The saved history held ONE entry (the user prompt) and no engine-log record at all.
// The user's only cure was a page reload, and later messages in that chat did not even
// land in history.
//
// WHY THIS IS A NO-PROGRESS WATCHDOG AND NOT A TOTAL-TURN TIMEOUT. A deadline on the
// whole turn would abort healthy work: legitimate beta turns reached first steps of
// 64-105 seconds on the biggest builds, and ONE REAL BUILD'S FIRST STEP TOOK 108
// SECONDS. What the wedge looks like is not slowness, it is TOTAL INACTIVITY: minutes
// with zero requests, zero stream events, zero dispatches, zero console output. So the
// window measures SILENCE, is re-armed by every sign of life, and never measures how
// long a turn is taking.
//
// DEPENDENCY-FREE BY CONTRACT, exactly like `turn-log.js` and `gate-message.js`:
// `turn-driver.js` is statically imported by both surface stores, so anything it
// imports statically ships to every session even with `ENGINE_SWAP_DISPATCH` off. This
// leaf imports NOTHING.
//
// THE CLOCK IS INJECTED. Production passes real timers; a suite passes a fake clock so
// it can advance four and a half minutes instantly. A watchdog whose tests sleep for
// its own window is a test suite nobody runs.

export const STALL_WATCHDOG_WINDOW_MS = 270000;

// The measured bound this window has to clear, recorded as a NUMBER so a later reader
// cannot quietly shrink the window without meeting the same evidence. The largest
// legitimate silence-free wait observed in the beta was 108 s for a big build's first
// step to appear; 270 s is 2.5x that, and it is still an order of magnitude below the
// 282 s wedge it has to catch.
export const STALL_WATCHDOG_OBSERVED_MAX_LEGITIMATE_WAIT_MS = 108000;

// The word a stalled turn settles as. MIRRORED, not imported, for the same reason
// `turn-log.js` mirrors the stop reasons: `turn-driver.js` is statically imported by both
// surface stores, so importing `tier1-session.js` (which pulls transports, the registry and
// the dispatch pipeline) would ship the whole engine to every session even with
// `ENGINE_SWAP_DISPATCH` off. `tests/engine_swap_stall_watchdog_test.mjs` asserts this
// equals `TIER1_TURN_STATUS.STALLED`, `TOOL_TURN_STOP_REASON.STALLED` and
// `TURN_LOG_OUTCOME.STALLED` value for value, so one vocabulary cannot drift into four.
export const STALLED_TURN_STATUS = "stalled";

// The ONE user-facing sentence for a stalled turn. Short, plain, settled, no emoji and
// no instructions aimed at a model -- the same audience rule `gate-message.js` follows.
// It says three things a reader needs: the turn stopped responding, it was ended, and
// they can retry. It never claims WHY, because a watchdog knows only that nothing
// arrived.
export function formatStallMessage({ seconds = 0 } = {}) {
  const waited = Math.max(0, Math.round(Number(seconds) || 0));
  const window = waited ? `${waited} seconds` : "a while";

  return `This turn stopped responding: nothing arrived from the model for ${window}, so it was ended. You can retry.`;
}

// The status line the surface shows while the stall is being reported. Kept here so the
// sentence and the status cannot drift, and so both surfaces word one stall identically.
export function formatStallStatus() {
  return "Stalled: the turn stopped responding and was ended. You can retry.";
}

// A WATCHDOG IS AN OBSERVER AND MUST NEVER BE THE REASON A PROCESS STAYS ALIVE.
//
// A bare `setTimeout` keeps the Node event loop open for the whole window. That is
// invisible in a browser, but every headless harness that constructs a real driver
// inherits it: the suite finishes its assertions, prints its results, and then sits for
// four and a half minutes with nothing to do. It was found exactly that way -- a suite
// that passes 11 of 11 and never exits, while the same suite on the base commit exits
// cleanly.
//
// `unref()` is a Node timer method and browsers do not have it, so the call is guarded
// rather than assumed. Unref'd timers still fire normally; they simply stop holding a
// process open when nothing else is pending. An armed watchdog is therefore still armed.
function defaultSchedule(handler, delayMs) {
  const handle = setTimeout(handler, delayMs);

  if (typeof handle?.unref === "function") {
    handle.unref();
  }

  return handle;
}

function defaultCancel(handle) {
  clearTimeout(handle);
}

// ONE watchdog. `arm()` starts (or restarts) the window, `touch()` re-arms it because
// something happened, `disarm()` stops it. `stalled` is the promise the turn races
// against: it resolves EXACTLY ONCE, the first time the window elapses with no activity.
//
// `isExempt()` is consulted at fire time, immediately before firing. A held destructive
// call is not a stall: the turn is waiting for a HUMAN, and a consent question can
// legitimately last minutes while somebody thinks about a delete. Exempting it here
// rather than trusting a paired cleanup call is the same discipline the turn-progress
// indicator uses: derive the fact at the moment it matters, so no exit path can miss it.
export function createStallWatchdog({
  cancel = defaultCancel,
  isExempt = null,
  now = () => Date.now(),
  onFire = null,
  schedule = defaultSchedule,
  windowMs = STALL_WATCHDOG_WINDOW_MS
} = {}) {
  let handle = null;
  let armedAt = 0;
  let lastActivityAt = 0;
  let fired = false;
  let resolveStalled = null;
  let settled = false;

  const stalled = new Promise((resolve) => {
    resolveStalled = resolve;
  });

  function clear() {
    if (handle !== null) {
      try {
        cancel(handle);
      } catch {
        // A cancel that throws must not leave the watchdog armed.
      }

      handle = null;
    }
  }

  function settle(payload) {
    if (settled) {
      return;
    }

    settled = true;
    resolveStalled(payload);
  }

  function onTimer() {
    handle = null;

    if (settled || fired) {
      return;
    }

    // The window elapsed. Before declaring a stall, ask the one question that
    // distinguishes "nothing is happening" from "a human is deciding": is a consent
    // question pending? If so this is not a stall, and the window restarts.
    let exempt = false;

    try {
      exempt = typeof isExempt === "function" && isExempt() === true;
    } catch {
      exempt = false;
    }

    if (exempt) {
      lastActivityAt = now();
      handle = schedule(onTimer, windowMs);

      return;
    }

    fired = true;

    const silenceMs = Math.max(0, now() - lastActivityAt);

    try {
      onFire?.({ silenceMs, windowMs });
    } catch {
      // Reporting a stall must never throw back into the timer.
    }

    settle({ silenceMs, windowMs });
  }

  function startTimer() {
    clear();
    handle = schedule(onTimer, windowMs);
  }

  return {
    // Any sign of life: a streamed delta, a model call starting or finishing, a tool
    // dispatch, a new iteration. Re-arms the FULL window, so a turn making slow but real
    // progress never accumulates toward a fire.
    touch() {
      if (settled) {
        return;
      }

      lastActivityAt = now();
      startTimer();
    },

    arm() {
      if (settled) {
        return;
      }

      armedAt = now();
      lastActivityAt = armedAt;
      fired = false;
      startTimer();
    },

    disarm() {
      clear();
    },

    // Resolves once, when the window elapses with no activity. Racing a turn against
    // this is what frees a session whose own await never settles: the hung promise stays
    // pending and nothing waits on it any more.
    get stalled() {
      return stalled;
    },

    get fired() {
      return fired;
    },

    get armedAt() {
      return armedAt;
    },

    get lastActivityAt() {
      return lastActivityAt;
    },

    get windowMs() {
      return windowMs;
    }
  };
}
