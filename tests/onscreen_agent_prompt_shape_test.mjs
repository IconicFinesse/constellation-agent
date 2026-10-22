import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const {
  buildMessagePromptParts,
  MESSAGE_PROMPT_PART_BLOCK
} = await import("../app/L0/_all/mod/_core/onscreen_agent/attachments.js");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

test("onscreen agent keeps attachment metadata in the user block and runtime guidance in framework telemetry", () => {
  const parts = buildMessagePromptParts({
    attachments: [
      {
        available: true,
        id: "attachment-1",
        name: "astronaut.jpg",
        size: 135 * 1024,
        type: "image/jpeg"
      }
    ],
    content: "save it for me",
    id: "user-1",
    role: "user"
  });

  assert.deepEqual(
    parts.map((part) => part.blockType),
    [MESSAGE_PROMPT_PART_BLOCK.USER, MESSAGE_PROMPT_PART_BLOCK.FRAMEWORK]
  );
  assert.match(parts[0].content, /^save it for me\n\nAttachments↓\n- attachment-1 \|/u);
  assert.match(parts[0].content, /astronaut\.jpg/u);
  assert.doesNotMatch(parts[0].content, /Chat runtime access↓/u);
  assert.match(parts[1].content, /^Chat runtime access↓/u);
  assert.match(parts[1].content, /space\.chat\.attachments\.forMessage\("user-1"\)/u);
  assert.doesNotMatch(parts[1].content, /Attachments↓/u);
});

test("onscreen prompt source keeps an explicit example reset boundary", async () => {
  const llmPath = path.join(ROOT_DIR, "app/L0/_all/mod/_core/onscreen_agent/llm.js");
  const llmSource = await fs.readFile(llmPath, "utf8");

  assert.match(llmSource, /start of new conversation - don't refer to previous contents/u);
  assert.match(llmSource, /appendExampleResetPromptEntry/u);
});
