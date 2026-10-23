import { buildHuggingFaceFallbackPrompt, normalizeHuggingFaceModelInput, normalizeMaxNewTokens } from "/modules/_core/huggingface/helpers.js";
import { WORKER_INBOUND, WORKER_OUTBOUND } from "/modules/_core/huggingface/protocol.js";

let runtimeModulePromise = null;
let generator = null;
let processor = null;
let tokenizer = null;
let currentGenerateRequestId = "";
let currentLoadRequestId = "";
let currentModelId = "";
let currentDtype = "";
let currentStopper = null;
let currentLoadProgressTracker = null;
const LOAD_PROGRESS_EMIT_INTERVAL_MS = 120;

function postMessageToHost(type, payload = {}) {
  self.postMessage({ payload, type });
}

function postTrace(stage, details = {}) {
  postMessageToHost(WORKER_OUTBOUND.TRACE, {
    currentDtype,
    currentModelId,
    stage,
    timestamp: Date.now(),
    ...details
  });
}

function createWorkerError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function clampProgress(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function readFiniteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function serializeError(error) {
  if (error instanceof Error) {
    const { cause, code, message, name, stack, ...details } = error;
    return {
      code: code ?? null,
      details,
      message,
      name: name || "Error",
      stack: stack || "",
      cause: cause == null ? null : String(cause)
    };
  }

  return {
    code: null,
    details: {},
    message: String(error || "Unknown worker error"),
    name: typeof error,
    stack: ""
  };
}

function logWorkerConsoleError(label, error, details = {}) {
  forwardWorkerConsoleError(`[huggingface-worker] ${label}`, {
    ...details,
    serialized: serializeError(error)
  }, error);
  console.error(`[huggingface-worker] ${label}`, {
    ...details,
    serialized: serializeError(error)
  }, error);
}

function serializeConsoleArg(value) {
  if (value instanceof Error) {
    return {
      kind: "error",
      value: serializeError(value)
    };
  }

  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return {
      items: value.slice(0, 12).map((entry) => serializeConsoleArg(entry)),
      kind: "array",
      length: value.length
    };
  }

  if (typeof value === "object") {
    const summary = {
      kind: value.constructor?.name || "object"
    };

    if ("message" in value && value.message != null) {
      summary.message = String(value.message);
    }

    if ("name" in value && value.name != null) {
      summary.name = String(value.name);
    }

    if ("type" in value && value.type != null) {
      summary.type = String(value.type);
    }

    if ("reason" in value && value.reason != null) {
      summary.reason = serializeConsoleArg(value.reason);
    }

    if ("filename" in value && value.filename != null) {
      summary.filename = String(value.filename);
    }

    if ("lineno" in value && value.lineno != null) {
      summary.lineno = Number(value.lineno);
    }

    if ("colno" in value && value.colno != null) {
      summary.colno = Number(value.colno);
    }

    const ownEntries = Object.entries(value).slice(0, 12);
    if (ownEntries.length) {
      summary.entries = Object.fromEntries(
        ownEntries.map(([key, entryValue]) => [key, serializeConsoleArg(entryValue)])
      );
    }

    return summary;
  }

  return String(value);
}

function forwardWorkerConsoleError(...args) {
  try {
    postMessageToHost(WORKER_OUTBOUND.CONSOLE_ERROR, {
      args: args.map((arg) => serializeConsoleArg(arg)),
      currentDtype,
      currentModelId,
      loadRequestId: currentLoadRequestId,
      timestamp: Date.now()
    });
  } catch {
    // Do not let logging failures mask the original worker error.
  }
}

function postWorkerError(type, error, details = {}) {
  const requestId = String(details.requestId || crypto.randomUUID());
  logWorkerConsoleError(type, error, details);
  postMessageToHost(type, {
    error: serializeError(error),
    requestId
  });
}

