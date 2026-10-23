import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildHuggingFaceFallbackPrompt } from "../app/L0/_all/modules/_core/huggingface/helpers.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

test("huggingface fallback prompt uses api-style system and conversation sections", () => {
  const prompt = buildHuggingFaceFallbackPrompt([
    {
      content: "Follow the system rules.",
      role: "system"
    },
    {
      content: "First user turn.",
      role: "user"
    },
    {
      content: "Earlier assistant turn.",
      role: "assistant"
    },
    {
      content: "Second user turn.",
      role: "user"
    }
  ]);

  assert.ok(prompt.startsWith([
    "You are continuing a chat conversation.",
    "Answer with only the next assistant message.",
    "Do not repeat the system instructions.",
    "Do not emit role labels such as User: or Assistant:.",
    "Do not continue the transcript beyond the assistant reply.",
    ""
  ].join("\n")));
  assert.ok(prompt.includes("System instructions:\nFollow the system rules."));
  assert.ok(prompt.includes("Conversation:\n\nUser:\nFirst user turn.\n\nAssistant:\nEarlier assistant turn.\n\nUser:\nSecond user turn."));
  assert.ok(prompt.endsWith("\n\nAssistant:"));
  assert.doesNotMatch(prompt, /BEGIN [A-Z]+ MESSAGE/u);
  assert.doesNotMatch(prompt, /END [A-Z]+ MESSAGE/u);
});

test("huggingface worker prefers the model processor chat template before fallback formatting", async () => {
  const workerPath = path.join(ROOT_DIR, "app/L0/_all/modules/_core/huggingface/huggingface-worker.js");
  const workerSource = await fs.readFile(workerPath, "utf8");

  assert.ok(workerSource.includes("let processor = null;"));
  assert.ok(workerSource.includes("async function resolveChatProcessor(runtimeModule, modelId, loadOptions = {})"));
  assert.ok(workerSource.includes("const { AutoProcessor } = runtimeModule || {};"));
  assert.ok(workerSource.includes("const loadedProcessor = await AutoProcessor.from_pretrained(modelId, loadOptions);"));
  assert.ok(workerSource.includes('if (typeof processor?.apply_chat_template === "function")'));
  assert.ok(workerSource.includes("const promptText = processor.apply_chat_template(messages, {"));
  assert.ok(workerSource.includes("enable_thinking: false"));
  assert.ok(workerSource.includes("Gemma processor tokenization can throw"));
  assert.ok(!workerSource.includes("processor.apply_chat_template(messages, {\n          add_generation_prompt: true,\n          enable_thinking: false,\n          return_dict: true,\n          tokenize: true\n        });"));
  assert.ok(workerSource.includes("const promptInputs = await tokenizer(promptText, {"));
  assert.ok(workerSource.includes("return_tensor: false"));
  assert.ok(workerSource.includes('postTrace("processor-load:start"'));
  assert.ok(workerSource.includes('postTrace("processor-load:done"'));
  assert.ok(workerSource.includes('postTrace("processor-load:failed"'));
  assert.ok(workerSource.includes('postTrace("prompt:processor-template"'));
  assert.ok(workerSource.includes('postTrace("prompt:processor-template-failed"'));
  assert.ok(workerSource.includes('postTrace("prompt:tokenizer-template"'));
  assert.ok(workerSource.includes('postTrace("prompt:tokenizer-template-failed"'));
  assert.ok(workerSource.includes('postTrace("prompt:fallback-template"'));
  assert.ok(workerSource.includes("const resolvedProcessor = await resolveChatProcessor(runtimeModule, modelId, {"));
  assert.ok(workerSource.includes("tokenizer = generator?.tokenizer || processor?.tokenizer || null;"));
});

test("huggingface worker loader versions bootstrap and runtime module urls", async () => {
  const protocolPath = path.join(ROOT_DIR, "app/L0/_all/modules/_core/huggingface/protocol.js");
  const managerPath = path.join(ROOT_DIR, "app/L0/_all/modules/_core/huggingface/manager.js");
  const bootstrapPath = path.join(ROOT_DIR, "app/L0/_all/modules/_core/huggingface/huggingface-worker-bootstrap.js");
  const [protocolSource, managerSource, bootstrapSource] = await Promise.all([
    fs.readFile(protocolPath, "utf8"),
    fs.readFile(managerPath, "utf8"),
    fs.readFile(bootstrapPath, "utf8")
  ]);

  assert.ok(protocolSource.includes('export const WORKER_RUNTIME_VERSION = "2026-04-16-auto-processor-v1";'));
  assert.ok(managerSource.includes('workerUrl.searchParams.set("v", WORKER_RUNTIME_VERSION);'));
  assert.ok(bootstrapSource.includes('runtimeUrl.searchParams.set("v", WORKER_RUNTIME_VERSION);'));
});

test("onscreen local client prefers the api-style folded transport payload", async () => {
  const apiPath = path.join(ROOT_DIR, "app/L0/_all/modules/_core/onscreen_agent/api.js");
  const apiSource = await fs.readFile(apiPath, "utf8");

  assert.ok(apiSource.includes("const requestBodyMessages = Array.isArray(preparedRequest?.requestBody?.messages)"));
  assert.ok(apiSource.includes("return normalizeCompletionMessagesForLocal(requestBodyMessages.length ? requestBodyMessages : requestMessages);"));
  assert.ok(!apiSource.includes("return normalizeCompletionMessagesForLocal(requestMessages.length ? requestMessages : requestBodyMessages);"));
});
