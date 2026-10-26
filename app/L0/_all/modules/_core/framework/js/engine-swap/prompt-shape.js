// Prompt shape for a Tier 1 session (plan §3.6).
//
// The API contract card retires on a tool session: its content now lives in the
// tool schemas and descriptions, where it is ENFORCED instead of recited. Telling a
// model both "here is a JSON schema and it is strict" and "remember that the third
// argument is a string" is the duplicated-contract pattern this campaign exists to
// delete, and the recited version is the one that drifts (BUG-006).
//
// What stays: role, behavioral norms, the protocol vocabulary the model still needs
// for prose, and the fence-contract line. The fence contract is NOT Tier 1
// scaffolding — it governs `run_code` displays and Tier 3 alike, and a show-me-code
// answer must stay plain text on every tier (BUG-007, plan §8).
//
// Tier 3 prompts are untouched: this function returns the input string unchanged
// when the session is not Tier 1.

export const API_CONTRACT_SECTION_HEADING = "api contracts";

// Sections that a tool session keeps verbatim. Kept as data so the intent is
// reviewable rather than implied by a regex nobody dares touch.
export const TIER1_RETAINED_SECTION_HEADINGS = Object.freeze([
  "known helpers",
  "final rule"
]);

// The fence-contract line. If a future firmware prompt renames it, this marker is
// what the drift test watches: the contract must survive on every tier.
export const FENCE_CONTRACT_MARKER = "_____javascript";

// Tier 1 only: the channel the model acts through is the typed tool list, not the
// separator. Without this the prompt's separator vocabulary is the ONLY acting
// idiom a model sees, and on a live run it answered a file request with separator
// prose that nothing executes (a chip that can never settle). The marker is what
// the drift test watches, and it makes the append idempotent.
//
// It must NOT forbid showing code: a show-me-code answer stays plain display on
// every tier (BUG-007). What it constrains is which channel ACTS.
export const TIER1_STEERING_MARKER = "## acting on this tier";

export const TIER1_STEERING_SECTION = [
  TIER1_STEERING_MARKER,
  "",
  "- to act, call a tool. a tool call is the only thing that runs.",
  "- fenced code and the _____javascript separator only SHOW code; they never run it.",
  "- use that display form only for code the user explicitly asked to see.",
  "- when the user asks for a file or system operation, call the matching tool."
].join("\n");

function findSectionBounds(lines, heading) {
  const normalizedHeading = String(heading || "").trim().toLowerCase();
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (String(lines[index]).trim().toLowerCase() === normalizedHeading) {
      start = index;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  // A section runs until the next line that looks like a top-level heading: a
  // non-empty, NON-INDENTED line that does not start with a bullet.
  //
  // The predicate must be `indented OR bullet`, not "contains whitespace": the
  // latter matches almost every prose line, so the scan would run to the end of
  // the prompt and the cut would take the sections below the card with it.
  let end = lines.length;

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.trim()) {
      continue;
    }

    if (/^\s|^-/u.test(line)) {
      continue;
    }

    end = index;
    break;
  }

  return { end, start };
}

// Removes one top-level section by heading, preserving everything else byte for
// byte apart from the collapsed blank lines at the seam.
export function removePromptSection(promptText, heading) {
  const text = typeof promptText === "string" ? promptText : "";

  if (!text.trim()) {
    return text;
  }

  const lines = text.split("\n");
  const bounds = findSectionBounds(lines, heading);

  if (!bounds) {
    return text;
  }

  const before = lines.slice(0, bounds.start);
  const after = lines.slice(bounds.end);
  const joined = [...before, ...after].join("\n");

  // Collapse the double blank line the cut can leave behind.
  return joined.replace(/\n{3,}/gu, "\n\n").trimEnd();
}

// Appends the steering leg exactly once. Idempotent by marker, so re-shaping an
// already-shaped prompt cannot stack duplicate sections (the shape function is
// pure and may be applied to its own output by a later layer).
export function appendTier1Steering(promptText) {
  const text = typeof promptText === "string" ? promptText : "";

  if (text.includes(TIER1_STEERING_MARKER)) {
    return text;
  }

  return `${text.trimEnd()}\n\n${TIER1_STEERING_SECTION}\n`;
}

// THE prompt-shape function. Pure: same input, same output, no config reads.
//
// `tier` is the resolved session tier (`tier1` / `tier3` / `none`). Only a real
// Tier 1 session changes the prompt; everything else is returned untouched.
export function shapeSystemPromptForTier({ promptText = "", tier = "" } = {}) {
  const text = typeof promptText === "string" ? promptText : "";

  if (String(tier || "").trim() !== "tier1") {
    return text;
  }

  const withoutContract = removePromptSection(text, API_CONTRACT_SECTION_HEADING);

  // The fence contract must survive the cut. If a prompt ever carries the card and
  // no separator vocabulary anywhere else, refusing to cut is safer than shipping a
  // tool session with a corrupted contract.
  if (!withoutContract.includes(FENCE_CONTRACT_MARKER)) {
    return text;
  }

  return appendTier1Steering(withoutContract);
}

// Deterministic visible-tool-list summary for diagnostics. One line, stable order:
// the same config logs the same line, which is what makes tier inspectable.
export function formatTier1ToolListLine(assembled) {
  const names = Array.isArray(assembled?.names) ? assembled.names : [];

  return `[engine-swap] tier1 tools=${names.join(",") || "(none)"} hash=${assembled?.hash || ""}`;
}
