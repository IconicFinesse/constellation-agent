import { applyOpenRouterHeaders, isOpenRouterEndpoint } from "/modules/_core/open_router/request.js";

export default async function openRouterOnscreenRequestHook(hookContext) {
  const apiRequest = hookContext?.result;

  if (!apiRequest || typeof apiRequest !== "object") {
    return;
  }

  if (!isOpenRouterEndpoint(apiRequest.apiEndpoint || apiRequest.settings?.apiEndpoint || "")) {
    return;
  }

  hookContext.result = applyOpenRouterHeaders(apiRequest);
}
