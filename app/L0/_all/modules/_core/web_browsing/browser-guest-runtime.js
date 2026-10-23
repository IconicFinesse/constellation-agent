function normalizeScriptPath(value) {
  return String(value || "").trim();
}

function dedupeScriptPaths(paths = []) {
  const seen = new Set();
  const deduped = [];

  paths.forEach((path) => {
    const normalizedPath = normalizeScriptPath(path);
    if (!normalizedPath || seen.has(normalizedPath)) {
      return;
    }

    seen.add(normalizedPath);
    deduped.push(normalizedPath);
  });

  return deduped;
}

function readScriptPathList(context, key) {
  return Array.isArray(context?.[key]) ? context[key] : [];
}

export const buildBrowserGuestRuntimeScriptPaths = globalThis.space.extend(
  import.meta,
  async function buildBrowserGuestRuntimeScriptPaths(context = {}) {
    const runtimeContext = context && typeof context === "object" ? context : {};
    const preBootstrapScriptPaths = readScriptPathList(runtimeContext, "preBootstrapScriptPaths");
    const postBootstrapScriptPaths = readScriptPathList(runtimeContext, "postBootstrapScriptPaths");

    postBootstrapScriptPaths.push("/modules/_core/web_browsing/browser-page-content.js");
    postBootstrapScriptPaths.push("/modules/_core/web_browsing/ext/browser_guest_runtime/core/handle-message.js");

    runtimeContext.preBootstrapScriptPaths = dedupeScriptPaths(preBootstrapScriptPaths);
    runtimeContext.postBootstrapScriptPaths = dedupeScriptPaths(postBootstrapScriptPaths);
    return runtimeContext;
  }
);