function normalizeProgressValue(report = {}) {
  const loaded = Number(report.loaded);
  const total = Number(report.total);
  if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
    return clampProgress(loaded / total);
  }

  const directProgress = Number(report.progress);
  if (Number.isFinite(directProgress) && directProgress > 1) {
    return clampProgress(directProgress / 100);
  }

  if (Number.isFinite(directProgress) && directProgress >= 0) {
    return clampProgress(directProgress);
  }

  return 0;
}

function normalizeProgressStatus(report = {}) {
  const rawStatus = String(report.status || "").trim().toLowerCase();

  if (rawStatus === "progress") {
    return "download";
  }

  if (rawStatus === "done") {
    return "done";
  }

  if (rawStatus === "ready") {
    return "ready";
  }

  return rawStatus || "loading";
}

function resolveProgressSource(report = {}, modelId = "") {
  const name = String(report.name || "").trim();
  const file = String(report.file || "").trim();
  return file || name || modelId || "model";
}

function formatProgressBytes(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = numericValue;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatProgressDetail(report = {}) {
  const loaded = Number(report.loaded);
  const total = Number(report.total);

  if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
    return `${formatProgressBytes(loaded)} / ${formatProgressBytes(total)}`;
  }

  const normalizedProgress = normalizeProgressValue(report);
  if (Number.isFinite(normalizedProgress) && normalizedProgress > 0) {
    return `${Math.round(normalizedProgress * 100)}%`;
  }

  return "";
}

function createLoadProgressTracker() {
  return {
    files: new Map(),
    lastReport: null,
    timerId: null
  };
}

function clearLoadProgressTrackerTimer(tracker) {
  if (!tracker?.timerId) {
    return;
  }

  clearTimeout(tracker.timerId);
  tracker.timerId = null;
}

function disposeLoadProgressTracker(tracker) {
  if (!tracker) {
    return;
  }

  clearLoadProgressTrackerTimer(tracker);
  tracker.files.clear();
  tracker.lastReport = null;
}

function updateLoadProgressTracker(tracker, report = {}, modelId = "") {
  if (!tracker?.files) {
    return null;
  }

  const source = resolveProgressSource(report, modelId);
  const previousEntry = tracker.files.get(source) || null;
  const status = normalizeProgressStatus(report);
  const loaded = readFiniteNumber(report.loaded);
  const total = readFiniteNumber(report.total);

  const nextEntry = {
    loaded: loaded != null && loaded >= 0
      ? loaded
      : previousEntry?.loaded ?? null,
    progress: normalizeProgressValue(report),
    source,
    status,
    total: total != null && total > 0
      ? total
      : previousEntry?.total ?? null,
    updatedAt: Date.now()
  };

  if (nextEntry.total != null && nextEntry.total > 0) {
    const previousLoaded = previousEntry?.loaded ?? 0;
    const boundedLoaded = Math.min(nextEntry.total, Math.max(nextEntry.loaded ?? 0, previousLoaded));
    nextEntry.loaded = status === "done" ? nextEntry.total : boundedLoaded;
    nextEntry.progress = clampProgress(nextEntry.loaded / nextEntry.total);
  } else if (status === "done") {
    nextEntry.progress = 1;
  }

  tracker.files.set(source, nextEntry);
  tracker.lastReport = report;
  return nextEntry;
}

