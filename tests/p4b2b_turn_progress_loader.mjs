// TEST-ONLY module loader for the P4b-2b turn-progress suite.
//
// It does two things, and both exist because this lane's claim is 'ONE implementation,
// two surfaces', which an assertion cannot distinguish from two lookalikes that happen
// to agree today:
//
//   1. It maps `/modules/...` specifiers the way `mod_specifier_loader.mjs` does, so the
//      suite can import product modules by their real product paths.
//
//   2. It swaps `visual/conversation/turn-progress.js` for a data-URL wrapper around the
//      real module that lets the test apply a TRANSFORM to every label the shared
//      classifier returns. Both agent stores and the shared thread view import that one
//      module, so a transform is visible in all three consumers. A surface that had kept
//      a local copy of the phrase table would ignore the transform and stay unchanged,
//      which is exactly the difference this loader can see and an output comparison
//      cannot.
//
// The real module is re-imported with a `?p4b2b-real` query so it resolves to a distinct
// URL and cannot be re-mapped by this loader into a loop.

const MOD_SPECIFIER_PREFIX = "/modules/";
const APP_L0_ALL_DIR = new URL("../app/L0/_all/", import.meta.url);

const TURN_PROGRESS_URL = new URL(
  "modules/_core/visual/conversation/turn-progress.js",
  APP_L0_ALL_DIR
).href;

// BASE64, not percent-encoding: a data-URL module is decoded before it is parsed, so any
// character the encoder leaves literal has to survive that decode.
function dataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

const REAL = JSON.stringify(TURN_PROGRESS_URL + "?p4b2b-real");

const WRAPPER_SOURCE = [
  "import * as real from " + REAL + ";",
  "export * from " + REAL + ";",
  // Mutable on purpose: the suite installs a transform, asserts BOTH surfaces change,
  // then clears it.
  "export const p4b2bLabelTransforms = [];",
  "export function getTurnProgressLabel(content, options) {",
  "  let label = real.getTurnProgressLabel(content, options);",
  "  for (const transform of p4b2bLabelTransforms) {",
  "    label = transform(label, content);",
  "  }",
  "  return label;",
  "}",
  ""
].join("\n");

const WRAPPER_URL = dataModule(WRAPPER_SOURCE);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(MOD_SPECIFIER_PREFIX)) {
    const mappedUrl = new URL(
      "modules/" + specifier.slice(MOD_SPECIFIER_PREFIX.length),
      APP_L0_ALL_DIR
    ).href;

    if (mappedUrl === TURN_PROGRESS_URL) {
      return nextResolve(WRAPPER_URL, context);
    }

    return nextResolve(mappedUrl, context);
  }

  return nextResolve(specifier, context);
}
