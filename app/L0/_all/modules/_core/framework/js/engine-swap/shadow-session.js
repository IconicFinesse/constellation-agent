// Shadow-diff session and artifact emission (contract: ca.shadow-diff/1).
//
// P1 runs Tier 3 exactly as today and, in shadow mode only, records what Tier 1
// would have sent beside what Tier 3 actually executed. The three artifacts are
// the gate's shared surface with the lab:
//
//   manifest.json  one per run
//   sessions.jsonl one line per assistant turn compared
//   summary.json   one per run — this is the gate
//
// Shapes are fixed by the addendum. Normalization is delegated to
// shadow-normalize.js so build side and lab side cannot drift, and display
// classification is delegated to shadow-classifier.js so the fence contract is
// read from one place.
//
// This module performs no I/O of its own: a caller supplies an `emit` sink (the
// documented seam) and owns where bytes land.

import {
  fingerprintCode,
  fingerprintToolArguments,
  normalizeToolArguments,
  redactArtifactArguments
} from "./shadow-normalize.js";
import {
  classifyShadowTurn,
  countDiffsByClass,
  decideShadowVerdict,
  SHADOW_DIFF_FORMAT
} from "./shadow-classifier.js";

export const SHADOW_ARTIFACT_FILES = Object.freeze({
  MANIFEST: "manifest.json",
  SESSIONS: "sessions.jsonl",
  SUMMARY: "summary.json"
});

export const SHADOW_SURFACE = Object.freeze({
  ADMIN: "admin",
  ONSCREEN: "onscreen"
});

function normalizeText(value) {
  return value === undefined || value === null ? "" : String(value);
}

function isoNow(now) {
  const date = typeof now === "function" ? now() : now instanceof Date ? now : new Date();
  return date.toISOString();
}

function blockRecord(block) {
  return {
    code: normalizeText(block?.code),
    fenced: block?.fenced === true,
    seq: Number(block?.seq) || 0
  };
}

function callRecord(call) {
  return {
    arguments: call?.arguments && typeof call.arguments === "object" ? call.arguments : {},
    mergedFromBlockSeqs: Array.isArray(call?.mergedFromBlockSeqs) ? call.mergedFromBlockSeqs : undefined,
    registered: call?.registered !== false,
    seq: Number(call?.seq) || 0,
    sourceBlockSeq: Number.isFinite(Number(call?.sourceBlockSeq)) ? Number(call.sourceBlockSeq) : null,
    tool: normalizeText(call?.tool).trim()
  };
}

async function buildTier3ArtifactBlocks(blocks, options) {
  const artifactBlocks = [];

  for (const block of blocks) {
    const normalized = blockRecord(block);
    const fingerprint = await fingerprintCode(normalized.code, options);

    artifactBlocks.push({
      code_sha: fingerprint.code_sha,
      fenced: normalized.fenced,
      first_line: fingerprint.first_line,
      seq: normalized.seq
    });
  }

  return artifactBlocks;
}

async function buildTier1ArtifactCalls(calls, { username, ...options } = {}) {
  const artifactCalls = [];

  for (const call of calls) {
    const normalized = callRecord(call);
    const collapsedArgs = normalizeToolArguments(normalized.arguments, { username });
    const normalizedArgs = await redactArtifactArguments(collapsedArgs, options);

    artifactCalls.push({
      args_normalized: normalizedArgs,
      args_sha: await fingerprintToolArguments(normalizedArgs, options),
      seq: normalized.seq,
      tool: normalized.tool
    });
  }

  return artifactCalls;
}

function buildMapping(diffs) {
  const byTier3 = new Map();

  diffs.forEach((diff) => {
    if (diff.tier3_seq === null || diff.tier3_seq === undefined) {
      return;
    }

    if (!byTier3.has(diff.tier3_seq)) {
      byTier3.set(diff.tier3_seq, []);
    }

    if (diff.tier1_seq !== null && diff.tier1_seq !== undefined) {
      byTier3.get(diff.tier3_seq).push(diff.tier1_seq);
    }
  });

  return [...byTier3.keys()]
    .sort((left, right) => left - right)
    .map((tier3Seq) => ({ tier1_seqs: [...new Set(byTier3.get(tier3Seq))].sort((left, right) => left - right), tier3_seq: tier3Seq }));
}

function turnArtifactLine({ diffs, sessionId, tier1Calls, tier3Blocks, turnIndex }) {
  return {
    diffs,
    mapping: buildMapping(diffs),
    session_id: sessionId,
    tier1_calls: tier1Calls,
    tier3_blocks: tier3Blocks,
    turn_index: turnIndex
  };
}

