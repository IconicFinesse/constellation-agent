#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  parseSimpleYaml,
  serializeSimpleYaml
} from "../../app/L0/_all/modules/_core/framework/js/yaml-lite.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_CONFIG_PATH = path.join(SCRIPT_DIR, "config.yaml");
const EXECUTION_SEPARATOR = "_____javascript";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config ? resolveFromCwd(args.config) : DEFAULT_CONFIG_PATH;
  const config = await loadConfig(configPath);
  const activeModels = resolveModelIds(args.model, args.models, config.run?.active_models, config.provider.model);
  const modelConcurrency = resolveCaseConcurrency(args.model_concurrency, config.run?.model_concurrency);

  await loadDotEnv(path.join(ROOT_DIR, ".env"));

  if (args.system && args.history) {
    const systemPath = resolveFromCwd(args.system);
    const historyPath = resolveFromCwd(args.history);
    const casePath = args.case ? resolveFromCwd(args.case) : null;
    const caseDef = casePath ? await loadJson(casePath) : null;
    const systemPrompt = await fs.readFile(systemPath, "utf8");
    const history = await loadJson(historyPath);
    const repeatCount = resolveRepeatCount(args.repeat, config.run?.repeat_count);
    const modelAttempts = await mapLimit(activeModels, modelConcurrency, async (modelId) => ({
      model_id: modelId,
      attempts: await runSingleAttempts(withModel(config, modelId), systemPrompt, history, caseDef, repeatCount)
    }));
    printSingleResults(systemPath, historyPath, modelAttempts);
    return;
  }

  const activePrompts = normalizeList(config.run?.active_prompts);
  const activeCases = normalizeList(config.run?.active_cases);
  const promptIds = args.prompt_id ? [String(args.prompt_id)] : activePrompts;
  const caseIds = args.case_id ? [String(args.case_id)] : activeCases;
  const promptPaths = promptIds.map((promptId) => resolvePromptPath(config, promptId));
  const casePaths = caseIds.map((caseId) => resolveCasePath(config, caseId));
  const promptSummaries = [];
  const caseConcurrency = resolveCaseConcurrency(args.case_concurrency, config.run?.case_concurrency);
  const promptConcurrency = resolveCaseConcurrency(args.prompt_concurrency, config.run?.prompt_concurrency);
  const repeatCount = resolveRepeatCount(args.repeat, config.run?.repeat_count);

  const summariesByModel = await mapLimit(activeModels, modelConcurrency, async (modelId) => {
    const modelConfig = withModel(config, modelId);

    return mapLimit(promptPaths, promptConcurrency, async (promptPath) => {
      const caseResults = await runPromptCases(modelConfig, promptPath, casePaths, caseConcurrency, repeatCount);
      return buildPromptSummary(path.basename(promptPath, ".md"), modelId, caseResults);
    });
  });

  promptSummaries.push(...summariesByModel.flat());

  promptSummaries.sort(comparePromptSummaries);

  if (!args.prompt_id && !args.case_id) {
    await saveResults(config, promptSummaries, activeModels);
  }

  printMatrixSummary(promptSummaries, activeModels);
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];

    if (!entry.startsWith("--")) {
      continue;
    }

    const key = entry.slice(2).replace(/-/g, "_");
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function resolveFromCwd(targetPath) {
  return path.resolve(process.cwd(), targetPath);
}

function resolveRelative(baseDir, targetPath) {
  return path.resolve(baseDir, String(targetPath || ""));
}

