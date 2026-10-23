import {
  buildChatMessages,
  createChatMessage,
  DEFAULT_SYSTEM_PROMPT,
  describeModelSelection,
  filterPrebuiltModels,
  formatDurationSeconds,
  formatNumber,
  formatTokenRate,
  inferModelFamily,
  normalizeUsageMetrics,
  validateModelSelection
} from "/modules/_core/webllm/helpers.js";
import { WORKER_INBOUND, WORKER_OUTBOUND } from "/modules/_core/webllm/protocol.js";

const PERSISTED_MODEL_STORAGE_KEY = "space.webllm.last-loaded-model";

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

function readPersistedModelSelection() {
  try {
    const rawValue = globalThis.localStorage?.getItem(PERSISTED_MODEL_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object") {
      return null;
    }

    if (parsedValue.source === "custom") {
      const customModelUrl = String(parsedValue.customModelUrl || "").trim();
      const customModelLibUrl = String(parsedValue.customModelLibUrl || "").trim();
      const customModelId = String(parsedValue.customModelId || parsedValue.modelId || "").trim();

      if (!customModelUrl || !customModelLibUrl) {
        return null;
      }

      return {
        customModelId,
        customModelLibUrl,
        customModelUrl,
        source: "custom"
      };
    }

    const modelId = String(parsedValue.modelId || "").trim();
    if (!modelId) {
      return null;
    }

    return {
      modelId,
      source: "prebuilt"
    };
  } catch {
    return null;
  }
}

