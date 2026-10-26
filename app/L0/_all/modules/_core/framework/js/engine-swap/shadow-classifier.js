// Shadow-diff classification for the P1 gate (contract: ca.shadow-diff/1).
//
// The closed enum has nine classes: five non-failing (`match`, `split`,
// `merge`, `fallback-run-code`, `suppressed-display`) and four failing
// (`unmapped`, `order-divergence`, `extra-call`, `missing-call`). The gate
// passes iff all four failing classes are zero, and counts are always reported
// in full — classification is named buckets with totals, never a narrative.
//
// Display detection does NOT re-implement fence parsing: the BUG-007 lesson is
// that a second copy of extraction logic diverges from the first. Every display
// question here delegates to the shared `execution-blocks.js` classifier that
// both agent surfaces already use.

import {
  collectExecutionFenceRegions,
  hasExecutableExecutionSeparator
} from "../execution-blocks.js";

export const SHADOW_DIFF_FORMAT = "ca.shadow-diff/1";

export const DIFF_CLASS = Object.freeze({
  EXTRA_CALL: "extra-call",
  FALLBACK_RUN_CODE: "fallback-run-code",
  MATCH: "match",
  MERGE: "merge",
  MISSING_CALL: "missing-call",
  ORDER_DIVERGENCE: "order-divergence",
  SPLIT: "split",
  SUPPRESSED_DISPLAY: "suppressed-display",
  UNMAPPED: "unmapped"
});

export const FAILING_DIFF_CLASSES = Object.freeze([
  DIFF_CLASS.UNMAPPED,
  DIFF_CLASS.ORDER_DIVERGENCE,
  DIFF_CLASS.EXTRA_CALL,
  DIFF_CLASS.MISSING_CALL
]);

export const NON_FAILING_DIFF_CLASSES = Object.freeze([
  DIFF_CLASS.MATCH,
  DIFF_CLASS.SPLIT,
  DIFF_CLASS.MERGE,
  DIFF_CLASS.FALLBACK_RUN_CODE,
  DIFF_CLASS.SUPPRESSED_DISPLAY
]);

export const ALL_DIFF_CLASSES = Object.freeze([...NON_FAILING_DIFF_CLASSES, ...FAILING_DIFF_CLASSES]);

// The execution separator is owned by each agent surface, not by this shared
// layer, so it is injected. The default mirrors the onscreen separator and
// exists only so a caller that has no surface constant still classifies
// display-only replies correctly.
export const DEFAULT_EXECUTION_SEPARATOR = "_____javascript";

export function createEmptyClassCounts() {
  const counts = {};

  ALL_DIFF_CLASSES.forEach((className) => {
    counts[className] = 0;
  });

  return counts;
}

function normalizeText(value) {
  return value === undefined || value === null ? "" : String(value);
}

function isRunCodeTool(tool) {
  return normalizeText(tool).trim() === "run_code";
}

// A reply is display-only when it carries fenced regions, no executable
// separator outside those fences, and nothing was executed. This is exactly the
// BUG-007 shape: showing code must never look like running it.
export function isDisplayOnlyReply(content, { executedBlockCount = 0, separator = DEFAULT_EXECUTION_SEPARATOR } = {}) {
  if (executedBlockCount > 0) {
    return false;
  }

  const text = normalizeText(content);

  if (!text) {
    return false;
  }

  if (hasExecutableExecutionSeparator(text, separator)) {
    return false;
  }

  return collectExecutionFenceRegions(text).length > 0;
}

function makeDiff({ className, note = "", tier1Seq = null, tier3Seq = null }) {
  return {
    class: className,
    note,
    tier1_seq: tier1Seq,
    tier3_seq: tier3Seq
  };
}

function groupByBlockSeq({ tier1Calls = [], tier3Blocks = [] } = {}) {
  const blockSeqs = tier3Blocks.map((block) => block.seq);
  const groups = new Map(blockSeqs.map((seq) => [seq, []]));
  const orphans = [];

  tier1Calls.forEach((call) => {
    const sourceSeq = call.sourceBlockSeq;

    if (sourceSeq !== null && sourceSeq !== undefined && groups.has(sourceSeq)) {
      groups.get(sourceSeq).push(call);
    } else {
      orphans.push(call);
    }
  });

  return { groups, orphans };
}

