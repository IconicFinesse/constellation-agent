// The Tier 1 TURN DRIVER (P4a-1).
//
// WHY THIS FILE EXISTS. The reusable engine already lived here in `engine-swap/`, but
// the code that decides what a TURN DOES — retry, preview lifecycle, provisional chips,
// wire baseline, commit slicing — was written inside `onscreen_agent/store.js`, because
// that is where the surface state it touches happened to live. Any other surface (admin,
// Starforge) wanting Tier 1 would therefore have had to import another MODULE's
// internals. Modules depend on the framework; they never depend on each other. That is
// the entire reason this extraction exists.
//
// THE BOUNDARY, stated once so it cannot erode:
//
//   - `surface`  — how THIS surface paints and stores. Injected. The driver never knows
//                  which surface it serves, and there is no `surface === admin` branch
//                  anywhere: if that check is ever needed, the seam is wrong.
//   - `inputs`   — values and framework bridges the surface hands in. Reached through
//                  thunks, never captured, so a mid-turn change (a stop request, a
//                  settings edit) is seen at the moment the turn reads it.
//   - driver state — `engineSwapStreamingPreview`, `engineSwapPreviewSealed`,
//                  `engineSwapProvisionalCalls`, `engineSwapHeldMessages`,
//                  `engineSwapTier1Session`, `engineSwapDisplayOnlyMessageIds`. These
//                  describe what a turn is DOING. They are meaningless to a surface that
//                  is not running a turn, so the driver owns them outright: one copy,
//                  one writer.
//
// `engineSwapPendingHold` deliberately does NOT live here. It is the surface's confirm
// affordance (a live template binding reads it), so it stays surface-owned and is read
// and written through `surface` in both directions. Moving it behind a plain getter
// would break template reactivity silently — a driver write never passes through the
// store proxy's set trap, so no trigger would fire and the confirm bar would simply stop
// appearing. That is a production regression the whole node suite is blind to, which is
// exactly why it is a decision recorded here rather than an accident.
//
// IMPORTS: this module may import from `engine-swap/` and from `framework/js/`. It must
// never import from `onscreen_agent/` or `admin/` — that is the contract this lane exists
// to establish.

import {
  formatDisplayFormToolCallLine,
  formatWireHygieneLine,
  resolveTier1CorrectivePrompt,
  resolveTier1CorrectiveRetry,
  sanitizeTier1WireMessages
} from "/modules/_core/framework/js/engine-swap/wire-hygiene.js";
import {
  appendGateOutcomeMessage,
  canonicalMessagesToTypedEntries
} from "/modules/_core/framework/js/engine-swap/history-shapes.js";
// The USER-FACING gate sentences (BUG-009). The gate has always told the MODEL what
// happened; these are the words a HUMAN reads, and they are committed to history so a
// pending decision survives a reload instead of living only in transient UI state.
import {
  formatGateCancelledMessage,
  formatGateHeldMessage
} from "/modules/_core/framework/js/engine-swap/gate-message.js";
// The ENGINE TURN LOG (P7-1). A dependency-free leaf, so importing it here keeps the
// dispatch-OFF import graph exactly as inert as it was: this file is statically
// imported by both surface stores, and nothing below allocates, logs or writes until a
// real Tier 1 turn begins.
import {
  appendTurnLogStep,
  createTurnLogRecord,
  createTurnLogStartRecord,
  emitTurnLogRecord,
  finalizeTurnLogRecord,
  turnLogStepFromEvent
} from "/modules/_core/framework/js/engine-swap/turn-log.js";

// The closed dispatch-outcome mapping. A status outside the `DISPATCH_OUTCOME` set is not
// a settle signal — the chip stays `Running` rather than having an outcome invented for it.
const ENGINE_SWAP_CHIP_OUTCOME_BY_DISPATCH_STATUS = Object.freeze({
  error: "error",
  held: "held",
  ok: "success"
});

// Outcomes that MEAN the thing happened (or was refused). `running` and `pending` describe
// work still in flight, so they are not news and never settle a chip. `deferred` is included
// for totality: the loop answers a held call's later siblings as `deferred:` without
// emitting a dispatch event for them, so nothing can reach this word today — it is here so a
// future emit settles correctly instead of silently regressing to `Running`.
const ENGINE_SWAP_TERMINAL_CHIP_OUTCOMES = new Set(["deferred", "error", "held", "success"]);

// The reserved id of the streaming preview row. A stable id is what lets the existing row
// patch REPLACE that row instead of appending a second one.
const ENGINE_SWAP_STREAMING_PREVIEW_ID = "engine-swap-streaming-preview";

/**
 * Build the Tier 1 turn driver for one surface.
 *
 * @param {object} options
 * @param {object} options.surface Painting, persistence and surface-owned state. Every
 *   member is called as a method on the surface, so a surface that replaces one of them
 *   later (a test collapsing a coalesced repaint into a synchronous one, for example) is
 *   honoured — the driver binds thunks, never captured function references.
 * @param {object} options.inputs Read-only per-turn inputs and the surface's bridges into
 *   the engine. Values are reachable only through thunks so a mid-turn change is seen.
 * @returns {object} the driver methods plus the engine-shaped state it owns.
 */
