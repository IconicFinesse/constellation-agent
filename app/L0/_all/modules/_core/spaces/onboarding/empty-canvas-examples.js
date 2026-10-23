import {
  normalizeIconHexColor,
  normalizeMaterialSymbolName
} from "/modules/_core/visual/icons/material-symbols.js";

const EMPTY_CANVAS_EXAMPLES_CONFIG_URL = "/modules/_core/spaces/onboarding/empty-canvas-examples.yaml";
const EMPTY_CANVAS_EXAMPLE_HELPERS_MODULE_URL = new URL(
  "/modules/_core/spaces/onboarding/empty-canvas-example-helpers.js",
  globalThis.location?.href || "http://localhost/"
).href;

let emptyCanvasExamplesPromise = null;

function getRuntime() {
  const runtime = globalThis.space;

  if (!runtime || typeof runtime !== "object") {
    throw new Error("Space runtime is not available.");
  }

  if (
    !runtime.utils ||
    typeof runtime.utils !== "object" ||
    !runtime.utils.yaml ||
    typeof runtime.utils.yaml.parse !== "function"
  ) {
    throw new Error("space.utils.yaml.parse is not available.");
  }

  return runtime;
}

function collapseWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeExampleId(value, fallbackIndex) {
  const normalizedValue = collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return normalizedValue || `example-${fallbackIndex + 1}`;
}

function normalizeExampleIcon(value) {
  return normalizeMaterialSymbolName(value) || "chat_bubble";
}

function normalizeExampleColor(value) {
  return normalizeIconHexColor(value) || "#94bcff";
}

function normalizeExampleKind(value, code = "") {
  const normalizedValue = collapseWhitespace(value).toLowerCase();

  if (normalizedValue === "chat" || normalizedValue === "prompt") {
    return "chat";
  }

  if (normalizedValue === "widget" || normalizedValue === "action") {
    return "action";
  }

  return /helpers\.(submitPrompt|sendPrompt)\s*\(/u.test(String(code))
    ? "chat"
    : "action";
}

function indentBlock(source, prefix = "  ") {
  return String(source ?? "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

async function compileExampleCode(source, label) {
  const moduleSource = [
    `import * as helpers from ${JSON.stringify(EMPTY_CANVAS_EXAMPLE_HELPERS_MODULE_URL)};`,
    "",
    "export default async function execute(example, event) {",
    indentBlock(String(source || "")),
    "}"
  ].join("\n");
  const moduleUrl = URL.createObjectURL(
    new Blob([moduleSource], {
      type: "text/javascript"
    })
  );

  try {
    const compiledModule = await import(moduleUrl);

    if (!compiledModule || typeof compiledModule.default !== "function") {
      throw new Error("Compiled example module did not export a default function.");
    }

    return compiledModule.default;
  } catch (error) {
    throw new Error(`Invalid empty-canvas example code for "${label}": ${error.message}`);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

async function normalizeExampleDefinition(rawExample, index) {
  const normalizedExample =
    rawExample && typeof rawExample === "object" && !Array.isArray(rawExample)
      ? rawExample
      : {};
  const text = collapseWhitespace(normalizedExample.text ?? normalizedExample.label ?? normalizedExample.prompt);
  const prompt = collapseWhitespace(normalizedExample.prompt ?? normalizedExample.text ?? normalizedExample.label);
  const code = String(normalizedExample.code ?? normalizedExample.javascript ?? "").trim();
  const icon = normalizeExampleIcon(normalizedExample.icon);
  const color = normalizeExampleColor(normalizedExample.color ?? normalizedExample.iconColor ?? normalizedExample.icon_color);
  const kind = normalizeExampleKind(normalizedExample.kind, code);

  if (!text) {
    throw new Error(`Empty-canvas example ${index + 1} is missing text.`);
  }

  if (!code) {
    throw new Error(`Empty-canvas example "${text}" is missing code.`);
  }

  const executeCode = await compileExampleCode(code, text);
  const example = Object.freeze({
    color,
    id: normalizeExampleId(normalizedExample.id ?? text, index),
    icon,
    kind,
    prompt,
    text
  });

  return {
    ...example,
    async execute(event = null) {
      return executeCode(example, event);
    }
  };
}

async function normalizeExamplesConfig(rawConfig) {
  const config =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? rawConfig
      : {};
  const entries = Array.isArray(rawConfig)
    ? rawConfig
    : Array.isArray(config.examples)
      ? config.examples
      : [];

  return Promise.all(entries.map((entry, index) => normalizeExampleDefinition(entry, index)));
}

export async function loadEmptyCanvasExamples() {
  if (!emptyCanvasExamplesPromise) {
    emptyCanvasExamplesPromise = (async () => {
      const runtime = getRuntime();
      const response = await fetch(EMPTY_CANVAS_EXAMPLES_CONFIG_URL, {
        credentials: "same-origin"
      });

      if (!response.ok) {
        throw new Error(
          `Unable to read ${EMPTY_CANVAS_EXAMPLES_CONFIG_URL}: ${response.status} ${response.statusText}`
        );
      }

      const source = await response.text();
      return normalizeExamplesConfig(runtime.utils.yaml.parse(source));
    })().catch((error) => {
      emptyCanvasExamplesPromise = null;
      throw error;
    });
  }

  return emptyCanvasExamplesPromise;
}
