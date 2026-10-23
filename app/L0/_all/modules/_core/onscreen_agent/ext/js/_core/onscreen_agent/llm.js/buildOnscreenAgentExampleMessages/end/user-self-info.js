import { formatExecutionResultValue, formatExecutionResultsMessage } from "/modules/_core/onscreen_agent/execution.js";

const USER_SELF_INFO_EXAMPLE_PROMPT = "check user detail";
const USER_SELF_INFO_EXAMPLE_RESPONSE = [
  "Fetching user detail...",
  "_____javascript",
  "return await space.api.userSelfInfo()"
].join("\n");

function formatUserSelfInfoResult(userSelfInfo) {
  return formatExecutionResultValue(userSelfInfo, {
    targetWindow: window
  });
}

function buildUserSelfInfoExecutionResultMessage(userSelfInfo) {
  return formatExecutionResultsMessage([{
    error: null,
    loadedSkills: [],
    logs: [],
    result: userSelfInfo,
    resultText: formatUserSelfInfoResult(userSelfInfo),
    status: "success"
  }]);
}

export default async function appendUserSelfInfoExample(hookContext) {
  const promptContext = hookContext?.result;

  if (!promptContext || !Array.isArray(promptContext.exampleMessages)) {
    return;
  }

  const userSelfInfo = await globalThis.space?.api?.userSelfInfo?.().catch((error) => {
    console.error("Unable to preload the onscreen agent user-self-info example.", error);
    return null;
  });

  if (!userSelfInfo) {
    return;
  }

  promptContext.exampleMessages = [
    ...promptContext.exampleMessages,
    {
      content: USER_SELF_INFO_EXAMPLE_PROMPT,
      kind: "example-framework",
      role: "user"
    },
    {
      content: USER_SELF_INFO_EXAMPLE_RESPONSE,
      role: "assistant"
    },
    {
      content: buildUserSelfInfoExecutionResultMessage(userSelfInfo),
      kind: "execution-output",
      role: "user"
    }
  ];
}
