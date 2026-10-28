// THE ONE TURN-PROGRESS VOCABULARY (P4b-2b).
//
// Before this module the phrase a user read while the agent worked existed in two
// places that had already drifted: the onscreen store's private
// `getStreamingAssistantStatus` (four phases, fence-aware, line-counted) and admin's
// inline arrow inside the turn-driver surface wiring, which could only ever say
// `Thinking...` or `Writing response...`. Two derivations of one fact is the defect
// class this campaign exists to remove, so the classifier MOVED here and every
// consumer delegates to it:
//
//   - the onscreen store, for its compact-mode opinion bubble;
//   - the admin store, for the status text its compact surface would show;
//   - the shared thread view, for the turn-level progress indicator's label.
//
// It closes over nothing. The fence-aware block extractor is INJECTED because each
// surface owns its own execution module (`onscreen_agent/execution.js` vs
// `admin/views/agent/execution.js`) and a second copy of fence logic is the BUG-007
// anti-pattern. A caller that passes nothing gets the no-blocks reading, which is the
// safe direction: it can never claim work that a fence said was only displayed.
//
// The four strings are byte-identical to the ones the onscreen store produced before
// this move. Nothing new is introduced and nothing is resurrected.

export const TURN_PROGRESS_THINKING = "Thinking...";
export const TURN_PROGRESS_PREPARING_CODE = "Preparing code...";
export const TURN_PROGRESS_WRITING_RESPONSE = "Writing response...";

// Trim trailing blank lines before counting, because a streamed reply almost always
// ends mid-line and an honest count must not grow on whitespace.
export function countDisplayLines(text) {
  const normalizedText =
    typeof text === "string" ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() : "";

  if (!normalizedText.trim()) {
    return 0;
  }

  return normalizedText.split("\n").length;
}

export function formatLineCount(lineCount) {
  return `${lineCount.toLocaleString()} ${lineCount === 1 ? "line" : "lines"}`;
}

export function getTurnProgressLabel(content, { extractExecuteBlocks } = {}) {
  const normalizedContent = typeof content === "string" ? content : "";
  const blocks =
    typeof extractExecuteBlocks === "function" ? extractExecuteBlocks(normalizedContent) : [];
  const executeBlocks = Array.isArray(blocks) ? blocks : [];

  if (executeBlocks.length) {
    const codeLineCount = countDisplayLines(executeBlocks[0]?.code || "");

    if (codeLineCount > 0) {
      return `Writing ${formatLineCount(codeLineCount)} of code...`;
    }

    return TURN_PROGRESS_PREPARING_CODE;
  }

  if (normalizedContent.trim()) {
    return TURN_PROGRESS_WRITING_RESPONSE;
  }

  return TURN_PROGRESS_THINKING;
}
