export const AGENT_PERSONALITY_PATH = "~/config/personality.system.include.md";

function getRuntime() {
  const runtime = globalThis.space;

  if (!runtime || typeof runtime !== "object") {
    throw new Error("Space runtime is not available.");
  }

  if (
    !runtime.api ||
    typeof runtime.api.fileRead !== "function" ||
    typeof runtime.api.fileWrite !== "function"
  ) {
    throw new Error("space.api helpers are not available.");
  }

  return runtime;
}

function isMissingFileError(error) {
  const message = String(error?.message || "");
  return /\bstatus 404\b/u.test(message) || /File not found\./u.test(message) || /Path not found\./u.test(message);
}

export async function loadAgentPersonality() {
  const runtime = getRuntime();

  try {
    const result = await runtime.api.fileRead(AGENT_PERSONALITY_PATH);
    return String(result?.content || "");
  } catch (error) {
    if (isMissingFileError(error)) {
      return "";
    }

    throw new Error(`Unable to load agent personality: ${error.message}`);
  }
}

export async function saveAgentPersonality(content) {
  const runtime = getRuntime();
  const normalizedContent = String(content ?? "");

  try {
    await runtime.api.fileWrite({
      files: [
        { path: "~/config/" },
        {
          path: AGENT_PERSONALITY_PATH,
          content: normalizedContent
        }
      ]
    });
  } catch (error) {
    throw new Error(`Unable to save agent personality: ${error.message}`);
  }
}