// A shadow session collects compared turns for one run and renders the three
// artifacts on demand. Every method is pure with respect to its inputs; nothing
// here reads the clock implicitly when `now` is supplied.
export function createShadowSession({
  appCommit = "",
  appVersion = "",
  configId = "",
  digest,
  now = () => new Date(),
  runId = "",
  startedAt = "",
  suite = "",
  surface = SHADOW_SURFACE.ONSCREEN
} = {}) {
  const turns = [];
  const sessionStartedAt = startedAt || isoNow(now);
  const resolvedRunId = String(runId || "").trim() || `p1-${sessionStartedAt.replace(/[:.]/gu, "-")}`;
  const fingerprintOptions = digest ? { digest } : {};

  return Object.freeze({
    summaryFormat: SHADOW_DIFF_FORMAT,
    runId: resolvedRunId,
    // Records one compared assistant turn.
    async recordTurn({
      replyContent = "",
      separator,
      sessionId = "s-",
      tier1Calls = [],
      tier3Blocks = [],
      turnIndex = turns.length,
      username = ""
    } = {}) {
      const blocks = Array.isArray(tier3Blocks) ? tier3Blocks.map((block) => blockRecord(block)) : [];
      const calls = Array.isArray(tier1Calls) ? tier1Calls.map((call) => callRecord(call)) : [];
      const classified = classifyShadowTurn({
        replyContent,
        ...(separator ? { separator } : {}),
        tier1Calls: calls,
        tier3Blocks: blocks
      });
      const artifactBlocks = await buildTier3ArtifactBlocks(blocks, fingerprintOptions);
      const artifactCalls = await buildTier1ArtifactCalls(calls, { username, ...fingerprintOptions });
      const line = turnArtifactLine({
        diffs: classified.diffs,
        sessionId: normalizeText(sessionId).trim() || "s-",
        tier1Calls: artifactCalls,
        tier3Blocks: artifactBlocks,
        turnIndex: Number(turnIndex) || 0
      });

      turns.push(line);
      return line;
    },
    get turnCount() {
      return turns.length;
    },
    buildManifest() {
      return {
        app_commit: normalizeText(appCommit),
        app_version: normalizeText(appVersion),
        config_id: normalizeText(configId),
        format: SHADOW_DIFF_FORMAT,
        run_id: resolvedRunId,
        started_at: sessionStartedAt,
        suite: normalizeText(suite),
        surface: surface === SHADOW_SURFACE.ADMIN ? SHADOW_SURFACE.ADMIN : SHADOW_SURFACE.ONSCREEN
      };
    },
    buildSessionLines() {
      return turns.map((line) => JSON.stringify(line));
    },
    buildSummary() {
      const allDiffs = turns.flatMap((line) => line.diffs);
      const byClass = countDiffsByClass(allDiffs);

      return {
        blocks: turns.reduce((total, line) => total + line.tier3_blocks.length, 0),
        by_class: byClass,
        calls: turns.reduce((total, line) => total + line.tier1_calls.length, 0),
        format: SHADOW_DIFF_FORMAT,
        run_id: resolvedRunId,
        turns: turns.length,
        verdict: decideShadowVerdict(byClass)
      };
    },
    // The documented emission seam. `emit` receives the artifact file name and
    // its exact bytes; the caller decides where they land (a lab harness in
    // memory, or app-file writes beside a build-side test run).
    async emit(emitHandler) {
      if (typeof emitHandler !== "function") {
        throw new Error("A shadow artifact emit handler is required.");
      }

      const manifest = this.buildManifest();
      const summary = this.buildSummary();
      const sessionText = this.buildSessionLines().join("\n");

      await emitHandler({ name: SHADOW_ARTIFACT_FILES.MANIFEST, text: `${JSON.stringify(manifest, null, 2)}\n` });
      await emitHandler({ name: SHADOW_ARTIFACT_FILES.SESSIONS, text: sessionText ? `${sessionText}\n` : "" });
      await emitHandler({ name: SHADOW_ARTIFACT_FILES.SUMMARY, text: `${JSON.stringify(summary, null, 2)}\n` });

      return { manifest, summary };
    },
    buildArtifacts() {
      return {
        manifest: this.buildManifest(),
        sessions: this.buildSessionLines(),
        summary: this.buildSummary()
      };
    }
  });
}
