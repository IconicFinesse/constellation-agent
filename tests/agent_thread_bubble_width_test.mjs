import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const agentThreadCssPath =
  process.env.AGENT_THREAD_CSS_PATH ||
  "app/L0/_all/modules/_core/visual/conversation/agent-thread.css";
const agentThreadCss = fs.readFileSync(agentThreadCssPath, "utf8");

function getRuleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = agentThreadCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u"));
  assert.ok(match, `expected a CSS rule for ${selector}`);
  return match[1];
}

test("shared thread bubbles clamp wide children to the bubble track", () => {
  const bubbleBody = getRuleBody(".agent-thread-surface .message-bubble");

  assert.match(
    bubbleBody,
    /grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    "message-bubble must use a shrinkable grid track so long code lines or unbreakable tokens cannot widen the bubble past its max-width"
  );
  assert.match(bubbleBody, /min-width:\s*0;/u);
  assert.match(bubbleBody, /max-width:\s*var\(--agent-thread-bubble-max-width\);/u);
});

test("markdown code blocks wrap instead of stretching the thread", () => {
  const codeBody = getRuleBody(".agent-thread-surface .message-markdown pre code");

  assert.match(codeBody, /white-space:\s*pre-wrap;/u);
  assert.match(codeBody, /overflow-wrap:\s*anywhere;/u);
});
