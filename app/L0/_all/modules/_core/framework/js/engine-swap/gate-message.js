// The USER-FACING wording for every destructive-gate outcome (BUG-009).
//
// WHY THIS FILE EXISTS. The gate told the MODEL what happened —
// `formatHeldToolResult` writes a coaching sentence into a tool result — and told the
// USER nothing that survives a reload. A held turn committed its assistant tool-call
// entry and its held tool-result entry and then stopped, so the saved transcript ended
// at the tool result with `answer: ""`. A reader of that history cannot tell a decision
// is pending, and a denial or a cancellation left the same silence. The chat was never
// dead (a following user message was answered normally); the transcript was.
//
// So the two audiences get two different strings, and they must never be swapped:
//
//   - model-facing: `formatHeldToolResult` / `formatDeniedToolResult` in
//     `destructive-gate.js` — coaching. "Do not retry", "you will receive a policy
//     result". Never shown to a human.
//   - user-facing: everything below — short, plain, and settled. No emoji, no
//     exclamation marks, no instructions aimed at a model.
//
// Pure leaf: no imports, no I/O, no `space.*`. Both surfaces and the turn driver call
// it, so one hold cannot be described two ways on two surfaces.

const TOOL_VERBS = Object.freeze({
  file_delete: "delete",
  file_write: "write"
});

// The sentence begins the message, so it is capitalized here rather than at every
// callsite.
function capitalize(text) {
  const value = String(text || "");
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

// The compact identity of the pending call: the verb the user understands plus the
// actual target. `file_delete {"path":"/x/y.txt"}` reads as `the delete of /x/y.txt`.
//
// Three sources are consulted in order, because a hold reaches a surface with
// different fields populated depending on which layer built it: the call arguments,
// then the pipeline's own `description` (a name followed by a compact JSON body), then
// the bare tool name. A hold with nothing but a name still yields an honest sentence.
export function describeGateAction({ arguments: args = null, description = "", tool = "" } = {}) {
  const toolName = String(tool || "").trim();
  const rawDescription = String(description || "").trim();
  const name = toolName || rawDescription.split(" ")[0] || "";
  const verb = TOOL_VERBS[name] || name.replace(/_/gu, " ").trim() || "action";

  let target = "";

  if (args && typeof args === "object" && typeof args.path === "string") {
    target = args.path.trim();
  }

  if (!target && rawDescription) {
    // `description` is `<tool> <json>`; the JSON is the source of the target.
    const body = rawDescription.slice(name.length).trim();

    if (body) {
      try {
        const parsed = JSON.parse(body);

        if (parsed && typeof parsed.path === "string") {
          target = parsed.path.trim();
        }
      } catch {
        // A description that is not JSON is still a description; it is used whole by
        // the fallback below rather than thrown away.
        target = "";
      }
    }

    if (!target && !toolName) {
      return rawDescription;
    }
  }

  return target ? `the ${verb} of ${target}` : `the ${verb}`;
}

// HELD. Names the action so the transcript says what is actually waiting.
export function formatGateHeldMessage(hold = {}) {
  return `${capitalize(describeGateAction(hold))} is waiting for your confirmation.`;
}

// CONFIRMED. `executed` is the session's confirmed outcome, or null when the gate had
// nothing left to execute. A failure is stated as a failure instead of being dressed as
// success, and it does not claim the target survived.
export function formatGateConfirmedMessage(hold = {}, executed = null) {
  const action = describeGateAction(hold);
  const ok = Boolean(executed) && executed.status === "ok";

  return ok ? `${capitalize(action)} executed.` : `The confirmed ${action.replace(/^the /u, "")} did not execute.`;
}

// DENIED / user cancelled the question. Says plainly that nothing changed, because that
// is the fact a later reader needs.
export function formatGateDeniedMessage(hold = {}) {
  return `You cancelled ${describeGateAction(hold)}; nothing was removed.`;
}

// CANCELLED by session end, chat clear or stop while held. The transcript must not claim
// a decision is still pending forever.
export function formatGateCancelledMessage(hold = {}) {
  return `The pending ${describeGateAction(hold).replace(/^the /u, "")} was cancelled; nothing was removed.`;
}
