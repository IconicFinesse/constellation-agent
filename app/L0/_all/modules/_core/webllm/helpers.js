export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

function asFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function sanitizeText(value) {
  return String(value || "").trim();
}

export function deriveModelIdFromUrl(url) {
  const rawValue = sanitizeText(url);

  if (!rawValue) {
    return "";
  }

  try {
    const parsedUrl = new URL(rawValue);
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    const resolveIndex = pathParts.indexOf("resolve");
    const relevantParts = resolveIndex >= 0 ? pathParts.slice(0, resolveIndex) : pathParts;
    const candidate = relevantParts.at(-1) || relevantParts.at(-2) || rawValue;

    return candidate.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/-+/gu, "-");
  } catch {
    return rawValue.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/-+/gu, "-");
  }
}

function estimateModelSize(model) {
  const modelId = sanitizeText(model?.model_id);
  const parsedSize = modelId.match(/(\d+(?:\.\d+)?)B/iu);

  if (parsedSize) {
    return Number(parsedSize[1]);
  }

  const vram = Number(model?.vram_required_MB);
  if (Number.isFinite(vram) && vram > 0) {
    return vram / 1024;
  }

  return Number.POSITIVE_INFINITY;
}

function titleCaseWords(value) {
  return String(value || "")
    .split(/[\s._-]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function inferModelFamily(modelId) {
  const normalizedModelId = sanitizeText(modelId).toLowerCase();

  if (!normalizedModelId) {
    return "Other";
  }

  if (normalizedModelId.includes("gemma-4")) {
    return "Gemma 4";
  }

  if (normalizedModelId.includes("gemma-3")) {
    return "Gemma 3";
  }

  if (normalizedModelId.includes("gemma")) {
    return "Gemma";
  }

  if (normalizedModelId.includes("qwen3")) {
    return "Qwen 3";
  }

  if (normalizedModelId.includes("qwen2.5")) {
    return "Qwen 2.5";
  }

  if (normalizedModelId.includes("llama")) {
    return "Llama";
  }

  if (normalizedModelId.includes("deepseek")) {
    return "DeepSeek";
  }

  if (normalizedModelId.includes("hermes")) {
    return "Hermes";
  }

  if (normalizedModelId.includes("mistral")) {
    return "Mistral";
  }

  if (normalizedModelId.includes("phi")) {
    return "Phi";
  }

  if (normalizedModelId.includes("smollm")) {
    return "SmolLM";
  }

  const firstToken = normalizedModelId.split(/[-_]/u).find(Boolean) || normalizedModelId;
  return titleCaseWords(firstToken);
}

export function compareModelRecords(left, right) {
  const familyCompare = inferModelFamily(left?.model_id).localeCompare(inferModelFamily(right?.model_id));
  if (familyCompare !== 0) {
    return familyCompare;
  }

  const lowResourceBias = Number(Boolean(right?.low_resource_required)) - Number(Boolean(left?.low_resource_required));
  if (lowResourceBias !== 0) {
    return lowResourceBias;
  }

  const sizeCompare = estimateModelSize(left) - estimateModelSize(right);
  if (sizeCompare !== 0) {
    return sizeCompare;
  }

  return sanitizeText(left?.model_id).localeCompare(sanitizeText(right?.model_id));
}

export function filterPrebuiltModels(models = [], options = {}) {
  const normalizedSearch = sanitizeText(options.search).toLowerCase();
  const normalizedFamily = sanitizeText(options.family);

  return [...(Array.isArray(models) ? models : [])]
    .filter((model) => {
      const family = inferModelFamily(model?.model_id);
      if (normalizedFamily && family !== normalizedFamily) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      const haystack = [
        sanitizeText(model?.model_id),
        sanitizeText(model?.model),
        sanitizeText(model?.model_lib),
        family
      ].join(" ").toLowerCase();

      return haystack.includes(normalizedSearch);
    })
    .sort(compareModelRecords);
}

export function buildFamilySummary(models = []) {
  const countsByFamily = new Map();

  for (const model of Array.isArray(models) ? models : []) {
    const family = inferModelFamily(model?.model_id);
    countsByFamily.set(family, (countsByFamily.get(family) || 0) + 1);
  }

  return [...countsByFamily.entries()]
    .map(([label, count]) => ({ count, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function describeModelSelection(selection = {}) {
  const customModelUrl = sanitizeText(selection.customModelUrl);
  if (customModelUrl) {
    return sanitizeText(selection.customModelId) || deriveModelIdFromUrl(customModelUrl) || "custom model";
  }

  return sanitizeText(selection.modelId) || "model";
}

export function validateModelSelection(selection = {}) {
  const modelId = sanitizeText(selection.modelId);
  const customModelUrl = sanitizeText(selection.customModelUrl);
  const customModelLibUrl = sanitizeText(selection.customModelLibUrl);
  const customModelId = sanitizeText(selection.customModelId);
  const isCustomSelection = Boolean(customModelUrl || customModelLibUrl || customModelId);

  if (isCustomSelection) {
    if (!customModelUrl || !customModelLibUrl) {
      return "Custom models require both a model URL and a model library URL.";
    }

    return "";
  }

  if (!modelId) {
    return "Choose a prebuilt model or provide custom model URLs.";
  }

  return "";
}

export function createChatMessage(role, content = "") {
  return {
    content: String(content || ""),
    finishReason: "",
    id: crypto.randomUUID(),
    isStreaming: false,
    metrics: null,
    role: role === "assistant" ? "assistant" : "user"
  };
}

export function buildChatMessages(systemPrompt, messages = []) {
  const payload = [];
  const normalizedSystemPrompt = sanitizeText(systemPrompt);

  if (normalizedSystemPrompt) {
    payload.push({
      content: normalizedSystemPrompt,
      role: "system"
    });
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    const content = String(message?.content || "");

    if (!content.trim()) {
      continue;
    }

    if (message?.role !== "user" && message?.role !== "assistant") {
      continue;
    }

    payload.push({
      content,
      role: message.role
    });
  }

  return payload;
}

export function normalizeUsageMetrics(usage, options = {}) {
  const promptTokens = Number(usage?.prompt_tokens);
  const completionTokens = Number(usage?.completion_tokens);
  const totalTokens = Number(usage?.total_tokens);
  const extra = usage?.extra && typeof usage.extra === "object" ? usage.extra : {};
  const elapsedMs = Number(options.elapsedMs);
  let tokensPerSecond = Number(extra.decode_tokens_per_s);

  if ((!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0)
    && Number.isFinite(completionTokens)
    && completionTokens > 0
    && Number.isFinite(elapsedMs)
    && elapsedMs > 0) {
    tokensPerSecond = completionTokens / (elapsedMs / 1000);
  }

  return {
    completionTokens: asFiniteNumber(completionTokens),
    endToEndLatencySeconds: asFiniteNumber(Number(extra.e2e_latency_s)),
    prefillTokensPerSecond: asFiniteNumber(Number(extra.prefill_tokens_per_s)),
    promptTokens: asFiniteNumber(promptTokens),
    timePerOutputTokenSeconds: asFiniteNumber(Number(extra.time_per_output_token_s)),
    timeToFirstTokenSeconds: asFiniteNumber(Number(extra.time_to_first_token_s)),
    tokensPerMinute: Number.isFinite(tokensPerSecond) ? tokensPerSecond * 60 : null,
    tokensPerSecond: asFiniteNumber(tokensPerSecond),
    totalTokens: asFiniteNumber(totalTokens)
  };
}

export function formatNumber(value, digits = 1) {
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue)) {
    return "-";
  }

  return normalizedValue.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  });
}

export function formatTokenRate(value) {
  return `${formatNumber(value, value >= 100 ? 0 : 1)}`;
}

export function formatDurationSeconds(value) {
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue)) {
    return "-";
  }

  return `${formatNumber(normalizedValue, normalizedValue >= 10 ? 1 : 2)}s`;
}