function summarizeLoadProgress(tracker, report = {}, modelId = "") {
  const source = resolveProgressSource(report, modelId);
  const rawStatus = normalizeProgressStatus(report);
  const entries = tracker?.files ? Array.from(tracker.files.values()) : [];
  const aggregateEntries = entries.filter((entry) => Number.isFinite(entry.total) && entry.total > 0);
  const activeDownloadEntries = entries.filter((entry) => entry.status === "download");
  const aggregateLoaded = aggregateEntries.reduce((sum, entry) => sum + Math.min(entry.loaded ?? 0, entry.total), 0);
  const aggregateTotal = aggregateEntries.reduce((sum, entry) => sum + entry.total, 0);
  const aggregateProgress = aggregateTotal > 0
    ? clampProgress(aggregateLoaded / aggregateTotal)
    : normalizeProgressValue(report);
  const aggregateDetail = aggregateTotal > 0
    ? `${formatProgressBytes(aggregateLoaded)} / ${formatProgressBytes(aggregateTotal)}`
    : formatProgressDetail(report);

  let status = rawStatus;
  let stepLabel = "";

  if (activeDownloadEntries.length > 0 || rawStatus === "download") {
    status = "download";
    stepLabel = aggregateDetail
      ? `Downloading model files (${aggregateDetail})`
      : "Downloading model files";
  } else if (rawStatus === "done") {
    status = "loading";
    stepLabel = aggregateDetail
      ? `Finalizing model (${aggregateDetail})`
      : "Finalizing model";
  } else if (rawStatus === "ready") {
    status = "loading";
    stepLabel = "Preparing runtime";
  } else if (rawStatus === "loading") {
    stepLabel = "Preparing runtime";
  } else if (rawStatus === "initiate" || rawStatus === "init") {
    stepLabel = "Starting model load";
  } else {
    const fallbackSource = source || modelId || "model";
    stepLabel = `${rawStatus.charAt(0).toUpperCase()}${rawStatus.slice(1)} ${fallbackSource}`.trim();
  }

  let visibleProgress = aggregateProgress;

  // Keep final runtime preparation visually distinct from true completion.
  // The load is not actually done until LOAD_COMPLETE arrives from the worker.
  if (status === "loading" && visibleProgress >= 1) {
    visibleProgress = 0.99;
  }

  return {
    file: activeDownloadEntries[0]?.source || source,
    loaded: aggregateLoaded,
    progress: visibleProgress,
    status,
    stepId: aggregateTotal > 0
      ? `${status}:${Math.round(aggregateLoaded)}:${Math.round(aggregateTotal)}`
      : `${status}:${source}`,
    stepLabel,
    total: aggregateTotal
  };
}

function flushLoadProgressTracker(tracker, requestId, modelId = "") {
  if (!tracker || currentLoadProgressTracker !== tracker) {
    return;
  }

  clearLoadProgressTrackerTimer(tracker);

  if (currentLoadRequestId !== requestId || !tracker.lastReport) {
    return;
  }

  postMessageToHost(WORKER_OUTBOUND.LOAD_PROGRESS, {
    report: summarizeLoadProgress(tracker, tracker.lastReport, modelId),
    requestId
  });
}

function scheduleLoadProgressTrackerFlush(tracker, requestId, modelId = "") {
  if (!tracker || currentLoadProgressTracker !== tracker || tracker.timerId) {
    return;
  }

  tracker.timerId = setTimeout(() => {
    flushLoadProgressTracker(tracker, requestId, modelId);
  }, LOAD_PROGRESS_EMIT_INTERVAL_MS);
}

function extractFirstSequenceLength(inputIds) {
  if (!inputIds) {
    return 0;
  }

  if (Array.isArray(inputIds)) {
    if (Array.isArray(inputIds[0])) {
      return inputIds[0].length;
    }

    return inputIds.length;
  }

  if (typeof inputIds.tolist === "function") {
    return extractFirstSequenceLength(inputIds.tolist());
  }

  if (Array.isArray(inputIds.dims) && inputIds.dims.length >= 2) {
    return Number(inputIds.dims.at(-1) || 0);
  }

  return 0;
}

function extractFirstSequence(outputIds) {
  if (!outputIds) {
    return [];
  }

  if (Array.isArray(outputIds)) {
    if (Array.isArray(outputIds[0])) {
      return [...outputIds[0]];
    }

    return [...outputIds];
  }

  if (typeof outputIds.tolist === "function") {
    return extractFirstSequence(outputIds.tolist());
  }

  return [];
}

async function ensureRuntimeModule() {
  if (!runtimeModulePromise) {
    runtimeModulePromise = import("/modules/_core/huggingface/transformers.js");
  }

  return runtimeModulePromise;
}

