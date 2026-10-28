// TEST-ONLY module loader for the P4b-1 typed-chip-content suite.
//
// It maps `/modules/...` specifiers the way the other suites do, and it swaps the SHARED
// typed-result formatter for a wrapper that can be overridden at runtime.
//
// The override hook exists because this lane's central claim is "there is ONE
// implementation": mutating that module and watching the PAINTED output change is the only
// way to distinguish a real shared formatter from a lookalike local one. An assertion that
// the renderer "calls the formatter" would pass for a lookalike; a mutation cannot.

const MOD_SPECIFIER_PREFIX = "/modules/";
const APP_L0_ALL_DIR = new URL("../app/L0/_all/", import.meta.url);

const FORMAT_URL = new URL(
  "modules/_core/framework/js/engine-swap/typed-result-format.js",
  APP_L0_ALL_DIR
).href;

function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

const REAL_FORMAT = JSON.stringify(FORMAT_URL + "?p4b1-real");

// `p4b1Overrides` is the mutation surface. A test sets one function to prove the renderer
// really paints through the shared module; a lookalike implementation would never be
// reached, so the painted output would not move.
const WRAPPER_SOURCE = [
  "import * as real from " + REAL_FORMAT + ";",
  "export * from " + REAL_FORMAT + ";",
  "export const p4b1Overrides = { formatTypedToolArguments: null, formatTypedToolResult: null };",
  "export const p4b1Calls = { arguments: 0, result: 0 };",
  "export function formatTypedToolArguments(args) {",
  "  p4b1Calls.arguments += 1;",
  "  return p4b1Overrides.formatTypedToolArguments",
  "    ? p4b1Overrides.formatTypedToolArguments(args, real)",
  "    : real.formatTypedToolArguments(args);",
  "}",
  "export function formatTypedToolResult(args) {",
  "  p4b1Calls.result += 1;",
  "  return p4b1Overrides.formatTypedToolResult",
  "    ? p4b1Overrides.formatTypedToolResult(args, real)",
  "    : real.formatTypedToolResult(args);",
  "}",
  ""
].join("\n");

const WRAPPER = dataModule(WRAPPER_SOURCE);

// Exported so a test can import the WRAPPED module directly and set an override. Importing
// it any other way would hand back the real module and the mutation would prove nothing.
export const P4B1_FORMAT_MODULE = WRAPPER;

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
