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
//
// This list is LOAD-BEARING, not documentation: after the cut these headings must
// still be present, and a prompt that lost one is not cut at all. Without that
// check the constant was decorative — exported, never read, while the sections it
// claimed to protect were cut or kept by accident.
export const TIER1_RETAINED_SECTION_HEADINGS = Object.freeze([
  "known helpers",
  "final rule"
]);

// The old-idiom corpus. `traces` and `task examples` are several hundred lines of
// `_____javascript` + `space.api.*` demonstration — the retired text protocol, shown
// to the model as the way to act. A live capture proved the cost: with the exact
// same tools, endpoint and model, a conversation carrying that teaching answered a
// file request with separator prose, while the same conversation without it
// produced a typed `file_read`. On Tier 1 the tool schemas are the acting channel,
// so the demonstration retires with the contract card.
//
// The fence contract is NOT in this list and must survive: it governs `run_code`
// displays and Tier 3 alike (BUG-007).
export const TIER1_DROPPED_SECTION_HEADINGS = Object.freeze([
  "traces",
  "task examples"
]);

// Every top-level section heading the shipped prompt can carry. Used to bound a
// cut: a section runs until the next KNOWN heading, so a body whose first line is
// not indented (as `task examples` is) cannot truncate the removal to its title.
export const PROMPT_TOP_LEVEL_HEADINGS = Object.freeze([
  "environment",
  "base law",
  "traces",
  "task examples",
  "rules",
  "invalid",
  API_CONTRACT_SECTION_HEADING,
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

function isKnownTopLevelHeading(line, headings) {
  return headings.includes(String(line || "").trim().toLowerCase());
}

// Removes one section by heading, bounded by the NEXT KNOWN top-level heading
// rather than by an indent heuristic.
//
// The indent heuristic is not enough here: `task examples` starts its body with a
// NON-indented line (`Checking the current page now...`), so an indent-bounded scan
// stops one line into the section and removes only the title — leaving every
// separator example in place while looking, in a diff, like the section was cut.
function removeBoundedSection(text, heading, headings) {
  const lines = text.split("\n");
  const target = String(heading || "").trim().toLowerCase();
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (String(lines[index]).trim().toLowerCase() === target) {
      start = index;
      break;
    }
  }

  if (start === -1) {
    return text;
  }

  let end = lines.length;

  for (let index = start + 1; index < lines.length; index += 1) {
    if (isKnownTopLevelHeading(lines[index], headings)) {
      end = index;
      break;
    }
  }

  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd();
}

function countOccurrences(text, needle) {
  return String(text || "").split(String(needle || "")).length - 1;
}

// Applies the Tier 1 cut: the recited contract card and the old-idiom corpus go,
// the fence contract and the retained reference sections stay.
function cutTier1Sections(text) {
  let cut = removeBoundedSection(text, API_CONTRACT_SECTION_HEADING, PROMPT_TOP_LEVEL_HEADINGS);

  for (const heading of TIER1_DROPPED_SECTION_HEADINGS) {
    cut = removeBoundedSection(cut, heading, PROMPT_TOP_LEVEL_HEADINGS);
  }

  return cut;
}

// The retained headings must still be there after the cut. This is the check that
// makes TIER1_RETAINED_SECTION_HEADINGS load-bearing: it was declared, exported and
// never read, so the sections it named were protected by luck rather than by code.
function keepsRetainedSections(text) {
  const lowered = String(text || "").toLowerCase();

  return TIER1_RETAINED_SECTION_HEADINGS.every((heading) =>
    lowered.split("\n").some((line) => line.trim() === String(heading).toLowerCase())
  );
}

// THE prompt-shape function. Pure: same input, same output, no config reads.
//
// `tier` is the resolved session tier (`tier1` / `tier3` / `none`). Only a real
// Tier 1 session changes the prompt; everything else is returned untouched.
//
// Two fail-safes, both refusing to cut rather than shipping a damaged prompt:
// a prompt that would lose the fence contract, and a prompt that would lose the
// retained reference sections.
export function shapeSystemPromptForTier({ promptText = "", tier = "" } = {}) {
  const text = typeof promptText === "string" ? promptText : "";

  if (String(tier || "").trim() !== "tier1") {
    return text;
  }

  const cut = cutTier1Sections(text);

  // The fence contract must survive the cut. If a prompt ever carries the separator
  // vocabulary only inside the sections being cut, refusing to cut is safer than
  // shipping a tool session with a corrupted contract.
  if (!cut.includes(FENCE_CONTRACT_MARKER)) {
    return text;
  }

  // A cut that removed a section it promised to keep is refused for the same
  // reason: a tool session with a half-eaten prompt is worse than a verbose one.
  if (!keepsRetainedSections(cut)) {
    return text;
  }

  return appendTier1Steering(cut);
}

// Diagnostics for the cut, used by the suite and by the one-line log. Reports what
// the model now sees instead of asserting a byte count nobody can check by eye.
export function describeTier1PromptShape({ promptText = "", tier = "tier1" } = {}) {
  const text = typeof promptText === "string" ? promptText : "";
  const shaped = shapeSystemPromptForTier({ promptText: text, tier });
  const lowered = shaped.toLowerCase();

  return Object.freeze({
    cutApplied: shaped !== text,
    droppedHeadingsPresent: Object.freeze(
      TIER1_DROPPED_SECTION_HEADINGS.filter((heading) =>
        lowered.split("\n").some((line) => line.trim() === String(heading).toLowerCase())
      )
    ),
    fenceMarkerOccurrences: countOccurrences(shaped, FENCE_CONTRACT_MARKER),
    retainedHeadingsPresent: Object.freeze(
      TIER1_RETAINED_SECTION_HEADINGS.filter((heading) =>
        lowered.split("\n").some((line) => line.trim() === String(heading).toLowerCase())
      )
    ),
    shapedChars: shaped.length,
    sourceChars: text.length,
    steeringPresent: shaped.includes(TIER1_STEERING_MARKER)
  });
}

// Deterministic visible-tool-list summary for diagnostics. One line, stable order:
// the same config logs the same line, which is what makes tier inspectable.
export function formatTier1ToolListLine(assembled) {
  const names = Array.isArray(assembled?.names) ? assembled.names : [];

  return `[engine-swap] tier1 tools=${names.join(",") || "(none)"} hash=${assembled?.hash || ""}`;
}
