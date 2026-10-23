import {
  buildChatMessages,
  createChatMessage,
  DEFAULT_SYSTEM_PROMPT,
  DTYPE_OPTIONS,
  formatDurationSeconds,
  formatNumber,
  formatTokenRate
} from "/modules/_core/huggingface/helpers.js";
import { getHuggingFaceManager, isHuggingFaceAbortError } from "/modules/_core/huggingface/manager.js";

const manager = getHuggingFaceManager();
const initialManagerState = manager.getSnapshot();

function updateMessageById(messages, messageId, updater) {
  return messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    return updater({
      ...message
    });
  });
}

const model = {
  ...initialManagerState,
  draft: "",
  isRouteGenerating: false,
  isRouteStopRequested: false,
  lastUsageMetrics: null,
  managerUnsubscribe: null,
  messages: [],
  refs: {},
  showAdvanced: false,
  showSystemPrompt: false,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,

  get composerButtonText() {
    if (this.isRouteGenerating) {
      return this.isRouteStopRequested ? "Stopping..." : "Stop";
    }

    if (this.isGenerating) {
      return "Busy";
    }

    return "Send";
  },

  get composerPlaceholder() {
    if (!this.activeModelId) {
      return "Load a model, then send a message.";
    }

    if (this.isRouteGenerating) {
      return "Generation in progress...";
    }

    if (this.isGenerating) {
      return "Hugging Face runtime is busy...";
    }

    return `Send a test message to ${this.activeModelId}`;
  },

  get currentModelActionLabel() {
    return this.isLoadingModel ? "Stop" : "Unload";
  },

  get currentModelBadgeText() {
    if (!this.webgpuSupported) {
      return "Unavailable";
    }

    if (this.error) {
      return "Error";
    }

    if (this.isWorkerBooting && !this.isLoadingModel) {
      return "Starting";
    }

    if (this.isLoadingModel) {
      return this.loadProgress.status === "download" ? "Downloading" : "Loading";
    }

    if (this.activeModelId) {
      return "Ready";
    }

    return "Idle";
  },

  get currentModelBadgeTone() {
    if (!this.webgpuSupported) {
      return "is-error";
    }

    if (this.error) {
      return "is-error";
    }

    if (this.isWorkerBooting || this.isLoadingModel) {
      return "is-loading";
    }

    if (this.activeModelId) {
      return "is-ready";
    }

    return "is-idle";
  },

  get currentModelLabel() {
    return this.loadingModelLabel || this.activeModelId || "No model loaded";
  },

  get dtypeOptions() {
    return DTYPE_OPTIONS;
  },

  get canUnloadActiveModel() {
    return Boolean(this.activeModelId || this.isLoadingModel) && !this.isGenerating;
  },

  get isComposerActionDisabled() {
    if (this.isLoadingModel) {
      return true;
    }

    if (this.isRouteGenerating) {
      return false;
    }

    if (this.isGenerating) {
      return true;
    }

    return !this.draft.trim();
  },

  get loadProgressPercent() {
    return Math.max(0, Math.min(100, Math.round(Number(this.loadProgress.progress || 0) * 100)));
  },

  get loadStepLabel() {
    return String(this.loadProgress.stepLabel || "").trim();
  },

  applyManagerState(nextState = {}) {
    Object.assign(this, nextState);
  },

  mount(refs = {}) {
    this.refs = refs;

    if (!this.managerUnsubscribe) {
      this.managerUnsubscribe = manager.subscribe((nextState) => {
        this.applyManagerState(nextState);
      });
    }

    this.syncComposerHeight();
    void manager.ensureWorker().catch(() => {});
  },

  unmount() {
    this.managerUnsubscribe?.();
    this.managerUnsubscribe = null;
    this.refs = {};
    this.isRouteGenerating = false;
    this.isRouteStopRequested = false;
  },

  setModelInput(value) {
    manager.setModelInput(value);
  },

  setSelectedDtype(value) {
    manager.setSelectedDtype(value);
  },

  setMaxNewTokens(value) {
    manager.setMaxNewTokens(value);
  },

  handleLoadModel(overrides = {}) {
    void manager.loadModel({
      dtype: overrides.dtype ?? this.selectedDtype,
      maxNewTokens: overrides.maxNewTokens ?? this.maxNewTokens,
      modelInput: overrides.modelInput ?? this.modelInput
    }).catch(() => {});
  },

  handleSavedModelAction(entry = {}) {
    if (manager.isActiveSavedModel(entry)) {
      void manager.unloadModel().catch(() => {});
      return;
    }

    this.handleLoadModel({
      dtype: entry.dtype || this.selectedDtype,
      modelInput: entry.modelInput || entry.modelId
    });
  },

  isActiveSavedModel(entry = {}) {
    return manager.isActiveSavedModel(entry);
  },

  isDiscardingSavedModel(entry = {}) {
    return manager.isDiscardingSavedModel(entry);
  },

  canDiscardSavedModel(entry = {}) {
    return manager.canDiscardSavedModel(entry);
  },

  getSavedModelActionLabel(entry = {}) {
    return manager.getSavedModelActionLabel(entry);
  },

  requestDiscardSavedModel(entry = {}) {
    void manager.discardSavedModel(entry).catch(() => {});
  },

  requestUnloadModel() {
    void manager.unloadModel().catch(() => {});
  },

  handleComposerInput(event) {
    this.draft = event?.target?.value ?? this.draft;
    this.syncComposerHeight(event?.target);
  },

  handleComposerKeydown(event) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    this.handleComposerPrimaryAction();
  },

  handleComposerPrimaryAction() {
    if (this.isRouteGenerating) {
      this.requestStop();
      return;
    }

    void this.sendMessage();
  },

  requestStop() {
    if (!this.isRouteGenerating) {
      return;
    }

    this.isRouteStopRequested = true;
    manager.requestStop();
  },

  async sendMessage() {
    const trimmedDraft = String(this.draft || "").trim();

    if (!trimmedDraft) {
      return;
    }

    if (!this.activeModelId) {
      manager.setError("Load a model before sending a message.");
      return;
    }

    const userMessage = createChatMessage("user", trimmedDraft);
    const conversationMessages = [...this.messages, userMessage];
    const assistantMessage = createChatMessage("assistant", "");
    assistantMessage.isStreaming = true;
    assistantMessage.modelId = this.activeModelId;

    this.messages = [...conversationMessages, assistantMessage];
    this.draft = "";
    this.lastUsageMetrics = null;
    this.isRouteGenerating = true;
    this.isRouteStopRequested = false;
    manager.setError("");
    this.syncComposerHeight();
    this.scheduleThreadScrollToBottom();

    try {
      const result = await manager.streamCompletion({
        messages: buildChatMessages(this.systemPrompt, conversationMessages),
        onDelta: (delta) => {
          assistantMessage.content += delta;
          this.messages = updateMessageById(this.messages, assistantMessage.id, (message) => ({
            ...message,
            content: assistantMessage.content,
            isStreaming: true
          }));
          this.scheduleThreadScrollToBottom();
        },
        requestOptions: {
          max_new_tokens: this.maxNewTokens
        }
      });

      this.messages = updateMessageById(this.messages, assistantMessage.id, (message) => ({
        ...message,
        content: String(result.text || message.content || ""),
        finishReason: String(result.finishReason || "stop"),
        isStreaming: false,
        metrics: result.metrics || null,
        modelId: String(result.modelId || this.activeModelId || "")
      }));
      this.lastUsageMetrics = result.metrics || null;
    } catch (error) {
      if (isHuggingFaceAbortError(error)) {
        const abortedText = String(error.text || assistantMessage.content || "");

        if (!abortedText.trim()) {
          this.messages = this.messages.filter((message) => message.id !== assistantMessage.id);
        } else {
          this.messages = updateMessageById(this.messages, assistantMessage.id, (message) => ({
            ...message,
            content: abortedText,
            finishReason: String(error.finishReason || "abort"),
            isStreaming: false,
            metrics: error.metrics || null,
            modelId: String(error.modelId || this.activeModelId || "")
          }));
          this.lastUsageMetrics = error.metrics || null;
        }
      } else {
        this.messages = updateMessageById(this.messages, assistantMessage.id, (message) => ({
          ...message,
          content: message.content || "Generation failed.",
          finishReason: "error",
          isStreaming: false
        }));
      }
    } finally {
      this.isRouteGenerating = false;
      this.isRouteStopRequested = false;
      this.scheduleThreadScrollToBottom();
    }
  },

  clearChat() {
    this.draft = "";
    this.messages = [];
    this.lastUsageMetrics = null;
    manager.setError("");
    this.syncComposerHeight();
  },

  formatDuration(value) {
    return formatDurationSeconds(value);
  },

  formatMetricNumber(value, digits = 1) {
    return formatNumber(value, digits);
  },

  formatTokenRate(value) {
    return formatTokenRate(value);
  },

  scheduleThreadScrollToBottom() {
    requestAnimationFrame(() => {
      if (!this.refs.thread) {
        return;
      }

      this.refs.thread.scrollTop = this.refs.thread.scrollHeight;
    });
  },

  syncComposerHeight(target = this.refs.composer) {
    if (!target) {
      return;
    }

    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 240)}px`;
  }
};

space.fw.createStore("huggingface", model);
