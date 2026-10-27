// Smart grouping for a run of typed tool calls (chat-surface polish, owner-approved).
//
// A run of tool calls used to draw one row per call, so a ten-call turn read as ten
// stacked cards. The grouping rule is DERIVED FROM THE STORED ENTRY SEQUENCE, never
// from narration and never from a heuristic about what the prose "looks like": a run
// starts at a typed call entry, keeps taking typed entries, and ends where the next
// announcement begins (a call entry that follows a result entry).
//
// The exclusions are load-bearing and deliberately live in ONE place:
//   - a HELD call is a consent affordance. Grouping it (or its result) behind a
//     summary row would hide the thing the human has to answer, so both its call row
//     and its result row stay individually visible.
//   - a DEFERRED call is the unanswered sibling of a held call; it belongs to the
//     same consent episode and stays visible with it.
//   - provisional chips are the running state itself.
//
// That rule needs to look at the WHOLE list: calls precede their results, so a held
// result can only be recognised at its own later index. `collectWithheldCallIds` does
// that one scan and every decision below reads it, so no branch has to guess.
//
// This module is pure: it reads display projections (`typedTool`, `typedToolOutcome`
// marks written by the shared history reader) and returns plain data. It never
// touches the DOM, so the grouping contract is assertable without a browser.

export const TOOL_RUN_GROUP_TYPE = "tool-run";

// Closed set: the outcomes that must never be hidden inside a summary.
export const TOOL_RUN_EXCLUDED_OUTCOMES = Object.freeze(["held", "deferred"]);

export function isToolRunEntry(entry) {
  return entry?.typedTool === "call" || entry?.typedTool === "result";
}

export function isToolRunExcludedEntry(entry) {
  return (
    entry?.provisional === true ||
    TOOL_RUN_EXCLUDED_OUTCOMES.includes(String(entry?.typedToolOutcome || ""))
  );
}

// Call ids whose result is a consent episode (held or deferred). Both the call row and
// the withholding result row stay out of every run.
export function collectWithheldCallIds(history) {
  const withheld = new Set();

  (Array.isArray(history) ? history : []).forEach((entry) => {
    if (entry?.typedTool !== "result" || !isToolRunExcludedEntry(entry)) {
      return;
    }

    const callId = String(entry?.typedToolCallId || "");

    if (callId) {
      withheld.add(callId);
    }
  });

  return withheld;
}

function isWithheldEntry(entry, withheldCallIds) {
  const callId = String(entry?.typedToolCallId || "");

  return Boolean(callId) && withheldCallIds instanceof Set && withheldCallIds.has(callId);
}

// One announcement's entries, starting at `startIndex`.
//
// Returns `null` when the entry at `startIndex` cannot start a run: not typed, a
// provisional chip, a consent-episode entry, or an orphan result with no call.
//
// WITHHELD BLOCKS ARE NOT GROUPED AT ALL, and that is deliberate. A run's calls and
// their results are contiguous, but a held call sits in the CALLS half while its own
// result sits in the RESULTS half. Grouping only the calls before it would leave the
// collected calls without their results, so they would summarize as `running` forever —
// a claim about work that already finished. Splitting the block around the held call
// would instead reorder rows the user watched. So the whole block stays individual and
// in stored order: the consent affordance is visible, and no call is described wrongly.
// Held turns are rare and the honesty rule wins over collapsing them.
export function collectToolRun(history, startIndex = 0, options = {}) {
  const list = Array.isArray(history) ? history : [];
  const withheldCallIds =
    options.withheldCallIds instanceof Set ? options.withheldCallIds : collectWithheldCallIds(list);
  const first = list[startIndex];

  if (!isToolRunEntry(first) || isToolRunExcludedEntry(first) || first.typedTool !== "call") {
    return null;
  }

  const entries = [first];
  let sawResult = false;
  let index = startIndex + 1;

  while (index < list.length) {
    const entry = list[index];

    if (!isToolRunEntry(entry) || isToolRunExcludedEntry(entry)) {
      break;
    }

    // A call AFTER a result is the next announcement, not a continuation of this
    // one. This is what keeps two narrationless iterations as two rows.
    if (entry.typedTool === "call" && sawResult) {
      break;
    }

    if (entry.typedTool === "result") {
      sawResult = true;
    }

    entries.push(entry);
    index += 1;
  }

  // Consent episodes keep their whole block individual (see the note above).
  const containsWithheld = entries.some((entry) => isWithheldEntry(entry, withheldCallIds));

  if (containsWithheld) {
    return null;
  }

  return { endIndex: index - 1, entries };
}

// Counts per CALL, not per entry: a call plus its result is one call, not two.
// A call with no result yet is `running`; that is the only honest word for it, and
// while the turn is live it is usually true. A settled run has no `running` calls,
// because its calls all carry results by then.
export function summarizeToolRun(entries) {
  const calls = [];
  const byCallId = new Map();

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    if (entry?.typedTool === "call") {
      const record = {
        callId: String(entry?.typedToolCallId || ""),
        id: String(entry?.id || ""),
        name: String(entry?.typedToolName || ""),
        outcome: "running"
      };

      calls.push(record);

      if (record.callId) {
        byCallId.set(record.callId, record);
      }

      return;
    }

    if (entry?.typedTool === "result") {
      const record = byCallId.get(String(entry?.typedToolCallId || ""));

      if (record) {
        record.outcome = String(entry?.typedToolOutcome || "success");
      }
    }
  });

  return {
    calls,
    failed: calls.filter((call) => call.outcome === "error").length,
    running: calls.filter((call) => call.outcome === "running").length,
    succeeded: calls.filter((call) => call.outcome === "success").length,
    total: calls.length
  };
}

// The summary line, e.g. `5 tool calls · 3 succeeded · 2 failed`. Parts that are zero
// are omitted so a clean run reads plainly instead of as a ledger.
export function formatToolRunLabel(summary) {
  const total = Math.max(0, Number(summary?.total) || 0);
  const succeeded = Math.max(0, Number(summary?.succeeded) || 0);
  const failed = Math.max(0, Number(summary?.failed) || 0);
  const running = Math.max(0, Number(summary?.running) || 0);
  const parts = [`${total} tool call${total === 1 ? "" : "s"}`];

  if (succeeded) {
    parts.push(`${succeeded} succeeded`);
  }

  if (failed) {
    parts.push(`${failed} failed`);
  }

  if (running) {
    parts.push(`${running} running`);
  }

  return parts.join(" · ");
}

// Stable identity for one run, so an expanded card survives a re-render: the row is
// rebuilt (its render signature changes as results land) but its open state is
// remembered against this key rather than against a DOM node that no longer exists.
export function toolRunKey(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const first = String(list[0]?.id || "");
  const last = String(list[list.length - 1]?.id || "");

  return `${TOOL_RUN_GROUP_TYPE}:${first}|${last}`;
}

// Expanded state for run cards. Kept OUTSIDE the DOM on purpose: the thread view
// replaces rows, so a `<details open>` boolean living only on a node would be lost
// on the next patch.
export function createToolRunOpenState() {
  const openKeys = new Set();

  return {
    isOpen(key) {
      return openKeys.has(String(key || ""));
    },
    setOpen(key, value) {
      const normalized = String(key || "");

      if (!normalized) {
        return;
      }

      if (value) {
        openKeys.add(normalized);
      } else {
        openKeys.delete(normalized);
      }
    },
    size() {
      return openKeys.size;
    }
  };
}
