// TEST-ONLY module loader for the P4b-2a bounded-output suite.
//
// It maps `/modules/...` specifiers the way the other suites do, and it swaps the SHARED
// bounding module (`framework/js/execution-format.js`) for a wrapper whose bounding helpers
// can be overridden at runtime.
//
// The override hook exists because this lane's central claim is "the caps live in ONE
// place": mutating the shared bounding helper and watching BOTH surfaces' painted output
// change is the only way to distinguish a real shared bound from a per-surface copy. An
// assertion that the formatter "calls the shared helper" would pass for a copy.

const MOD_SPECIFIER_PREFIX = "/modules/";
const APP_L0_ALL_DIR = new URL("../app/L0/_all/", import.meta.url);

const FORMAT_URL = new URL(
  "modules/_core/framework/js/execution-format.js",
  APP_L0_ALL_DIR
).href;

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

const REAL_FORMAT = JSON.stringify(FORMAT_URL + "?p4b2a-real");

// `p4b2aOverrides` is the mutation surface. `export *` is shadowed by the explicit local
// exports below (in the module spec, a locally declared export always wins over a star
// re-export of the same name), so importing either helper gets the wrapper's version.
const WRAPPER_SOURCE = [
  "import * as real from " + REAL_FORMAT + ";",
  "export * from " + REAL_FORMAT + ";",
  "export const p4b2aOverrides = {",
  "  boundExecutionStructuredValue: null,",
  "  boundExecutionTranscriptChunks: null,",
  "  formatExecutionHiddenMarker: null",
  "};",
  "export const p4b2aCalls = { structured: 0, transcript: 0, marker: 0 };",
  "export function boundExecutionStructuredValue(value, options) {",
  "  p4b2aCalls.structured += 1;",
  "  return p4b2aOverrides.boundExecutionStructuredValue",
  "    ? p4b2aOverrides.boundExecutionStructuredValue(value, options, real)",
  "    : real.boundExecutionStructuredValue(value, options);",
  "}",
  "export function boundExecutionTranscriptChunks(chunks, options) {",
  "  p4b2aCalls.transcript += 1;",
  "  return p4b2aOverrides.boundExecutionTranscriptChunks",
  "    ? p4b2aOverrides.boundExecutionTranscriptChunks(chunks, options, real)",
  "    : real.boundExecutionTranscriptChunks(chunks, options);",
  "}",
  "export function formatExecutionHiddenMarker(count, noun) {",
  "  p4b2aCalls.marker += 1;",
  "  return p4b2aOverrides.formatExecutionHiddenMarker",
  "    ? p4b2aOverrides.formatExecutionHiddenMarker(count, noun, real)",
  "    : real.formatExecutionHiddenMarker(count, noun);",
  "}",
  ""
].join("\n");

const WRAPPER = dataModule(WRAPPER_SOURCE);

// Exported so a test can import the WRAPPED module directly and set an override. Importing
// it any other way would hand back the real module and the mutation would prove nothing.
export const P4B2A_FORMAT_MODULE = WRAPPER;

export async function resolve(specifier, context, nextResolve) {
  const absolute = specifier.startsWith(MOD_SPECIFIER_PREFIX)
    ? new URL("modules/" + specifier.slice(MOD_SPECIFIER_PREFIX.length), APP_L0_ALL_DIR).href
    : null;
  const resolved = await nextResolve(absolute || specifier, context);

  if (resolved.url === FORMAT_URL) {
    return { ...resolved, shortCircuit: true, url: WRAPPER };
  }

  return resolved;
}
