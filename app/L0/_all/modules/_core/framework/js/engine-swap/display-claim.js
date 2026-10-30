// BUG-008: a turn that tells the user it is only SHOWING code must not also run it.
//
// THE DEFECT, measured on the beta (two passes, 12 display turns): 7 were fully
// clean; 2 write-side turns actually created the file the model had just told the
// user it would not create; 3 delete-side turns dispatched a real delete (all
// caught by the destructive gate, nothing lost). The old engine got this
// structurally right — the fence contract made displayed code non-executing — and
// the typed engine had no representation of display intent at all.
//
// THE SHAPE THAT PICKS THE FIX, verified entry by entry in all five non-clean
// turns: an assistant TEXT entry carrying BOTH the display claim and the fenced
// code, then the dispatch as a SEPARATE, LATER tool_call entry. No single message
// both claimed "not executed" and carried the dispatch. So the sufficient fix is a
// LOOP-LEVEL refusal of the calls of a turn whose text claims non-execution — not a
// dispatch-time dry-run mode, not a per-tool opt-out, not a schema flag.
//
// WHAT THIS MODULE IS: a small, auditable TEXT PREDICATE. It is a heuristic, and it
// says so. A model that phrases a non-execution claim in words outside the lists
// below evades it entirely; the lists are therefore explicit and reviewable rather
// than clever, and `tests/engine_swap_display_guard_test.mjs` pins both directions
// (the observed failure shapes fire, eight legitimate turns do not).
//
// WHAT IT IS NOT: it never executes, never mutates, needs no network, and holds no
// state. Pure leaf with TWO imports, both pure: the shared fence scan (a second copy
// of fence logic in this tree is the BUG-007 anti-pattern) and the closed dispatch
// error taxonomy, so the refusal is a REAL `policy` error rather than a new string
// family invented here.

import { collectExecutionFenceRegions } from "../execution-blocks.js";
import { createPolicyError } from "./dispatch-errors.js";

// THE CLAIM PHRASES. Every entry is a claim that an action was NOT performed (or
// will not be). They are the phrases the beta actually produced, plus close
// variants of the same claim.
//
// Deliberately ABSENT: "here is the code" / "here's the code". Printing code while
// announcing it is legitimate — "I'll create the file now. Here is the code:" is a
// real action turn — so those phrases are NOT claims on their own. A turn needs a
// non-execution claim to arm the guard.
//
// Also deliberately absent: bare "not" / "nothing" / "executed". A past-tense
// report ("the script was executed successfully") must never arm the guard.
export const DISPLAY_CLAIM_PHRASES = Object.freeze([
  "not executed",
  "not been executed",
  "not run",
  "not been run",
  "not performed",
  "not actually run",
  "not actually executed",
  "won't run",
  "won't be run",
  "will not run",
  "will not be run",
  "didn't run",
  "did not run",
  "without running it",
  "without running this",
  "without running anything",
  "without executing",
  "display only",
  "display-only",
  "for display",
  "shown for reference",
  "shown, not executed",
  "showing only",
  "nothing was created",
  "nothing has been created",
  "nothing was deleted",
  "nothing has been deleted",
  "nothing was written",
  "nothing has been written",
  "nothing was modified",
  "nothing has been modified",
  "no file was created",
  "no file has been created",
  "no files were created",
  "no file was deleted",
  "nothing was executed",
  "nothing has been executed"
]);

// THE ACTION-INTENT VETO. A turn that ALSO says it is acting right now is not a
// display turn — it is an action turn that happens to mention a non-execution fact
// ("the old file was not deleted, so I'll write the new one now"). Refusing such a
// turn would be a FALSE REFUSAL, which is the cost this guard must not pay, so any
// of these phrases disarms it. Applied to the whole fence-stripped text, not per
// sentence: conservative in the direction of not refusing.
export const ACTION_INTENT_PHRASES = Object.freeze([
  "i will now",
  "i'll now",
  "now i'll",
  "now i will",
  // Unambiguous action forms. None of these can appear inside a
  // "… will not run" claim, because the negation word sits between the subject and
  // the verb ("i will not run" does not contain "i will run"), so adding them can
  // only ever reduce false refusals.
  "i will write",
  "i will create",
  "i will run",
  "i will execute",
  "i will delete",
  "i'll write",
  "i'll create",
  "i'll run",
  "i'll execute",
  "i'll delete",
  "i am going to",
  "i'm going to",
  "running it now",
  "executing it now",
  "creating it now",
  "writing it now",
  "deleting it now",
  "doing it now",
  "doing that now",
  "let me write",
  "let me create",
  "let me run",
  "let me execute",
  "let me delete",
  "i am creating",
  "i'm creating",
  "i am writing",
  "i'm writing",
  "i am running",
  "i'm running",
  "i am executing",
  "i'm executing"
]);

