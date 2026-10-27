// The ONE place the live chat surface decides WHAT to draw (chat-surface polish).
//
// Two classes of render-only state are appended to the committed projection here — and
// nowhere else:
//   - the provisional `running` chips of a streamed turn (item 2),
//   - the accumulated streaming text preview.
//
// Both are projection-only by construction: the committed history is the input, this
// function never mutates it, and its output is what a render consumes. Persistence,
// the display-only derivation and the reload replay read history, so they cannot see
// either one.
//
// THE RACE GUARD (item 4) also lives here, for the same reason the surface needed one
// seam in the first place. The doubled row the owner saw was the streaming preview and
// the committed reply drawn in the same pass. An identity check fixes that at the root:
// a projection is keyed by message id, so an id that is already committed can never be
// admitted a second time from the preview slot. That is a property of the projection
// rather than of one call site's ordering, so no future caller can reintroduce the
// duplication by rendering at the wrong moment.
//
// INPUT CONTRACT: `history` must be the DISPLAY projection, not raw stored history.
// `typedTool` / `typedToolCallId` / `typedToolOutcome` only exist after
// `projectHistoryEntryForDisplay`, so a caller that passes raw typed entries hands this
// module a shape it cannot match and the stranding guard silently does nothing
// (chat-polish audit blocker 2, 2026-10-27). The store calls `buildRenderHistory`,
// which projects first.

export const PROVISIONAL_CHIP_PREFIX = "provisional-call-";

function collectIds(entries) {
  const ids = new Set();

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const id = String(entry?.id || "");

    if (id) {
      ids.add(id);
    }
  });

  return ids;
}

// Call ids the committed history already speaks for. A committed typed call entry or
// its result means the real row exists, so any provisional chip for that call is stale
// by definition and must not be drawn — the structural half of "no chip may strand".
//
// Reads the DISPLAY projection: `typedTool`/`typedToolCallId` are added by
// `projectHistoryEntryForDisplay`, so raw typed entries (`kind: "tool_call"`) never
// match here.
function collectCommittedCallIds(entries) {
  const ids = new Set();

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const callId = String(entry?.typedToolCallId || "");

    if (callId && (entry?.typedTool === "call" || entry?.typedTool === "result")) {
      ids.add(callId);
    }
  });

  return ids;
}

// Assistant texts the CURRENT TURN has already committed.
//
// Scoping this to the turn is load-bearing, not tidiness. "Done.", "OK." and "Let me
// check." repeat across turns constantly, so comparing a preview against EVERY
// assistant message in the thread made every later preview of a common phrase invisible
// for the whole stream — the paint-timing regression this campaign already fixed once.
//
// The turn boundary is derived, never remembered: a turn is opened by a real user
// message, so committed assistant output belonging to THIS turn can only appear after
// it. Deriving it from the same input keeps the guard deterministic across renders
// (store state could drift; this cannot) and needs no extra bookkeeping at send.
//
// "Real" is load-bearing. Typed tool projections and provisional chips both wear
// `role: "user"` (they are display rows, not turns), so a boundary search that accepted
// any user role would land after this turn's own tool rows and let the narration ahead
// of them slip past the guard — reintroducing the double row. A turn-opening entry is
// therefore one that is a user message AND carries no typed-tool or provisional mark.
//
// With no such entry (a fresh chat) the whole list is considered, which is the
// conservative direction: the guard's job is to stop a row being drawn twice.
function collectTurnCommittedAssistantTexts(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let from = 0;

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index];

    // A turn is opened by a REAL user message. Framework follow-up rows (a legacy
    // text-protocol `execution-output` / `execution-retry` / `protocol-retry`) also
    // carry `role: "user"` but they belong to the turn they follow, so accepting one
    // as an opener would truncate this turn's scope and let its narration slip past
    // the guard — reintroducing the double row the guard exists to prevent
    // (chat-polish re-audit non-blocker 1). Real user messages normalize `kind: ""`.
    if (
      entry?.role === "user" &&
      !entry?.typedTool &&
      entry?.provisional !== true &&
      !entry?.kind
    ) {
      from = index + 1;
      break;
    }
  }

  return list
    .slice(from)
    .filter((entry) => entry?.role === "assistant")
    .map((entry) => String(entry?.content || "").trim());
}

// The display shape of ONE provisional chip: a typed tool-call entry wearing the
// existing chip projection, marked `provisional` so the chip resolver can settle it as
// `running`/`sync` and so grouping leaves it alone (a consent-level affordance must
// never be folded into a summary row).
export function createProvisionalChipEntry(call = {}) {
  const callId = String(call?.callId || call?.id || "");
  const name = String(call?.name || "tool");

  return Object.freeze({
    content: `execution ${name} call\nrunning`,
    id: `${PROVISIONAL_CHIP_PREFIX}${callId || name}`,
    kind: "execution-output",
    provisional: true,
    role: "user",
    typedTool: "call",
    typedToolCallId: callId,
    typedToolName: name,
    typedToolOutcome: "running"
  });
}

export function buildChatRenderProjection({ history = [], preview = null, provisionalCalls = [] } = {}) {
  const committed = Array.isArray(history) ? history : [];
  const projection = committed.slice();
  const seenIds = collectIds(committed);
  const committedCallIds = collectCommittedCallIds(committed);

  (Array.isArray(provisionalCalls) ? provisionalCalls : []).forEach((call) => {
    const entry = createProvisionalChipEntry(call);

    if (seenIds.has(entry.id) || committedCallIds.has(String(entry.typedToolCallId || ""))) {
      return;
    }

    seenIds.add(entry.id);
    projection.push(entry);
  });

  if (preview && String(preview.content || "").trim()) {
    // RACE GUARD (item 4). Two shapes of the SAME stale preview are excluded:
    //   - identity: the committed turn already owns this id. In production the preview
    //     id is the reserved constant `engine-swap-streaming-preview` and committed ids
    //     are `${role}-${Date.now()}-${random}`, so this half is a structural guard
    //     against a future caller handing the preview a real message id — it is not the
    //     half that fixes today's doubled row.
    //   - content: THIS TURN already committed an assistant message carrying exactly
    //     this text. That is the shape the owner saw: the preview had accumulated the
    //     whole reply and the commit wrote the same words into history, so one render
    //     pass drew them twice — once raw, once formatted.
    //
    // The text match is scoped to the current turn (`collectTurnCommittedAssistantTexts`).
    // An unscoped match silently killed live output on any chat that had ever used the
    // phrase, which is a worse defect than the double row it guards: the user saw
    // nothing until commit.
    const committedAssistantTexts = collectTurnCommittedAssistantTexts(committed);
    const previewText = String(preview.content || "").trim();

    if (!seenIds.has(String(preview.id || "")) && !committedAssistantTexts.includes(previewText)) {
      projection.push(preview);
    }
  }

  return projection;
}
