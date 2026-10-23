const OPEN_ROUTER_HOST = "openrouter.ai";

export function isOpenRouterEndpoint(endpoint = "") {
  const normalizedEndpoint = String(endpoint || "").trim();

  if (!normalizedEndpoint) {
    return false;
  }

  try {
    const url = new URL(normalizedEndpoint, globalThis.location?.origin || "http://localhost");
    return url.hostname === OPEN_ROUTER_HOST || url.hostname.endsWith(`.${OPEN_ROUTER_HOST}`);
  } catch {
    return normalizedEndpoint.includes(OPEN_ROUTER_HOST);
  }
}

export function applyOpenRouterHeaders(apiRequest = {}, options = {}) {
  const headers =
    apiRequest?.headers && typeof apiRequest.headers === "object"
      ? { ...apiRequest.headers }
      : {};

  headers["HTTP-Referer"] = String(options?.referer || "https://github.com/IconicFinesse/constellation-agent").trim();
  headers["X-OpenRouter-Title"] = String(options?.title || "Constellation Agent").trim();
  headers["X-OpenRouter-Categories"] = String(
    options?.categories || "personal-agent,cloud-agent"
  ).trim();

  return {
    ...apiRequest,
    headers
  };
}