async function loadConfig(configPath) {
  const configText = await fs.readFile(configPath, "utf8");
  const parsed = parseSimpleYaml(configText);
  const configDir = path.dirname(configPath);

  return {
    _configPath: configPath,
    _configDir: configDir,
    provider: {
      api_base: parsed.provider?.api_base || "https://openrouter.ai/api/v1/chat/completions",
      model: parsed.provider?.model || "openai/gpt-5.4-mini",
      api_key_env: parsed.provider?.api_key_env || "OPENROUTER_API_KEY",
      temperature: toNumber(parsed.provider?.temperature, 0.2),
      max_tokens: toInteger(parsed.provider?.max_tokens, 4000),
      timeout_ms: toInteger(parsed.provider?.timeout_ms, 90000),
      retry_count: toInteger(parsed.provider?.retry_count, 2),
      retry_backoff_ms: toInteger(parsed.provider?.retry_backoff_ms, 1500),
      referer: parsed.provider?.referer || "https://constellation-agent.local/tests/agent_llm_performance",
      title: parsed.provider?.title || "Constellation Agent Prompt Performance Tests"
    },
    paths: {
      prompts_dir: resolveRelative(configDir, parsed.paths?.prompts_dir || "./prompts"),
      cases_dir: resolveRelative(configDir, parsed.paths?.cases_dir || "./cases"),
      histories_dir: resolveRelative(configDir, parsed.paths?.histories_dir || "./histories"),
      results_dir: resolveRelative(configDir, parsed.paths?.results_dir || "./results"),
      history_dir: resolveRelative(configDir, parsed.paths?.history_dir || "./results/history"),
      leaderboard_file: resolveRelative(configDir, parsed.paths?.leaderboard_file || "./results/leaderboard.yaml"),
      latest_run_file: resolveRelative(configDir, parsed.paths?.latest_run_file || "./results/latest-run.json"),
      progress_file: resolveRelative(configDir, parsed.paths?.progress_file || "./results/progress.md"),
      summary_file: resolveRelative(configDir, parsed.paths?.summary_file || "./results/summary.md")
    },
    run: {
      active_prompts: normalizeList(parsed.run?.active_prompts),
      active_cases: normalizeList(parsed.run?.active_cases),
      active_models: normalizeList(parsed.run?.active_models),
      model_concurrency: resolveCaseConcurrency(null, parsed.run?.model_concurrency),
      prompt_concurrency: resolveCaseConcurrency(null, parsed.run?.prompt_concurrency),
      case_concurrency: resolveCaseConcurrency(null, parsed.run?.case_concurrency),
      repeat_count: resolveRepeatCount(null, parsed.run?.repeat_count),
      keep_generations: resolveKeepGenerations(parsed.run?.keep_generations)
    }
  };
}

function resolveModelIds(cliModel, cliModels, configuredModels, defaultModel) {
  const values = [];

  if (cliModels) {
    values.push(...splitModelList(cliModels));
  }

  if (cliModel) {
    values.unshift(...splitModelList(cliModel));
  }

  if (!values.length) {
    values.push(...normalizeList(configuredModels));
  }

  if (!values.length && defaultModel) {
    values.push(String(defaultModel));
  }

  return Array.from(new Set(values.filter(Boolean)));
}