export function createTier1TurnDriver({ surface = {}, inputs = {} } = {}) {
  // The driver's own state. One copy, one writer: nothing outside this file assigns it,
  // and the surface reaches it only through the accessors the store declares.
  const state = {
    engineSwapDisplayOnlyMessageIds: new Set(),
    engineSwapHeldMessages: null,
    engineSwapPreviewSealed: false,
    engineSwapProvisionalCalls: [],
    engineSwapStreamingPreview: null,
    engineSwapTier1Session: null,
    // The IN-FLIGHT engine turn log (P7-1): `{ lastEventAt, record }` for the turn
    // currently running, or null outside one. Seventh member of the owned state and
    // subject to the same rule as the other six -- nothing template-binds to it.
    engineSwapTurnLog: null
  };

  // THE PUBLIC SEAMS THE SURFACE OWNS. `runTier1TurnAndCommit` composes TWO driver
  // operations, and on the surface both are public methods a caller may replace (a
  // suite stubs the conversation turn to drive the commit path without a transport).
  // Reaching for the sibling method directly would silently bypass that replacement,
  // so composition goes through these thunks when the surface supplies them and falls
  // back to the driver's own implementation when it does not.
  const runConversationTurn =
    typeof inputs.runConversationTurn === "function" ? inputs.runConversationTurn : driver_runConversationTurn;
  const collectDisplayOnlyIds =
    typeof inputs.collectDisplayOnlyIds === "function" ? inputs.collectDisplayOnlyIds : driver_collectDisplayOnlyIds;

  function driver_runConversationTurn(...args) {
    return driver.runTier1ConversationTurn(...args);
  }

  function driver_collectDisplayOnlyIds(...args) {
    return driver.collectEngineSwapDisplayOnlyIds(...args);
  }

  const driver = {
    // Exposed so the surface can declare delegating accessors onto the ONE copy of this
    // state instead of keeping a second one that could drift.
    state,

    // A streaming preview that outlived its turn would be a message the user never
    // received, so every exit clears it: commit, hold, error, stop and a thrown
    // transport all pass through the turn's `finally`.
    //
    // THE ONE CLEANUP SITE (items 2 and 4). Provisional chips are the same class of
    // state as the text preview — projection-only, meaningless outside the turn that
    // produced them — so they are cleared HERE rather than in a second place that
    // could drift. Every provisional chip therefore ends its life at commit, at an
    // error, at a stop, at a hold, or at a thrown transport: none can strand.
    clearEngineSwapStreamingPreview() {
      state.engineSwapStreamingPreview = null;
      state.engineSwapProvisionalCalls = [];
    },

    // Sealing is what makes the ordering guarantee hold against a LATE delta: once a
    // turn has committed, nothing may create preview state again until the next turn
    // opens it explicitly.
    sealEngineSwapPreview() {
      state.engineSwapPreviewSealed = true;
      driver.clearEngineSwapStreamingPreview();
    },

    openEngineSwapPreview() {
      state.engineSwapPreviewSealed = false;
      driver.clearEngineSwapStreamingPreview();
    },

    // --- engine-swap Tier 1 streaming preview --------------------------------
    //
    // Tool turns STREAM text as well as tool calls. The transport already reports
    // each text delta (`api.js` `onDelta`), but the Tier 1 path passed no callback,
    // so the prose only appeared when the whole turn returned: "text arrives all at
    // once".
    //
    // The preview lives OUTSIDE the surface's committed history on purpose. History is
    // the committed turn: persistence serializes it, the display-only derivation reads
    // it, and a reload replays it. A half-streamed reply has no business in any of
    // those, so a preview that is merely ADDED TO THE RENDER PROJECTION cannot leak
    // into them.
    appendEngineSwapStreamingDelta(delta) {
      const text = typeof delta === "string" ? delta : "";

      // SEALED (item 4). The turn that owned this slot has committed, so a delta
      // arriving late (an in-flight frame, a transport that resolved after abort) must
      // not resurrect a preview row beside the committed reply. Dropping it here is the
      // other half of the ordering guarantee; the projection's id check is the first.
      if (state.engineSwapPreviewSealed) {
        return;
      }

      if (!text) {
        return;
      }

      if (!state.engineSwapStreamingPreview) {
        const preview = inputs.createStreamingAssistantMessage();

        // A stable, reserved id: the row patch looks its row up by id, and it must
        // never collide with a committed message or a queued preview.
        preview.id = ENGINE_SWAP_STREAMING_PREVIEW_ID;
        // ONE VOCABULARY PER TIER (chat-polish-3 item 1). This row belongs to a TYPED tier
        // turn, where separator text is display by construction, so the surface must read it
        // that way WHILE it streams — not only after commit. The mark lives on this
        // projection-only preview (it never enters history, so it is never persisted and no
        // reload can resurrect it); the committed row gets the same reading through the
        // derived display-only id set.
        //
        // Tier 3 never builds a preview here, so its cards are untouched.
        preview.tier1Turn = true;
        state.engineSwapStreamingPreview = preview;
      }

      state.engineSwapStreamingPreview.content += text;
      // Compact and full mode paint streaming text through different seams; feed
      // both, exactly as the Tier 3 delta path does.
      surface.setStreamingAssistantStatus(state.engineSwapStreamingPreview.content);
      surface.maybeShowCompactStreamingAssistantBubble(state.engineSwapStreamingPreview);
      surface.scheduleStreamingMessageRender(state.engineSwapStreamingPreview);
    },

    // PROVISIONAL chips, painted as a call's streamed arguments complete.
    //
    // Deduped by call id: providers repeat a completed call in later deltas, and a
    // second chip for one call would be a lie about how many calls are running. This
    // NEVER dispatches anything — the loop dispatches from the assembled result only.
    recordEngineSwapProvisionalCall(call = {}) {
      const callId = String(call?.callId || call?.id || "");
      const name = String(call?.name || "tool");

      if (!callId || state.engineSwapPreviewSealed) {
        return false;
      }

      // THE FIRST SIGHTING IS USUALLY EMPTY (owner-reported live on v1.2.1+70). Providers
      // announce a call's id and name on the first delta with an EMPTY arguments body, and an
      // empty body is a LEGALLY COMPLETE payload (it is how a no-argument call is spelled) —
      // so this fires before the JSON exists. The record is still created here, because the
      // chip must appear the instant the model announces the call, as `Running` with honest
      // empty arguments. The real payload arrives on a later delta and lands through the
      // fill-in path below.
      //
      // Deduping by call id is unchanged and load bearing: exactly one chip per call, ever.
      const index = state.engineSwapProvisionalCalls.findIndex(
        (entry) => String(entry?.callId || "") === callId
      );

      if (index !== -1) {
        return driver.updateEngineSwapProvisionalCall(index, call);
      }

      state.engineSwapProvisionalCalls = [
        ...state.engineSwapProvisionalCalls,
        {
          // THE CALL'S ARGUMENTS (P3 provisional panes). The transport had them all along
          // and simply did not pass them, so the chip had nothing real to show and fell back
          // to whatever the projection wrote after the newline. They are kept verbatim — the
          // raw JSON string the provider streamed — because the projection formats them
          // through the shared canonical writer, which is what makes the mid-turn pane
          // byte-identical to the committed row's.
          arguments: call?.arguments,
          // INTERLEAVE OFFSET (chat-polish-2 item C). The chip belongs WHERE IT APPEARED, so
          // the preview's length at this instant is recorded with it and the projection
          // splits the accumulated text there. Reading the length at paint time instead
          // would move every chip to the bottom of the prose.
          atChars: String(state.engineSwapStreamingPreview?.content || "").length,
          callId,
          name
        }
      ];
      surface.scheduleEngineSwapChipRender();

      return true;
    },

    // FILL IN A CHIP THAT WAS ANNOUNCED EMPTY (owner-reported live on v1.2.1+70).
    //
    // The record already exists, so this is the same call seen again with more truth. Two
    // rules, both load bearing:
    //
    //   - `atChars` is NOT touched. It was frozen at the first sighting and it is what keeps
    //     the chip where the user watched it appear; recomputing it here would slide every
    //     chip to the bottom of the prose it interleaves with.
    //   - nothing is APPENDED, to the array or to a field. The record is replaced in place at
    //     the same index, so chip ORDER is the order the calls were announced in.
    //
    // AN EMPTY INCOMING VALUE NEVER CLOBBERS A NON-EMPTY ONE. Providers repeat a call in
    // later deltas, sometimes with the argument body omitted entirely; treating that as
    // "the arguments are now empty" would erase the payload the chip is showing. The first
    // real value wins over any later blank, and the LAST non-empty value wins over an earlier
    // one — which is what makes a repeated `name` a replacement rather than a concatenation
    // (`run_coderun_coderun_code` was the measured defect).
    //
    // Returns true only when state actually changed, so a no-op repeat does not schedule a
    // wasted repaint. Display-only: this never dispatches anything.
    updateEngineSwapProvisionalCall(index, call = {}) {
      const current = state.engineSwapProvisionalCalls[index];

      if (!current) {
        return false;
      }

      const incomingArguments = call?.arguments;
      const incomingName = String(call?.name || "").trim();
      const next = { ...current };
      let changed = false;

      // The raw JSON string the provider streamed, kept verbatim: the projection formats it
      // through the shared canonical writer, which is what makes a filled-in chip byte-
      // identical to the committed row.
      if (typeof incomingArguments === "string" && incomingArguments.trim()) {
        if (incomingArguments !== current?.arguments) {
          next.arguments = incomingArguments;
          changed = true;
        }
      } else if (incomingArguments !== undefined && incomingArguments !== null && current?.arguments === undefined) {
        // A structured payload on a record that had none (a provider that sends an object
        // instead of a fragment) still counts as arriving: the formatter accepts both.
        next.arguments = incomingArguments;
        changed = true;
      }

      if (incomingName && incomingName !== String(current?.name || "")) {
        next.name = incomingName;
        changed = true;
      }

      if (!changed) {
        return false;
      }

      const calls = state.engineSwapProvisionalCalls.slice();

      calls[index] = next;
      state.engineSwapProvisionalCalls = calls;
      surface.scheduleEngineSwapChipRender();

      return true;
    },

    // SETTLE-ON-DISPATCH: the loop already knows the outcome when it dispatches, and this
    // is where the surface finally listens (owner-reported: every chip read
    // `run_code · Running` for the whole turn and only flipped at turn end).
    //
    // The record is edited IN PLACE, and that is the whole point:
    //   - `atChars` is preserved, so the chip stays where the user watched it appear
    //     instead of jumping to the end of the prose;
    //   - the array is replaced with a copy at the SAME index, so chip ORDER is preserved;
    //   - an unknown call id creates nothing. A provider that never streamed the call (a
    //     single JSON body, or an assembled call with no completed-arguments hook) must not
    //     have a chip invented for it: that would draw a row for a call the user never
    //     watched arrive, with no offset to interleave at.
    //
    // Non-terminal words are refused HERE rather than downstream so exactly one place
    // decides what "settled" means: an `ok`/`error`/`held` dispatch status settles, and
    // anything else leaves the chip `Running` for the turn-exit clear to finish.
    settleEngineSwapProvisionalCall({ callId, outcome, result = null } = {}) {
      const id = String(callId || "");
      const settledOutcome = String(outcome || "").trim();

      // A sealed or cleared slot has nothing to settle: the turn this chip belonged to is
      // over, and its committed row speaks for the call now.
      if (!id || state.engineSwapPreviewSealed || !ENGINE_SWAP_TERMINAL_CHIP_OUTCOMES.has(settledOutcome)) {
        return false;
      }

      const index = state.engineSwapProvisionalCalls.findIndex(
        (entry) => String(entry?.callId || "") === id
      );

      if (index === -1) {
        return false;
      }

      const current = state.engineSwapProvisionalCalls[index];

      // Idempotent: providers repeat a completed call, and a settled chip must not flip
      // back as duplicates arrive. First terminal outcome wins.
      if (String(current?.outcome || "")) {
        return false;
      }

      // THE RESULT PANE'S TEXT, taken from the loop's own committed tool message. The
      // loop decides that string once and hands it over on the dispatch event, so this is
      // not a second formatter: it is the very text history will hold, and the projection
      // renders it through the same reader the committed row uses. A result that arrives
      // without content (an older caller) leaves the field absent rather than inventing a
      // payload, so the chip keeps the honest `No output yet.` reading.
      const resultContent = typeof result?.content === "string" ? result.content : null;

      const next = state.engineSwapProvisionalCalls.slice();
      next[index] = resultContent === null
        ? { ...current, outcome: settledOutcome }
        : { ...current, outcome: settledOutcome, resultContent, resultIsError: result?.isError === true };
      state.engineSwapProvisionalCalls = next;

      surface.scheduleEngineSwapChipRender();
      return true;
    },

    // --- engine turn log (P7-1) ------------------------------------------------
    //
    // OBSERVATION ONLY. One content-free record per turn, delivered fire-and-forget
    // through the surface's api client. Every helper below is TOTAL and SILENT on
    // failure: a log that can break or delay a chat turn is worse than no log, so each
    // one swallows its own throw and the emit path additionally resolves rather than
    // rejects. Nothing here reads or influences dispatch, validation, transport or the
    // committed history.
    //
    // WHY THE `finally` AND NOT THE RETURN: `runTier1ConversationTurn` has ONE exit for
    // a finished turn and a `finally` that every path crosses -- success, transport
    // error, user stop, held, iteration cap, AND a thrown transport that never reaches
    // a return statement at all. Recording the end there means a turn that dies cannot
    // leave a record permanently open, which a return-site record would.
    //
    // IT EMITS A START RECORD, not just allocates one. The log used to write ONLY on
    // completion, so a turn that WEDGED -- the single most interesting turn there is, per a
    // live beta wedge with 43 requests and no hanging response -- left no record anywhere.
    // The start record is emitted HERE, before the first model call, so a turn that never
    // returns still leaves a trace naming when it began, what tier/model it resolved and
    // its turn id. Both records carry that same id (see `turn-log.js`), so a reader pairs
    // started-without-finished against finished by id and sees the wedge.
    beginEngineTurnLog({ model = "", tier = "", wireMessageCount = 0 } = {}) {
      try {
        state.engineSwapTurnLog = {
          lastEventAt: Date.now(),
          record: createTurnLogRecord({ model, startedAt: Date.now(), tier })
        };
        state.engineSwapTurnLog.record.wireMessageCount = Number(wireMessageCount) || 0;

        // A SNAPSHOT, not the live record: the live one keeps accumulating steps and is
        // finalized in the `finally`, and handing the writer a reference to it would let
        // later mutation rewrite a record already sent. Fire-and-forget, so a slow or dead
        // log endpoint can never delay the first model call.
        emitTurnLogRecord(createTurnLogStartRecord(state.engineSwapTurnLog.record), {
          api: inputs.runtime()?.api || null
        });
      } catch {
        state.engineSwapTurnLog = null;
      }
    },

    recordEngineTurnLogEvent(event) {
      try {
        const active = state.engineSwapTurnLog;

        if (!active) {
          return;
        }

        const now = Date.now();
        const step = turnLogStepFromEvent(event, { durationMs: now - active.lastEventAt });

        if (!step) {
          return;
        }

        appendTurnLogStep(active.record, step);
        active.lastEventAt = now;
      } catch {
        // Observation must never break a turn.
      }
    },

    // `turns` is the loop's own per-model-call record list, handed in so the usage counts
    // are DERIVED from the one place a model call's usage is stored rather than summed a
    // second time beside it. Omitted (a turn that died before returning a result) leaves
    // the usage `null`, which is the honest reading for a turn that never reported.
    finishEngineTurnLog({ outcome = "", toolCount = 0, turns = [], wireMessageCount = 0 } = {}) {
      try {
        const active = state.engineSwapTurnLog;

        state.engineSwapTurnLog = null;

        if (!active) {
          return null;
        }

        const record = finalizeTurnLogRecord(active.record, {
          endedAt: Date.now(),
          outcome,
          toolCount,
          turns,
          wireMessageCount
        });

        // Fire-and-forget: the promise is intentionally not awaited, and a rejected
        // post resolves to null inside the recorder.
        emitTurnLogRecord(record, { api: inputs.runtime()?.api || null });

        return record;
      } catch {
        // Observation must never break a turn.
      }

      return null;
    },

    // The ONE translation from a loop event to surface state. Every OTHER event the loop
    // emits (`assistant-turn`, `turn-error`, `incomplete-arguments-refused`) already reaches
    // the surface through the turn RESULT, so consuming those here would be a second source
    // of the same truth.
    //
    // Defensive by construction: this runs inside the transport's event path, so a throw
    // here would break a live turn over a cosmetic chip. A malformed event is ignored,
    // never raised.
    handleEngineSwapTurnEvent(event = {}) {
      try {
        // ENGINE TURN LOG (P7-1): the SAME subscription the chip settle already uses.
        // Recording happens BEFORE the dispatch-only early return below, because three
        // of the four recorded step types (`assistant-turn`, `turn-error`,
        // `incomplete-arguments-refused`) are exactly the events that return early --
        // subscribing anywhere after that guard would log dispatch steps only. The
        // recorder swallows its own errors, so this cannot change the return value.
        driver.recordEngineTurnLogEvent(event);

        if (String(event?.type || "") !== "dispatch") {
          return false;
        }

        // The call id travels on the CALL, not on the outcome (`emit({ call, outcome,
        // position, type })` in `tool-turn-loop.js`). Both spellings are read because a
        // streamed fragment and a completion payload name the id differently.
        const callId = String(event?.call?.id || event?.call?.callId || "");
        const outcome = ENGINE_SWAP_CHIP_OUTCOME_BY_DISPATCH_STATUS[String(event?.outcome?.status || "")];

        if (!outcome) {
          return false;
        }

        // The loop's committed result text travels with the event so the chip's OUTPUT pane
        // can show the same bytes the committed row will show. Absent on a caller that does
        // not supply it (and on the held/deferred paths that never had one), which leaves the
        // honest empty pane rather than a fabricated payload.
        return driver.settleEngineSwapProvisionalCall({ callId, outcome, result: event?.result || null });
      } catch {
        // A chip is presentation. It never gets to fail a turn.
        return false;
      }
    },

    // --- engine-swap Tier 1 turn ---------------------------------------------
    //
    // Dispatch-ON turns for a tools-capable config run the typed tool loop from the
    // shared engine-swap layer. Everything here is a call into that layer; the only
    // surface-side work is translating its result into history entries and status.
    async runTier1ConversationTurn(requestMessages, preparedRequest, plan, options = {}) {
      // The Tier 1 conversation starts from the SAME prepared messages the streaming
      // path just built. Re-deriving them would give the two tiers different prompts.
      const preparedMessages = Array.isArray(preparedRequest?.messages) ? preparedRequest.messages : [];
      const normalizedMessages = preparedMessages.map((message) => ({
        content: String(message?.content || ""),
        role: message?.role === "assistant" ? "assistant" : message?.role === "system" ? "system" : message?.role === "tool" ? "tool" : "user"
      }));

      // WIRE HYGIENE: the conversation a Tier 1 model receives must not carry the
      // protocol envelope as content, and must not carry an assistant turn that acts
      // with the execution separator. Both re-teach the retired text protocol; a live
      // capture proved the model imitates them even when the tool list is present.
      //
      // The marker vocabulary and the separator test are INJECTED — a second copy of
      // either is the BUG-007 anti-pattern. Tier 3 never reaches this function, so its
      // wire is untouched.
      const sanitized = sanitizeTier1WireMessages({
        envelopeMarkers: inputs.envelopeMarkers,
        findSeparatorIndex: inputs.findSeparatorIndex,
        messages: normalizedMessages
      });
      const messages = sanitized.messages.map((message) => ({ ...message }));

      // Observable, once per turn that actually changed something: a sanitization that
      // silently rewrote the wire would be untestable from a live session.
      if (sanitized.changed) {
        try {
          console.info(formatWireHygieneLine(sanitized));
        } catch {
          // Logging must never break a turn.
        }
      }

      if (messages[0]?.role === "system") {
        messages[0] = {
          content: await inputs.shapeSystemPrompt({
            promptText: messages[0].content,
            tier: plan.tier
          }),
          role: "system"
        };
      }

      // Stop reuses the ONE mechanism the text path already owns: `requestStop()`
      // sets the stop flag and aborts the active request controller. The loop consults
      // the flag between iterations, and the controller's signal reaches the
      // tool-turn fetch so an in-flight request is cut instead of waited out (P2
      // audit non-blocker 3). No second stop source is introduced.
      const controller = new AbortController();

      surface.setActiveRequestController(controller);

      // The preview ACCUMULATES across this turn's iterations (owner-reported
      // transcript defect, 2026-10-27): it used to be cleared at the start of every
      // `sendCompletion`, so iteration 1's prose blinked out the moment iteration 2
      // began and the user only ever saw the LAST iteration's words. Every iteration's
      // narration is part of what the user watched, so the slot is reset ONCE per turn
      // here and appended to thereafter, with a blank-line boundary between iterations
      // so two narrations do not run together. It is still cleared exactly once, in
      // the `finally` below, and it still never enters the committed history.
      let previewStarted = false;
      let previewBoundaryPending = false;

      const appendPreviewDelta = (delta) => {
        if (previewBoundaryPending) {
          previewBoundaryPending = false;
          driver.appendEngineSwapStreamingDelta("\n\n");
        }

        driver.appendEngineSwapStreamingDelta(delta);
      };

      const buildTurnRequest = ({ initialMessages, onEvent, sendCompletion }) => ({
        api: inputs.runtime()?.api || globalThis.space?.api || null,
        apiEndpoint: String(inputs.settings().apiEndpoint || ""),
        executionContext: inputs.executionContext(),
        initialMessages,
        isStopRequested: () => inputs.stopRequested() === true,
        model: String(inputs.settings().model || ""),
        params: inputs.parseParams(inputs.settings().paramsText || ""),
        providerKey: "",
        onEvent,
        sendCompletion
      });

      // ENGINE TURN LOG (P7-1). Declared OUTSIDE the try so the `finally` below can
      // close the record on every exit; all three are assigned inside it.
      let turnLogOutcome = "";
      let turnLogToolCount = 0;
      // The loop's own per-model-call records, the ONE place a call's token usage is
      // stored. Left empty when the turn dies before returning a result, which the
      // recorder reads as `usage: null` -- a turn that never reported, not a free one.
      let turnLogTurns = [];

      try {
        // One record per turn, opened before the first provider call so the turn's own
        // duration covers the whole thing the owner waited for. `wireMessageCount` is
        // filled at the finish below, where the sanitized wire length is in scope.
        driver.beginEngineTurnLog({
          model: String(inputs.settings().model || ""),
          tier: String(plan?.tier || "")
        });

        const turn = await inputs.runTier1Turn(buildTurnRequest({
          initialMessages: messages,
          // SETTLE-ON-DISPATCH: the loop emits `{ type: "dispatch", call, outcome }` the
          // moment a call has been dispatched. Display-only subscription: it settles the
          // matching provisional chip and touches nothing else. Without it the outcome the
          // loop already knew was simply dropped and every chip read `Running` until the
          // commit-time history rewrite replaced it.
          onEvent: (event) => driver.handleEngineSwapTurnEvent(event),
          // P3: tool turns STREAM. The transport assembles `tool_calls` fragments per
          // call index and reports each call complete only when its arguments are
          // complete JSON, so the loop can dispatch without ever seeing half a call.
          sendCompletion: async ({ request }) => {
            // One preview slot per TURN, appended to across iterations: iteration 1's
            // prose is part of what the user watched and must not blink out when
            // iteration 2 starts. Reset only on the FIRST request of the turn, and
            // separate later iterations with a blank line so two narrations do not run
            // together. The reserved id still makes the row patch REPLACE the same row
            // instead of appending a second one.
            if (!previewStarted) {
              previewStarted = true;
              // Opens the slot for THIS turn: clears any stale preview and lifts the
              // seal the previous turn left behind (item 4).
              driver.openEngineSwapPreview();
            } else {
              previewBoundaryPending = true;
            }

            return inputs.streamToolTurn({
              // Text deltas reach the surface while tool-call fragments are still
              // assembling. This is the "text appears all at once" fix: without it the
              // transport buffered the prose and the turn returned it in one piece.
              // Routed through the turn's accumulator so an iteration boundary is
              // inserted between this iteration's prose and the next one's.
              onDelta: (delta) => appendPreviewDelta(delta),
              // A call whose arguments COMPLETE paints a provisional `running` chip
              // immediately (item 2). Display only: the loop still dispatches from the
              // assembled turn, and every chip is cleared at ONE cleanup site.
              onToolCallComplete: (call) => driver.recordEngineSwapProvisionalCall(call),
              requestBody: request.body,
              settings: inputs.settings(),
              signal: controller.signal
            });
          }
        }));

        // How many tools the model was actually OFFERED, read off the session that
        // built the request list rather than re-derived from config: a logged count
        // that disagrees with the wire would be evidence against us.
        turnLogToolCount = Number(turn?.session?.assembled?.tools?.length) || turnLogToolCount;

        // BOUNDED CORRECTIVE RETRY. A sanitized wire is the fix; this is the belt for
        // the case where a model still answered with separator prose and never made a
        // single call. Without it that turn ends silently on the retired protocol and
        // the user is told nothing. ONE retry, decided from the loop's own turn record
        // rather than from parsing prose, and it continues from the turn's messages so
        // the separator reply stays in context as a thing that already happened.
        let finalTurn = turn;
        // ONE decision, and it names the SHAPE (chat-polish-3 item 3). The detector runs over
        // the answer the wire actually produced, using the shared fence classifier and the
        // separator test — never a second copy of either. A fenced block of code with no call
        // is legitimate display (BUG-007), so a catch only ever means "call-shaped display
        // content AND nothing dispatched", which is exactly the turn that needs correcting.
        const corrective = resolveTier1CorrectiveRetry({
          answer: turn?.result?.answer,
          attempts: 0,
          fenceRegions: inputs.fenceRegions(turn?.result?.answer),
          findSeparatorIndex: inputs.findSeparatorIndex,
          separator: inputs.separator,
          turns: turn?.result?.turns,
          // The user's OWN request, so a "show me how you'd call it" turn cannot burn the
          // single retry on code the human asked to see (p35 audit non-blocker 3). Display
          // requests and actions need opposite handling, and only this turn says which it is.
          userTurn: (() => {
            const list = Array.isArray(requestMessages) ? requestMessages : [];

            for (let index = list.length - 1; index >= 0; index -= 1) {
              const entry = list[index];

              if (entry?.role === "user" && !entry?.typedTool && !entry?.kind) {
                return String(entry?.content || "");
              }
            }

            return "";
          })()
        });
        const retry = corrective.retry;
        // Names the SPECIFIC mistake. More prompt steering is not the lever — the steering leg
        // already says a tool call is the only thing that runs, and the model fenced anyway.
        const correctivePrompt = resolveTier1CorrectivePrompt(corrective.shape);

        if (retry) {
          // Counted once per catch, on the existing diagnostics channel, with the SHAPE and
          // no message content: the owner needs to know whether this is rare drift or a
          // habitual pattern without the log carrying replies.
          try {
            console.info(formatDisplayFormToolCallLine(corrective.shape));
          } catch {
            // Logging must never break a turn.
          }
        }

        if (retry && !inputs.stopRequested()) {
          const continuedMessages = [
            ...(Array.isArray(turn?.result?.messages) ? turn.result.messages : messages),
            { content: correctivePrompt, role: "user" }
          ];
          // INVARIANT: the coaching element sits EXACTLY at this index — it is the last
          // entry of the list the retry starts from, so every earlier entry keeps its
          // position and the retry's baseline is `correctiveIndex`. The removal below is
          // POSITIONAL for that reason: matching on text alone would also delete a
          // message the model happened to echo back.
          const correctiveIndex = continuedMessages.length - 1;

          // The retry CONTINUES the turn's one preview. The first attempt's prose is
          // kept in the committed history (only the coaching turn is dropped), so
          // resetting the slot here would make the user watch prose vanish that the
          // transcript then keeps -- the same defect as a per-iteration reset, one
          // level up. The coaching attempt's prose simply accumulates after it.
          previewBoundaryPending = true;

          try {
            const second = await inputs.runTier1Turn(buildTurnRequest({
              initialMessages: continuedMessages,
              // The corrective retry is a CONTINUATION of the same turn, so it subscribes
              // through the same handler. A retry that dispatched silently would leave the
              // chips of its calls running exactly like the main attempt used to.
              onEvent: (event) => driver.handleEngineSwapTurnEvent(event),
              sendCompletion: async ({ request }) => {
                // The turn's ONE accumulator continues here. The boundary before this
                // attempt was set once, above; each further iteration of the retry sets
                // another boundary, exactly as the main attempt does.
                previewBoundaryPending = true;

                return inputs.streamToolTurn({
                  onDelta: (delta) => appendPreviewDelta(delta),
                  onToolCallComplete: (call) => driver.recordEngineSwapProvisionalCall(call),
                  requestBody: request.body,
                  settings: inputs.settings(),
                  signal: controller.signal
                });
              }
            }));

            turnLogToolCount = Number(second?.session?.assembled?.tools?.length) || turnLogToolCount;

            // The coaching turn is scaffolding, not conversation. Dropping it from
            // the persisted message list keeps the transcript honest: the user never
            // said it, so it must not become a user bubble they later scroll past.
            // Positional, per the invariant above: the coaching turn is scaffolding the
            // user never wrote, and it is removed by WHERE it sits, not by what it says.
            const persistedMessages = (
              Array.isArray(second?.result?.messages) ? second.result.messages : []
            ).filter((_message, index) => index !== correctiveIndex);

            finalTurn = {
              result: {
                ...second.result,
                messages: persistedMessages,
                turns: [
                  ...(Array.isArray(turn?.result?.turns) ? turn.result.turns : []),
                  ...(Array.isArray(second?.result?.turns) ? second.result.turns : [])
                ]
              },
              session: second.session
            };
          } catch {
            // A retry that fails must not replace a real answer with nothing. The
            // first turn's result stands, and the chip-exit derivation still explains
            // what the user is looking at.
            finalTurn = turn;
          }
        }

        // The WIRE length is the baseline the commit must slice from, not the length
        // of the prepared conversation: sanitization can DROP messages, and a tail
        // sliced at the pre-sanitization length would silently discard the assistant
        // reply and its tool results. Reported here so there is one source of truth
        // for what was actually sent. Deliberately the ORIGINAL wire length, so a
        // corrective retry cannot erase the first attempt from history.
        // The turn's own settled status IS the logged outcome: one vocabulary, read from
        // the loop rather than re-decided here. A thrown turn never reaches this line,
        // which the recorder reports as `error` -- the honest word for it.
        turnLogOutcome = String(finalTurn?.result?.status || "");
        // The per-model-call records of the turn that actually settled. A corrective
        // retry's calls are part of the same turn's cost, and `finalTurn` already merges
        // them, so this reads the one list the commit reads.
        turnLogTurns = Array.isArray(finalTurn?.result?.turns) ? finalTurn.result.turns : [];

        return {
          correctiveRetry: retry,
          result: finalTurn.result,
          session: finalTurn.session,
          wireHygiene: sanitized,
          wireMessageCount: messages.length
        };
      } finally {
        // ENGINE TURN LOG (P7-1): ONE guaranteed exit. This `finally` is why the record is
        // finished HERE and not at a return site -- success, transport error, user stop, a
        // held destructive call, the iteration cap AND a thrown transport all cross this
        // line, and a record left open by the one path that never returns would be the
        // same stranding defect the preview slot was fixed for. Delivered fire-and-forget:
        // nothing is awaited, so logging cannot delay the turn either.
        try {
          driver.finishEngineTurnLog({
            outcome: turnLogOutcome,
            toolCount: turnLogToolCount,
            turns: turnLogTurns,
            wireMessageCount: messages.length
          });
        } catch {
          // Observation must never break a turn.
        }

        // The preview dies with the turn. Commit, hold, error, stop, iteration cap and
        // a thrown transport all return through here, so a streamed reply the user
        // watched can never linger as a row that history does not contain.
        //
        // SEAL + CLEAR in ONE call, in that order (items 2 and 4): sealing makes a LATE
        // delta (an in-flight frame, a transport resolving after an abort) unable to
        // recreate preview state beside the committed reply, and the same call settles
        // every provisional chip. Both kinds of projection state therefore exit through
        // a single line on every path.
        driver.sealEngineSwapPreview();

        if (surface.getActiveRequestController() === controller) {
          surface.setActiveRequestController(null);
        }
      }
    },

    // Assistant text that carries an executable execution separator was SHOWN, not run.
    //
    // On Tier 1 nothing ever executes separator text: execution happens only through a
    // typed tool call. So a reply that answers with separator prose ends the turn with
    // no result coming, and a chip waiting for one would wait forever. Recording those
    // ids makes the chip settle at `Shown, not executed` instead of spinning.
    //
    // The separator test is the SHARED fence-aware one: a separator inside a fence is
    // display text and never starts an execution, and a second copy of fence logic is
    // the BUG-007 anti-pattern.
    //
    // THE ONE derivation, used by the Tier 1 commit, by history restore and by a rerun.
    // Deriving instead of remembering is the whole point: the set describes PERSISTED
    // history, so it must survive a reload. Persisted ids are kept verbatim
    // (`assistant-<n>`), so the same inputs derive the same ids and nothing is stored
    // twice.
    //
    // Eligibility is three conditions, not two:
    //   - assistant text (only assistant entries render a chip),
    //   - carrying an EXECUTABLE separator (fenced separators are display),
    //   - with NO execution results. A message that really executed — a Tier 3 turn
    //     with its `execution-output` follow-up, or any message with a results
    //     override — must keep its executed label. Without this condition a reload
    //     would relabel real executions as `Shown, not executed`.
    collectEngineSwapDisplayOnlyIds(entries, outputOverrides = null) {
      const ids = new Set();
      const list = Array.isArray(entries) ? entries : [];
      const overrides = outputOverrides && typeof outputOverrides === "object" ? outputOverrides : {};

      for (let index = 0; index < list.length; index += 1) {
        const entry = list[index];

        if (entry?.role !== "assistant" || typeof entry?.content !== "string" || !entry.id) {
          continue;
        }

        if (inputs.findSeparatorIndex(entry.content) === -1) {
          continue;
        }

        const overrideResults = overrides[entry.id];
        const hasOverrideResults = Array.isArray(overrideResults) && overrideResults.length > 0;
        // The other results shape: the framework follow-up turn written under the
        // assistant message by the text protocol (Tier 3) after real execution.
        const next = list[index + 1];
        const hasFollowUpResults = Boolean(next) && inputs.isFrameworkFollowUpKind(next.kind);

        if (!hasOverrideResults && !hasFollowUpResults) {
          ids.add(String(entry.id));
        }
      }

      return ids;
    },

    // Applies the shared derivation to a history snapshot. Deterministic by design:
    // calling it twice with the same inputs yields the same set, so restore cannot
    // drift from commit and a rerun can truthfully REMOVE an id.
    syncEngineSwapDisplayOnlyIds(history, outputOverrides = null) {
      state.engineSwapDisplayOnlyMessageIds = collectDisplayOnlyIds(
        history,
        outputOverrides || inputs.executionOutputOverrides()
      );

      return state.engineSwapDisplayOnlyMessageIds;
    },

    async runTier1TurnAndCommit(requestMessages, preparedRequest, plan, options = {}) {
      const turn = await runConversationTurn(requestMessages, preparedRequest, plan, options);
      const { result, session } = turn;
      // Slice at the WIRE length, not the prepared length: sanitization can drop
      // messages, and the loop's message list starts from the shorter wire. Using the
      // pre-sanitization length here would silently discard the assistant reply and
      // its tool results from persisted history.
      const baseline = Number.isFinite(Number(turn?.wireMessageCount))
        ? Number(turn.wireMessageCount)
        : Array.isArray(preparedRequest?.messages)
          ? preparedRequest.messages.length
          : 0;
      const tailEntries = canonicalMessagesToTypedEntries(result?.messages || [], { fromIndex: baseline });

      // Derived from the WHOLE composed history with the one shared collector, the
      // same call the restore path makes. A union with the previous set could only
      // ever add ids: it could not see that a message had since acquired results, and
      // it could not match what a reload would compute. Determinism here is what lets
      // commit and restore agree (audit blocker 1).
      const composedHistory = [...requestMessages, ...tailEntries];

      driver.syncEngineSwapDisplayOnlyIds(composedHistory);

      if (result?.status === "held") {
        // The destructive call is HELD: nothing executed, and the chat now renders an
        // inline confirm affordance. The session is kept so confirm/deny can settle
        // the exact call the user is looking at.
        //
        // One consent question at a time. A second hold in the same loop would
        // overwrite the first, and the call the user is looking at would become
        // unreachable.
        //
        // THE PENDING HOLD IS SURFACE STATE (P4a-1). It is a live template binding, so
        // it stays on the surface and is read/written through the surface here. A second
        // copy in the driver would be able to drift from the one the confirm bar reads.
        if (surface.getPendingHold()) {
          session.cancelHeld?.();
          state.engineSwapTier1Session = null;
          // The FIRST hold's confirm bar must go with the session it belonged to.
          // Leaving it set left two buttons that both no-op on `!session`: an
          // affordance that lied about being actionable (P2 audit non-blocker 1).
          surface.setPendingHold(null);
          state.engineSwapHeldMessages = null;
          // This hold was CANCELLED by the policy (one consent question at a time), so the
          // transcript says so. Without it the kept tail would end on a held placeholder
          // that no reachable control can ever settle, which is the same silence BUG-009
          // is about, just reached through a different door.
          surface.setHistory(
            appendGateOutcomeMessage([...requestMessages, ...tailEntries], {
              content: formatGateCancelledMessage(result.hold || {})
            })
          );
          await surface.persistHistory({ immediate: true });
          surface.render();
          surface.setStatus("A confirmation is already waiting; finish it before starting another.");
          return "complete";
        }

        state.engineSwapTier1Session = session;
        surface.setPendingHold(result.hold || null);
        // The canonical turn (assistant tool call + held result) is kept so a
        // confirmation can resume the loop from it and let the model report what
        // actually happened, instead of stranding the user with a chip.
        state.engineSwapHeldMessages = Array.isArray(result.messages) ? [...result.messages] : null;
        // THE COMMITTED SENTENCE (BUG-009). The held sentence the model receives is a tool
        // RESULT, so on its own the saved transcript ends at a tool row and a reader cannot
        // tell a decision is pending. This appends the user-facing line as a real assistant
        // entry — the same message shape every normal reply uses — so it persists, reloads
        // and paints through the ordinary path. Both surfaces retire it when the hold
        // settles (`settleGateOutcome`) or is cancelled.
        surface.setHistory(
          appendGateOutcomeMessage([...requestMessages, ...tailEntries], {
            content: formatGateHeldMessage(result.hold || {})
          })
        );
        await surface.persistHistory({ immediate: true });
        surface.render();
        surface.setStatus("Waiting for your confirmation to delete.");
        return "complete";
      }

      state.engineSwapTier1Session = null;
      surface.setPendingHold(null);
      surface.setHistory([...requestMessages, ...tailEntries]);
      await surface.persistHistory({ immediate: true });

      if (result?.status === "error") {
        surface.reportError("running the tool turn", new Error(result.error || "the tool turn failed"));
        return "failed";
      }

      // A stop is its own ended state, never a silent completion: the user asked
      // for it, no further calls executed, and the submission series reports it.
      if (result?.status === "stopped") {
        surface.setStatus("Stopped: the tool turn ended at your stop request.");
        surface.render();
        return "stopped";
      }

      const answer = String(result?.answer || "").trim();

      if (answer) {
        surface.showCompactAssistantReplyBubble(answer, {
          messageId: tailEntries[tailEntries.length - 1]?.id || ""
        });
      } else {
        surface.setStatus(result?.status === "iteration-cap" ? "Stopped: the tool turn hit its iteration limit." : "The tool turn produced no answer.");
      }

      surface.render();
      return "complete";
    }
  };

  return driver;
}