function normalizeText(text) {
  if (typeof text !== "string" || !text) {
    return "";
  }

  return text
    .replace(/\u2019/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

// The claim is looked for OUTSIDE fences only: code the user was shown is not a
// claim about what ran. The fence scan is the SHARED one (`execution-blocks.js`),
// and its fail-safe direction is the one we want — an unterminated fence counts as
// display to the end, so unclosed code cannot smuggle a claim into the prose scan.
export function stripFencedText(text) {
  if (typeof text !== "string" || !text) {
    return "";
  }

  const regions = collectExecutionFenceRegions(text);

  if (!regions.length) {
    return text;
  }

  let out = "";
  let cursor = 0;

  regions.forEach((region) => {
    out += text.slice(cursor, region.start);
    out += " ";
    cursor = region.end;
  });

  out += text.slice(cursor);

  return out;
}

function isWordBoundaryAt(text, index, length) {
  const before = index > 0 ? text[index - 1] : " ";
  const after = index + length < text.length ? text[index + length] : " ";
  const isWordChar = (char) => /[a-z0-9]/u.test(char);

  return !isWordChar(before) && !isWordChar(after);
}

// Longest-first: when several listed phrases match the same span family ("not run"
// sits inside "will not run"), the MOST SPECIFIC one is reported. That matters for
// the recurrence count in coaching and for a test that wants to name the phrase
// that actually fired, without a shorter neighbour masking it.
const CLAIM_PHRASES_LONGEST_FIRST = Object.freeze(
  [...DISPLAY_CLAIM_PHRASES].sort((left, right) => right.length - left.length)
);

const ACTION_INTENT_PHRASES_LONGEST_FIRST = Object.freeze(
  [...ACTION_INTENT_PHRASES].sort((left, right) => right.length - left.length)
);

function findPhrase(haystack, phrases) {
  for (const phrase of phrases) {
    let from = 0;

    while (from <= haystack.length) {
      const index = haystack.indexOf(phrase, from);

      if (index === -1) {
        break;
      }

      if (isWordBoundaryAt(haystack, index, phrase.length)) {
        return phrase;
      }

      from = index + 1;
    }
  }

  return "";
}

// THE PREDICATE. Rule, in order:
//   1. non-string or empty text -> no claim (nothing to read);
//   2. fenced regions are removed, so code being shown never counts as prose;
//   3. an action-intent phrase anywhere in what is left DISARMS the guard;
//   4. otherwise the guard arms iff a claim phrase appears on word boundaries.
//
// Returns the matched claim phrase ("" when nothing armed), so a caller can name
// the reason in coaching and a test can assert WHICH phrase fired.
export function findDisplayClaim(text) {
  const prose = normalizeText(stripFencedText(text));

  if (!prose) {
    return "";
  }

  if (findPhrase(prose, ACTION_INTENT_PHRASES_LONGEST_FIRST)) {
    return "";
  }

  return findPhrase(prose, CLAIM_PHRASES_LONGEST_FIRST);
}

export function hasDisplayOnlyClaim(text) {
  return Boolean(findDisplayClaim(text));
}

// THE MODEL-FACING REFUSAL, as a real `policy` error from the closed taxonomy.
//
// Two audiences stay separate, exactly as they do for the destructive gate: the
// model receives coaching (what happened, what to do instead), the human receives
// whatever the surface paints for the tool row. Tone follows `formatHeldToolResult`
// and `formatDeniedToolResult`: state the fact, forbid the wrong continuation, name
// the right one.
//
// It is NOT a hold, and the distinction is load-bearing. A hold is a consent
// QUESTION: execution is pending a human's yes, `gate.status` is `held`, and the
// surface paints a confirm bar. This is a REFUSAL that has already happened: nothing
// is pending, the gate stays `idle`, and no confirm affordance exists because there
// is nothing to confirm. A caller can tell them apart by class (`policy`, never
// `held`), by status (`error`, never `held`), and by the absence of `outcome.hold`.
export function createDisplayRefusalError({ callId = "", count = 1, tool = "" } = {}) {
  const action = String(tool || "the action").trim();
  const calls = Number.isFinite(Number(count)) && Number(count) > 1 ? ` (${Number(count)} calls refused in this turn)` : "";

  return createPolicyError({
    callId,
    message: `The turn's text told the user that ${action} would not run, so it was not run.${calls}`,
    retryHint: [
      "This refusal is about the turn, not the arguments: the reply stated the action was display only (not executed / nothing was created / for display), and an action described as not running must not run.",
      "Do not retry this call in this turn. If the user actually wants it performed they must ask for it explicitly in a new message; never perform work you have already described as display only, and never claim it happened.",
      "Showing code without running it is a legitimate answer — if that is what the user asked to see, answer in plain text and stop there."
    ].join("\n"),
    tool: action
  });
}
