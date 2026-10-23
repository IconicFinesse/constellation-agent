import { deriveModelIdFromUrl } from "/modules/_core/webllm/helpers.js";
import { WORKER_INBOUND, WORKER_OUTBOUND } from "/modules/_core/webllm/protocol.js";
import { deleteModelAllInfoInCache, hasModelInCache, MLCEngine, prebuiltAppConfig } from "/modules/_core/webllm/web-llm.js";

let engine = null;
let currentGenerateRequestId = "";
let currentLoadRequestId = "";
let currentModelId = "";
let currentModelSource = "";

function postMessageToHost(type, payload = {}) {
  self.postMessage({ payload, type });
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack || ""
    };
  }

  return {
    message: String(error || "Unknown worker error"),
    stack: ""
  };
}

function summarizePrebuiltModels() {
  return prebuiltAppConfig.model_list.map((model) => ({
    low_resource_required: Boolean(model.low_resource_required),
    model: model.model,
    model_id: model.model_id,
    model_lib: model.model_lib,
    required_features: Array.isArray(model.required_features) ? [...model.required_features] : [],
    vram_required_MB: Number.isFinite(model.vram_required_MB) ? model.vram_required_MB : null
  }));
}

async function ensureEngine() {
  if (engine) {
    return engine;
  }

  engine = new MLCEngine({
    initProgressCallback(report) {
      if (!currentLoadRequestId) {
        return;
      }

      postMessageToHost(WORKER_OUTBOUND.LOAD_PROGRESS, {
        report,
        requestId: currentLoadRequestId
      });
    }
  });

  return engine;
}

function normalizeLoadRequest(payload = {}) {
  const modelId = String(payload.modelId || "").trim();
  const customModelUrl = String(payload.customModelUrl || "").trim();
  const customModelLibUrl = String(payload.customModelLibUrl || "").trim();
  const customModelId = String(payload.customModelId || "").trim();
  const isCustom = Boolean(customModelUrl || customModelLibUrl || customModelId);

  if (isCustom) {
    if (!customModelUrl || !customModelLibUrl) {
      throw new Error("Custom models require both a model URL and a model library URL.");
    }

    const resolvedModelId = customModelId || deriveModelIdFromUrl(customModelUrl) || `custom-${Date.now()}`;

    return {
      appConfig: {
        model_list: [
          {
            model: customModelUrl,
            model_id: resolvedModelId,
            model_lib: customModelLibUrl
          }
        ]
      },
      modelId: resolvedModelId,
      source: "custom"
    };
  }

  if (!modelId) {
    throw new Error("Choose a prebuilt model or provide custom model URLs.");
  }

  const knownModel = prebuiltAppConfig.model_list.find((model) => model.model_id === modelId);

  if (!knownModel) {
    throw new Error(`Unknown prebuilt model: ${modelId}`);
  }

  return {
    appConfig: prebuiltAppConfig,
    modelId,
    source: "prebuilt"
  };
}

async function handleLoadModel(payload = {}) {
  const requestId = String(payload.requestId || crypto.randomUUID());

  if (currentGenerateRequestId) {
    postMessageToHost(WORKER_OUTBOUND.LOAD_ERROR, {
      error: {
        message: "Stop the current generation before loading another model.",
        stack: ""
      },
      requestId
    });
    return;
  }

  currentLoadRequestId = requestId;

  try {
    const modelRequest = normalizeLoadRequest(payload);
    const runtimeEngine = await ensureEngine();

    runtimeEngine.setAppConfig(modelRequest.appConfig);
    await runtimeEngine.reload(modelRequest.modelId);

    if (currentLoadRequestId !== requestId) {
      return;
    }

    currentModelId = modelRequest.modelId;
    currentModelSource = modelRequest.source;

    const [gpuVendorResult, bufferSizeResult] = await Promise.allSettled([
      runtimeEngine.getGPUVendor(),
      runtimeEngine.getMaxStorageBufferBindingSize()
    ]);

    postMessageToHost(WORKER_OUTBOUND.LOAD_COMPLETE, {
      gpuVendor: gpuVendorResult.status === "fulfilled" ? gpuVendorResult.value : "",
      maxStorageBufferBindingSize:
        bufferSizeResult.status === "fulfilled" ? bufferSizeResult.value : null,
      modelId: currentModelId,
      requestId,
      source: currentModelSource
    });

    void handleScanCache();
  } catch (error) {
    postMessageToHost(WORKER_OUTBOUND.LOAD_ERROR, {
      error: serializeError(error),
      requestId
    });
  } finally {
    currentLoadRequestId = "";
  }
}

