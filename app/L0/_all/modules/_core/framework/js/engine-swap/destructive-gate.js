// The v1 destructive gate (plan §5, D3 = inline confirm in chat).
//
// A `destructive` tool call is HELD by the system, never auto-executed. The model
// is told the call is held, not that it failed — those are different facts and
// conflating them teaches the model to retry a call that is already waiting for a
// human.
//
// This is a consent affordance, not a security boundary. Say it plainly because
// the plan says it plainly (rev 2): the same deletion performed inside `run_code`
// is ungated by construction. The gate exists so an approved deletion has a visible
// moment of consent, not so deletion becomes impossible.
//
// State machine — every state has a guaranteed exit:
//
//   idle --hold--> held --confirm--> confirmed (terminal)
//                     \----deny-----> denied    (terminal)
//                      \---session-end--> cancelled (terminal)
//
// `held` is bounded in time by the caller's session lifecycle: `cancelHeld()` is
// called on session end, chat clear, and stop. There is no state that can wait
// forever with no exit, and no exit depends on the chat being "busy" — a stop
// control that greys out while work is pending is exactly the bug this shape
// avoids.

export const DESTRUCTIVE_GATE_STATUS = Object.freeze({
  CANCELLED: "cancelled",
  CONFIRMED: "confirmed",
  DENIED: "denied",
  HELD: "held",
  IDLE: "idle"
});

const TERMINAL_STATUSES = Object.freeze([
  DESTRUCTIVE_GATE_STATUS.CANCELLED,
  DESTRUCTIVE_GATE_STATUS.CONFIRMED,
  DESTRUCTIVE_GATE_STATUS.DENIED
]);

export function createDestructiveGate() {
  let hold = null;

  function settle(status) {
    if (!hold) {
      return null;
    }

    const settled = Object.freeze({
      ...hold,
      resolvedAt: Date.now(),
      status
    });

    hold = null;
    return settled;
  }

  return Object.freeze({
    // The status of the current hold, or `idle`.
    get status() {
      return hold ? hold.status : DESTRUCTIVE_GATE_STATUS.IDLE;
    },

    // True only while a call is waiting for the human. Callers must never gate a
    // stop control on this value.
    get isHeld() {
      return Boolean(hold);
    },

    // The held call, for rendering the confirm affordance. Null when idle.
    get held() {
      return hold;
    },

    // Holds one destructive call. Throws on programmer error (holding twice), not
    // on user input: a second hold while one is pending is a bug in the caller.
    hold({ arguments: args = {}, callId = "", description = "", tool = "" } = {}) {
      if (hold) {
        throw new Error("A destructive call is already held; settle it before holding another.");
      }

      hold = Object.freeze({
        arguments: args,
        callId: String(callId || ""),
        description: String(description || ""),
        heldAt: Date.now(),
        status: DESTRUCTIVE_GATE_STATUS.HELD,
        tool: String(tool || "")
      });

      return hold;
    },

    // The human said yes. Returns the settled record; `null` when nothing was held
    // (a double click is not an error worth throwing at a user).
    confirm() {
      return settle(DESTRUCTIVE_GATE_STATUS.CONFIRMED);
    },

    // The human said no. The pipeline turns this into a structured policy result.
    deny() {
      return settle(DESTRUCTIVE_GATE_STATUS.DENIED);
    },

    // Session end, chat clear, or stop. Guaranteed exit with no user input.
    cancelHeld() {
      return settle(DESTRUCTIVE_GATE_STATUS.CANCELLED);
    },

    isTerminalStatus(status) {
      return TERMINAL_STATUSES.includes(status);
    }
  });
}

// The model-facing text for a held call. It says HELD, gives the exact pending
// action, and tells the model what to do next (nothing — wait).
export function formatHeldToolResult({ description = "", tool = "" } = {}) {
  const action = String(description || tool || "the action").trim();

  return [
    `held: ${action} is waiting for the user's confirmation in the chat.`,
    "Do not retry this call and do not claim it happened. It will execute at most once if the user confirms; if they deny it, you will receive a policy result.",
    "Continue only with work that does not depend on this action, or answer the user and wait."
  ].join("\n");
}

// The structured policy result after a denial.
export function formatDeniedToolResult({ description = "", tool = "" } = {}) {
  const action = String(description || tool || "the action").trim();

  return [
    `policy: the user denied ${action}.`,
    "Nothing was changed. Do not retry the same call. Ask the user what they want instead, or stop."
  ].join("\n");
}
