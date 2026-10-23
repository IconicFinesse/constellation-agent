import {
  buildOnscreenAgentPromptInput
} from "/modules/_core/onscreen_agent/llm.js";
import {
  createAgentPromptInstance,
  hasPreparedPromptInput
} from "/modules/_core/agent_prompt/prompt-runtime.js";

export const DEFAULT_ADMIN_SYSTEM_PROMPT_PATH = "/modules/_core/admin/views/agent/system-prompt.md";
export const ADMIN_HISTORY_COMPACT_MODE = Object.freeze({
  AUTOMATIC: "automatic",
  USER: "user"
});
export const ADMIN_HISTORY_COMPACT_PROMPT_PATH = "/modules/_core/admin/views/agent/compact-prompt.md";
export const ADMIN_HISTORY_AUTO_COMPACT_PROMPT_PATH = "/modules/_core/admin/views/agent/compact-prompt-auto.md";

let defaultSystemPromptPromise = null;
const compactPromptPromises = {
  [ADMIN_HISTORY_COMPACT_MODE.AUTOMATIC]: null,
  [ADMIN_HISTORY_COMPACT_MODE.USER]: null
};

function normalizeSystemPrompt(systemPrompt = "") {
  return typeof systemPrompt === "string" ? systemPrompt.trim() : "";
}

function stripDefaultPromptPrefix(storedPrompt, defaultSystemPrompt) {
  const normalizedStoredPrompt = normalizeSystemPrompt(storedPrompt);
  const normalizedDefaultPrompt = normalizeSystemPrompt(defaultSystemPrompt);

  if (!normalizedStoredPrompt) {
    return "";
  }

  if (!normalizedDefaultPrompt) {
    return normalizedStoredPrompt;
  }

  if (normalizedStoredPrompt === normalizedDefaultPrompt) {
    return "";
  }

  if (!normalizedStoredPrompt.startsWith(normalizedDefaultPrompt)) {
    return normalizedStoredPrompt;
  }

  return normalizedStoredPrompt.slice(normalizedDefaultPrompt.length).replace(/^\s+/u, "").trim();
}

async function loadPromptFile(promptPath, promptLabel) {
  const response = await fetch(promptPath);

  if (!response.ok) {
    throw new Error(`Unable to load the ${promptLabel} (${response.status}).`);
  }

  const prompt = normalizeSystemPrompt(await response.text());

  if (!prompt) {
    throw new Error(`The ${promptLabel} file is empty.`);
  }

  return prompt;
}

async function loadDefaultSystemPrompt() {
  return loadPromptFile(DEFAULT_ADMIN_SYSTEM_PROMPT_PATH, "default admin system prompt");
}

function normalizeHistoryCompactMode(mode = ADMIN_HISTORY_COMPACT_MODE.USER) {
  return mode === ADMIN_HISTORY_COMPACT_MODE.AUTOMATIC
    ? ADMIN_HISTORY_COMPACT_MODE.AUTOMATIC
    : ADMIN_HISTORY_COMPACT_MODE.USER;
}

function resolveHistoryCompactPromptConfig(mode) {
  if (mode === ADMIN_HISTORY_COMPACT_MODE.AUTOMATIC) {
    return {
      label: "admin automatic history compact prompt",
      path: ADMIN_HISTORY_AUTO_COMPACT_PROMPT_PATH
    };
  }

  return {
    label: "admin history compact prompt",
    path: ADMIN_HISTORY_COMPACT_PROMPT_PATH
  };
}

async function loadCompactPrompt(mode) {
  const promptConfig = resolveHistoryCompactPromptConfig(mode);
  return loadPromptFile(promptConfig.path, promptConfig.label);
}

export async function fetchDefaultAdminSystemPrompt(options = {}) {
  const forceRefresh = options.forceRefresh === true;

  if (!forceRefresh && defaultSystemPromptPromise) {
    return defaultSystemPromptPromise;
  }

  defaultSystemPromptPromise = loadDefaultSystemPrompt().catch((error) => {
    defaultSystemPromptPromise = null;
    throw error;
  });

  return defaultSystemPromptPromise;
}

export async function fetchAdminHistoryCompactPrompt(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const mode = normalizeHistoryCompactMode(options.mode);

  if (!forceRefresh && compactPromptPromises[mode]) {
    return compactPromptPromises[mode];
  }

  compactPromptPromises[mode] = loadCompactPrompt(mode).catch((error) => {
    compactPromptPromises[mode] = null;
    throw error;
  });

  return compactPromptPromises[mode];
}

export function extractCustomAdminSystemPrompt(storedPrompt = "", defaultSystemPrompt = "") {
  return stripDefaultPromptPrefix(storedPrompt, defaultSystemPrompt);
}

function buildAdminPromptOptions(options = {}) {
  const normalizedOptions =
    options && typeof options === "object" && !Array.isArray(options)
      ? { ...options }
      : {};

  return {
    ...normalizedOptions,
    customPromptPlacement: "end"
  };
}

export function createAdminPromptInstance(options = {}) {
  return createAgentPromptInstance({
    ...options,
    buildPromptInput: async (context) => buildOnscreenAgentPromptInput(context),
    options: buildAdminPromptOptions(options.options)
  });
}

export async function buildAdminPromptInput(options = {}) {
  const normalizedOptions =
    options && typeof options === "object" && !Array.isArray(options)
      ? options
      : {};
  const historyMessages = Array.isArray(normalizedOptions.historyMessages)
    ? normalizedOptions.historyMessages
    : Array.isArray(normalizedOptions.messages)
      ? normalizedOptions.messages
      : [];
  const promptOptions = buildAdminPromptOptions(normalizedOptions.options);
  const promptContext = {
    ...normalizedOptions,
    historyMessages,
    messages: historyMessages,
    options: promptOptions
  };
  const promptInstance = normalizedOptions.promptInstance;

  if (promptInstance && typeof promptInstance.updateHistory === "function" && hasPreparedPromptInput(promptInstance)) {
    return promptInstance.updateHistory(historyMessages, {
      defaultSystemPrompt: normalizedOptions.defaultSystemPrompt,
      options: promptOptions,
      systemPrompt: normalizedOptions.systemPrompt,
      transientSections: normalizedOptions.transientSections
    });
  }

  if (promptInstance && typeof promptInstance.build === "function") {
    return promptInstance.build(promptContext);
  }

  return buildOnscreenAgentPromptInput(promptContext);
}

export async function buildAdminPromptContext(systemPrompt = "", options = {}) {
  const defaultSystemPrompt = normalizeSystemPrompt(
    options.defaultSystemPrompt || (await fetchDefaultAdminSystemPrompt())
  );

  return buildAdminPromptInput({
    defaultSystemPrompt,
    historyMessages: Array.isArray(options.historyMessages)
      ? options.historyMessages
      : Array.isArray(options.messages)
        ? options.messages
        : [],
    options: options.options,
    promptInstance: options.promptInstance,
    systemPrompt,
    transientSections: options.transientSections
  });
}

export async function buildAdminPromptMessages(systemPrompt = "", messages = [], options = {}) {
  const promptInput = await buildAdminPromptContext(systemPrompt, {
    ...options,
    historyMessages: Array.isArray(messages) ? messages : []
  });

  return Array.isArray(promptInput?.requestMessages) ? promptInput.requestMessages : [];
}

export async function buildRuntimeAdminSystemPrompt(systemPrompt = "", options = {}) {
  const promptContext = await buildAdminPromptContext(systemPrompt, options);
  return typeof promptContext?.systemPrompt === "string" ? promptContext.systemPrompt : "";
}