// Classifies one compared turn. Pure: no clocks, no I/O, no randomness.
//
// Mapping rule: every Tier 1 call records the Tier 3 block sequence it was
// assembled from. A block with no calls and no display evidence is a genuine
// missing-call; a block whose calls disagree in position is order-divergence.
export function classifyShadowTurn({
  replyContent = "",
  separator = DEFAULT_EXECUTION_SEPARATOR,
  tier1Calls = [],
  tier3Blocks = []
} = {}) {
  const diffs = [];
  const blocks = Array.isArray(tier3Blocks) ? [...tier3Blocks] : [];
  const calls = Array.isArray(tier1Calls) ? [...tier1Calls] : [];
  const displayOnly = isDisplayOnlyReply(replyContent, {
    executedBlockCount: blocks.length,
    separator
  });
  const { groups, orphans } = groupByBlockSeq({ tier1Calls: calls, tier3Blocks: blocks });

  // A fenced show-me-code reply executes nothing, so it has no blocks to walk.
  // The turn itself is the suppressed-display evidence, and it is still counted.
  if (displayOnly && !blocks.length) {
    diffs.push(
      makeDiff({
        className: DIFF_CLASS.SUPPRESSED_DISPLAY,
        note: "fenced display executed nothing; shadow assembled nothing"
      })
    );
  }

  orphans.forEach((call) => {
    // An assembled call whose tool is not in the registry is a registry gap, not
    // a shadow mismatch: `unmapped` names it so it can never hide inside
    // extra-call noise.
    diffs.push(
      makeDiff({
        className: call.registered === false ? DIFF_CLASS.UNMAPPED : DIFF_CLASS.EXTRA_CALL,
        note:
          call.registered === false
            ? `assembled tool is not in the registry: ${call.tool}`
            : "assembled call has no originating executed block",
        tier1Seq: call.seq
      })
    );
  });

  // n -> 1: one call that names several executed blocks as its source. Merging
  // is checked before the per-block walk because the walk would otherwise
  // report the same call as extra-call plus missing-call on every block.
  const mergedCall =
    blocks.length > 1 && calls.length === 1 && blocks.every((block) => calls[0].mergedFromBlockSeqs?.includes(block.seq))
      ? calls[0]
      : null;

  if (mergedCall) {
    diffs.push(
      makeDiff({
        className: DIFF_CLASS.MERGE,
        note: `${blocks.length} blocks -> 1 call`,
        tier1Seq: mergedCall.seq,
        tier3Seq: blocks[0].seq
      })
    );

    return Object.freeze({ diffs, displayOnly });
  }

  let lastTier1Seq = -1;

  blocks.forEach((block) => {
    const allBlockCalls = (groups.get(block.seq) || []).slice().sort((left, right) => left.seq - right.seq);

    // An assembled call whose tool is not in the registry is a registry gap. It
    // is named `unmapped` even when it maps cleanly to a block, because a
    // 1-block-1-unknown-tool turn is not a match and must not pass the gate.
    const unregisteredCalls = allBlockCalls.filter((call) => call.registered === false);

    unregisteredCalls.forEach((call) => {
      diffs.push(
        makeDiff({
          className: DIFF_CLASS.UNMAPPED,
          note: `assembled tool is not in the registry: ${call.tool}`,
          tier1Seq: call.seq,
          tier3Seq: block.seq
        })
      );
    });

    const blockCalls = allBlockCalls.filter((call) => call.registered !== false);

    if (!allBlockCalls.length) {
      // An executed block with nothing assembled is a genuine gap. Suppressed
      // display is decided at the turn level above, because a display-only reply
      // has no executed blocks by definition.
      diffs.push(
        makeDiff({
          className: DIFF_CLASS.MISSING_CALL,
          note: "executed block produced no Tier 1 call",
          tier3Seq: block.seq
        })
      );
      return;
    }

    if (!blockCalls.length) {
      // Every assembled call for this block was unregistered; `unmapped` above is
      // the whole story, so no second class is invented for the same evidence.
      return;
    }

    // Order: blocks map in ascending order to ascending call sequences. A call
    // reaching back before the previous block's calls is a genuine divergence.
    const firstCallSeq = blockCalls[0].seq;
    const outOfOrder = firstCallSeq < lastTier1Seq;

    lastTier1Seq = Math.max(lastTier1Seq, ...blockCalls.map((call) => call.seq));

    if (outOfOrder) {
      diffs.push(
        makeDiff({
          className: DIFF_CLASS.ORDER_DIVERGENCE,
          note: "block maps to calls positioned before the previous block's calls",
          tier1Seq: firstCallSeq,
          tier3Seq: block.seq
        })
      );
      return;
    }

    if (blockCalls.every((call) => isRunCodeTool(call.tool))) {
      blockCalls.forEach((call) => {
        diffs.push(
          makeDiff({
            className: DIFF_CLASS.FALLBACK_RUN_CODE,
            note: "block maps to run_code — expected and counted, never a failure",
            tier1Seq: call.seq,
            tier3Seq: block.seq
          })
        );
      });
      return;
    }

    const blockCount = 1;
    const callCount = blockCalls.length;

    if (blockCount === 1 && callCount === 1) {
      diffs.push(
        makeDiff({
          className: DIFF_CLASS.MATCH,
          note: "",
          tier1Seq: blockCalls[0].seq,
          tier3Seq: block.seq
        })
      );
      return;
    }

    // 1 -> n. Every call is counted so `calls` totals stay honest.
    blockCalls.forEach((call) => {
      diffs.push(
        makeDiff({
          className: DIFF_CLASS.SPLIT,
          note: `1 block -> ${callCount} calls`,
          tier1Seq: call.seq,
          tier3Seq: block.seq
        })
      );
    });
  });

  return Object.freeze({
    diffs,
    displayOnly
  });
}

export function countDiffsByClass(diffs) {
  const counts = createEmptyClassCounts();

  (Array.isArray(diffs) ? diffs : []).forEach((diff) => {
    const className = normalizeText(diff?.class).trim();

    if (Object.prototype.hasOwnProperty.call(counts, className)) {
      counts[className] += 1;
    }
  });

  return counts;
}

export function countFailingDiffs(counts) {
  return FAILING_DIFF_CLASSES.reduce(
    (total, className) => total + Number(counts?.[className] || 0),
    0
  );
}

export function decideShadowVerdict(counts) {
  return countFailingDiffs(counts) === 0 ? "pass" : "fail";
}
