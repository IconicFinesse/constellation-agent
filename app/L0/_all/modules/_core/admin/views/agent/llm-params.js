import { SimpleYamlError, parseYamlDocument } from "../../../framework/js/yaml-lite.js";

function createYamlError(message, lineNumber) {
  return new Error(lineNumber ? `Invalid LLM params YAML on line ${lineNumber}: ${message}` : message);
}

export function parseAdminAgentParamsText(sourceText) {
  try {
    const parsed = parseYamlDocument(sourceText);

    if (parsed === null || parsed === undefined) {
      return {};
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw createYamlError("LLM params must be YAML key: value pairs");
    }

    return parsed;
  } catch (error) {
    if (error instanceof SimpleYamlError) {
      throw createYamlError(error.reason, error.lineNumber);
    }

    throw error;
  }
}