async function handleScanCache() {
  const cachedModelIds = [];

  await Promise.allSettled(prebuiltAppConfig.model_list.map(async (modelRecord) => {
    const isCached = await hasModelInCache(modelRecord.model_id, prebuiltAppConfig);
    if (isCached) {
      cachedModelIds.push(modelRecord.model_id);
    }
  }));

  postMessageToHost(WORKER_OUTBOUND.CACHE_STATUS, {
    cachedModelIds
  });
}

async function handleUnloadModel(payload = {}) {
  const requestId = String(payload.requestId || crypto.randomUUID());

  if (currentGenerateRequestId) {
    postMessageToHost(WORKER_OUTBOUND.UNLOAD_ERROR, {
      error: {
        message: "Stop the current generation before unloading the model.",
        stack: ""
      },
      requestId
    });
    return;
  }

  if (!engine && !currentLoadRequestId && !currentModelId) {
    postMessageToHost(WORKER_OUTBOUND.UNLOAD_COMPLETE, {
      requestId
    });
    return;
  }

  try {
    const stoppedLoad = Boolean(currentLoadRequestId);
    currentLoadRequestId = "";
    await engine.unload();
    currentModelId = "";
    currentModelSource = "";

    postMessageToHost(WORKER_OUTBOUND.UNLOAD_COMPLETE, {
      requestId,
      stoppedLoad
    });
  } catch (error) {
    postMessageToHost(WORKER_OUTBOUND.UNLOAD_ERROR, {
      error: serializeError(error),
      requestId
    });
  }
}

async function handleDiscardModelCache(payload = {}) {
  const requestId = String(payload.requestId || crypto.randomUUID());
  const modelId = String(payload.modelId || "").trim();

  if (!modelId) {
    postMessageToHost(WORKER_OUTBOUND.DISCARD_ERROR, {
      error: {
        message: "Choose a cached model to discard.",
        stack: ""
      },
      requestId
    });
    return;
  }

  if (currentGenerateRequestId) {
    postMessageToHost(WORKER_OUTBOUND.DISCARD_ERROR, {
      error: {
        message: "Stop the current generation before discarding cached model files.",
        stack: ""
      },
      requestId
    });
    return;
  }

  if (currentLoadRequestId) {
    postMessageToHost(WORKER_OUTBOUND.DISCARD_ERROR, {
      error: {
        message: "Wait for the current model load to finish before discarding cached model files.",
        stack: ""
      },
      requestId
    });
    return;
  }

  try {
    const unloadedActiveModel = Boolean(engine && currentModelId === modelId);

    if (engine && currentModelId === modelId) {
      await engine.unload();
      currentModelId = "";
      currentModelSource = "";
    }

    await deleteModelAllInfoInCache(modelId, prebuiltAppConfig);

    postMessageToHost(WORKER_OUTBOUND.DISCARD_COMPLETE, {
      modelId,
      requestId,
      unloadedActiveModel
    });

    void handleScanCache();
  } catch (error) {
    postMessageToHost(WORKER_OUTBOUND.DISCARD_ERROR, {
      error: serializeError(error),
      modelId,
      requestId
    });
  }
}

