function cloneFallbackValue(value, seen = new WeakMap()) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  if (Array.isArray(value)) {
    const clonedArray = [];
    seen.set(value, clonedArray);

    value.forEach((entry) => {
      const clonedEntry = cloneFallbackValue(entry, seen);
      clonedArray.push(clonedEntry === undefined ? null : clonedEntry);
    });

    return clonedArray;
  }

  const clonedObject = {};
  seen.set(value, clonedObject);

  Object.entries(value).forEach(([key, entry]) => {
    const clonedEntry = cloneFallbackValue(entry, seen);

    if (clonedEntry !== undefined) {
      clonedObject[key] = clonedEntry;
    }
  });

  return clonedObject;
}

function cloneStructuredData(value) {
  if (value == null) {
    return value;
  }

  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      return cloneFallbackValue(value);
    }
  }

  if (Array.isArray(value) || typeof value === "object") {
    return cloneFallbackValue(value);
  }

  return value;
}

function normalizePromptContext(context = {}) {
  const normalizedContext =
    context && typeof context === "object" && !Array.isArray(context)
      ? cloneStructuredData(context)
      : {};
  const historyMessages = Array.isArray(normalizedContext.historyMessages)
    ? normalizedContext.historyMessages
    : Array.isArray(normalizedContext.messages)
      ? normalizedContext.messages
      : [];

  return {
    ...normalizedContext,
    exampleMessages: Array.isArray(normalizedContext.exampleMessages)
      ? cloneStructuredData(normalizedContext.exampleMessages)
      : [],
    historyMessages: cloneStructuredData(historyMessages),
    messages: cloneStructuredData(historyMessages),
    options:
      normalizedContext.options && typeof normalizedContext.options === "object" && !Array.isArray(normalizedContext.options)
        ? cloneStructuredData(normalizedContext.options)
        : {},
    systemPrompt: typeof normalizedContext.systemPrompt === "string" ? normalizedContext.systemPrompt : "",
    transientSections: Array.isArray(normalizedContext.transientSections)
      ? cloneStructuredData(normalizedContext.transientSections)
      : []
  };
}

export function hasPreparedPromptInput(promptInstance) {
  if (!promptInstance || typeof promptInstance.getPromptInput !== "function") {
    return false;
  }

  const promptInput = promptInstance.getPromptInput();
  return Boolean(promptInput?.systemPrompt || (Array.isArray(promptInput?.requestEntries) && promptInput.requestEntries.length));
}

export class AgentPromptInstance {
  constructor(options = {}) {
    if (typeof options.buildPromptInput !== "function") {
      throw new Error("AgentPromptInstance requires a buildPromptInput(context) function.");
    }

    this.buildPromptInput = options.buildPromptInput;
    this.updatePromptHistory =
      typeof options.updatePromptHistory === "function" ? options.updatePromptHistory : null;
    this.context = normalizePromptContext({
      ...(options.context && typeof options.context === "object" && !Array.isArray(options.context)
        ? options.context
        : {}),
      defaultSystemPrompt: options.defaultSystemPrompt,
      exampleMessages: options.exampleMessages,
      historyMessages: Array.isArray(options.historyMessages) ? options.historyMessages : options.messages,
      options: options.options,
      systemPrompt: options.systemPrompt,
      transientSections: options.transientSections
    });
    this.promptInput = null;
  }

  async build(context = {}) {
    this.context = normalizePromptContext({
      ...this.context,
      ...(context && typeof context === "object" && !Array.isArray(context) ? context : {})
    });
    this.promptInput = await this.buildPromptInput({
      ...cloneStructuredData(this.context),
      prompt: this
    });
    return cloneStructuredData(this.promptInput);
  }

  async updateHistory(historyMessages, options = {}) {
    const nextHistoryMessages = Array.isArray(historyMessages) ? historyMessages : [];

    this.context = normalizePromptContext({
      ...this.context,
      ...(options && typeof options === "object" && !Array.isArray(options) ? options : {}),
      historyMessages: nextHistoryMessages
    });

    if (this.updatePromptHistory && hasPreparedPromptInput(this)) {
      this.promptInput = await this.updatePromptHistory({
        context: cloneStructuredData(this.context),
        historyMessages: cloneStructuredData(nextHistoryMessages),
        options:
          options && typeof options === "object" && !Array.isArray(options)
            ? cloneStructuredData(options)
            : {},
        prompt: this,
        promptInput: cloneStructuredData(this.promptInput)
      });

      return cloneStructuredData(this.promptInput);
    }

    return this.build({
      ...(options && typeof options === "object" && !Array.isArray(options) ? options : {}),
      historyMessages: nextHistoryMessages
    });
  }

  getPromptInput() {
    return cloneStructuredData(this.promptInput);
  }
}

export function createAgentPromptInstance(options = {}) {
  return new AgentPromptInstance(options);
}
