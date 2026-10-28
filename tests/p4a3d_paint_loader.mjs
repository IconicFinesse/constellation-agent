// TEST-ONLY module loader for the P4a-3d render-projection suite.
//
// It does two things, and both exist because the brief demands PROOF rather than an
// assertion that could be satisfied by a lookalike:
//
//   1. It maps `/modules/...` specifiers the way `mod_specifier_loader.mjs` does, so the
//      suite can import product modules by their real product paths.
//
//   2. It swaps TWO product modules for data-URL wrappers around the real thing:
//
//      - `framework/js/engine-swap/chat-projection.js`. The wrapper delegates to the real
//        module and TAGS every array it returns. Admin's painted history must carry that
//        tag. A surface-local copy of the projection cannot produce it, so the tag is the
//        difference between `one painter` and `two painters that happen to agree today`
//        — which is exactly what the brief says an assertion cannot distinguish.
//
//      - `admin/views/agent/view.js`. The wrapper replaces `renderMessages` with a
//        recorder, so the suite observes the (thread, history, options) triple that
//        admin's REAL `render()` hands the renderer. The recorded history is then fed to
//        the REAL `buildMessageDisplayGroups`, so grouping is judged by the same code the
//        product runs rather than by a restatement of its rules.
//
// The real modules are re-imported with a `?p4a3d-real` query so they resolve to a
// distinct URL and cannot be re-mapped by this loader into a loop.

const MOD_SPECIFIER_PREFIX = "/modules/";
const APP_L0_ALL_DIR = new URL("../app/L0/_all/", import.meta.url);

const PROJECTION_URL = new URL(
  "modules/_core/framework/js/engine-swap/chat-projection.js",
  APP_L0_ALL_DIR
).href;
const ADMIN_VIEW_URL = new URL("modules/_core/admin/views/agent/view.js", APP_L0_ALL_DIR).href;

// BASE64, not percent-encoding. A data-URL module is decoded before it is parsed, so any
// character the encoder leaves literal (`(`, `)`, `'`) still has to survive that decode;
// base64 removes the question entirely and keeps the wrapper URLs stable, which is what
// makes two imports of the same wrapper the SAME module instance.
function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

const REAL_PROJECTION = JSON.stringify(PROJECTION_URL + "?p4a3d-real");
const REAL_ADMIN_VIEW = JSON.stringify(ADMIN_VIEW_URL + "?p4a3d-real");

// Plain concatenation, not a template literal: a wrapper SOURCE is itself source code, and
// string-building code that nests quoting is exactly how a harness becomes unreadable.
const PROJECTION_WRAPPER_SOURCE = [
  "import * as real from " + REAL_PROJECTION + ";",
  "export * from " + REAL_PROJECTION + ";",
  "export const p4a3dProjectionCalls = { count: 0 };",
  "export const p4a3dTransformers = [];",
  "export function buildChatRenderProjection(args) {",
  "  p4a3dProjectionCalls.count += 1;",
  "  let projection = real.buildChatRenderProjection(args);",
  "  p4a3dTransformers.forEach((transform) => { projection = transform(projection, args); });",
  "  if (Array.isArray(projection)) {",
  "    Object.defineProperty(projection, 'p4a3dShared', { enumerable: false, value: true });",
  "  }",
  "  return projection;",
  "}",
  ""
].join("\n");

const ADMIN_VIEW_WRAPPER_SOURCE = [
  "import * as real from " + REAL_ADMIN_VIEW + ";",
  "export * from " + REAL_ADMIN_VIEW + ";",
  "export const p4a3dPaints = [];",
  "export function renderMessages(thread, history, options = {}) {",
  // THE TEXT IS SNAPSHOTTED AT PAINT TIME. The streaming preview entry is ONE object the
  // driver mutates in place (`preview.content += delta`), so a recorder that kept only the
  // array reference would read the FINAL text out of every earlier paint and report a live
  // stream as if it had appeared all at once. The array reference is still kept, because
  // the shared-module tag and the grouping options live on it.
  "  const list = Array.isArray(history) ? history : [];",
  "  const contents = list.map((entry) => String(entry && entry.content ? entry.content : ''));",
  "  const ids = list.map((entry) => String(entry && entry.id ? entry.id : ''));",
  "  const streamingFlags = list.map((entry) => entry && entry.streaming === true);",
  "  p4a3dPaints.push({ contents, history, ids, options, streamingFlags, thread });",
  "}",
  ""
].join("\n");

const PROJECTION_WRAPPER = dataModule(PROJECTION_WRAPPER_SOURCE);
const ADMIN_VIEW_WRAPPER = dataModule(ADMIN_VIEW_WRAPPER_SOURCE);

export async function resolve(specifier, context, nextResolve) {
  const absolute = specifier.startsWith(MOD_SPECIFIER_PREFIX)
    ? new URL("modules/" + specifier.slice(MOD_SPECIFIER_PREFIX.length), APP_L0_ALL_DIR).href
    : null;
  const resolved = await nextResolve(absolute || specifier, context);

  if (resolved.url === PROJECTION_URL) {
    return { ...resolved, shortCircuit: true, url: PROJECTION_WRAPPER };
  }

  if (resolved.url === ADMIN_VIEW_URL) {
    return { ...resolved, shortCircuit: true, url: ADMIN_VIEW_WRAPPER };
  }

  return resolved;
}