async function resolveChatProcessor(runtimeModule, modelId, loadOptions = {}) {
  const pipelineProcessor = generator?.processor || null;

  if (pipelineProcessor) {
    postTrace("processor-load:pipeline", {
      hasApplyChatTemplate: typeof pipelineProcessor.apply_chat_template === "function",
      hasTokenizer: Boolean(pipelineProcessor?.tokenizer),
      modelId,
      processorType: pipelineProcessor?.constructor?.name || ""
    });
    return {
      processor: pipelineProcessor,
      source: "pipeline"
    };
  }

  const { AutoProcessor } = runtimeModule || {};
  if (typeof AutoProcessor?.from_pretrained !== "function") {
    postTrace("processor-load:unavailable", {
      modelId
    });
    return {
      processor: null,
      source: ""
    };
  }

  postTrace("processor-load:start", {
    modelId,
    source: "auto-processor"
  });

  try {
    const loadedProcessor = await AutoProcessor.from_pretrained(modelId, loadOptions);
    postTrace("processor-load:done", {
      hasApplyChatTemplate: typeof loadedProcessor?.apply_chat_template === "function",
      hasTokenizer: Boolean(loadedProcessor?.tokenizer),
      modelId,
      processorType: loadedProcessor?.constructor?.name || "",
      source: "auto-processor"
    });
    return {
      processor: loadedProcessor || null,
      source: loadedProcessor ? "auto-processor" : ""
    };
  } catch (error) {
    const serializedError = serializeError(error);
    postTrace("processor-load:failed", {
      errorMessage: serializedError.message,
      errorName: serializedError.name,
      modelId,
      source: "auto-processor"
    });
    return {
      processor: null,
      source: ""
    };
  }
}

async function preparePrompt(messages = []) {
  if (!tokenizer) {
    throw new Error("Load a model before sending a chat message.");
  }

  if (typeof processor?.apply_chat_template === "function") {
    try {
      const promptText = processor.apply_chat_template(messages, {
        add_generation_prompt: true,
        enable_thinking: false,
        tokenize: false
      });

      if (typeof promptText === "string" && promptText.length > 0) {
        // Tokenize the rendered processor template directly because Gemma processor tokenization can throw.
        const promptInputs = await tokenizer(promptText, {
          add_special_tokens: false,
          return_dict: true,
          return_tensor: false
        });

        postTrace("prompt:processor-template", {
          messageCount: Array.isArray(messages) ? messages.length : 0,
          promptLength: promptText.length
        });

        return {
          addSpecialTokens: false,
          promptText,
          promptTokenCount: extractFirstSequenceLength(promptInputs?.input_ids)
        };
      }
    } catch (error) {
      postTrace("prompt:processor-template-failed", {
        errorMessage: serializeError(error).message,
        errorName: serializeError(error).name
      });
      // Fall back to tokenizer formatting or handwritten prompt formatting when the processor template is unavailable.
    }
  }

  if (typeof tokenizer.apply_chat_template === "function") {
    try {
      const promptText = tokenizer.apply_chat_template(messages, {
        add_generation_prompt: true,
        tokenize: false
      });

      if (typeof promptText === "string" && promptText.length > 0) {
        const inputs = await tokenizer(promptText, {
          add_special_tokens: false,
          return_dict: true,
          return_tensor: false
        });

        postTrace("prompt:tokenizer-template", {
          messageCount: Array.isArray(messages) ? messages.length : 0,
          promptLength: promptText.length
        });

        return {
          addSpecialTokens: false,
          promptText,
          promptTokenCount: extractFirstSequenceLength(inputs?.input_ids)
        };
      }
    } catch (error) {
      postTrace("prompt:tokenizer-template-failed", {
        errorMessage: serializeError(error).message,
        errorName: serializeError(error).name
      });
      // Fall back to plain prompt formatting when the tokenizer lacks a usable chat template.
    }
  }

  const promptText = buildHuggingFaceFallbackPrompt(messages);
  const addSpecialTokens = (tokenizer.add_bos_token || tokenizer.add_eos_token) ?? false;
  postTrace("prompt:fallback-template", {
    messageCount: Array.isArray(messages) ? messages.length : 0,
    promptLength: promptText.length
  });
  const inputs = await tokenizer(promptText, {
    add_special_tokens: addSpecialTokens,
    return_dict: true,
    return_tensor: false
  });

  return {
    addSpecialTokens,
    promptText,
    promptTokenCount: extractFirstSequenceLength(inputs?.input_ids)
  };
}

