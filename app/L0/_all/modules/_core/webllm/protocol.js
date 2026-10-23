export const WORKER_INBOUND = {
  BOOT: "boot",
  DISCARD_MODEL_CACHE: "discard-model-cache",
  INTERRUPT: "interrupt",
  LOAD_MODEL: "load-model",
  RESET_CHAT: "reset-chat",
  RUN_CHAT: "run-chat",
  SCAN_CACHE: "scan-cache",
  UNLOAD_MODEL: "unload-model"
};

export const WORKER_OUTBOUND = {
  CACHE_STATUS: "cache-status",
  DISCARD_COMPLETE: "discard-complete",
  DISCARD_ERROR: "discard-error",
  CHAT_COMPLETE: "chat-complete",
  CHAT_DELTA: "chat-delta",
  CHAT_ERROR: "chat-error",
  CHAT_RESET: "chat-reset",
  INTERRUPT_ACK: "interrupt-ack",
  LOAD_COMPLETE: "load-complete",
  LOAD_ERROR: "load-error",
  LOAD_PROGRESS: "load-progress",
  READY: "ready",
  UNLOAD_COMPLETE: "unload-complete",
  UNLOAD_ERROR: "unload-error"
};
