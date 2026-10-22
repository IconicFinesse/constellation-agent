export const allowAnonymous = true;

export function get(context) {
  const browserAppUrl = context.requestUrl ? context.requestUrl.origin : context.browserUrl;

  return {
    ok: true,
    name: "constellation-agent-server",
    browserAppUrl,
    user: context.user || null,
  };
}