async function handleLoadModel(payload = {}) {
  const requestId = String(payload.requestId || crypto.randomUUID());

  if (currentGenerateRequestId) {
    postWorkerError(
      WORKER_OUTBOUND.LOAD_ERROR,
      createWorkerError("Stop the current generation before loading another model."),
      {
        activeModelId: currentModelId,
        dtype: payload.dtype,
        modelInput: payload.modelInput,
        requestId
      }
    );
    return;
  }

  const modelId = normalizeHuggingFaceModelInput(payload.modelId || payload.modelInput);
  const dtype = String(payload.dtype || "").trim() || "q4";

  if (!modelId) {
    postWorkerError(
      WORKER_OUTBOUND.LOAD_ERROR,
      createWorkerError("Enter a Hugging Face model id or Hub URL."),
      {
        dtype,
        modelInput: payload.modelInput,
        requestId
      }
    );
    return;
  }

  currentLoadRequestId = requestId;
  currentLoadProgressTracker = createLoadProgressTracker();
  generator = null;
  processor = null;
  tokenizer = null;
  currentModelId = "";
  currentDtype = "";

  try {
    postTrace("load:start", {
      dtype,
      modelId,
      requestId
    });
    postTrace("runtime-import:start", {
      requestId
    });
    const runtimeModule = await ensureRuntimeModule();
    postTrace("runtime-import:done", {
      requestId
    });
    const { pipeline } = runtimeModule;
    const progress_callback = (report) => {
      if (currentLoadRequestId !== requestId) {
        return;
      }

      updateLoadProgressTracker(currentLoadProgressTracker, report, modelId);
      scheduleLoadProgressTrackerFlush(currentLoadProgressTracker, requestId, modelId);
    };

    postTrace("pipeline-load:start", {
      modelId,
      requestId
    });
    generator = await pipeline("text-generation", modelId, {
      device: "webgpu",
      dtype,
      progress_callback
    });
    flushLoadProgressTracker(currentLoadProgressTracker, requestId, modelId);
    const resolvedProcessor = await resolveChatProcessor(runtimeModule, modelId, {
      device: "webgpu",
      dtype,
      progress_callback
    });
    processor = resolvedProcessor.processor;
    tokenizer = generator?.tokenizer || processor?.tokenizer || null;
    postTrace("pipeline-load:done", {
      dtype,
      modelId,
      processorSource: resolvedProcessor.source,
      processorType: processor?.constructor?.name || "",
      requestId,
      resolvedProcessor: Boolean(processor),
      tokenizerHasChatTemplate: typeof tokenizer?.apply_chat_template === "function"
    });

    if (currentLoadRequestId !== requestId) {
      return;
    }

    currentModelId = modelId;
    currentDtype = dtype;

    postMessageToHost(WORKER_OUTBOUND.LOAD_COMPLETE, {
      dtype,
      modelId,
      requestId
    });
    return;
  } catch (error) {
    disposeLoadProgressTracker(currentLoadProgressTracker);
    currentLoadProgressTracker = null;
    generator = null;
    processor = null;
    tokenizer = null;
    currentModelId = "";
    currentDtype = "";

    postWorkerError(WORKER_OUTBOUND.LOAD_ERROR, error, {
      dtype,
      modelId,
      requestId
    });
  } finally {
    disposeLoadProgressTracker(currentLoadProgressTracker);
    currentLoadProgressTracker = null;
    currentLoadRequestId = "";
  }
}