async function handleRunChat(payload = {}) {
  const requestId = String(payload.requestId || crypto.randomUUID());

  if (!engine || !currentModelId) {
    postMessageToHost(WORKER_OUTBOUND.CHAT_ERROR, {
      error: {
        message: "Load a model before sending a chat message.",
        stack: ""
      },
      requestId
    });
    return;
  }

  if (currentLoadRequestId) {
    postMessageToHost(WORKER_OUTBOUND.CHAT_ERROR, {
      error: {
        message: "Wait for the current model load to finish before sending a message.",
        stack: ""
      },
      requestId
    });
    return;
  }

  if (currentGenerateRequestId) {
    postMessageToHost(WORKER_OUTBOUND.CHAT_ERROR, {
      error: {
        message: "A generation is already running.",
        stack: ""
      },
      requestId
    });
    return;
  }

  currentGenerateRequestId = requestId;

  try {
    const responseStream = await engine.chat.completions.create({
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      stream: true,
      stream_options: {
        include_usage: true
      }
    });

    let fullText = "";
    let finishReason = "";
    let usage = null;

    for await (const chunk of responseStream) {
      const delta = chunk?.choices?.[0]?.delta?.content || "";
      const chunkFinishReason = chunk?.choices?.[0]?.finish_reason || "";

      if (delta) {
        fullText += delta;
        postMessageToHost(WORKER_OUTBOUND.CHAT_DELTA, {
          delta,
          requestId,
          text: fullText
        });
      }

      if (chunkFinishReason) {
        finishReason = chunkFinishReason;
      }

      if (chunk?.usage) {
        usage = chunk.usage;
      }
    }

    const currentMessage = await engine.getMessage(currentModelId).catch(() => fullText);

    postMessageToHost(WORKER_OUTBOUND.CHAT_COMPLETE, {
      finishReason: finishReason || "stop",
      modelId: currentModelId,
      requestId,
      text: currentMessage || fullText,
      usage
    });
  } catch (error) {
    postMessageToHost(WORKER_OUTBOUND.CHAT_ERROR, {
      error: serializeError(error),
      requestId
    });
  } finally {
    currentGenerateRequestId = "";
  }
}

async function handleInterrupt(payload = {}) {
  if (!engine || !currentGenerateRequestId) {
    return;
  }

  await engine.interruptGenerate();
  postMessageToHost(WORKER_OUTBOUND.INTERRUPT_ACK, {
    requestId: String(payload.requestId || currentGenerateRequestId)
  });
}

async function handleResetChat() {
  if (engine) {
    await engine.resetChat(true, currentModelId || undefined);
  }

  postMessageToHost(WORKER_OUTBOUND.CHAT_RESET, {});
}

self.addEventListener("message", (event) => {
  const message = event.data || {};

  switch (message.type) {
    case WORKER_INBOUND.BOOT: {
      postMessageToHost(WORKER_OUTBOUND.READY, {
        prebuiltModels: summarizePrebuiltModels(),
        webgpuSupported: Boolean(self.navigator?.gpu)
      });
      void handleScanCache();
      break;
    }
    case WORKER_INBOUND.DISCARD_MODEL_CACHE: {
      void handleDiscardModelCache(message.payload);
      break;
    }
    case WORKER_INBOUND.INTERRUPT: {
      void handleInterrupt(message.payload);
      break;
    }
    case WORKER_INBOUND.LOAD_MODEL: {
      void handleLoadModel(message.payload);
      break;
    }
    case WORKER_INBOUND.RESET_CHAT: {
      void handleResetChat();
      break;
    }
    case WORKER_INBOUND.RUN_CHAT: {
      void handleRunChat(message.payload);
      break;
    }
    case WORKER_INBOUND.SCAN_CACHE: {
      void handleScanCache();
      break;
    }
    case WORKER_INBOUND.UNLOAD_MODEL: {
      void handleUnloadModel(message.payload);
      break;
    }
    default:
      break;
  }
});
