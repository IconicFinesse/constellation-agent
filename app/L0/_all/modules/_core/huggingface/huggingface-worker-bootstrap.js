import { WORKER_OUTBOUND, WORKER_RUNTIME_VERSION } from "/modules/_core/huggingface/protocol.js";

let runtimeModulePromise = null;

function postMessageToHost(type, payload = {}) {
  self.postMessage({ payload, type });
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name || "Error",
      stack: error.stack || ""
    };
  }

  return {
    message: String(error || "Unknown bootstrap worker error"),
    name: typeof error,
    stack: ""
  };
}

async function ensureRuntimeModule() {
  if (!runtimeModulePromise) {
    const runtimeUrl = new URL("./huggingface-worker.js", self.location.href);
    runtimeUrl.searchParams.set("v", WORKER_RUNTIME_VERSION);
    runtimeModulePromise = import(runtimeUrl.href);
  }

  return runtimeModulePromise;
}

self.addEventListener("message", async (event) => {
  try {
    const runtimeModule = await ensureRuntimeModule();

    if (typeof runtimeModule.handleWorkerMessage !== "function") {
      throw new Error("Hugging Face worker runtime did not export handleWorkerMessage().");
    }

    runtimeModule.handleWorkerMessage(event.data || {});
  } catch (error) {
    postMessageToHost(WORKER_OUTBOUND.CONSOLE_ERROR, {
      args: [
        "[huggingface-worker-bootstrap] Runtime import failed",
        serializeError(error)
      ],
      timestamp: Date.now()
    });
    postMessageToHost(WORKER_OUTBOUND.TRACE, {
      stage: "bootstrap:runtime-import-failed",
      timestamp: Date.now()
    });
    throw error;
  }
});