async function handleRunChat(payload = {}) {
  const requestId = String(payload.requestId || crypto.randomUUID());

  if (!tokenizer || !generator || !currentModelId) {
    postWorkerError(
      WORKER_OUTBOUND.CHAT_ERROR,
      createWorkerError("Load a model before sending a chat message."),
      {
        activeModelId: currentModelId,
        messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
        requestId
      }
    );
    return;
  }

  if (currentLoadRequestId) {
    postWorkerError(
      WORKER_OUTBOUND.CHAT_ERROR,
      createWorkerError("Wait for the current model load to finish before sending a message."),
      {
        activeModelId: currentModelId,
        requestId
      }
    );
    return;
  }

  if (currentGenerateRequestId) {
    postWorkerError(
      WORKER_OUTBOUND.CHAT_ERROR,
      createWorkerError("A generation is already running."),
      {
        activeModelId: currentModelId,
        requestId
      }
    );
    return;
  }

  currentGenerateRequestId = requestId;

  try {
    const runtimeModule = await ensureRuntimeModule();
    const { StoppingCriteria, TextStreamer } = runtimeModule;
    const { addSpecialTokens, promptText, promptTokenCount } = await preparePrompt(payload.messages);
    const requestOptions =
      payload.requestOptions && typeof payload.requestOptions === "object" && !Array.isArray(payload.requestOptions)
        ? { ...payload.requestOptions }
        : {};
    const maxNewTokens = normalizeMaxNewTokens(
      requestOptions.max_new_tokens ?? requestOptions.maxNewTokens ?? payload.maxNewTokens
    );
    delete requestOptions.max_new_tokens;
    delete requestOptions.maxNewTokens;
    delete requestOptions.add_special_tokens;
    delete requestOptions.return_full_text;

    if (!Object.hasOwn(requestOptions, "do_sample")) {
      requestOptions.do_sample = Object.hasOwn(requestOptions, "temperature") || Object.hasOwn(requestOptions, "top_p");
    }

    const startedAt = performance.now();
    let timeToFirstTokenMs = null;
    let streamedText = "";

    class WorkerStoppingCriteria extends StoppingCriteria {
      interrupted = false;

      interrupt() {
        this.interrupted = true;
      }

      _call(input_ids) {
        return new Array(Array.isArray(input_ids) ? input_ids.length : 1).fill(this.interrupted);
      }
    }

    class WorkerTextStreamer extends TextStreamer {
      constructor(localTokenizer, onText) {
        super(localTokenizer, {
          callback_function() {},
          skip_prompt: true,
          skip_special_tokens: true
        });
        this.onText = onText;
      }

      put(value) {
        if (value.length > 1) {
          throw Error("WorkerTextStreamer only supports batch size of 1");
        }

        const isPrompt = this.next_tokens_are_prompt;

        if (isPrompt) {
          this.next_tokens_are_prompt = false;

          if (this.skip_prompt) {
            return;
          }
        }

        const tokens = value[0];
        this.token_callback_function?.(tokens);

        if (tokens.length === 1 && this.special_ids.has(tokens[0])) {
          if (this.decode_kwargs.skip_special_tokens) {
            return;
          }

          if (this.token_cache.length > 0) {
            const cachedText = this.tokenizer.decode(this.token_cache, this.decode_kwargs);
            const cachedDelta = cachedText.slice(this.print_len);

            if (cachedDelta) {
              this.onText(cachedDelta);
            }

            this.token_cache = [];
            this.print_len = 0;
          }

          const specialText = this.tokenizer.decode(tokens, this.decode_kwargs);

          if (specialText) {
            this.onText(specialText);
          }

          return;
        }

        this.token_cache.push(...tokens);
        const text = this.tokenizer.decode(this.token_cache, this.decode_kwargs);
        const printableText = text.slice(this.print_len);

        if (!printableText) {
          return;
        }

        this.print_len += printableText.length;
        this.onText(printableText);
      }

      end() {
        if (this.token_cache.length > 0) {
          const text = this.tokenizer.decode(this.token_cache, this.decode_kwargs);
          const printableText = text.slice(this.print_len);

          if (printableText) {
            this.onText(printableText);
          }
        }

        this.token_cache = [];
        this.print_len = 0;
        this.next_tokens_are_prompt = true;
      }
    }

    const stoppingCriteria = new WorkerStoppingCriteria();
    currentStopper = stoppingCriteria;

    const streamer = new WorkerTextStreamer(tokenizer, (text) => {
      if (timeToFirstTokenMs == null) {
        timeToFirstTokenMs = Math.max(performance.now() - startedAt, 0);
      }

      streamedText += text;
      postMessageToHost(WORKER_OUTBOUND.CHAT_DELTA, {
        requestId,
        text: streamedText
      });
    });

    const outputs = await generator(promptText, {
      ...requestOptions,
      add_special_tokens: addSpecialTokens,
      max_new_tokens: maxNewTokens,
      return_full_text: false,
      stopping_criteria: stoppingCriteria,
      streamer
    });

    const generatedResult = Array.isArray(outputs) ? outputs[0] : outputs;
    const generatedTextPayload = generatedResult?.generated_text;
    const decodedText = Array.isArray(generatedTextPayload)
      ? String(generatedTextPayload.at(-1)?.content || "")
      : String(generatedTextPayload || streamedText || "");
    const endToEndLatencySeconds = Math.max(performance.now() - startedAt, 0) / 1000;
    const decodeLatencySeconds = Math.max(endToEndLatencySeconds - ((timeToFirstTokenMs || 0) / 1000), 0);
    const completionTokenIds = await tokenizer(decodedText || streamedText || "", {
      return_dict: true,
      return_tensor: false
    });
    const completionTokens = extractFirstSequenceLength(completionTokenIds?.input_ids);
    const tokensPerSecond = completionTokens > 0 && decodeLatencySeconds > 0
      ? completionTokens / decodeLatencySeconds
      : null;

    postMessageToHost(WORKER_OUTBOUND.CHAT_COMPLETE, {
      finishReason: stoppingCriteria.interrupted ? "abort" : "stop",
      metrics: {
        completionTokens,
        endToEndLatencySeconds,
        promptTokens: promptTokenCount,
        timeToFirstTokenSeconds: timeToFirstTokenMs == null ? null : timeToFirstTokenMs / 1000,
        tokensPerSecond,
        totalTokens: promptTokenCount + completionTokens
      },
      modelId: currentModelId,
      requestId,
      text: decodedText || streamedText || ""
    });
    return;
  } catch (error) {
    postWorkerError(WORKER_OUTBOUND.CHAT_ERROR, error, {
      activeModelId: currentModelId,
      messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
      requestId
    });
  } finally {
    currentGenerateRequestId = "";
    currentStopper = null;
  }
}

