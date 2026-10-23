const TOAST_RUNTIME_KEY = "__spaceToastRuntime";
const TOAST_DISMISS_DELAY_MS = 180;
const DEFAULT_TOAST_DURATION_MS = 4200;

function normalizeToastTone(value) {
  const tone = String(value || "info").trim().toLowerCase();

  if (tone === "error" || tone === "success") {
    return tone;
  }

  return "info";
}

function getToastIconName(tone) {
  if (tone === "error") {
    return "error";
  }

  if (tone === "success") {
    return "check_circle";
  }

  return "info";
}

function ensureToastContainer() {
  const root = document.body || document.documentElement;

  if (!root) {
    throw new Error("Toast container requires an active document body.");
  }

  let container = document.getElementById("space-toast-stack");

  if (container) {
    return container;
  }

  container = document.createElement("div");
  container.id = "space-toast-stack";
  container.className = "space-toast-stack";
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-atomic", "false");
  root.append(container);
  return container;
}

function removeToastRecord(record) {
  if (!record || record.closed) {
    return;
  }

  record.closed = true;

  if (record.timerId) {
    clearTimeout(record.timerId);
    record.timerId = null;
  }

  record.element.classList.remove("is-visible");
  window.setTimeout(() => {
    record.element.remove();
  }, TOAST_DISMISS_DELAY_MS);
}

function getToastRuntime() {
  if (globalThis[TOAST_RUNTIME_KEY]) {
    return globalThis[TOAST_RUNTIME_KEY];
  }

  const runtime = {
    container: ensureToastContainer()
  };

  globalThis[TOAST_RUNTIME_KEY] = runtime;
  return runtime;
}

function createToastRecord(message, options = {}) {
  const tone = normalizeToastTone(options.tone);
  const toast = document.createElement("div");
  toast.className = `space-toast is-${tone}`;
  toast.setAttribute("role", tone === "error" ? "alert" : "status");

  const icon = document.createElement("x-icon");
  icon.className = "space-toast-icon";
  icon.textContent = getToastIconName(tone);

  const body = document.createElement("div");
  body.className = "space-toast-body";

  const text = document.createElement("p");
  text.className = "space-toast-message";
  text.textContent = String(message || "").trim();
  body.append(text);

  const dismissButton = document.createElement("button");
  dismissButton.className = "space-toast-dismiss";
  dismissButton.type = "button";
  dismissButton.setAttribute("aria-label", "Dismiss notification");

  const dismissIcon = document.createElement("x-icon");
  dismissIcon.textContent = "close";
  dismissButton.append(dismissIcon);

  const record = {
    closed: false,
    element: toast,
    timerId: null,
    dismiss() {
      removeToastRecord(record);
    }
  };

  dismissButton.addEventListener("click", () => record.dismiss());
  toast.append(icon, body, dismissButton);
  return record;
}

export function showToast(message, options = {}) {
  const normalizedMessage = String(message || "").trim();

  if (!normalizedMessage) {
    return null;
  }

  const runtime = getToastRuntime();
  const durationMs = Number(options.durationMs);
  const resolvedDurationMs =
    Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : DEFAULT_TOAST_DURATION_MS;
  const record = createToastRecord(normalizedMessage, options);

  runtime.container.append(record.element);
  window.requestAnimationFrame(() => {
    record.element.classList.add("is-visible");
  });

  if (resolvedDurationMs > 0) {
    record.timerId = window.setTimeout(() => record.dismiss(), resolvedDurationMs);
  }

  return record;
}

const space = globalThis.space && typeof globalThis.space === "object" ? globalThis.space : (globalThis.space = {});
space.visual = space.visual || {};
space.visual.showToast = showToast;
