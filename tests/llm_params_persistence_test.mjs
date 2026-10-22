import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import {
  parseSimpleYaml,
  serializeSimpleYaml
} from "../app/L0/_all/mod/_core/framework/js/yaml-lite.js";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const ONSCREEN_CONFIG_PATH = "~/conf/onscreen-agent.yaml";
const ADMIN_CONFIG_PATH = "~/conf/admin-chat.yaml";
const MEMBER_PROFILE = "temperature:1.1";
const MEMBER_INSTRUCTIONS = "Prefer short answers.";

function createRuntimeStub(files) {
  return {
    api: {
      async fileRead(path) {
        if (!files.has(path)) {
          const error = new Error("File not found.");
          error.status = 404;
          throw error;
        }

        return { content: files.get(path) };
      },
      async fileWrite(path, content) {
        files.set(path, content);
        return {};
      },
      async userSelfInfo() {
        return { username: "tester" };
      }
    },
    config: {
      get(key, fallback) {
        return fallback;
      }
    },
    utils: {
      userCrypto: {
        async decryptText(value) {
          return String(value || "").replace(/^userCrypto:/u, "");
        },
        async encryptText(value) {
          return "userCrypto:" + String(value || "");
        }
      },
      yaml: {
        parse(sourceText) {
          return parseSimpleYaml(sourceText);
        },
        stringify(source) {
          return serializeSimpleYaml(source);
        }
      }
    }
  };
}

function installRuntime(files) {
  const runtime = createRuntimeStub(files);

  globalThis.space = runtime;

  return runtime;
}

async function loadStorageModules() {
  const onscreenStorage = await import(
    "../app/L0/_all/mod/_core/onscreen_agent/storage.js"
  );
  const adminStorage = await import(
    "../app/L0/_all/mod/_core/admin/views/agent/storage.js"
  );

  return {
    adminStorage,
    onscreenStorage
  };
}

function readStoredParams(content) {
  const parsed = parseSimpleYaml(content);

  return {
    hasParams: Object.hasOwn(parsed, "params"),
    instructions: parsed.custom_system_prompt ?? "",
    params: parsed.params
  };
}

const { adminStorage, onscreenStorage } = await loadStorageModules();

const ONSCREEN_DEFAULT_PARAMS = (
  await import("../app/L0/_all/mod/_core/onscreen_agent/config.js")
).DEFAULT_ONSCREEN_AGENT_SETTINGS.paramsText;
const ADMIN_DEFAULT_PARAMS = (
  await import("../app/L0/_all/mod/_core/admin/views/agent/config.js")
).DEFAULT_ADMIN_CHAT_SETTINGS.paramsText;

test("onscreen agent keeps an explicitly cleared params value and saved custom instructions", async () => {
  const files = new Map();

  installRuntime(files);

  await onscreenStorage.saveOnscreenAgentConfig({
    settings: {
      paramsText: ""
    },
    systemPrompt: MEMBER_INSTRUCTIONS
  });

  const savedContent = files.get(ONSCREEN_CONFIG_PATH);
  const saved = readStoredParams(savedContent);

  assert.equal(saved.hasParams, true, "saved config must include the params field");
  assert.equal(saved.params, "", "cleared params must stay empty instead of the default");
  assert.equal(saved.instructions, MEMBER_INSTRUCTIONS);

  const loaded = await onscreenStorage.loadOnscreenAgentConfig();

  assert.equal(loaded.settings.paramsText, "", "cleared params must load back as empty");
  assert.equal(loaded.systemPrompt, MEMBER_INSTRUCTIONS);
});

test("onscreen agent still falls back to the default params when the field is absent", async () => {
  const files = new Map();

  installRuntime(files);
  files.set(ONSCREEN_CONFIG_PATH, "model: custom/model\n");

  const loaded = await onscreenStorage.loadOnscreenAgentConfig();

  assert.equal(loaded.settings.paramsText, ONSCREEN_DEFAULT_PARAMS);
});

test("onscreen agent persists member-supplied params unchanged", async () => {
  const files = new Map();

  installRuntime(files);

  await onscreenStorage.saveOnscreenAgentConfig({
    settings: {
      paramsText: MEMBER_PROFILE
    },
    systemPrompt: ""
  });

  const saved = readStoredParams(files.get(ONSCREEN_CONFIG_PATH));

  assert.equal(saved.params, MEMBER_PROFILE);
});

test("admin agent keeps an explicitly cleared params value and saved custom instructions", async () => {
  const files = new Map();

  installRuntime(files);

  await adminStorage.saveAdminChatConfig({
    settings: {
      paramsText: ""
    },
    systemPrompt: MEMBER_INSTRUCTIONS
  });

  const saved = readStoredParams(files.get(ADMIN_CONFIG_PATH));

  assert.equal(saved.hasParams, true);
  assert.equal(saved.params, "");
  assert.equal(saved.instructions, MEMBER_INSTRUCTIONS);

  const loaded = await adminStorage.loadAdminChatConfig();

  assert.equal(loaded.settings.paramsText, "");
  assert.equal(loaded.systemPrompt, MEMBER_INSTRUCTIONS);
});

test("admin agent still falls back to the default params when the field is absent", async () => {
  const files = new Map();

  installRuntime(files);
  files.set(ADMIN_CONFIG_PATH, "model: custom/model\n");

  const loaded = await adminStorage.loadAdminChatConfig();

  assert.equal(loaded.settings.paramsText, ADMIN_DEFAULT_PARAMS);
});