function handleInterrupt(payload = {}) {
  if (!currentGenerateRequestId || !currentStopper) {
    return;
  }

  currentStopper.interrupt();
  postMessageToHost(WORKER_OUTBOUND.INTERRUPT_ACK, {
    requestId: String(payload.requestId || currentGenerateRequestId)
  });
}

export function handleWorkerMessage(message = {}) {
  switch (message.type) {
    case WORKER_INBOUND.BOOT: {
      postTrace("worker:boot", {});
      postMessageToHost(WORKER_OUTBOUND.READY, {
        webgpuSupported: Boolean(self.navigator?.gpu)
      });
      break;
    }
    case WORKER_INBOUND.INTERRUPT: {
      handleInterrupt(message.payload);
      break;
    }
    case WORKER_INBOUND.LOAD_MODEL: {
      void handleLoadModel(message.payload);
      break;
    }
    case WORKER_INBOUND.RUN_CHAT: {
      void handleRunChat(message.payload);
      break;
    }
    default:
      break;
  }
}

self.addEventListener("error", (event) => {
  console.error("[huggingface-worker] Unhandled worker error", {
    colno: event.colno,
    error: event.error ? serializeError(event.error) : null,
    filename: event.filename,
    lineno: event.lineno,
    message: event.message
  }, event.error);
});

self.addEventListener("unhandledrejection", (event) => {
  console.error("[huggingface-worker] Unhandled rejection", {
    reason: serializeError(event.reason)
  }, event.reason);
});
