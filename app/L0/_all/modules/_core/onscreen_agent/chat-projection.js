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
    //   - identity: the committed turn already owns this id;
    //   - content: the committed history already ends with an assistant message
    //     carrying exactly this text.
    //
    // The second is the shape the owner saw: the preview had accumulated the whole
    // reply and the commit wrote the same words into history, so one render pass drew
    // them twice — once raw, once formatted. Recognising it here makes "one assistant
    // message, one row" a property of the projection rather than a promise about the
    // order two call sites happen to run in.
    const committedAssistantTexts = committed
      .filter((entry) => entry?.role === "assistant")
      .map((entry) => String(entry?.content || "").trim());
    const previewText = String(preview.content || "").trim();

    if (!seenIds.has(String(preview.id || "")) && !committedAssistantTexts.includes(previewText)) {
      projection.push(preview);
    }
  }

  return projection;
}
