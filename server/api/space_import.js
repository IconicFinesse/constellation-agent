import { importSpaceArchiveForUser } from "../lib/share/service.js";
import { runTrackedMutation } from "../runtime/request_mutations.js";

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeImportMode(value) {
  const candidate = String(value || "import").trim().toLowerCase();
  return candidate === "replace" ? "replace" : "import";
}

export async function post(context) {
  const username = String(context.user?.username || "").trim();

  if (!username) {
    throw createHttpError("Authentication required.", 401);
  }

  const result = await runTrackedMutation(context, async () =>
    importSpaceArchiveForUser({
      mode: normalizeImportMode(context.query?.mode),
      payloadBuffer: context.rawBody,
      projectRoot: context.projectRoot,
      runtimeParams: context.runtimeParams,
      targetSpaceId: context.query?.spaceId,
      tmpDir: context.tmpDir,
      username
    })
  );

  return {
    headers: {
      "Cache-Control": "no-store"
    },
    status: 200,
    body: result
  };
}
