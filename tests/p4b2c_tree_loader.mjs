// TEST-ONLY module loader for the P4b-2c parity suite.
//
// Both surfaces import their shared modules through the product's absolute `/modules/...`
// specifier, so a plain resolution can only ever reach ONE tree. This lane's central claim
// is an EQUIVALENCE claim ("admin's rendering did not change; onscreen adopted admin's
// bounds"), and equivalence claims are earned by differential execution against the REAL
// base tree — not against fixtures transcribed from it.
//
// So `/modules/x` resolves against the importing file's OWN module tree:
//
//   <root>/app/L0/_all/modules/_core/onscreen_agent/execution.js
//        importing "/modules/_core/framework/js/execution-format.js"
//     -> <root>/app/L0/_all/modules/_core/framework/js/execution-format.js
//
// The rule is STATELESS on purpose. Node's `register()` runs this hook on a separate hooks
// thread, so any registry mutated from the test thread would be invisible here — a mutation
// surface that silently does nothing. Deriving the root from `context.parentURL` means the
// tip tree, a real `git archive` base tree and a mutated copy can all be imported into ONE
// process with no coordination at all.

const MODULES_SPECIFIER_PREFIX = "/modules/";
const MODULES_TREE_MARKER = "/app/L0/_all/modules/";

const TIP_MODULES_URL = new URL("../app/L0/_all/modules/", import.meta.url).href;

export const P4B2C_TIP_MODULES_URL = TIP_MODULES_URL;

export function modulesUrlForTree(treeRoot) {
  const normalized = treeRoot.endsWith("/") ? treeRoot : `${treeRoot}/`;
  const asUrl = normalized.startsWith("file://") ? normalized : new URL(`file://${normalized}`).href;

  return asUrl.endsWith(MODULES_TREE_MARKER)
    ? asUrl
    : new URL(MODULES_TREE_MARKER.replace(/^\//u, ""), asUrl).href;
}

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(MODULES_SPECIFIER_PREFIX)) {
    return nextResolve(specifier, context);
  }

  const parentUrl = context.parentURL || "";
  const markerIndex = parentUrl.indexOf(MODULES_TREE_MARKER);
  const treeRootUrl =
    markerIndex === -1
      ? TIP_MODULES_URL
      : parentUrl.slice(0, markerIndex + MODULES_TREE_MARKER.length);
  const relativeSpecifier = specifier.slice(MODULES_SPECIFIER_PREFIX.length);

  return nextResolve(new URL(relativeSpecifier, treeRootUrl).href, context);
}