function persistModelSelection(selection) {
  try {
    if (!selection) {
      globalThis.localStorage?.removeItem(PERSISTED_MODEL_STORAGE_KEY);
      return;
    }

    globalThis.localStorage?.setItem(PERSISTED_MODEL_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Ignore storage failures in private browsing or restricted environments.
  }
}

function clearPersistedModelSelection() {
  persistModelSelection(null);
}

const model = {
  activeGpuVendor: "",
  activeMaxStorageBufferBindingSize: null,
  activeModelId: "",
  activeModelSource: "",
  cachedModelIds: [],
  cacheStatusReady: false,
  customModelId: "",
  customModelLibUrl: "",
  customModelUrl: "",
  draft: "",
  error: "",
  generationStartTimeMs: 0,
  hasTriedPersistedReload: false,
  isDiscardingModelId: "",
  isGenerating: false,
  isLoadingModel: false,
  isUnloadingModel: false,
  isRestoringPersistedModel: false,
  isStopRequested: false,
  isWorkerReady: false,
  lastUsageMetrics: null,
  loadProgress: {
    progress: 0,
    text: "",
    timeElapsed: 0
  },
  loadingModelLabel: "",
  messages: [],
  modelId: "",
  pendingAssistantMessageId: "",
  pendingGenerateRequestId: "",
  pendingLoadRequestId: "",
  pendingDiscardRequestId: "",
  pendingUnloadRequestId: "",
  prebuiltModels: [],
  prebuiltSearch: "",
  refs: {},
  showDownloadedOnly: false,
  showAdvanced: false,
  showSystemPrompt: false,
  statusText: "Starting WebLLM worker...",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  webgpuSupported: Boolean(globalThis.navigator?.gpu),
  worker: null,

  get filteredPrebuiltModels() {
    const visibleModels = filterPrebuiltModels(this.prebuiltModels, {
      search: this.prebuiltSearch
    });

    if (!this.showDownloadedOnly) {
      return visibleModels;
    }

    return visibleModels.filter((modelRecord) => this.isModelCached(modelRecord.model_id));
  },

  get composerButtonText() {
    if (this.isGenerating) {
      return this.isStopRequested ? "Stopping..." : "Stop";
    }

    return "Send";
  },

  get composerPlaceholder() {
    if (!this.activeModelId) {
      return "Load a model, then send a message.";
    }

    if (this.isGenerating) {
      return "Generation in progress...";
    }

    return `Send a test message to ${this.activeModelId}`;
  },

  get currentModelLabel() {
    return this.loadingModelLabel || this.activeModelId || "No model loaded";
  },

  get loadProgressPercent() {
    return Math.max(0, Math.min(100, Math.round(Number(this.loadProgress.progress || 0) * 100)));
  },

  get currentModelBadgeText() {
    if (!this.webgpuSupported) {
      return "Unavailable";
    }

    if (!this.isWorkerReady) {
      return "Starting";
    }

    if (this.isUnloadingModel) {
      return "Unloading";
    }

    if (this.isLoadingModel) {
      return this.isDownloadingPendingModel() ? "Downloading" : "Loading";
    }

    if (this.activeModelId) {
      return "Ready";
    }

    if (this.error) {
      return "Error";
    }

    return "Idle";
  },

  get currentModelBadgeTone() {
    if (!this.webgpuSupported) {
      return "is-error";
    }

    if (!this.isWorkerReady || this.isLoadingModel || this.isUnloadingModel) {
      return "is-loading";
    }

    if (this.activeModelId) {
      return "is-ready";
    }

    if (this.error) {
      return "is-error";
    }

    return "is-idle";
  },

  get visiblePrebuiltCount() {
    return this.filteredPrebuiltModels.length;
  },

  get canUnloadActiveModel() {
    return (Boolean(this.activeModelId) || this.isLoadingModel)
      && !this.isGenerating
      && !this.isUnloadingModel
      && !this.isDiscardingModelId;
  },

  get currentModelActionLabel() {
    return this.isLoadingModel ? "Stop" : "Unload";
  },

  mount(refs = {}) {
    this.refs = refs;
    this.ensureWorker();
    this.syncComposerHeight();
  },

  unmount() {
    if (this.worker) {
      this.worker.terminate();
    }

    this.refs = {};
    this.worker = null;
    this.isWorkerReady = false;
  },

  ensureWorker() {
    if (this.worker) {
      return;
    }

    const worker = new Worker(new URL("./webllm-worker.js", import.meta.url), {
      type: "module"
    });

    worker.addEventListener("message", (event) => {
      this.handleWorkerMessage(event.data);
    });
    worker.addEventListener("error", (event) => {
      this.error = event.message || "The WebLLM worker failed to start.";
      this.statusText = "Worker startup failed.";
    });

    this.worker = worker;
    worker.postMessage({
      type: WORKER_INBOUND.BOOT
    });
  },

  handleWorkerMessage(message = {}) {
    const payload = message.payload || {};

    switch (message.type) {
      case WORKER_OUTBOUND.READY: {
        this.isWorkerReady = true;
        this.cacheStatusReady = false;
        this.prebuiltModels = Array.isArray(payload.prebuiltModels) ? payload.prebuiltModels : [];
        this.webgpuSupported = payload.webgpuSupported !== false;
        this.statusText = this.webgpuSupported
          ? "Choose a model and load it."
          : "WebGPU is unavailable, so WebLLM cannot run here.";
        this.restorePersistedModel();
        break;
      }

      case WORKER_OUTBOUND.CACHE_STATUS: {
        this.cachedModelIds = Array.isArray(payload.cachedModelIds) ? payload.cachedModelIds : [];
        this.cacheStatusReady = true;
        break;
      }

      case WORKER_OUTBOUND.DISCARD_COMPLETE: {
        if (payload.requestId !== this.pendingDiscardRequestId) {
          return;
        }

        const discardedModelId = String(payload.modelId || "");

        this.pendingDiscardRequestId = "";
        this.isDiscardingModelId = "";
        this.cachedModelIds = this.cachedModelIds.filter((modelId) => modelId !== discardedModelId);

        if (discardedModelId && this.activeModelId === discardedModelId) {
          this.activeGpuVendor = "";
          this.activeMaxStorageBufferBindingSize = null;
          this.activeModelId = "";
          this.activeModelSource = "";
          this.loadingModelLabel = "";
          clearPersistedModelSelection();
        }

        this.error = "";
        this.statusText = discardedModelId
          ? `Discarded cached files for ${discardedModelId}.`
          : "Discarded cached model files.";
        break;
      }

      case WORKER_OUTBOUND.DISCARD_ERROR: {
        if (payload.requestId !== this.pendingDiscardRequestId) {
          return;
        }

        this.pendingDiscardRequestId = "";
        this.isDiscardingModelId = "";
        this.error = payload.error?.message || "Cached model discard failed.";
        this.statusText = "Cached model discard failed.";
        break;
      }

      case WORKER_OUTBOUND.LOAD_PROGRESS: {
        if (payload.requestId !== this.pendingLoadRequestId) {
          return;
        }

        this.loadProgress = {
          progress: Number(payload.report?.progress || 0),
          text: String(payload.report?.text || ""),
          timeElapsed: Number(payload.report?.timeElapsed || 0)
        };
        this.statusText = this.isRestoringPersistedModel ? "Restoring model..." : "Loading model...";
        break;
      }

      case WORKER_OUTBOUND.LOAD_COMPLETE: {
        if (payload.requestId !== this.pendingLoadRequestId) {
          return;
        }

        this.isLoadingModel = false;
        this.isRestoringPersistedModel = false;
        this.pendingLoadRequestId = "";
        this.loadProgress = {
          progress: 1,
          text: "Model ready.",
          timeElapsed: this.loadProgress.timeElapsed
        };
        this.activeGpuVendor = String(payload.gpuVendor || "");
        this.activeMaxStorageBufferBindingSize = Number(payload.maxStorageBufferBindingSize || 0) || null;
        this.activeModelId = String(payload.modelId || "");
        this.activeModelSource = String(payload.source || "prebuilt");
        if (this.customModelUrl && !this.customModelId && this.activeModelSource === "custom") {
          this.customModelId = this.activeModelId;
        }
        this.loadingModelLabel = "";
        this.error = "";
        this.statusText = this.activeGpuVendor
          ? `Loaded ${this.activeModelId} on ${this.activeGpuVendor}.`
          : `Loaded ${this.activeModelId}.`;
        this.persistLoadedModel();
        break;
      }

      case WORKER_OUTBOUND.LOAD_ERROR: {
        if (payload.requestId !== this.pendingLoadRequestId) {
          return;
        }

        this.isLoadingModel = false;
        this.isRestoringPersistedModel = false;
        this.pendingLoadRequestId = "";
        this.loadingModelLabel = "";
        this.error = payload.error?.message || "Model load failed.";
        this.statusText = "Model load failed.";
        break;
      }

      case WORKER_OUTBOUND.UNLOAD_COMPLETE: {
        if (payload.requestId !== this.pendingUnloadRequestId) {
          return;
        }

        this.isUnloadingModel = false;
        this.pendingUnloadRequestId = "";
        this.isLoadingModel = false;
        this.isRestoringPersistedModel = false;
        this.pendingLoadRequestId = "";
        this.loadProgress = {
          progress: 0,
          text: "",
          timeElapsed: 0
        };
        this.activeGpuVendor = "";
        this.activeMaxStorageBufferBindingSize = null;
        this.activeModelId = "";
        this.activeModelSource = "";
        this.loadingModelLabel = "";
        this.error = "";
        this.statusText = payload.stoppedLoad ? "Model load stopped." : "Model unloaded.";
        clearPersistedModelSelection();
        break;
      }

      case WORKER_OUTBOUND.UNLOAD_ERROR: {
        if (payload.requestId !== this.pendingUnloadRequestId) {
          return;
        }

        this.isUnloadingModel = false;
        this.pendingUnloadRequestId = "";
        this.error = payload.error?.message || "Model unload failed.";
        this.statusText = "Model unload failed.";
        break;
      }

      case WORKER_OUTBOUND.CHAT_DELTA: {
        if (payload.requestId !== this.pendingGenerateRequestId || !this.pendingAssistantMessageId) {
          return;
        }

        const nextText = String(payload.text || "");
        this.messages = updateMessageById(this.messages, this.pendingAssistantMessageId, (message) => ({
          ...message,
          content: nextText,
          isStreaming: true
        }));
        this.scheduleThreadScrollToBottom();
        break;
      }

      case WORKER_OUTBOUND.INTERRUPT_ACK: {
        if (payload.requestId !== this.pendingGenerateRequestId) {
          return;
        }

        this.isStopRequested = true;
        this.statusText = "Stopping generation...";
        break;
      }

      case WORKER_OUTBOUND.CHAT_COMPLETE: {
        if (payload.requestId !== this.pendingGenerateRequestId || !this.pendingAssistantMessageId) {
          return;
        }

        const finishReason = String(payload.finishReason || "stop");
        const elapsedMs = Math.max(Date.now() - this.generationStartTimeMs, 0);
        const metrics = normalizeUsageMetrics(payload.usage, { elapsedMs });

        this.messages = updateMessageById(this.messages, this.pendingAssistantMessageId, (message) => ({
          ...message,
          content: String(payload.text || message.content || ""),
          finishReason,
          isStreaming: false,
          metrics
        }));
        this.lastUsageMetrics = metrics;
        this.isGenerating = false;
        this.isStopRequested = false;
        this.pendingAssistantMessageId = "";
        this.pendingGenerateRequestId = "";
        this.statusText = finishReason === "abort" ? "Generation stopped." : "Reply complete.";
        this.scheduleThreadScrollToBottom();
        break;
      }

      case WORKER_OUTBOUND.CHAT_ERROR: {
        if (payload.requestId !== this.pendingGenerateRequestId) {
          return;
        }

        if (this.pendingAssistantMessageId) {
          this.messages = updateMessageById(this.messages, this.pendingAssistantMessageId, (message) => ({
            ...message,
            content: message.content || "Generation failed.",
            finishReason: "error",
            isStreaming: false
          }));
        }

        this.error = payload.error?.message || "Generation failed.";
        this.statusText = "Generation failed.";
        this.isGenerating = false;
        this.isStopRequested = false;
        this.pendingAssistantMessageId = "";
        this.pendingGenerateRequestId = "";
        break;
      }

      case WORKER_OUTBOUND.CHAT_RESET: {
        this.statusText = this.activeModelId
          ? `Chat cleared for ${this.activeModelId}.`
          : "Chat cleared.";
        break;
      }

      default:
        break;
    }
  },

  handleLoadModel() {
    if (!this.worker || !this.isWorkerReady) {
      this.error = "The WebLLM worker is still starting.";
      return;
    }

    if (!this.webgpuSupported) {
      this.error = "WebGPU is unavailable in this browser context.";
      return;
    }

    if (this.isGenerating) {
      this.error = "Stop the current generation before loading another model.";
      return;
    }

    const validationError = validateModelSelection(this);
    if (validationError) {
      this.error = validationError;
      return;
    }

    this.pendingLoadRequestId = crypto.randomUUID();
    this.isLoadingModel = true;
    this.loadingModelLabel = describeModelSelection(this);
    this.error = "";
    this.loadProgress = {
      progress: 0,
      text: "",
      timeElapsed: 0
    };
    this.statusText = `Loading ${describeModelSelection(this)}...`;
    this.worker.postMessage({
      payload: {
        customModelId: this.customModelId,
        customModelLibUrl: this.customModelLibUrl,
        customModelUrl: this.customModelUrl,
        modelId: this.modelId,
        requestId: this.pendingLoadRequestId
      },
      type: WORKER_INBOUND.LOAD_MODEL
    });
  },

  handleLoadCustomModel() {
    const hasCustomFields = Boolean(String(this.customModelUrl || "").trim()
      || String(this.customModelLibUrl || "").trim()
      || String(this.customModelId || "").trim());

    if (!hasCustomFields) {
      this.error = "Enter a compiled model URL and model library URL first.";
      return;
    }

    this.handleLoadModel();
  },

  usePrebuiltModel(modelId, options = {}) {
    const selectedModel = this.prebuiltModels.find((model) => model.model_id === modelId);
    if (!selectedModel) {
      return;
    }

    this.modelId = selectedModel.model_id;
    this.customModelId = "";
    this.customModelLibUrl = "";
    this.customModelUrl = "";
    this.error = "";
    this.statusText = `Selected ${selectedModel.model_id}.`;

    if (options.load === true) {
      this.handleLoadModel();
    }
  },

  handlePrebuiltModelAction(modelRecord) {
    if (!modelRecord?.model_id) {
      return;
    }

    if (this.isActivePrebuiltModel(modelRecord.model_id)) {
      this.requestUnloadModel();
      return;
    }

    this.usePrebuiltModel(modelRecord.model_id, { load: true });
  },

  requestDiscardCachedModel(modelId) {
    const normalizedModelId = String(modelId || "").trim();
    if (!this.worker || !normalizedModelId || this.isDiscardingModelId) {
      return;
    }

    if (!this.isModelCached(normalizedModelId)) {
      return;
    }

    if (this.isGenerating) {
      this.error = "Stop the current generation before discarding cached model files.";
      return;
    }

    if (this.isLoadingModel || this.isUnloadingModel) {
      this.error = "Wait for the current model transition to finish before discarding cached model files.";
      return;
    }

    this.error = "";
    this.isDiscardingModelId = normalizedModelId;
    this.pendingDiscardRequestId = crypto.randomUUID();
    this.statusText = `Discarding cached files for ${normalizedModelId}...`;
    this.worker.postMessage({
      payload: {
        modelId: normalizedModelId,
        requestId: this.pendingDiscardRequestId
      },
      type: WORKER_INBOUND.DISCARD_MODEL_CACHE
    });
  },

  isModelCached(modelId) {
    return this.cachedModelIds.includes(modelId);
  },

  isDiscardingModel(modelId) {
    return this.isDiscardingModelId === modelId;
  },

  canDiscardCachedModel(modelId) {
    return this.isModelCached(modelId)
      && !this.isGenerating
      && !this.isLoadingModel
      && !this.isUnloadingModel
      && !this.isDiscardingModelId;
  },

  isActivePrebuiltModel(modelId) {
    return this.activeModelSource === "prebuilt" && this.activeModelId === modelId;
  },

  isDownloadingPendingModel() {
    return Boolean(this.modelId) && !this.isModelCached(this.modelId);
  },

  formatModelSizeLabel(vramRequiredMb) {
    const numericValue = Number(vramRequiredMb || 0);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return "";
    }

    if (numericValue >= 1000) {
      return `${formatNumber(numericValue / 1000, 1)} GB`;
    }

    return `${formatNumber(numericValue, 0)} MB`;
  },

  getModelListActionLabel(modelRecord) {
    if (!modelRecord?.model_id) {
      return "Enable";
    }

    if (this.isActivePrebuiltModel(modelRecord.model_id)) {
      return "Unload";
    }

    if (this.isModelCached(modelRecord.model_id)) {
      return "Enable";
    }

    const sizeLabel = this.formatModelSizeLabel(modelRecord.vram_required_MB);
    return sizeLabel ? `Download ${sizeLabel}` : "Download";
  },

  requestUnloadModel() {
    if (!this.worker || (!this.activeModelId && !this.isLoadingModel) || this.isUnloadingModel) {
      return;
    }

    if (this.isGenerating) {
      this.error = "Stop the current generation before unloading the model.";
      return;
    }

    this.error = "";
    this.isUnloadingModel = true;
    this.pendingUnloadRequestId = crypto.randomUUID();
    this.statusText = this.isLoadingModel
      ? `Stopping ${this.loadingModelLabel || "model load"}...`
      : `Unloading ${this.activeModelId}...`;
    this.worker.postMessage({
      payload: {
        requestId: this.pendingUnloadRequestId
      },
      type: WORKER_INBOUND.UNLOAD_MODEL
    });
  },

  persistLoadedModel() {
    if (!this.activeModelId) {
      return;
    }

    if (this.activeModelSource === "custom" && this.customModelUrl && this.customModelLibUrl) {
      persistModelSelection({
        customModelId: this.customModelId || this.activeModelId,
        customModelLibUrl: this.customModelLibUrl,
        customModelUrl: this.customModelUrl,
        modelId: this.activeModelId,
        source: "custom"
      });
      return;
    }

    persistModelSelection({
      modelId: this.activeModelId,
      source: "prebuilt"
    });
  },

  restorePersistedModel() {
    if (this.hasTriedPersistedReload || !this.isWorkerReady || !this.webgpuSupported) {
      return;
    }

    this.hasTriedPersistedReload = true;
    const persistedSelection = readPersistedModelSelection();
    if (!persistedSelection) {
      return;
    }

    this.error = "";
    this.isRestoringPersistedModel = true;

    if (persistedSelection.source === "custom") {
      this.modelId = "";
      this.customModelUrl = persistedSelection.customModelUrl;
      this.customModelLibUrl = persistedSelection.customModelLibUrl;
      this.customModelId = persistedSelection.customModelId || "";
    } else {
      this.modelId = persistedSelection.modelId;
      this.customModelUrl = "";
      this.customModelLibUrl = "";
      this.customModelId = "";
    }

    this.handleLoadModel();
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
    if (this.isGenerating) {
      this.requestStop();
      return;
    }

    void this.sendMessage();
  },

  async sendMessage() {
    const trimmedDraft = String(this.draft || "").trim();

    if (!trimmedDraft) {
      return;
    }

    if (!this.worker || !this.activeModelId) {
      this.error = "Load a model before sending a message.";
      return;
    }

    const userMessage = createChatMessage("user", trimmedDraft);
    const conversationMessages = [...this.messages, userMessage];
    const currentModelId = this.activeModelId;
    const assistantMessage = createChatMessage("assistant", "");
    assistantMessage.isStreaming = true;
    assistantMessage.modelId = currentModelId;

    this.messages = [...conversationMessages, assistantMessage];
    this.draft = "";
    this.error = "";
    this.isGenerating = true;
    this.isStopRequested = false;
    this.pendingAssistantMessageId = assistantMessage.id;
    this.pendingGenerateRequestId = crypto.randomUUID();
    this.generationStartTimeMs = Date.now();
    this.statusText = `Generating with ${currentModelId}...`;
    this.syncComposerHeight();
    this.scheduleThreadScrollToBottom();

    this.worker.postMessage({
      payload: {
        messages: buildChatMessages(this.systemPrompt, conversationMessages),
        requestId: this.pendingGenerateRequestId
      },
      type: WORKER_INBOUND.RUN_CHAT
    });
  },

  requestStop() {
    if (!this.worker || !this.pendingGenerateRequestId || this.isStopRequested) {
      return;
    }

    this.isStopRequested = true;
    this.statusText = "Stopping generation...";
    this.worker.postMessage({
      payload: {
        requestId: this.pendingGenerateRequestId
      },
      type: WORKER_INBOUND.INTERRUPT
    });
  },

  clearChat() {
    this.draft = "";
    this.messages = [];
    this.lastUsageMetrics = null;
    this.error = "";
    this.pendingAssistantMessageId = "";
    this.pendingGenerateRequestId = "";
    this.isGenerating = false;
    this.isStopRequested = false;

    if (this.worker) {
      this.worker.postMessage({
        type: WORKER_INBOUND.RESET_CHAT
      });
    }

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

  inferModelFamily(modelId) {
    return inferModelFamily(modelId);
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

space.fw.createStore("webllm", model);
