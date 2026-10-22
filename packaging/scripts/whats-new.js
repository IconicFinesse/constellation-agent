#!/usr/bin/env node

// Regenerate the README "What's new" block from git history.
//
// Groups commits since the fork baseline into their release tag, drops
// documentation/test/merge noise, dedupes by subject, and rewrites the region
// between the WHATS-NEW markers in README.md.
//
// Usage:
//   node packaging/scripts/whats-new.js           # rewrite README.md in place
//   node packaging/scripts/whats-new.js --check   # exit 1 if README is stale

const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const README = path.join(ROOT, "README.md");
const BASELINE_TAG = "baseline-2026-06-08";
const START = "<!-- WHATS-NEW:START -->";
const END = "<!-- WHATS-NEW:END -->";
const RECENT_RELEASES = 2;
const MAX_ITEMS_PER_RELEASE = 8;

// Subjects that describe process rather than product. These would otherwise
// dominate a block that readers treat as a feature list.
const NOISE = [
  /^docs?\b/iu,
  /^document\b/iu,
  /^track\b/iu,
  /^tests?\b/iu,
  /^test:/iu,
  /^chore\b/iu,
  /^repair\b/iu,
  /^ci\b/iu,
  /^build\b/iu,
  /^style\b/iu,
  /^merge\b/iu,
  /^revert\b/iu,
  /rebrand/iu,
];

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function hasBaseline() {
  try {
    git(["rev-parse", "--verify", `refs/tags/${BASELINE_TAG}`]);
    return true;
  } catch {
    return false;
  }
}

// Fork release tags in creation order, each resolved to its own commit.
// A tag is included only when it sits ahead of the fork baseline.
function releaseTags() {
  const baseline = git(["rev-parse", BASELINE_TAG]);
  const listed = git(["tag", "--list", "v*-fork.*", "--sort=creatordate"]);
  if (!listed) return [];

  const tags = [];
  for (const name of listed.split("\n")) {
    const tag = name.trim();
    if (!tag) continue;
    let commit;
    try {
      commit = git(["rev-list", "-n", "1", tag]);
    } catch {
      continue;
    }
    if (commit === baseline) continue;
    tags.push({ tag, commit });
  }
  return tags;
}

function subjectsIn(from, to) {
  try {
    const out = git(["log", "--no-merges", "--format=%s", `${from}..${to}`]);
    return out ? out.split("\n") : [];
  } catch {
    return [];
  }
}

function classify(subject) {
  const trimmed = subject.trim();
  if (!trimmed) return null;
  if (NOISE.some((pattern) => pattern.test(trimmed))) return null;

  const refs = new Set();
  for (const match of trimmed.matchAll(/#(\d+)/gu)) refs.add(`#${match[1]}`);

  let text = trimmed
    .replace(/^[a-z][\w-]*(\([^)]*\))?:\s*/u, "")
    .replace(/\s*\(#\d+\)/gu, "")
    .replace(/\s*\(PR #\d+\).*$/u, "")
    .replace(/\s+—\s+.*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (text.length < 10) return null;
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return { text, refs: [...refs] };
}

function entriesFor(from, to) {
  const seen = new Set();
  const entries = [];
  for (const subject of subjectsIn(from, to)) {
    const entry = classify(subject);
    if (!entry) continue;
    const key = entry.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries.slice(0, MAX_ITEMS_PER_RELEASE);
}

function bullets(entries) {
  return entries.map((entry) => {
    const refs = entry.refs.length ? ` (${entry.refs.join(", ")})` : "";
    return `- ${entry.text}${refs}`;
  });
}

function buildBlock() {
  if (!hasBaseline()) {
    return [
      START,
      `_Baseline tag \`${BASELINE_TAG}\` is missing, so this block cannot be generated._`,
      END,
    ].join("\n");
  }

  const all = releaseTags();
  if (!all.length) {
    return [START, "_No tagged releases beyond the fork baseline yet._", END].join("\n");
  }

  const recent = all.slice(-RECENT_RELEASES);
  const firstIndex = all.length - recent.length;
  let previous = firstIndex > 0 ? all[firstIndex - 1].commit : BASELINE_TAG;

  const lines = [START, ""];

  for (const { tag, commit } of recent) {
    const entries = entriesFor(previous, commit);
    previous = commit;
    if (!entries.length) continue;
    lines.push(`**\`${tag}\`**`, "", ...bullets(entries), "");
  }

  const head = git(["rev-parse", "HEAD"]);
  if (previous !== head) {
    const entries = entriesFor(previous, head);
    if (entries.length) lines.push("**Unreleased**", "", ...bullets(entries), "");
  }

  lines.push(
    "_Newest releases only. The full per-release record lives in [\`ROADMAP.md\`](./ROADMAP.md). " +
      `Generated from \`${BASELINE_TAG}..HEAD\` by \`packaging/scripts/whats-new.js\`._`,
    END,
  );
  return lines.join("\n");
}

function main() {
  const check = process.argv.includes("--check");
  const source = readFileSync(README, "utf8");
  const start = source.indexOf(START);
  const end = source.indexOf(END);

  if (start === -1 || end === -1 || end < start) {
    console.error(`README.md is missing the ${START} / ${END} markers.`);
    process.exit(2);
  }

  const block = buildBlock();
  const updated = source.slice(0, start) + block + source.slice(end + END.length);

  if (check) {
    if (updated !== source) {
      console.error("README What's-new block is stale. Run: node packaging/scripts/whats-new.js");
      process.exit(1);
    }
    console.log("README What's-new block is current.");
    return;
  }

  if (updated === source) {
    console.log("README What's-new block already current; nothing written.");
    return;
  }

  writeFileSync(README, updated);
  console.log("Updated the README What's-new block from git history.");
}

main();
