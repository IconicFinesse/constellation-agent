// THE CACHE-PREFIX DIGEST (P5-1).
//
// Provider-side proof is not engine-side proof. A live probe showed both target
// providers serve an implicit prefix cache (7,424 of 7,538 tokens on a second
// identical-prefix call), but that only proves the PROVIDER caches a stable prefix.
// It says nothing about whether THIS engine keeps its prefix stable across a real
// tool turn. This module turns that belief into a measurement.
//
// What is digested is the cache-relevant prefix of one outbound request:
//
//   system  the system message content (what the surface assembled, after shaping)
//   tools   the serialized visible tool list (names, order, schemas)
//   head    the NON-system messages that form the shared prefix
//
// `headLength` is the bound, and it is load-bearing. A tool turn APPENDS to its
// message list by design, so a digest over "all messages" would change every
// iteration and prove nothing. The digest therefore covers the session's opening
// messages -- the part every later turn re-sends verbatim -- and the length it used
// is reported beside the digest so the bound is inspectable rather than implied.
//
// Deterministic and cheap: one canonical serialization through the SAME
// `stableStringify` the artifact contract uses (recursively key-sorted, so JSON key
// order cannot make two identical prefixes hash differently) and the SAME FNV-1a
// implementation the assembled-list hash uses (one copy tree-wide).
//
// Secret-free BY CONSTRUCTION: this function accepts messages and tools only. It
// has no access to settings, headers, API keys or the endpoint, so a secret cannot
// reach the digest input even by a later refactor that hands them to the caller.
//
// The component digests are not decoration: when the composite moves, the log line
// can say WHICH part moved (a reordered tool list and an edited earlier message are
// very different bugs), and a test can pin each perturbation to its own component.

import { stableStringify } from "./shadow-normalize.js";
import { hashCanonicalText } from "./tool-registry.js";

export const PREFIX_DIGEST_VERSION = "prefix-digest/1";

function messageText(message) {
  const content = message?.content;

  return typeof content === "string" ? content : stableStringify(content ?? "");
}

// The system content of the head, in order. A prepared conversation can carry the
// system message first; a session built from `history + systemPrompt` does the
// same. Reading it out of the messages (rather than taking a second `systemPrompt`
// argument) means the digest describes what is actually SENT -- there is no way for
// the caller's idea of the prompt to disagree with the wire.
function systemTextOf(head) {
  return head
    .filter((message) => String(message?.role || "") === "system")
    .map((message) => messageText(message))
    .join("\n\u0000\n");
}

function nonSystemHeadOf(head) {
  return head.filter((message) => String(message?.role || "") !== "system");
}

function boundedHeadLength(messages, headLength) {
  const total = Array.isArray(messages) ? messages.length : 0;
  const requested = Number.isFinite(headLength) ? Math.floor(headLength) : total;

  return Math.max(0, Math.min(total, requested));
}

// One digest for one outbound turn.
//
// `messages` is the list the transport is about to send; `headLength` is the size
// of the shared prefix (the session's opening messages). Anything the loop appended
// beyond that bound is deliberately EXCLUDED -- it is the growing tail, not the
// prefix, and including it would make every iteration "unstable" while the provider
// still served a hit.
export function computePrefixDigest({ headLength = 0, messages = [], tools = [] } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const bound = boundedHeadLength(list, headLength);
  const head = list.slice(0, bound);
  const systemText = systemTextOf(head);
  const headMessages = nonSystemHeadOf(head);
  const toolText = stableStringify(Array.isArray(tools) ? tools : []);
  const headText = stableStringify(headMessages);

  const systemDigest = hashCanonicalText(`${PREFIX_DIGEST_VERSION}\nsystem:\n${systemText}`);
  const toolsDigest = hashCanonicalText(`${PREFIX_DIGEST_VERSION}\ntools:\n${toolText}`);
  const headDigest = hashCanonicalText(`${PREFIX_DIGEST_VERSION}\nhead:\n${headText}`);

  // The composite is a hash of the three COMPONENT DIGESTS, not a re-serialization
  // of the raw sections: one derivation of each part, composed once.
  const digest = hashCanonicalText(
    [PREFIX_DIGEST_VERSION, systemDigest, toolsDigest, headDigest].join("\n")
  );

  return Object.freeze({
    digest,
    headDigest,
    headLength: bound,
    headMessages: headMessages.length,
    systemChars: systemText.length,
    systemDigest,
    toolCount: Array.isArray(tools) ? tools.length : 0,
    toolsDigest,
    version: PREFIX_DIGEST_VERSION
  });
}

// One line, stable order, for the per-turn log. Reported beside the cache numbers
// so a stale cache is visible as "digest moved" rather than as a mystery miss.
export function formatPrefixDigestLine(digestInfo) {
  if (!digestInfo || !digestInfo.digest) {
    return "[engine-swap] prefix digest=unknown";
  }

  return (
    `[engine-swap] prefix digest=${digestInfo.digest} head=${digestInfo.headLength}` +
    ` system=${digestInfo.systemDigest} tools=${digestInfo.toolsDigest}(${digestInfo.toolCount})` +
    ` headpart=${digestInfo.headDigest}`
  );
}
