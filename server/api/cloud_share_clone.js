import { cloneHostedCloudShareToGuest } from "../lib/share/service.js";
import { areGuestUsersAllowed } from "../lib/utils/runtime_params.js";
import { runTrackedMutation } from "../runtime/request_mutations.js";

export const allowAnonymous = true;

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function post(context) {
  if (!areGuestUsersAllowed(context.runtimeParams)) {
    throw createHttpError("Cloud share not found.", 404);
  }

  const cloneResult = await runTrackedMutation(context, async () =>
    cloneHostedCloudShareToGuest({
      payloadBuffer: context.rawBody,
      projectRoot: context.projectRoot,
      runtimeParams: context.runtimeParams,
      shareToken: context.query?.token,
      tmpDir: context.tmpDir
    })
  );

  return {
    headers: {
      "Cache-Control": "no-store"
    },
    status: 200,
    body: {
      password: cloneResult.password,
      redirectUrl: "/#/spaces?id=" + encodeURIComponent(cloneResult.importedSpace.spaceId),
      spaceId: cloneResult.importedSpace.spaceId,
      username: cloneResult.username
    }
  };
}