function splitModelList(rawValue) {
  return String(rawValue || "")
    .split(/[,\n]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function withModel(config, modelId) {
  return {
    ...config,
    provider: {
      ...config.provider,
      model: String(modelId)
    }
  };
}

function toNumber(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function toInteger(value, fallback) {
  const normalized = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function resolveCaseConcurrency(cliValue, configValue) {
  const rawValue = cliValue ?? configValue;

  if (rawValue == null || rawValue === "") {
    return Infinity;
  }

  if (rawValue === true) {
    return Infinity;
  }

  const normalized = String(rawValue).trim().toLowerCase();

  if (!normalized || normalized === "all" || normalized === "max" || normalized === "parallel") {
    return Infinity;
  }

  const parsed = Number.parseInt(normalized, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Infinity;
  }

  return parsed;
}

function resolveRepeatCount(cliValue, configValue) {
  const rawValue = cliValue ?? configValue;

  if (rawValue == null || rawValue === "") {
    return 1;
  }

  const parsed = Number.parseInt(String(rawValue), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function resolveKeepGenerations(value) {
  if (value == null || value === "") {
    return Infinity;
  }

  const normalized = String(value).trim().toLowerCase();

  if (!normalized || normalized === "all" || normalized === "full" || normalized === "infinite") {
    return Infinity;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
}

async function loadDotEnv(envPath) {
  if (process.env.OPENROUTER_API_KEY) {
    return;
  }

  let envText = "";

  try {
    envText = await fs.readFile(envPath, "utf8");
  } catch {
    return;
  }

  envText.split(/\r?\n/u).forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

function resolvePromptPath(config, promptId) {
  return path.join(config.paths.prompts_dir, `${promptId}.md`);
}

function resolveCasePath(config, caseId) {
  return path.join(config.paths.cases_dir, `${caseId}.json`);
}

async function loadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function requestCompletion(config, systemPrompt, history) {
  const apiKey = process.env[config.provider.api_key_env];

  if (!apiKey) {
    throw new Error(`Missing ${config.provider.api_key_env} in environment or repo .env`);
  }

  const attempts = Math.max(1, config.provider.retry_count + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(config.provider.api_base, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": config.provider.referer,
          "X-Title": config.provider.title
        },
        body: JSON.stringify({
          model: config.provider.model,
          temperature: config.provider.temperature,
          max_tokens: config.provider.max_tokens,
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            ...history
          ]
        }),
        signal: AbortSignal.timeout(config.provider.timeout_ms)
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const error = new Error(payload.error?.message || payload.error || JSON.stringify(payload));
        error.status = response.status;

        if (attempt < attempts && shouldRetryRequestError(error)) {
          await delay(config.provider.retry_backoff_ms * attempt);
          continue;
        }

        throw error;
      }

      const message = payload.choices?.[0]?.message || {};
      return {
        content: extractMessageContent(message.content),
        usage: payload.usage || {}
      };
    } catch (error) {
      lastError = error;

      if (attempt < attempts && shouldRetryRequestError(error)) {
        await delay(config.provider.retry_backoff_ms * attempt);
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error("request failed");
}

function extractMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (typeof part?.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

async function runCase(config, promptPath, casePath) {
  const systemPrompt = await fs.readFile(promptPath, "utf8");
  return runPreparedCase(config, promptPath, casePath, systemPrompt, 1);
}

async function runPreparedCase(config, promptPath, casePath, systemPrompt, repeatCount = 1) {
  const caseDef = await loadJson(casePath);
  const historyPath = resolveRelative(path.dirname(casePath), caseDef.history);
  const history = await loadJson(historyPath);
  const attempts = [];

  for (let index = 0; index < repeatCount; index += 1) {
    attempts.push(
      await runPreparedCaseAttempt(config, promptPath, casePath, historyPath, caseDef, history, systemPrompt)
    );
  }

  if (repeatCount === 1) {
    return attempts[0];
  }

  return buildRepeatedCaseResult(promptPath, casePath, historyPath, caseDef, attempts);
}

async function runPreparedCaseAttempt(config, promptPath, casePath, historyPath, caseDef, history, systemPrompt) {
  try {
    const response = await requestCompletion(config, systemPrompt, history);
    const evaluation = evaluateResponse(response.content, caseDef.expect);

    return {
      case_id: caseDef.id,
      description: caseDef.description,
      prompt_id: path.basename(promptPath, ".md"),
      model_id: config.provider.model,
      prompt_path: path.relative(ROOT_DIR, promptPath),
      case_path: path.relative(ROOT_DIR, casePath),
      history_path: path.relative(ROOT_DIR, historyPath),
      passed: evaluation.passed,
      failures: evaluation.failures,
      response_type: evaluation.response_type,
      response: response.content,
      usage: response.usage
    };
  } catch (error) {
    return buildCaseErrorResult(promptPath, casePath, historyPath, caseDef, error, config.provider.model);
  }
}

function buildRepeatedCaseResult(promptPath, casePath, historyPath, caseDef, attempts) {
  const passCount = attempts.filter((attempt) => attempt.passed).length;
  const mergedFailures = Array.from(
    new Set(attempts.flatMap((attempt) => attempt.failures || []).filter(Boolean))
  );

  return {
    case_id: caseDef.id,
    description: caseDef.description,
    prompt_id: path.basename(promptPath, ".md"),
    prompt_path: path.relative(ROOT_DIR, promptPath),
    case_path: path.relative(ROOT_DIR, casePath),
    history_path: path.relative(ROOT_DIR, historyPath),
    passed: passCount === attempts.length,
    pass_count: passCount,
    repeat_count: attempts.length,
    failures: passCount === attempts.length ? [] : [`passed ${passCount}/${attempts.length} attempts`, ...mergedFailures],
    response_type: passCount === attempts.length ? "stable" : "unstable",
    response: attempts[attempts.length - 1]?.response || "",
    usage: attempts.reduce((totals, attempt) => mergeUsage(totals, attempt.usage), {}),
    attempts
  };
}

function mergeUsage(totals = {}, usage = {}) {
  const merged = { ...totals };

  for (const [key, value] of Object.entries(usage || {})) {
    const numericValue = Number(value);
    merged[key] = Number.isFinite(numericValue) ? (Number(merged[key]) || 0) + numericValue : value;
  }

  return merged;
}

async function runPromptCases(config, promptPath, casePaths, caseConcurrency, repeatCount) {
  const systemPrompt = await fs.readFile(promptPath, "utf8");
  return mapLimit(casePaths, caseConcurrency, (casePath) =>
    runPreparedCase(config, promptPath, casePath, systemPrompt, repeatCount)
  );
}

async function mapLimit(items, limit, worker) {
  const maxConcurrency = normalizeConcurrencyLimit(limit, items.length);
  const results = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: maxConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
  return results;
}

function normalizeConcurrencyLimit(limit, itemCount) {
  if (!itemCount) {
    return 0;
  }

  if (!Number.isFinite(limit)) {
    return itemCount;
  }

  return Math.max(1, Math.min(itemCount, Math.trunc(limit)));
}

function evaluateResponse(content, expect = {}) {
  const normalized = String(content || "");
  const separatorMatches = normalized.match(new RegExp(EXECUTION_SEPARATOR, "gu")) || [];
  const separatorLineMatches = normalized.match(/^_____javascript$/gmu) || [];
  const responseType = separatorMatches.length > 0 ? "thrust" : "terminal";
  const separatorIndex = normalized.indexOf(EXECUTION_SEPARATOR);
  const beforeCode = separatorIndex === -1 ? normalized.trim() : normalized.slice(0, separatorIndex).trim();
  const beforeSeparator = separatorIndex === -1 ? "" : normalized.slice(0, separatorIndex).trim();
  const codeAfterSeparator =
    separatorIndex === -1
      ? ""
      : normalized
          .slice(separatorIndex)
          .split(/\r?\n/u)
          .slice(1)
          .join("\n")
          .trim();
  const failures = [];

  if (expect.response_type && responseType !== expect.response_type) {
    failures.push(`expected ${expect.response_type} but got ${responseType}`);
  }

  if (expect.require_staging_line && !beforeSeparator) {
    failures.push("missing staging line before execution separator");
  }

  if (expect.require_separator_line && separatorLineMatches.length !== 1) {
    failures.push("execution separator must appear exactly once on its own line");
  }

  if (expect.require_single_separator && separatorMatches.length !== 1) {
    failures.push("execution separator must appear exactly once");
  }

  if (expect.require_code_after_separator && !codeAfterSeparator) {
    failures.push("missing code after execution separator");
  }

  if (expect.require_valid_javascript) {
    const validationError = validateJavascriptBody(codeAfterSeparator);

    if (validationError) {
      failures.push(`invalid javascript after execution separator: ${validationError}`);
    }
  }

  for (const requiredText of expect.must_contain || []) {
    if (!normalized.includes(requiredText)) {
      failures.push(`missing required text: ${requiredText}`);
    }
  }

  for (const forbiddenText of expect.must_not_contain || []) {
    if (normalized.includes(forbiddenText)) {
      failures.push(`contains forbidden text: ${forbiddenText}`);
    }
  }

  for (const forbiddenText of expect.must_not_contain_before_separator || []) {
    if (beforeCode.includes(forbiddenText)) {
      failures.push(`contains forbidden text before execution separator: ${forbiddenText}`);
    }
  }

  for (const patternDef of expect.must_match || []) {
    const pattern = toRegExp(patternDef);

    if (!pattern.test(normalized)) {
      failures.push(`missing required pattern: ${pattern}`);
    }
  }

  if (Array.isArray(expect.must_match_any) && expect.must_match_any.length > 0) {
    const patterns = expect.must_match_any.map(toRegExp);

    if (!patterns.some((pattern) => pattern.test(normalized))) {
      failures.push(
        `missing any required pattern: ${patterns.map((pattern) => String(pattern)).join(" OR ")}`
      );
    }
  }

  for (const patternDef of expect.must_not_match || []) {
    const pattern = toRegExp(patternDef);

    if (pattern.test(normalized)) {
      failures.push(`matched forbidden pattern: ${pattern}`);
    }
  }

  for (const patternDef of expect.must_not_match_before_separator || []) {
    const pattern = toRegExp(patternDef);

    if (pattern.test(beforeCode)) {
      failures.push(`matched forbidden pattern before execution separator: ${pattern}`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    response_type: responseType
  };
}

function validateJavascriptBody(sourceText) {
  const normalized = String(sourceText || "").trim();

  if (!normalized) {
    return "missing code";
  }

  try {
    new AsyncFunction(normalized);
    return "";
  } catch (error) {
    return error?.message || String(error);
  }
}

function toRegExp(patternDef) {
  if (patternDef && typeof patternDef === "object") {
    return new RegExp(patternDef.pattern || "", patternDef.flags || "u");
  }

  return new RegExp(String(patternDef || ""), "u");
}

function buildPromptSummary(promptId, modelId, caseResults) {
  const passedCases = caseResults.filter((result) => result.passed).length;
  const totalCases = caseResults.length;
  const passedAttempts = caseResults.reduce(
    (total, result) => total + (result.pass_count ?? (result.passed ? 1 : 0)),
    0
  );
  const totalAttempts = caseResults.reduce(
    (total, result) => total + (result.repeat_count ?? 1),
    0
  );

  return {
    prompt_id: promptId,
    model_id: String(modelId || ""),
    passed_cases: passedCases,
    total_cases: totalCases,
    pass_rate: totalCases ? Number((passedCases / totalCases).toFixed(4)) : 0,
    passed_attempts: passedAttempts,
    total_attempts: totalAttempts,
    attempt_pass_rate: totalAttempts ? Number((passedAttempts / totalAttempts).toFixed(4)) : 0,
    failed_cases: caseResults.filter((result) => !result.passed).map((result) => result.case_id),
    cases: caseResults
  };
}

function buildCaseErrorResult(promptPath, casePath, historyPath, caseDef, error, modelId) {
  return {
    case_id: caseDef.id,
    description: caseDef.description,
    prompt_id: path.basename(promptPath, ".md"),
    model_id: String(modelId || ""),
    prompt_path: path.relative(ROOT_DIR, promptPath),
    case_path: path.relative(ROOT_DIR, casePath),
    history_path: path.relative(ROOT_DIR, historyPath),
    passed: false,
    failures: [`request error: ${error?.message || String(error)}`],
    response_type: "error",
    response: "",
    usage: {},
    harness_error: true
  };
}

function shouldRetryRequestError(error) {
  const status = Number(error?.status);

  if (Number.isFinite(status)) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }

  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("fetch failed") || message.includes("timeout") || message.includes("econnreset");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms || 0));
  });
}

function comparePromptSummaries(a, b) {
  if (b.passed_cases !== a.passed_cases) {
    return b.passed_cases - a.passed_cases;
  }

  if (b.attempt_pass_rate !== a.attempt_pass_rate) {
    return b.attempt_pass_rate - a.attempt_pass_rate;
  }

  if (b.pass_rate !== a.pass_rate) {
    return b.pass_rate - a.pass_rate;
  }

  if (String(a.model_id || "") !== String(b.model_id || "")) {
    return String(a.model_id || "").localeCompare(String(b.model_id || ""));
  }

  return a.prompt_id.localeCompare(b.prompt_id);
}

async function saveResults(config, promptSummaries, modelIds) {
  const generatedAt = new Date().toISOString();
  const generationId = toGenerationId(generatedAt);
  const groupedSummaries = groupPromptSummariesByModel(promptSummaries, modelIds);

  await fs.mkdir(config.paths.results_dir, {
    recursive: true
  });
  await fs.mkdir(config.paths.history_dir, {
    recursive: true
  });

  const latestRun = {
    generated_at: generatedAt,
    generation_id: generationId,
    models: modelIds,
    results: promptSummaries
  };

  await fs.writeFile(config.paths.latest_run_file, `${JSON.stringify(latestRun, null, 2)}\n`, "utf8");

  const leaderboard = modelIds.length === 1
    ? {
        generated_at: generatedAt,
        generation_id: generationId,
        model: modelIds[0],
        prompts: serializeLeaderboardPrompts(groupedSummaries[0]?.prompts || [])
      }
    : {
        generated_at: generatedAt,
        generation_id: generationId,
        models: groupedSummaries.map((group) => ({
          id: group.model_id,
          prompts: serializeLeaderboardPrompts(group.prompts)
        }))
      };

  await fs.writeFile(config.paths.leaderboard_file, serializeSimpleYaml(leaderboard), "utf8");
  await saveGenerationHistory(config, generationId, leaderboard, latestRun);
  await pruneGenerationHistory(config.paths.history_dir, config.run.keep_generations);
  const overallLeaders = await loadOverallPromptLeaders(config);
  await fs.writeFile(
    config.paths.progress_file,
    renderProgressMarkdown({
      generatedAt,
      generationId,
      modelIds,
      promptSummaries,
      overallLeader: overallLeaders[0] || null
    }),
    "utf8"
  );
  await fs.writeFile(
    config.paths.summary_file,
    await renderSummaryMarkdown(config, {
      generatedAt,
      modelIds,
      currentPromptSummaries: promptSummaries
    }),
    "utf8"
  );
}

function serializeLeaderboardPrompts(promptSummaries) {
  return promptSummaries.map((summary, index) => ({
    rank: index + 1,
    id: summary.prompt_id,
    passed_cases: summary.passed_cases,
    total_cases: summary.total_cases,
    pass_rate: summary.pass_rate,
    passed_attempts: summary.passed_attempts,
    total_attempts: summary.total_attempts,
    attempt_pass_rate: summary.attempt_pass_rate,
    failed_cases: summary.failed_cases
  }));
}

function groupPromptSummariesByModel(promptSummaries, modelIds = []) {
  const order = new Map(modelIds.map((modelId, index) => [String(modelId), index]));
  const groups = new Map();

  for (const summary of promptSummaries) {
    const modelId = String(summary.model_id || "");

    if (!groups.has(modelId)) {
      groups.set(modelId, []);
    }

    groups.get(modelId).push(summary);
  }

  return Array.from(groups.entries())
    .sort((a, b) => {
      const aOrder = order.has(a[0]) ? order.get(a[0]) : Number.MAX_SAFE_INTEGER;
      const bOrder = order.has(b[0]) ? order.get(b[0]) : Number.MAX_SAFE_INTEGER;

      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }

      return a[0].localeCompare(b[0]);
    })
    .map(([modelId, summaries]) => ({
      model_id: modelId,
      prompts: [...summaries].sort(comparePromptSummaries)
    }));
}

function renderPromptLabel(entry) {
  const promptId = String(entry?.prompt_id || "");
  const modelId = String(entry?.model_id || "");
  return modelId ? `${promptId} @ ${modelId}` : promptId;
}

function renderPromptScore(entry) {
  return `${entry?.passed_cases ?? 0}/${entry?.total_cases ?? 0}`;
}

function findBestPerModel(promptSummaries, modelIds) {
  return groupPromptSummariesByModel(promptSummaries, modelIds)
    .map((group) => ({
      model_id: group.model_id,
      top: group.prompts[0] || null
    }))
    .filter((entry) => entry.top);
}

function toGenerationId(generatedAt) {
  return String(generatedAt || "")
    .replace(/[:.]/gu, "-")
    .replace(/[^0-9A-Za-zT_-]/gu, "");
}

async function saveGenerationHistory(config, generationId, leaderboard, latestRun) {
  const generationDir = path.join(config.paths.history_dir, generationId);

  await fs.mkdir(generationDir, {
    recursive: true
  });

  await fs.writeFile(path.join(generationDir, "leaderboard.yaml"), serializeSimpleYaml(leaderboard), "utf8");
  await fs.writeFile(path.join(generationDir, "latest-run.json"), `${JSON.stringify(latestRun, null, 2)}\n`, "utf8");
}

function renderProgressMarkdown({ generatedAt, generationId, modelIds, promptSummaries, overallLeader }) {
  const top = promptSummaries[0] || null;
  const promptIds = Array.from(new Set(promptSummaries.map((summary) => summary.prompt_id)));
  const cleanPrompts = promptSummaries.filter(
    (summary) => summary.passed_cases === summary.total_cases
  );
  const commonFailures = collectCommonFailures(promptSummaries);
  const cVariant = [...promptSummaries]
    .filter((summary) => /[A-Z]_/u.test(summary.prompt_id) && /C_/u.test(summary.prompt_id))
    .sort(comparePromptSummaries)[0] || null;
  const bestPerModel = findBestPerModel(promptSummaries, modelIds);

  const statusLine = top
    ? `Best overall: \`${renderPromptLabel(top)}\` with \`${renderPromptScore(top)}\` strict`
    : "Best overall: none";

  let summaryLine = "No prompt results recorded yet";

  if (cleanPrompts.length === promptSummaries.length && promptSummaries.length) {
    summaryLine = `All prompt-model runs in this generation cleared the strict matrix`;
  } else if (cleanPrompts.length > 1) {
    summaryLine = `\`${cleanPrompts.length}/${promptSummaries.length}\` prompt-model runs cleared the strict matrix, so repeat stability is now the deciding filter`;
  } else if (cleanPrompts.length === 1) {
    summaryLine = `Only \`${renderPromptLabel(cleanPrompts[0])}\` cleared the strict matrix in this generation`;
  } else if (top) {
    summaryLine = `No prompt-model run cleared the strict matrix; closest was \`${renderPromptLabel(top)}\``;
  }

  const branchLine = cVariant
    ? `Wild branch: \`${renderPromptLabel(cVariant)}\` scored \`${renderPromptScore(cVariant)}\` and remains exploratory`
    : "";
  const overallBestLine = overallLeader &&
    (!top ||
      overallLeader.prompt_id !== top.prompt_id ||
      overallLeader.model_id !== top.model_id ||
      overallLeader.passed_cases !== top.passed_cases ||
      overallLeader.total_cases !== top.total_cases)
    ? `Overall best still: \`${renderPromptLabel(overallLeader)}\` at \`${renderPromptScore(overallLeader)}\` strict`
    : "";

  const nextLine = top
    ? cleanPrompts.length > 1
      ? `Next: rerun the clean leaders with repeat sampling and continue from the stronger repeat survivor`
      : commonFailures.length
        ? `Next: target ${commonFailures.map((entry) => `\`${entry.case_id}\``).join(", ")} without overfitting`
        : `Next: stress the current leader with repeat sampling before promotion`
    : "Next: run a prompt generation";

  return [
    "# Progress",
    "",
    `Updated: \`${generatedAt}\``,
    `Generation Id: \`${generationId}\``,
    `Generation: \`${promptIds.join(" / ")}\``,
    modelIds.length === 1 ? `Model: \`${modelIds[0]}\`` : `Models: \`${modelIds.join(" / ")}\``,
    "",
    `- ${statusLine}`,
    `- ${summaryLine}`,
    ...(overallBestLine ? [`- ${overallBestLine}`] : []),
    ...bestPerModel
      .filter(() => modelIds.length > 1)
      .map((entry) => `- Best in \`${entry.model_id}\`: \`${entry.top.prompt_id}\` with \`${renderPromptScore(entry.top)}\` strict`),
    ...(branchLine ? [`- ${branchLine}`] : []),
    `- ${nextLine}`
  ].join("\n") + "\n";
}

function collectCommonFailures(promptSummaries) {
  const counts = new Map();

  for (const summary of promptSummaries) {
    for (const caseId of summary.failed_cases || []) {
      counts.set(caseId, (counts.get(caseId) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([caseId, count]) => ({ case_id: caseId, count }));
}

async function renderSummaryMarkdown(config, { generatedAt, modelIds, currentPromptSummaries }) {
  const leaders = await loadOverallPromptLeaders(config);
  const activeGeneration = Array.from(new Set(currentPromptSummaries.map((summary) => summary.prompt_id))).join(" / ");
  const topFive = leaders.slice(0, 5);

  const lines = [
    "# Summary",
    "",
    `Updated: \`${generatedAt}\``,
    modelIds.length === 1 ? `Model: \`${modelIds[0]}\`` : `Models: \`${modelIds.join(" / ")}\``,
    `Current Active Generation: \`${activeGeneration}\``,
    ""
  ];

  if (!topFive.length) {
    lines.push("- No archived prompt results yet");
    return `${lines.join("\n")}\n`;
  }

  topFive.forEach((entry, index) => {
    lines.push(`${index + 1}. \`${renderPromptLabel(entry)}\` — \`${renderPromptScore(entry)}\` strict`);
    lines.push(`   ${describePromptSpecialty(entry)}`);
  });

  return `${lines.join("\n")}\n`;
}

async function loadOverallPromptLeaders(config) {
  const entries = await fs.readdir(config.paths.history_dir, {
    withFileTypes: true
  }).catch(() => []);
  const candidateFiles = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(config.paths.history_dir, entry.name, "leaderboard.yaml"));
  const bestByPromptModel = new Map();

  for (const filePath of candidateFiles) {
    const leaderboardText = await fs.readFile(filePath, "utf8").catch(() => "");

    if (!leaderboardText) {
      continue;
    }

    const parsed = parseSimpleYaml(leaderboardText) || {};
    const modelPromptGroups = Array.isArray(parsed.models)
      ? parsed.models.map((group) => ({
          model_id: String(group.id || ""),
          prompts: Array.isArray(group.prompts) ? group.prompts : []
        }))
      : [{
          model_id: String(parsed.model || ""),
          prompts: Array.isArray(parsed.prompts) ? parsed.prompts : []
        }];

    for (const group of modelPromptGroups) {
      for (const prompt of group.prompts || []) {
        const normalized = {
          prompt_id: String(prompt.id || ""),
          model_id: group.model_id,
          passed_cases: toInteger(prompt.passed_cases, 0),
          total_cases: toInteger(prompt.total_cases, 0),
          pass_rate: toNumber(prompt.pass_rate, 0),
          passed_attempts: toInteger(prompt.passed_attempts, prompt.passed_cases),
          total_attempts: toInteger(prompt.total_attempts, prompt.total_cases),
          attempt_pass_rate: toNumber(prompt.attempt_pass_rate, prompt.pass_rate || 0),
          failed_cases: normalizeList(prompt.failed_cases),
          generated_at: String(parsed.generated_at || ""),
          generation_id: String(parsed.generation_id || "")
        };
        const key = `${normalized.model_id}::${normalized.prompt_id}`;
        const current = bestByPromptModel.get(key);

        if (!current || compareHistoricalPrompt(normalized, current) < 0) {
          bestByPromptModel.set(key, normalized);
        }
      }
    }
  }

  return Array.from(bestByPromptModel.values()).sort(compareHistoricalPrompt);
}

function compareHistoricalPrompt(a, b) {
  if (b.passed_cases !== a.passed_cases) {
    return b.passed_cases - a.passed_cases;
  }

  if (b.attempt_pass_rate !== a.attempt_pass_rate) {
    return b.attempt_pass_rate - a.attempt_pass_rate;
  }

  if (b.pass_rate !== a.pass_rate) {
    return b.pass_rate - a.pass_rate;
  }

  if (a.generated_at !== b.generated_at) {
    return String(b.generated_at).localeCompare(String(a.generated_at));
  }

  if (String(a.model_id || "") !== String(b.model_id || "")) {
    return String(a.model_id || "").localeCompare(String(b.model_id || ""));
  }

  return a.prompt_id.localeCompare(b.prompt_id);
}

function describePromptSpecialty(entry) {
  const promptId = String(entry.prompt_id || "").toLowerCase();

  if (promptId.includes("success_seal")) {
    return "Adds an explicit success seal so successful mutation telemetry closes the task unless a newer user turn reopens it";
  }

  if (promptId.includes("transient_not_reopen")) {
    return "Surgical fix aimed at stopping mutation-caused transient refresh from being treated as a reason to keep executing";
  }

  if (promptId.includes("closure_gate")) {
    return "Uses a closure gate so post-success behavior is decided by reopen signals instead of open-ended follow-through";
  }

  if (promptId.includes("integrity")) {
    return "Focuses on reply-shape integrity and follow-through so staging, marker, and code stay together under pressure";
  }

  if (promptId.includes("imperative")) {
    return "Pushes hard on imperative follow-through so short user nudges trigger execution instead of more narration";
  }

  if (promptId.includes("marker")) {
    return "Hardens the execution marker contract so thrust replies stay syntactically valid and complete";
  }

  if (promptId.includes("single_thrust")) {
    return "Experiments with a single obvious-next-step law that tries to force one decisive execution turn";
  }

  if (promptId.includes("sealed") || promptId.includes("orders")) {
    return "Wild redesign exploring success sealing and simpler command language instead of the standard protocol narrative";
  }

  if (promptId.includes("reset") || promptId.includes("reboot")) {
    return "Wild reset that discards most inherited prompt structure to probe a different control philosophy";
  }

  const failedCount = Array.isArray(entry.failed_cases) ? entry.failed_cases.length : 0;

  if (failedCount === 0) {
    return "Cleared the strict matrix in its best observed generation";
  }

  return `Strong contender with ${failedCount} remaining case miss${failedCount === 1 ? "" : "es"} in its best observed run`;
}

async function pruneGenerationHistory(historyDir, keepCount) {
  if (!Number.isFinite(keepCount)) {
    return;
  }

  const entries = await fs.readdir(historyDir, {
    withFileTypes: true
  }).catch(() => []);
  const generations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const toDelete = generations.slice(Math.max(0, keepCount));

  await Promise.all(
    toDelete.map((entryName) =>
      fs.rm(path.join(historyDir, entryName), {
        recursive: true,
        force: true
      })
    )
  );
}

async function runSingleAttempts(config, systemPrompt, history, caseDef, repeatCount) {
  const attempts = [];

  for (let index = 0; index < repeatCount; index += 1) {
    const response = await requestCompletion(config, systemPrompt, history);
    const evaluation = caseDef ? evaluateResponse(response.content, caseDef.expect) : null;
    attempts.push({ response, evaluation });
  }

  return attempts;
}

function printSingleResults(systemPath, historyPath, modelAttempts) {
  modelAttempts.forEach((entry, index) => {
    if (index > 0) {
      console.log("");
    }

    printSingleResult(systemPath, historyPath, entry.attempts, entry.model_id);
  });
}

function printSingleResult(systemPath, historyPath, attempts, modelId = "") {
  const finalAttempt = attempts[attempts.length - 1];
  console.log(`system: ${path.relative(ROOT_DIR, systemPath)}`);
  console.log(`history: ${path.relative(ROOT_DIR, historyPath)}`);
  if (modelId) {
    console.log(`model: ${modelId}`);
  }
  console.log("");
  console.log("assistant↓");
  console.log(finalAttempt?.response?.content || "(empty)");

  if (!finalAttempt?.evaluation) {
    return;
  }

  console.log("");
  const passCount = attempts.filter((attempt) => attempt.evaluation?.passed).length;
  console.log(`result: ${passCount === attempts.length ? "PASS" : "FAIL"} (${passCount}/${attempts.length})`);

  const mergedFailures = Array.from(
    new Set(attempts.flatMap((attempt) => attempt.evaluation?.failures || []).filter(Boolean))
  );
  mergedFailures.forEach((failure) => {
    console.log(`- ${failure}`);
  });
}

function printMatrixSummary(promptSummaries, modelIds) {
  const groups = groupPromptSummariesByModel(promptSummaries, modelIds);

  groups.forEach((group, index) => {
    if (index > 0) {
      console.log("");
    }

    console.log(`model: ${group.model_id}`);
    console.log("");

    group.prompts.forEach((summary) => {
      const strictSummary = `${summary.passed_cases}/${summary.total_cases} strict`;
      const attemptSummary =
        summary.total_attempts > summary.total_cases
          ? `, ${summary.passed_attempts}/${summary.total_attempts} attempts`
          : "";
      console.log(`${summary.prompt_id}: ${strictSummary}${attemptSummary} (${Math.round(summary.pass_rate * 100)}%)`);

      summary.cases.forEach((caseResult) => {
        const status = caseResult.passed ? "PASS" : "FAIL";
        const caseAttemptSummary =
          caseResult.repeat_count > 1 ? ` (${caseResult.pass_count}/${caseResult.repeat_count})` : "";
        console.log(`  ${status} ${caseResult.case_id}${caseAttemptSummary}`);

        if (!caseResult.passed) {
          caseResult.failures.forEach((failure) => {
            console.log(`    - ${failure}`);
          });
        }
      });

      console.log("");
    });
  });
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
