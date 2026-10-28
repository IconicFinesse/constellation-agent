import { renderMarkdown } from "/modules/_core/framework/js/markdown-frontmatter.js";
// The ONE reader of the projected chip format (`execution <name> call|result` + newline
// + body). It lives beside the writer that produces that format, so the committed row and
// the mid-turn provisional chip slice the body identically instead of keeping two copies
// of the rule. Pure data transform: no I/O, no dispatch, no engine-swap machinery.
import { readProjectedChipBody } from "/modules/_core/framework/js/engine-swap/history-shapes.js";
// THE ONE LINE CLASSIFIER and the ONE typed-result formatter (P4b-1).
//
// The classifier MOVED here from this file's factory closure: it closes over nothing but
// its own print-level pattern, so living in the shared layer changes no behaviour and makes
// the `result↓` arrow reachable from the typed panes — which is the whole point, because a
// typed payload is drawn as classified lines now instead of one undifferentiated blob.
//
// Both the mid-turn chip and the committed row paint through this one module, so there is
// exactly one vocabulary for what a line means.
import {
  formatTypedToolArguments,
  formatTypedToolResult,
  getExecutionOutputLineModifier,
  hasExecutionHiddenMarker
} from "/modules/_core/framework/js/engine-swap/typed-result-format.js";
import {
  collectToolRun,
  collectToolRunCalls,
  collectWithheldCallIds,
  formatToolRunLabel,
  summarizeToolRun,
  toolRunKey
} from "/modules/_core/visual/conversation/tool-run.js";
import {
  MESSAGE_CONTENT_PAINTER,
  paintPreviewMarkdown,
  PREVIEW_PAINT_MODE,
  selectMessageContentPainter
} from "/modules/_core/visual/conversation/preview-markdown.js";
// THE ONE turn-progress vocabulary (P4b-2b). The turn-level indicator below and the two
// surfaces' status lines all read their words from here, so a phase can never be spelled
// two ways. The fence-aware block extractor stays injected through this factory's
// `execution` config, exactly as every other separator question in this file does.
import { getTurnProgressLabel } from "/modules/_core/visual/conversation/turn-progress.js";

const EXECUTION_STATUS_LINE_PATTERN = /^execution\s+(.+)$/iu;
// `EXECUTION_PRINT_LINE_PATTERN` MOVED with the classifier it belongs to (P4b-1).
const ORDERED_LIST_LINE_PATTERN = /^\d+\.\s+/u;
const STICKY_SCROLL_THRESHOLD = 96;

// Terminal chip state for text that carries an execution separator but was never
// executed. On a Tier 1 turn a model can answer with separator-bearing prose and
// no typed tool call: nothing dispatches, so no execution result ever arrives to
// settle the chip. A chip that waits for a result that cannot exist is a state
// with no exit, so that turn ends here instead.
export const EXECUTION_DISPLAY_ONLY_STATE = "display-only";
export const EXECUTION_DISPLAY_ONLY_LABEL = "Shown, not executed";
export const EXECUTION_DISPLAY_ONLY_OUTPUT_TEXT = "Nothing was executed.";

// ONE VOCABULARY PER TIER (chat-polish-3 item 1).
//
// A separator-bearing reply on a TYPED turn (Tier 1) is display text BY CONSTRUCTION: on
// that tier nothing executes separator code, ever — actions happen only through typed
// tool calls. Yet the live reply still rendered the Tier 3 card, `Writing 70 lines of
// code` with the pencil icon, BESIDE the typed `run_code · Running` chip for the same
// turn. Two mechanisms, two vocabularies, one turn: the exact inconsistency the owner
// reported.
//
// The message carries the mark (`tier1Turn: true`) because the STORE created it as the
// engine-swap preview; that is the only thing that knows which tier is running. With the
// mark, the card resolves display-only even while the text is still arriving, and the
// turn reads in ONE vocabulary: typed calls say `run_code · Running/Success/Error`,
// displayed code says `Shown, not executed`.
//
// A Tier 3 turn carries no mark, so its cards (and their `Writing N lines` /
// `Executed N lines` wording) stay byte-identical.
function isTier1DisplayOnlyTurn(message) {
  return message?.tier1Turn === true;
}

// ONE resolver for the execution card's visual state, so the summary label, the
// status icon, the output pane, and the render signature cannot disagree.
//
// Precedence is deliberate. Live streaming and an explicit rerun both mean work is
// genuinely in flight, so they win. A message KNOWN to carry unexecuted text then
// wins over the busy guess: `isConversationBusy` is an inference that results are
// coming, and for separator text on a tool session no result ever will be, so the
// inference must not be allowed to outrank the fact. The busy branch keeps its old
// meaning for every other message: no results yet and the surface is still busy.
export function resolveExecutionCardState({
  displayOnly = false,
  displayOnlyTier = false,
  hasError = false,
  hasResults = false,
  isConversationBusy = false,
  isProvisional = false,
  isRerunning = false,
  isStreaming = false
} = {}) {
  // A TYPED-TIER (Tier 1) card has ONE reading, whatever else is true of it: nothing on
  // that tier executes separator text, so the card describes shown code and cannot
  // legitimately claim to be writing or running anything. Its own facts still outrank it
  // — a rerun that really executed turns the same card into Success/Error, exactly as on
  // any other message.
  //
  // This branch is why a live Tier 1 turn no longer reads `Writing 70 lines of code`
  // beside its typed `run_code · Running` chip. Streaming still outranks display-only for
  // every OTHER message (Tier 3), which the resolver's existing tests pin.
  if (displayOnlyTier) {
    if (hasError) {
      return { iconName: "error", pendingState: "", tone: "is-error" };
    }

    if (hasResults) {
      return { iconName: "check_circle", pendingState: "", tone: "is-success" };
    }

    return { iconName: "visibility", pendingState: EXECUTION_DISPLAY_ONLY_STATE, tone: "is-pending" };
  }

  if (isStreaming) {
    return { iconName: "edit_note", pendingState: "generating", tone: "is-writing" };
  }

  // A PROVISIONAL chip is a call whose streamed arguments completed but whose turn
  // has not committed. It is running by construction and it can never carry results:
  // the thing it describes has not happened yet. It therefore outranks every
  // results-shaped branch below, and it is the one state the surface MUST be able to
  // end, which is why the provisional set is cleared on every turn exit.
  if (isProvisional) {
    return { iconName: "sync", pendingState: "running", tone: "is-running" };
  }

  if (isRerunning) {
    return { iconName: "sync", pendingState: "running", tone: "is-running" };
  }

  // Real execution results outrank the display-only label. A message can stop being
  // unexecuted (the user reruns it), and the label must follow the output pane rather
  // than contradict it: a card showing real output under "Shown, not executed" would
  // be the same class of lie this state exists to remove.
  if (hasError) {
    return { iconName: "error", pendingState: "", tone: "is-error" };
  }

  if (hasResults) {
    return { iconName: "check_circle", pendingState: "", tone: "is-success" };
  }

  if (displayOnly) {
    return { iconName: "visibility", pendingState: EXECUTION_DISPLAY_ONLY_STATE, tone: "is-pending" };
  }

  if (isConversationBusy) {
    return { iconName: "sync", pendingState: "running", tone: "is-running" };
  }

  return { iconName: "schedule", pendingState: "", tone: "is-pending" };
}

function executionResultsHaveError(results) {
  const normalizedResults = Array.isArray(results) ? results : [];

  return normalizedResults.some(
    (result) => String(result?.status || "").trim().toLowerCase() === "error"
  );
}

function joinClassNames(...classNames) {
  return classNames
    .map((className) => (typeof className === "string" ? className.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

function defaultFormatAttachmentSize(bytes) {
  const normalizedBytes = Number.isFinite(Number(bytes)) ? Math.max(0, Math.round(Number(bytes))) : 0;

  if (normalizedBytes < 1024) {
    return `${normalizedBytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = normalizedBytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const roundedValue = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${roundedValue} ${units[unitIndex]}`;
}

function buildDefaultEmptyState(text) {
  const emptyState = document.createElement("div");
  emptyState.className = "chat-empty";

  const hint = document.createElement("div");
  hint.className = "chat-empty-hint";
  hint.textContent = text || "Send a message to start the thread.";

  emptyState.append(hint);
  return emptyState;
}

export function createAgentThreadView(config = {}) {
  const assistantAvatarPath = typeof config.assistantAvatarPath === "string" ? config.assistantAvatarPath : "";
  const autoResizeMaxHeight = Number.isFinite(Number(config.autoResizeMaxHeight))
    ? Math.max(32, Math.round(Number(config.autoResizeMaxHeight)))
    : 120;
  const groupConsecutiveAvatars = config.groupConsecutiveAvatars === true;
  const renderMarkdownWithMarked = config.renderMarkdownWithMarked === true;
  const assistantMarkdownClassName =
    typeof config.assistantMarkdownClassName === "string" ? config.assistantMarkdownClassName.trim() : "";
  const defaultEmptyStateText =
    typeof config.emptyStateText === "string" && config.emptyStateText.trim()
      ? config.emptyStateText.trim()
      : "Send a message to start the thread.";
  const executionModule = config.execution && typeof config.execution === "object" ? config.execution : null;
  const formatAttachmentSize =
    typeof config.formatAttachmentSize === "function" ? config.formatAttachmentSize : defaultFormatAttachmentSize;
  const createEmptyState =
    typeof config.createEmptyState === "function" ? config.createEmptyState : null;

  function extractExecuteBlocks(content) {
    if (!executionModule || typeof executionModule.extractExecuteBlocks !== "function") {
      return [];
    }

    return executionModule.extractExecuteBlocks(content);
  }

  function summarizeSystemPrompt(systemPrompt) {
    if (!systemPrompt.trim()) {
      return "Default only";
    }

    const preview = systemPrompt.trim().replace(/\s+/gu, " ");
    return preview.length > 72 ? `${preview.slice(0, 72)}...` : preview;
  }

  function summarizeEndpoint(endpoint) {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint || "Not set";
    }
  }

  function summarizeLlmConfig(apiEndpoint, model) {
    const normalizedModel = typeof model === "string" ? model.trim() : "";
    const provider = summarizeEndpoint(apiEndpoint);

    if (normalizedModel) {
      return normalizedModel;
    }

    return provider || "Not set";
  }

  function autoResizeTextarea(textarea) {
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, autoResizeMaxHeight)}px`;
  }

  function stripExecuteBlocks(content) {
    if (typeof content !== "string" || !content.trim()) {
      return "";
    }

    let stripped = content;

    extractExecuteBlocks(content).forEach((block) => {
      stripped = stripped.replace(block.raw, "");
    });

    return stripped.replace(/\n{3,}/gu, "\n\n").trim();
  }

  function normalizeExecuteNarration(content) {
    return stripExecuteBlocks(content);
  }

  function parseExecuteDisplayContent(content) {
    if (typeof content !== "string" || !content.trim()) {
      return null;
    }

    const executeBlocks = extractExecuteBlocks(content);

    if (!executeBlocks.length) {
      return null;
    }

    let narration = content;

    executeBlocks.forEach((block) => {
      narration = narration.replace(block.raw, "");
    });

    return {
      blocks: executeBlocks.map((block) => block.code.trimEnd()),
      narration: normalizeExecuteNarration(narration)
    };
  }

  function parseExecutionOutputMessage(content) {
    if (typeof content !== "string") {
      return null;
    }

    const lines = content.trim().split(/\r?\n/u).map((line) => line.trimEnd());
    const results = [];
    let currentResult = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line) {
        continue;
      }

      const statusMatch = line.match(EXECUTION_STATUS_LINE_PATTERN);

      if (statusMatch) {
        currentResult = {
          outputLines: [`execution ${statusMatch[1].trim()}`],
          status: statusMatch[1].trim()
        };
        results.push(currentResult);
        continue;
      }

      if (!currentResult) {
        return null;
      }

      currentResult.outputLines.push(line);
    }

    return results.length ? results : null;
  }

  function getExecutionOutputResults(message) {
    if (!message || message.role !== "user" || message.kind !== "execution-output") {
      return null;
    }

    return parseExecutionOutputMessage(message.content);
  }

  // The line classifier MOVED to the shared typed-result formatter (P4b-1). It is not
  // re-declared here: one classifier, one vocabulary, imported from above.

  function appendTerminalLine(container, text, modifier) {
    const line = document.createElement("div");
    line.className = modifier ? `terminal-line ${modifier}` : "terminal-line";
    line.textContent = text;
    container.append(line);
  }

  function countCodeLines(text) {
    if (typeof text !== "string" || !text.length) {
      return 0;
    }

    return text.split("\n").length;
  }

  function getExecuteDisplayLineCount(executeDisplay) {
    if (!executeDisplay || !Array.isArray(executeDisplay.blocks) || !executeDisplay.blocks.length) {
      return 0;
    }

    return executeDisplay.blocks.reduce((total, block) => total + countCodeLines(block), 0);
  }

  function formatLineCount(lineCount) {
    return `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
  }

  function createTerminalOutputEntries(results, options = {}) {
    const pendingState = options.pendingState || "";

    if (!Array.isArray(results) || !results.length) {
      const pendingText =
        pendingState === "generating"
          ? "Generating code..."
          : pendingState === "running"
            ? "Running..."
            : pendingState === EXECUTION_DISPLAY_ONLY_STATE
              ? EXECUTION_DISPLAY_ONLY_OUTPUT_TEXT
              : "No output yet.";

      return [
        {
          modifier: "is-muted",
          text: pendingText
        }
      ];
    }

    const entries = [];

    results.forEach((result, index) => {
      if (index > 0) {
        entries.push({
          type: "divider"
        });
      }

      const lines = Array.isArray(result?.outputLines) ? result.outputLines : [];

      lines.forEach((line) => {
        entries.push({
          modifier: getExecutionOutputLineModifier(line),
          text: line
        });
      });
    });

    return entries;
  }

  function appendTerminalOutput(container, results, pendingState = "") {
    createTerminalOutputEntries(results, {
      pendingState
    }).forEach((entry) => {
      if (entry.type === "divider") {
        const divider = document.createElement("div");
        divider.className = "terminal-divider";
        divider.setAttribute("aria-hidden", "true");
        container.append(divider);
        return;
      }

      appendTerminalLine(container, entry.text, entry.modifier);
    });
  }

  function getTerminalInputText(executeDisplay) {
    if (!executeDisplay || !Array.isArray(executeDisplay.blocks)) {
      return "";
    }

    return executeDisplay.blocks.join("\n\n").trim();
  }

  function getTerminalOutputText(results) {
    return createTerminalOutputEntries(results)
      .map((entry) => (entry.type === "divider" ? "" : entry.text))
      .join("\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
  }

  function appendInlineFormattedText(target, text) {
    const source = String(text || "");
    const pattern = /`([^`]+)`|(https?:\/\/[^\s<]+)/gu;
    let lastIndex = 0;

    source.replace(pattern, (match, codeText, urlText, index) => {
      if (index > lastIndex) {
        target.append(document.createTextNode(source.slice(lastIndex, index)));
      }

      if (codeText) {
        const code = document.createElement("code");
        code.textContent = codeText;
        target.append(code);
      } else if (urlText) {
        const link = document.createElement("a");
        link.href = urlText;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = urlText;
        target.append(link);
      }

      lastIndex = index + match.length;
      return match;
    });

    if (lastIndex < source.length) {
      target.append(document.createTextNode(source.slice(lastIndex)));
    }
  }

  function appendParagraphLines(element, text) {
    const lines = String(text || "").split("\n");

    lines.forEach((line, index) => {
      if (index > 0) {
        element.append(document.createElement("br"));
      }

      appendInlineFormattedText(element, line);
    });
  }

  function appendTextSegment(container, text) {
    const blocks = String(text || "")
      .trim()
      .split(/\n\s*\n/gu)
      .map((block) => block.trim())
      .filter(Boolean);

    blocks.forEach((block) => {
      const lines = block.split("\n").map((line) => line.trimEnd());
      const isUnorderedList = lines.every((line) => /^[-*]\s+/u.test(line.trim()));
      const isOrderedList = lines.every((line) => ORDERED_LIST_LINE_PATTERN.test(line.trim()));

      if (isUnorderedList || isOrderedList) {
        const list = document.createElement(isOrderedList ? "ol" : "ul");

        lines.forEach((line) => {
          const item = document.createElement("li");
          const itemText = isOrderedList
            ? line.trim().replace(ORDERED_LIST_LINE_PATTERN, "")
            : line.trim().slice(2);
          appendParagraphLines(item, itemText);
          list.append(item);
        });

        container.append(list);
        return;
      }

      const paragraph = document.createElement("p");
      appendParagraphLines(paragraph, block);
      container.append(paragraph);
    });
  }

  function createLegacyFormattedMessageBlock(text, className) {
    const normalizedText = String(text || "").trim();

    if (!normalizedText) {
      return null;
    }

    const content = document.createElement("div");
    content.className = className;
    const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/gu;
    let cursor = 0;
    let match;

    while ((match = fencePattern.exec(normalizedText))) {
      const [rawMatch, language, code] = match;
      const before = normalizedText.slice(cursor, match.index);

      if (before.trim()) {
        appendTextSegment(content, before);
      }

      const pre = document.createElement("pre");
      const codeElement = document.createElement("code");

      if (language && language.trim()) {
        codeElement.className = `language-${language.trim()}`;
      }

      codeElement.textContent = code.trimEnd();
      pre.append(codeElement);
      content.append(pre);
      cursor = match.index + rawMatch.length;
    }

    const trailing = normalizedText.slice(cursor);

    if (trailing.trim()) {
      appendTextSegment(content, trailing);
    }

    return content.childNodes.length ? content : null;
  }

  function createSharedMarkdownBlock(text, className) {
    const normalizedText = String(text || "").trim();

    if (!normalizedText) {
      return null;
    }

    const content = renderMarkdown(normalizedText, null, { className });
    return content.childNodes.length ? content : null;
  }

  function createFormattedMessageBlock(text, className = "message-content message-markdown") {
    if (renderMarkdownWithMarked) {
      return createSharedMarkdownBlock(text, className);
    }

    return createLegacyFormattedMessageBlock(text, className);
  }

  function unwrapSingleParagraphMessageBlock(block) {
    if (!block || block.tagName !== "DIV") {
      return block;
    }

    const significantChildNodes = Array.from(block.childNodes).filter((childNode) => {
      if (childNode.nodeType !== Node.TEXT_NODE) {
        return true;
      }

      return Boolean(childNode.textContent && childNode.textContent.trim());
    });
    const elementChildren = Array.from(block.children);

    if (significantChildNodes.length !== 1 || elementChildren.length !== 1) {
      return block;
    }

    const [onlyChild] = elementChildren;

    if (!onlyChild || onlyChild.tagName !== "P") {
      return block;
    }

    onlyChild.className = joinClassNames(block.className, onlyChild.className);
    return onlyChild;
  }

  function createExecutionNarrationBlock(text) {
    return unwrapSingleParagraphMessageBlock(
      createFormattedMessageBlock(text, buildAssistantMarkdownClassName("terminal-note"))
    );
  }

  function buildAssistantMarkdownClassName(...classNames) {
    return joinClassNames("message-content", "message-markdown", assistantMarkdownClassName, ...classNames);
  }

  function createAttachmentList(attachments) {
    if (!Array.isArray(attachments) || !attachments.length) {
      return null;
    }

    const list = document.createElement("div");
    list.className = "message-attachments";

    attachments.forEach((attachment) => {
      const item = document.createElement("div");
      item.className = "message-attachment";

      if (attachment.available === false) {
        item.classList.add("is-unavailable");
      }

      const name = document.createElement("span");
      name.className = "message-attachment-name";
      name.textContent = attachment.name || "Attachment";

      const meta = document.createElement("span");
      meta.className = "message-attachment-meta";
      meta.textContent = [
        attachment.type || "file",
        formatAttachmentSize(attachment.size),
        attachment.available === false ? "unavailable after reload" : "live"
      ]
        .filter(Boolean)
        .join(" • ");

      item.append(name, meta);
      list.append(item);
    });

    return list;
  }

  function createQueuedStateBadge() {
    const badge = document.createElement("span");
    badge.className = "message-queued-state";
    badge.textContent = "Queued";
    return badge;
  }

  function createMessageAvatar(role) {
    const avatar = document.createElement("div");
    avatar.className =
      role === "assistant" ? "message-avatar message-avatar-agent" : "message-avatar message-avatar-user";
    avatar.setAttribute("aria-hidden", "true");

    if (role === "assistant") {
      const image = document.createElement("img");
      image.src = assistantAvatarPath;
      image.alt = "";
      image.loading = "lazy";
      avatar.append(image);
      return avatar;
    }

    const icon = document.createElement("x-icon");
    icon.textContent = "person";
    avatar.append(icon);
    return avatar;
  }

  function createMessageAvatarSpacer(role) {
    const avatar = document.createElement("div");
    avatar.className =
      role === "assistant"
        ? "message-avatar message-avatar-agent message-avatar-spacer"
        : "message-avatar message-avatar-user message-avatar-spacer";
    avatar.setAttribute("aria-hidden", "true");
    return avatar;
  }

  function createAssistantMessageActionButton({ action, disabled = false, iconName, messageId, title }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "assistant-message-action";
    button.dataset.messageAction = action;
    button.dataset.messageId = messageId;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.disabled = disabled;

    const icon = document.createElement("x-icon");
    icon.textContent = iconName;
    button.append(icon);
    return button;
  }

  function createMessageAccessory(role, options = {}) {
    const accessory = document.createElement("div");
    accessory.className = role === "assistant" ? "message-accessory" : "message-accessory message-accessory-user";

    if (options.showAvatar === false) {
      accessory.classList.add("is-avatar-continuation");
      accessory.append(createMessageAvatarSpacer(role));
      return accessory;
    }

    accessory.append(createMessageAvatar(role));
    return accessory;
  }

  // --- TURN-LEVEL PROGRESS AFFORDANCE (P4b-2b) --------------------------------
  //
  // The per-call chip spinner answers "is THIS call running". Nothing answered "is the
  // agent working right now", so before the first token of a turn the transcript showed
  // the user's own row and nothing else — dead air — and a turn that opened with a tool
  // call showed chips with no turn-level context around them.
  //
  // PRESENCE IS DERIVED, NEVER REMEMBERED. `options.isConversationBusy` is the surface's
  // own in-flight flag and BOTH surfaces already pass it to this renderer, so the
  // indicator needs no new store field, no new render option and no cleanup call. It is
  // recomputed on every paint from the same option the chip's busy state already reads,
  // which is what makes an outliving indicator impossible: there is no stored state that
  // a missed exit could leave behind, only a paint that would have to keep claiming a
  // turn is live after the surface stopped saying so.
  //
  // THE LABEL is the ONE shared vocabulary (`turn-progress.js`), fed the content this
  // render was handed. That content is the live assistant entry the projection already
  // appends while a turn streams, so the label tracks the phase with no second reader.
  function getLiveTurnContent(history) {
    if (!Array.isArray(history)) {
      return "";
    }

    const liveEntry = history.find(
      (entry) => entry && entry.role === "assistant" && entry.streaming === true
    );

    return liveEntry && typeof liveEntry.content === "string" ? liveEntry.content : "";
  }

  function createTurnProgressRow() {
    const row = document.createElement("div");
    row.className = "message-row assistant turn-progress-row";
    row.dataset.turnProgress = "true";
    // A live region, announced when it appears and when the PHASE changes. The label is
    // written through `setElementText`, which skips an identical string, so a repaint tick
    // that changes nothing does not re-announce. The spinner is decorative: the words carry
    // the meaning, which is also what makes the reduced-motion variant honest.
    row.setAttribute("role", "status");
    row.setAttribute("aria-live", "polite");
    row.setAttribute("aria-atomic", "true");

    const bubble = document.createElement("div");
    bubble.className = "turn-progress-bubble";

    const spinner = document.createElement("span");
    spinner.className = "turn-progress-spinner";
    spinner.setAttribute("aria-hidden", "true");
    // The EXISTING icon and the EXISTING keyframes: `agent-thread-spin` already drives
    // every running chip, so the turn indicator cannot introduce a second animation.
    const icon = document.createElement("x-icon");
    icon.textContent = "sync";
    spinner.append(icon);

    const label = document.createElement("span");
    label.className = "turn-progress-label";
    label.dataset.turnProgressLabel = "true";

    bubble.append(spinner, label);
    row.append(createMessageAvatarSpacer("assistant"), bubble);
    return row;
  }

  // The LABEL half on its own, for the per-delta patch path. A phase change ("Thinking..." →
  // "Writing 12 lines of code...") happens while the row is being patched in place, not
  // only on a full render, so both painters read the SAME classifier and the SAME live
  // content. Presence is deliberately not touched here: a patch can only run while a
  // streaming entry exists, which is a turn in flight by definition.
  function syncTurnProgressLabel(thread, content) {
    if (!thread) {
      return;
    }

    const row = thread.querySelector("[data-turn-progress]");

    if (!row) {
      return;
    }

    setElementText(
      row.querySelector("[data-turn-progress-label]"),
      getTurnProgressLabel(content, { extractExecuteBlocks })
    );
  }

  function syncTurnProgress(thread, history, options = {}) {
    if (!thread) {
      return;
    }

    const existing = thread.querySelector("[data-turn-progress]");

    if (options.isConversationBusy !== true) {
      // ABSENT when no turn is in flight. Presence is the only thing this row ever says
      // about liveness, so removing it IS the clear — there is no separate completion path
      // that could be forgotten.
      existing?.remove();
      return;
    }

    const row = existing || createTurnProgressRow();
    setElementText(
      row.querySelector("[data-turn-progress-label]"),
      getTurnProgressLabel(getLiveTurnContent(history), { extractExecuteBlocks })
    );

    if (!existing) {
      thread.append(row);
      return;
    }

    // KEEP IT LAST. The thread's row diff is POSITIONAL, so a row inserted here would
    // shift every index above it. This renderer filters the indicator out of that diff (it
    // is not a history row), and re-appending keeps the reading order stable: the words a
    // turn is producing, then the one line saying the turn is still going.
    const children = Array.from(thread.children || []);

    if (children[children.length - 1] !== row) {
      row.remove();
      thread.append(row);
    }
  }

  function createMessageRow(role, bubble, extraClassName = "", options = {}) {
    const row = document.createElement("div");
    row.className = extraClassName ? `message-row ${role} ${extraClassName}` : `message-row ${role}`;

    if (options.showAvatar === false) {
      row.classList.add("is-avatar-continuation");
    }

    row.append(createMessageAccessory(role, options), bubble);
    return row;
  }

  function formatExecutionSummaryLabel(lineCount, pendingState = "", results = []) {
    const lineLabel = lineCount ? formatLineCount(lineCount) : "code";

    if (pendingState === "generating") {
      return `Writing ${lineLabel} of code`;
    }

    if (pendingState === "running") {
      return `Executing ${lineLabel} of code`;
    }

    // Text that was SHOWN but never executed must not claim it ran. This is the
    // terminal state a Tier 1 separator-bearing answer settles into.
    if (pendingState === EXECUTION_DISPLAY_ONLY_STATE) {
      return EXECUTION_DISPLAY_ONLY_LABEL;
    }

    if (Array.isArray(results) && results.length) {
      return `Executed ${lineLabel} of code - ${executionResultsHaveError(results) ? "Error" : "Success"}`;
    }

    return `Executed ${lineLabel}`;
  }

  // HONEST LABELS FOR TYPED CHIPS (chat-polish-2 item D).
  //
  // A typed chip is not "N lines of code": it is a named tool call and its outcome.
  // The Tier 3 vocabulary above measures CODE LINES, which a typed chip does not have,
  // so a typed chip inherited the degenerate `Executed code of code - Success` wording
  // (lineCount 0 renders the literal word "code"). This is the Tier 3 vocabulary
  // leaking onto a different kind of row.
  //
  // The vocabulary here is deliberately flat and closed: the tool name, a middot, and
  // the outcome word. It reuses the outcome words the surface already shows elsewhere
  // (Success / Error / Running) so no new visual language is introduced, and it is
  // short enough to sit in the same summary slot. Tier 3 chips keep
  // `formatExecutionSummaryLabel` byte-identical.
  const TYPED_TOOL_OUTCOME_LABELS = Object.freeze({
    deferred: "Deferred",
    error: "Error",
    held: "Held",
    // `pending` is the call-side outcome (a call whose result has not landed yet). The card
    // renders it running, so the label says the same word: one vocabulary, one meaning.
    pending: "Running",
    running: "Running",
    success: "Success"
  });

  function formatTypedToolLabel(name, outcome) {
    const toolName = String(name || "").trim() || "tool";
    const outcomeWord = TYPED_TOOL_OUTCOME_LABELS[String(outcome || "").trim()] || "Success";

    return `${toolName} · ${outcomeWord}`;
  }

  // The card state for a TYPED chip, resolved from the outcome the history reader already
  // classified (`typedToolOutcome`) instead of from the entry's prose.
  //
  // This is the second half of item D and the honest half of item A. A typed chip's text
  // is a projection (`execution <name> result\n<payload>`), and re-parsing it as an
  // execution transcript reports the STATUS LINE as the outcome — which is how a FAILED
  // typed call could draw a green check_circle: `execution file_read result` parses as a
  // result whose status is the string "file_read result", never "error". The outcome word
  // is already known, so the state is taken from it and nothing is re-derived by string
  // matching. `pending` is the call-side outcome (a call whose result has not landed yet);
  // it means the same thing as `running` here.
  const TYPED_TOOL_CARD_STATES = Object.freeze({
    deferred: Object.freeze({ iconName: "schedule", tone: "is-pending" }),
    error: Object.freeze({ iconName: "error", tone: "is-error" }),
    held: Object.freeze({ iconName: "visibility", tone: "is-pending" }),
    pending: Object.freeze({ iconName: "sync", tone: "is-running" }),
    running: Object.freeze({ iconName: "sync", tone: "is-running" }),
    success: Object.freeze({ iconName: "check_circle", tone: "is-success" })
  });

  // SETTLE-ON-DISPATCH vocabulary guard (owner-reported: chips read `Running` for the
  // whole turn). A provisional chip settles on the loop's dispatch event, and only a
  // TERMINAL word may describe it. This set is deliberately narrow: `running` and
  // `pending` mean "work is still in flight", so an entry carrying one of them is not
  // settled news and must fall through to the pre-existing resolution in the descriptor.
  //
  // That restriction is what keeps COMMITTED call rows byte-identical: a committed typed
  // call entry carries `pending` from the shared history reader (history-shapes.js), and
  // its outcome must keep coming from its own result entry exactly as it did before this
  // change.
  const TYPED_TOOL_TERMINAL_OUTCOMES = new Set(["deferred", "error", "held", "success"]);

  function resolveTypedToolCardState(name, outcome) {
    const key = String(outcome || "").trim();
    const state = TYPED_TOOL_CARD_STATES[key] || TYPED_TOOL_CARD_STATES.success;

    return {
      iconName: state.iconName,
      label: formatTypedToolLabel(name, key || "success"),
      tone: state.tone
    };
  }

  function getExecutionSummaryState(results, pendingState = "") {
    return resolveExecutionCardState({
      hasError: executionResultsHaveError(results),
      hasResults: Array.isArray(results) && results.length > 0,
      isStreaming: pendingState === "generating"
    });
  }

  function createAssistantMessageActionRow(message, outputResults = null) {
    const actions = document.createElement("div");
    actions.className = "assistant-message-actions";
    actions.append(
      createAssistantMessageActionButton({
        action: "show-raw",
        disabled: !message.content,
        iconName: "data_object",
        messageId: message.id,
        title: "Show raw output"
      }),
      createAssistantMessageActionButton({
        action: "copy-message",
        disabled: !message.content && (!Array.isArray(outputResults) || !outputResults.length),
        iconName: "content_copy",
        messageId: message.id,
        title: "Copy response or result"
      })
    );
    return actions;
  }

  function createExecutionPane({ body, label, scrollKey = "", type = "" }) {
    const pane = document.createElement("div");
    pane.className = "execution-pane";

    if (type) {
      pane.dataset.executionPane = type;
    }

    const paneLabel = document.createElement("span");
    paneLabel.className = "execution-pane-label";
    paneLabel.textContent = label;

    const paneBody = document.createElement("div");
    paneBody.className = "execution-pane-scroll";

    if (scrollKey) {
      paneBody.dataset.scrollKey = scrollKey;
    }

    if (body) {
      paneBody.append(body);
    }

    pane.append(paneLabel, paneBody);
    return pane;
  }

  function createExecutionRerunButton({ disabled = false, isActive = false, messageId }) {
    return createExecutionDetailButton({
      action: "rerun",
      active: isActive,
      disabled,
      iconName: isActive ? "sync" : "replay",
      label: isActive ? "Running" : "Run again",
      messageId
    });
  }

  function createExecutionDetailButton({ action, active = false, disabled = false, iconName, label, messageId }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "execution-detail-button";
    button.dataset.terminalAction = action;
    button.dataset.terminalMessageId = messageId;
    button.disabled = disabled;

    if (active) {
      button.classList.add("is-active");
    }

    const icon = document.createElement("x-icon");
    icon.textContent = iconName;

    const labelElement = document.createElement("span");
    labelElement.textContent = label;

    button.append(icon, labelElement);
    return button;
  }

  function createExecutionCard({
    displayOnly = false,
    displayOnlyTier = false,
    executeDisplay,
    isConversationBusy,
    isProvisional = false,
    isStreaming,
    messageId,
    outputResults,
    rerunningMessageId,
    typedTool = null
  }) {
    const lineCount = getExecuteDisplayLineCount(executeDisplay);
    const displayOutputResults = rerunningMessageId === messageId ? null : outputResults;
    // TYPED chips resolve their state from the outcome the history reader classified
    // (item D), so a failed typed call can never draw a success icon because its
    // projected prose happens to parse as a status line. Tier 3 chips keep the
    // pre-existing resolver untouched.
    const typedState = typedTool ? resolveTypedToolCardState(typedTool.name, typedTool.outcome) : null;
    const summaryState = typedState
      ? {
          iconName: typedState.iconName,
          pendingState:
            typedTool.outcome === "pending" || typedTool.outcome === "running" ? "running" : "",
          tone: typedState.tone
        }
      : resolveExecutionCardState({
          displayOnly,
          displayOnlyTier,
          hasError: executionResultsHaveError(displayOutputResults),
          hasResults: Array.isArray(displayOutputResults) && displayOutputResults.length > 0,
          isConversationBusy,
          // NON-BLOCKER 4 (chat-polish-2 re-audit): this parameter was threaded in and
          // destructured but never forwarded, so a provisional chip could not resolve
          // `running` through the card at all — the flag existed and did nothing.
          isProvisional,
          isRerunning: rerunningMessageId === messageId,
          isStreaming
        });
    const pendingState = summaryState.pendingState;
    const terminal = document.createElement("details");
    terminal.className = "execution-card";
    terminal.dataset.executionCard = "true";

    if (messageId) {
      terminal.dataset.executionMessageId = messageId;
    }

    const summary = document.createElement("summary");
    summary.className = "execution-summary";

    const summaryMain = document.createElement("div");
    summaryMain.className = "execution-summary-main";

    const status = document.createElement("span");
    status.className = `execution-status ${summaryState.tone}`;
    status.dataset.executionStatus = "true";

    const statusIcon = document.createElement("x-icon");
    statusIcon.dataset.executionStatusIcon = "true";
    statusIcon.textContent = summaryState.iconName;
    status.append(statusIcon);

    const summaryText = document.createElement("div");
    summaryText.className = "execution-summary-text";

    const summaryTitle = document.createElement("span");
    summaryTitle.className = "execution-summary-title";
    summaryTitle.dataset.executionSummaryTitle = "true";
    summaryTitle.textContent = typedState
      ? typedState.label
      : formatExecutionSummaryLabel(lineCount, pendingState, displayOutputResults);

    summaryText.append(summaryTitle);
    summaryMain.append(status, summaryText);

    const summaryChevron = document.createElement("x-icon");
    summaryChevron.className = "execution-summary-chevron";
    summaryChevron.textContent = "chevron_right";

    summary.append(summaryMain, summaryChevron);
    terminal.append(summary);

    const details = document.createElement("div");
    details.className = "execution-details";

    if (executeDisplay) {
      const inputBody = document.createElement("div");
      inputBody.className = "execution-code-list";
      inputBody.dataset.executionInputList = "true";

      executeDisplay.blocks.forEach((block) => {
        const inputBlock = document.createElement("pre");
        inputBlock.className = "terminal-code";
        inputBlock.textContent = block || (isStreaming ? "" : "[empty]");
        inputBody.append(inputBlock);
      });

      details.append(
        createExecutionPane({
          body: inputBody,
          label: lineCount ? `Input • ${formatLineCount(lineCount)}` : "Input",
          scrollKey: messageId ? `${messageId}:input` : "",
          type: "input"
        })
      );
    }

    if (typedTool && (typedTool.argumentsText || typedTool.outputText || typedTool.resultText)) {
      // A typed chip has no execution blocks: its "input" is the call's ARGUMENTS and its
      // "output" is the payload or error the tool returned. Showing them under the honest
      // labels means expanding a typed chip in a group still explains the call (item D),
      // instead of leaving the same projected sentence the summary already stated.
      const inputBody = document.createElement("div");
      inputBody.className = "execution-code-list";
      inputBody.dataset.executionInputList = "true";

      // THE ARGUMENTS, PRETTY-PRINTED (P4b-1). A `run_code` call's arguments are a whole
      // program inside a JSON string, so the untouched text is one line full of escaped
      // `\n` — the wall the owner reported. The shared formatter parses, re-serializes with
      // indentation, and hands back the untouched original for the Raw toggle. A payload
      // that is not JSON comes back verbatim: never mangled.
      const formattedArguments = formatTypedToolArguments({ argumentsText: typedTool.argumentsText });
      const inputBlock = document.createElement("pre");
      inputBlock.className = "terminal-code";
      inputBlock.textContent = formattedArguments.text;
      inputBody.append(inputBlock);

      // The `{ } Raw` affordance, matching the legacy card's. LOCAL DOM STATE ONLY: it swaps
      // this `<pre>`'s text and nothing else — no store field, no persistence, and
      // deliberately absent from `getGroupRenderSignature`, so every repaint starts on the
      // pretty form. The button wears neither `data-message-action` nor
      // `data-terminal-action`, so a store's delegated handler cannot mistake it for one of
      // its own actions.
      const rawButton = document.createElement("button");
      rawButton.type = "button";
      rawButton.className = "execution-detail-button";
      rawButton.dataset.typedArgumentsToggle = "raw";
      const rawIcon = document.createElement("x-icon");
      rawIcon.textContent = "data_object";
      const rawLabel = document.createElement("span");
      rawLabel.textContent = "Raw";
      rawButton.append(rawIcon, rawLabel);
      rawButton.addEventListener("click", () => {
        const showingRaw = rawButton.dataset.typedArgumentsShown === "raw";

        inputBlock.textContent = showingRaw ? formattedArguments.text : formattedArguments.raw;
        rawButton.dataset.typedArgumentsShown = showingRaw ? "pretty" : "raw";
        rawButton.classList.toggle("is-active", !showingRaw);
      });

      inputBody.append(rawButton);

      details.append(
        createExecutionPane({
          body: inputBody,
          label: formattedArguments.lineCount
            ? `Arguments • ${formatLineCount(formattedArguments.lineCount)}`
            : "Arguments",
          scrollKey: messageId ? `${messageId}:input` : "",
          type: "input"
        })
      );
    }

    const outputBody = document.createElement("div");
    outputBody.className = "execution-output-list";
    outputBody.dataset.executionOutputList = "true";

    if (typedState) {
      // THE TYPED RESULT, STRUCTURED, CLASSIFIED AND BOUNDED (P4b-1 + P4b-2a).
      //
      // P4b-1 made this structured: before it, the pane was ONE `terminal-line` holding the
      // whole payload as text, so nothing ever reached the classifier and the `result↓` arrow
      // was missing. P4b-2a makes it BOUNDED, because a structured wall is still a wall. The
      // shared formatter paints a bounded transcript by default (line count for transcript
      // text, admin's console caps for structured values, errors never cut) and paints the
      // complete content when asked for `unbounded`. Both forms come through that ONE
      // formatter, so the collapsed and expanded panes cannot disagree.
      //
      // A pending typed call has no payload at all, so it keeps the honest placeholder it
      // always had rather than an invented empty result.
      const typedResultOptions = {
        error: typedTool.error ?? null,
        name: typedTool.name,
        outputText: String(typedTool.outputText || typedTool.resultText || ""),
        payload: typedTool.payload
      };

      // Repaints the pane and answers whether the BOUNDED form hid anything. Asking the
      // painted lines (rather than recomputing the arithmetic here) is what keeps the
      // affordance honest: it appears exactly when a marker is actually on screen.
      const paintTypedResult = ({ unbounded = false } = {}) => {
        const typedResultLines = formatTypedToolResult({ ...typedResultOptions, unbounded });

        outputBody.replaceChildren();

        if (!typedResultLines.length) {
          appendTerminalLine(outputBody, "No output yet.", "is-muted");

          return false;
        }

        typedResultLines.forEach((entry) => appendTerminalLine(outputBody, entry.text, entry.modifier));

        return typedResultLines.some((entry) => hasExecutionHiddenMarker(entry.text));
      };

      if (paintTypedResult()) {
        // THE EXPANSION AFFORDANCE, in the `{ } Raw` shape P4b-1 established. LOCAL DOM
        // STATE ONLY: it repaints this one pane and nothing else — no store field, no
        // persistence, and deliberately absent from `getGroupRenderSignature`, so every
        // repaint starts on the bounded form. It wears neither `data-message-action` nor
        // `data-terminal-action`, so a store's delegated handler cannot claim it.
        const expandButton = document.createElement("button");
        expandButton.type = "button";
        expandButton.className = "execution-detail-button";
        expandButton.dataset.typedOutputToggle = "expand";
        const expandIcon = document.createElement("x-icon");
        expandIcon.textContent = "expand_more";
        const expandLabel = document.createElement("span");
        expandLabel.textContent = "Show all";
        expandButton.append(expandIcon, expandLabel);
        expandButton.addEventListener("click", () => {
          const showingAll = expandButton.dataset.typedOutputShown === "all";

          paintTypedResult({ unbounded: !showingAll });

          expandButton.dataset.typedOutputShown = showingAll ? "bounded" : "all";
          expandButton.classList.toggle("is-active", !showingAll);
          expandIcon.textContent = showingAll ? "expand_more" : "expand_less";
          expandLabel.textContent = showingAll ? "Show all" : "Show less";
          // The repaint clears the pane, so the control that triggered it is re-appended.
          outputBody.append(expandButton);
        });

        outputBody.append(expandButton);
      }
    } else {
      appendTerminalOutput(outputBody, displayOutputResults || [], pendingState);
    }

    details.append(
      createExecutionPane({
        body: outputBody,
        label: "Output",
        scrollKey: messageId ? `${messageId}:output` : "",
        type: "output"
      })
    );

    if (executeDisplay && messageId) {
      const actions = document.createElement("div");
      actions.className = "execution-details-actions";

      const rawButton = document.createElement("button");
      rawButton.type = "button";
      rawButton.className = "execution-detail-button";
      rawButton.dataset.messageAction = "show-raw";
      rawButton.dataset.messageId = messageId;
      const rawIcon = document.createElement("x-icon");
      rawIcon.textContent = "data_object";
      const rawLabel = document.createElement("span");
      rawLabel.textContent = "Raw";
      rawButton.append(rawIcon, rawLabel);

      actions.append(
        rawButton,
        createExecutionDetailButton({
          action: "copy-input",
          disabled: !getTerminalInputText(executeDisplay),
          iconName: "content_copy",
          label: "Input",
          messageId
        }),
        createExecutionDetailButton({
          action: "copy-output",
          disabled: !Array.isArray(displayOutputResults) || !displayOutputResults.length,
          iconName: "content_copy",
          label: "Output",
          messageId
        }),
        createExecutionRerunButton({
          disabled: isConversationBusy || isStreaming || !getTerminalInputText(executeDisplay),
          isActive: rerunningMessageId === messageId,
          messageId
        })
      );
      details.append(actions);
    }

    terminal.append(details);
    return terminal;
  }

  function createStandardMessageBubble(message) {
    const bubble = document.createElement("article");
    bubble.className = "message-bubble";

    // `is-streaming` USED TO BE ADDED HERE AND PAINTED NOTHING (P4b-2b). Three sites added
    // it and no stylesheet in the tree ever had a rule for it, so it was a marker with no
    // reader — drift that looked like a feature. The turn-level indicator
    // (`[data-turn-progress]`, below) is now the one place a live turn is signalled, and it
    // is a real element rather than an unread class name.
    if (message.kind === "queued") {
      bubble.classList.add("is-queued");
    }

    if (message.role === "assistant") {
      bubble.classList.add("assistant-message-shell");

      // THE ONE committed-vs-preview decision for assistant text (item 3). It is a
      // named seam rather than two inline branches so the boundary is assertable: a
      // settled message takes the PRE-EXISTING formatted block, and only a streaming
      // message may take the preview painter (bounded work, plain-text fallback per
      // tick). Routing a commit through the preview painter therefore CHANGES the
      // rendered output instead of being an invisible style preference.
      const painter = selectMessageContentPainter({ streaming: message.streaming === true });

      if (painter === MESSAGE_CONTENT_PAINTER.PREVIEW) {
        bubble.dataset.streamingMessageId = message.id;
        const streamingBlock = document.createElement("p");
        streamingBlock.className = "message-content";
        streamingBlock.dataset.streamingContent = "true";
        // PROGRESSIVE FORMATTING (item 3). This node exists only while the message
        // is streaming, so it is the preview by construction; the committed block
        // below still goes through `createFormattedMessageBlock` unchanged.
        // A preview SEGMENT may legitimately be EMPTY: when a chip lands at the end of
        // the text the projection still emits a tail row (so the live patch always has
        // a row to find), and that row has nothing to say yet. Falling back to a
        // "Streaming..." placeholder there flashed a fake line under the chip until the
        // next delta arrived (chat-polish-2 re-audit non-blocker 2). A NON-segment
        // preview keeps the placeholder: that shape really is "no content yet".
        const previewText = message.previewSegment === true
          ? String(message.content || "")
          : String(message.content || "Streaming...");

        renderPreviewMarkdown(streamingBlock, previewText);
        bubble.append(streamingBlock);

        // ONE action row for the live preview, on its TAIL segment only (chat-polish-2 item
        // C). The projection splits the preview at each chip, so a chip-bearing turn is
        // several preview rows; giving each one its own copy/raw row would stack buttons
        // mid-stream. A frozen segment is text the user has already scrolled past a chip —
        // it is not a message they can copy yet.
        if (message.previewSegmentFrozen !== true) {
          bubble.append(createAssistantMessageActionRow(message));
        }

        return bubble;
      }

      const contentBlock = createFormattedMessageBlock(message.content || "", buildAssistantMarkdownClassName());

      if (contentBlock) {
        bubble.append(contentBlock);
      }

      bubble.append(createAssistantMessageActionRow(message));
      return bubble;
    }

    const hasTextContent = Boolean(message.content || message.streaming);
    const attachmentList = createAttachmentList(message.attachments);

    if (hasTextContent) {
      const textBlock = document.createElement("p");
      textBlock.className = "message-content";
      textBlock.textContent = message.content || (message.streaming ? "Streaming..." : "");
      bubble.append(textBlock);
    }

    if (attachmentList) {
      bubble.append(attachmentList);
    }

    if (message.kind === "queued") {
      bubble.append(createQueuedStateBadge());
    }

    if (!hasTextContent && !attachmentList) {
      const textBlock = document.createElement("p");
      textBlock.className = "message-content";
      textBlock.textContent = message.streaming ? "Streaming..." : "";
      bubble.append(textBlock);
    }

    return bubble;
  }

  function createStreamingAssistantRow(message, options = {}) {
    const executeDisplay = parseExecuteDisplayContent(message.content);
    let row = null;

    if (executeDisplay) {
      row = createMessageRow(
        "assistant",
        createAssistantSequenceBubble(
          {
            sections: [
              {
                executeDisplay,
                message,
                showAvatar: options.showAvatar !== false,
                outputResults: null,
                type: "execute"
              }
            ],
            showAvatar: options.showAvatar !== false,
            type: "assistant-sequence"
          },
          options
        ),
        "terminal-row",
        {
          showAvatar: options.showAvatar !== false
        }
      );
    } else {
      row = createMessageRow("assistant", createStandardMessageBubble(message), "", {
        showAvatar: options.showAvatar !== false
      });
    }

    row.dataset.streamingMessageId = message.id;
    return row;
  }

  function createAssistantSequenceBubble(group, options = {}) {
    const bubble = document.createElement("article");
    bubble.className = "message-bubble";

    // The second of the three dead `is-streaming` additions, removed in P4b-2b: no rule in
    // the tree ever matched it, so it painted nothing. Whether this sequence is live is
    // still read where it MATTERS — `section.message.streaming` drives the per-section chip
    // state and the row's streaming mark — and turn-level liveness is the indicator's job.
    group.sections.forEach((section) => {
      const sectionElement = document.createElement("div");
      sectionElement.className = "assistant-sequence-section assistant-message-shell";

      if (section.type === "execute") {
        if (section.executeDisplay.narration) {
          const narrationBlock = createExecutionNarrationBlock(section.executeDisplay.narration);

          if (narrationBlock) {
            narrationBlock.dataset.executionNarration = "true";
            // The text the block was painted from, so a live tick that adds nothing does
            // not repaint it (chat-polish-2 item C). Kept for committed rows too: it is how
            // the streaming patch knows whether the prose actually moved.
            narrationBlock.dataset.executionNarrationText = section.executeDisplay.narration.trim();
            sectionElement.append(narrationBlock);
          }
        }

        sectionElement.append(
          createExecutionCard({
            displayOnly: section.displayOnly === true,
            // A TYPED-tier turn's separator text is display BY CONSTRUCTION, so its card
            // reads `Shown, not executed` from the first painted frame — not after the
            // turn ends, and never as `Writing N lines of code` beside a typed chip.
            displayOnlyTier: isTier1DisplayOnlyTurn(section.message),
            executeDisplay: section.executeDisplay,
            isConversationBusy: options.isConversationBusy,
            isStreaming: Boolean(section.message.streaming),
            messageId: section.message.id,
            outputResults: section.outputResults,
            rerunningMessageId: options.rerunningMessageId
          })
        );
      } else {
        sectionElement.classList.add("is-followup");
        const followupBlock = createFormattedMessageBlock(
          section.message.content || (section.message.streaming ? "Streaming..." : ""),
          buildAssistantMarkdownClassName("terminal-followup")
        );

        if (followupBlock) {
          sectionElement.append(followupBlock);
        }

        sectionElement.append(createAssistantMessageActionRow(section.message));
      }

      bubble.append(sectionElement);
    });

    return bubble;
  }

  function setElementText(element, text) {
    if (!element) {
      return;
    }

    const normalizedText = String(text || "");

    if (element.textContent !== normalizedText) {
      element.textContent = normalizedText;
    }
  }

  function syncExecutionCodeBlocks(container, blocks, options = {}) {
    if (!container) {
      return;
    }

    const normalizedBlocks = Array.isArray(blocks) ? blocks : [];
    const existingBlocks = Array.from(container.querySelectorAll(".terminal-code"));
    const emptyBlockText = options.emptyBlockText ?? "[empty]";

    normalizedBlocks.forEach((block, index) => {
      const normalizedText = block || emptyBlockText;
      let inputBlock = existingBlocks[index];

      if (!inputBlock) {
        inputBlock = document.createElement("pre");
        inputBlock.className = "terminal-code";
        container.append(inputBlock);
      }

      setElementText(inputBlock, normalizedText);
    });

    for (let index = normalizedBlocks.length; index < existingBlocks.length; index += 1) {
      existingBlocks[index].remove();
    }
  }

  function syncStreamingExecutionNarration(sectionElement, executeDisplay) {
    if (!sectionElement) {
      return false;
    }

    const existingNarration = sectionElement.querySelector("[data-execution-narration]");
    const narrationText = typeof executeDisplay?.narration === "string" ? executeDisplay.narration.trim() : "";

    if (!narrationText) {
      existingNarration?.remove();
      return true;
    }

    if (existingNarration) {
      // NARRATION GROWS WHILE THE CARD STREAMS (chat-polish-2 item C). Returning early here
      // froze the prose at the FIRST fragment that had a narration block: the card kept
      // updating while the sentence above it never did, which is the owner-visible "plain
      // unformatted text on tool turns". It is repainted through the SAME preview painter
      // the text turns use, so it formats progressively and partial syntax degrades to
      // plain text for a tick. The key check keeps a repaint-free tick from touching the
      // DOM, and the committed narration path (`createExecutionNarrationBlock` from
      // `createAssistantSequenceBubble`) is untouched, so settled output is byte-identical.
      if (existingNarration.dataset.executionNarrationText === narrationText) {
        return true;
      }

      existingNarration.dataset.executionNarrationText = narrationText;
      renderPreviewMarkdown(existingNarration, narrationText);
      return true;
    }

    const nextNarration = createExecutionNarrationBlock(narrationText);

    if (!nextNarration) {
      existingNarration?.remove();
      return true;
    }

    nextNarration.dataset.executionNarration = "true";
    nextNarration.dataset.executionNarrationText = narrationText;

    const executionCard = sectionElement.querySelector("[data-execution-card]");

    if (executionCard) {
      sectionElement.insertBefore(nextNarration, executionCard);
      return true;
    }

    sectionElement.prepend(nextNarration);
    return true;
  }

  function patchStreamingExecutionRow(row, message) {
    if (!row || !message || message.role !== "assistant" || message.streaming !== true) {
      return false;
    }

    const executeDisplay = parseExecuteDisplayContent(message.content);

    if (!executeDisplay) {
      return false;
    }

    const bubble = row.querySelector(".message-bubble");
    const sectionElement = bubble?.querySelector(".assistant-sequence-section");
    const executionCard = sectionElement?.querySelector("[data-execution-card]");
    const inputPane = executionCard?.querySelector('[data-execution-pane="input"]');
    const inputLabel = inputPane?.querySelector(".execution-pane-label");
    const inputBody = executionCard?.querySelector("[data-execution-input-list]");
    const status = executionCard?.querySelector("[data-execution-status]");
    const statusIcon = executionCard?.querySelector("[data-execution-status-icon]");
    const summaryTitle = executionCard?.querySelector("[data-execution-summary-title]");

    if (!bubble || !sectionElement || !executionCard || !inputPane || !inputBody || !status || !statusIcon || !summaryTitle) {
      return false;
    }

    // The third dead `is-streaming` addition, removed in P4b-2b: it repainted a class no
    // rule ever matched on every live frame. `message.streaming` still decides everything
    // this patch actually does below (chip vocabulary, tier reading, narration).
    row.dataset.streamingMessageId = message.id;
    const lineCount = getExecuteDisplayLineCount(executeDisplay);
    // ONE VOCABULARY PER TIER, on the live path too (item 1). The patch used to force
    // `generating` on every mid-stream card, so a typed-tier turn showed `Writing N lines
    // of code` next to its own `run_code · Running` chip until the turn ended. A typed-tier
    // card resolves through the SAME resolver as its committed form, so the live frame and
    // the settled row cannot disagree — and the transition is unskippable because the
    // pending state is in the render signature.
    const summaryState = isTier1DisplayOnlyTurn(message)
      ? resolveExecutionCardState({ displayOnlyTier: true })
      : getExecutionSummaryState([], "generating");

    status.className = `execution-status ${summaryState.tone}`;
    setElementText(statusIcon, summaryState.iconName);
    setElementText(
      summaryTitle,
      isTier1DisplayOnlyTurn(message)
        ? EXECUTION_DISPLAY_ONLY_LABEL
        : formatExecutionSummaryLabel(lineCount, "generating", [])
    );
    setElementText(inputLabel, lineCount ? `Input • ${formatLineCount(lineCount)}` : "Input");

    syncStreamingExecutionNarration(sectionElement, executeDisplay);
    syncExecutionCodeBlocks(inputBody, executeDisplay.blocks, {
      emptyBlockText: ""
    });

    const copyInputButton = executionCard.querySelector('[data-terminal-action="copy-input"]');
    const copyOutputButton = executionCard.querySelector('[data-terminal-action="copy-output"]');
    const rerunButton = executionCard.querySelector('[data-terminal-action="rerun"]');
    const rerunButtonIcon = rerunButton?.querySelector("x-icon");
    const rerunButtonLabel = rerunButton?.querySelector("span");

    if (copyInputButton) {
      copyInputButton.disabled = !getTerminalInputText(executeDisplay);
    }

    if (copyOutputButton) {
      copyOutputButton.disabled = true;
    }

    if (rerunButton) {
      rerunButton.disabled = true;
      rerunButton.classList.remove("is-active");
      setElementText(rerunButtonIcon, "replay");
      setElementText(rerunButtonLabel, "Run again");
    }

    return true;
  }

  function createStandaloneExecutionOutputBubble(outputResults, messageId = "", options = {}) {
    const bubble = document.createElement("article");
    bubble.className = "message-bubble is-terminal-output";
    bubble.append(
      createExecutionCard({
        executeDisplay: null,
        isConversationBusy: false,
        // A provisional chip describes a call whose arguments completed but which has
        // not been dispatched. Passing the flag keeps it `running` instead of letting
        // its placeholder text parse as a real result.
        isProvisional: options.provisional === true,
        isStreaming: false,
        messageId,
        outputResults,
        rerunningMessageId: "",
        typedTool: options.typedTool || null
      })
    );

    if (options.provisional === true) {
      bubble.dataset.provisionalChip = "true";
    }

    return bubble;
  }

  // A TYPED chip describes a tool call, so its honest contents are the call's ARGUMENTS
  // and the tool's own payload/error — not a terminal transcript. The display projection
  // encodes both as `execution <name> call|result` followed by the JSON body, so the body
  // is read from the projected text rather than by re-reading the stored typed shape (the
  // second-reader anti-pattern the shared history reader exists to prevent).
  function getTypedEntryBodyText(entry) {
    // ONE BODY READER, shared with the mid-turn provisional chip.
    //
    // This used to slice the projected prose itself, which meant the committed row and the
    // provisional chip each had their own copy of "take everything after the first
    // newline". Two copies of a reader drift exactly like two formatters do, so the slice
    // lives beside the writer that produces the format and both callers use it.
    return readProjectedChipBody(entry);
  }

  // One descriptor per CALL (item A): the call entry supplies the arguments and the name,
  // its own result entry supplies the outcome and the payload. A call whose result has not
  // landed keeps `running` and an empty output, so nothing is invented.
  function createTypedToolDescriptorForCall(record) {
    const callEntry = record?.entry || null;
    const resultEntry = record?.result || null;

    return {
      argumentsText: getTypedEntryBodyText(callEntry) || "{}",
      // THE PAYLOAD OBJECT, so the output pane can be rendered structurally instead of
      // re-parsed out of `outputText` (P4b-1). Display-only fields the shared projection
      // attached; a call with no result yet has neither, which is the truth.
      error: resultEntry?.typedToolResultError ?? null,
      name: String(record?.name || callEntry?.typedToolName || "tool"),
      outcome: String(record?.outcome || "running"),
      outputText: resultEntry ? getTypedEntryBodyText(resultEntry) : "",
      payload: resultEntry?.typedToolResultPayload
    };
  }

  // A RESULT entry's projected name is EMPTY by construction: the canonical writer stores a
  // tool message as `{role, content, toolCallId}` with no name, and the display projection
  // can only echo what the stored entry carries. A standalone result chip therefore read
  // `tool · Success` instead of the tool that actually ran (chat-polish-2 item D). The name
  // is recoverable from the CALL of the same id, which is in the same history, so it is
  // resolved here rather than by re-reading or rewriting stored shapes.
  //
  // THE SAME SCAN CARRIES THE SETTLED OUTCOME (chat-polish-2 re-audit blocker 2). A
  // standalone CALL has no result of its own to consult, so it used to hardcode `running` —
  // which meant the commonest shape of all, a single-call turn, rendered `file_read · Running`
  // FOREVER beside its own settled result row, and survived reload because it is derived from
  // stored entries. A `running` claim about finished work is the same class of lie the item D
  // labels exist to remove.
  function collectTypedToolCallFacts(history) {
    const facts = { names: new Map(), outcomes: new Map() };

    (Array.isArray(history) ? history : []).forEach((entry) => {
      const callId = String(entry?.typedToolCallId || "");

      if (!callId) {
        return;
      }

      if (entry?.typedTool === "call") {
        const name = String(entry?.typedToolName || "");

        if (name && !facts.names.has(callId)) {
          facts.names.set(callId, name);
        }

        return;
      }

      // First result wins: exactly one result exists per call id by contract, so a second
      // one is a duplicate rather than a newer truth.
      if (entry?.typedTool === "result" && !facts.outcomes.has(callId)) {
        facts.outcomes.set(callId, String(entry?.typedToolOutcome || "success"));
      }
    });

    return facts;
  }

  // A STANDALONE typed chip (ungrouped) keeps its pre-existing one-entry shape; this only
  // supplies the honest label for it (item D).
  function createTypedToolDescriptor(entry, callFacts = null) {
    if (!entry?.typedTool) {
      return null;
    }

    const callId = String(entry.typedToolCallId || "");
    const resolvedName =
      String(entry.typedToolName || "") || (callFacts?.names?.get?.(callId) ?? "") || "";

    if (entry.typedTool === "call") {
      const settledOutcome = callFacts?.outcomes?.get?.(callId) ?? "";

      // THE OUTCOME THE ENTRY ITSELF CARRIES, when it carries a terminal one.
      //
      // This is the seam that makes settle-on-dispatch visible at all. A provisional chip
      // is painted from a call whose args completed mid-turn and which has NO result entry
      // yet, so `callFacts.outcomes` — built only from `typedTool === "result"` entries —
      // can never describe it. Without this line the chip painted the settled outcome into
      // its projection and then rendered `Running` anyway.
      //
      // TERMINAL ONLY, deliberately. A committed call entry carries `pending` here, so
      // preferring the entry unconditionally would rewrite every committed row on every
      // thread; the fallback below keeps those byte-identical.
      const ownOutcome = String(entry.typedToolOutcome || "").trim();
      const ownTerminalOutcome = TYPED_TOOL_TERMINAL_OUTCOMES.has(ownOutcome) ? ownOutcome : "";

      // THE ENTRY'S OWN PANES, when the projection supplied them.
      //
      // A provisional chip carries `typedToolArgumentsText` / `typedToolOutputText`, which
      // the projection produced through the SAME formatters the committed row uses. The
      // fallbacks below are what a COMMITTED entry needs (it carries neither field), so the
      // committed row's bytes are exactly what they were: arguments sliced from its own
      // projected prose, output resolved from its result entry.
      //
      // Output is deliberately `""` when the entry has none: an args-complete-but-
      // undispatched chip has no result yet, and rendering `No output yet.` there is honest.
      const projectedArguments = String(entry.typedToolArgumentsText ?? "");
      const projectedOutput = String(entry.typedToolOutputText ?? "");

      // The CLASSIFIED outcome of this call's own result when one exists; `running` only
      // when nothing has answered this call yet, which is the one case where it is true.
      // THE RESULT OBJECT, when the projection supplied one (P4b-1). A settled PROVISIONAL
      // chip is a `call` entry carrying its own output text, so the payload pair has to
      // travel here too — otherwise the live chip could only re-parse its text while the
      // committed row rendered structure, and the two panes would stop being byte-equal.
      return {
        argumentsText: projectedArguments || getTypedEntryBodyText(entry) || "{}",
        error: entry.typedToolResultError ?? null,
        name: resolvedName || "tool",
        outcome: ownTerminalOutcome || settledOutcome || "running",
        outputText: projectedOutput,
        payload: entry.typedToolResultPayload
      };
    }

    // A standalone RESULT entry carries its own object, attached by the display projection,
    // so this row renders structure exactly as a grouped row does (P4b-1).
    return {
      argumentsText: "",
      error: entry.typedToolResultError ?? null,
      name: resolvedName || "tool",
      outcome: String(entry.typedToolOutcome || "success"),
      outputText: getTypedEntryBodyText(entry),
      payload: entry.typedToolResultPayload
    };
  }

  // One collapsible summary row for a run of tool calls, expandable to ONE row per CALL.
  //
  // THE ROW COUNT IS THE HEADER COUNT, by construction: both read `summary.calls`, which
  // `summarizeToolRun` derives from the one per-call fold in `tool-run.js`. Drawing a row
  // per ENTRY instead is what produced the owner-visible "2 tool calls · 2 succeeded" with
  // four chips underneath — a call entry and its result entry are two entries describing
  // ONE call (chat-polish-2 item A).
  function createToolRunCard(group, options = {}) {
    const key = String(group.key || toolRunKey(group.entries));
    const openState = options.toolRunOpenState || null;
    const card = document.createElement("details");
    card.className = "tool-run-card";
    card.dataset.toolRunCard = "true";
    card.dataset.toolRunKey = key;

    if (openState?.isOpen?.(key) === true) {
      card.open = true;
    }

    const summary = document.createElement("summary");
    summary.className = "tool-run-summary";

    const icon = document.createElement("x-icon");
    icon.className = "tool-run-icon";
    icon.textContent = group.summary?.failed ? "error" : group.summary?.running ? "sync" : "check_circle";

    const label = document.createElement("span");
    label.className = "tool-run-label";
    label.dataset.toolRunLabel = "true";
    label.textContent = formatToolRunLabel(group.summary);

    const chevron = document.createElement("x-icon");
    chevron.className = "tool-run-chevron";
    chevron.textContent = "chevron_right";

    summary.append(icon, label, chevron);
    card.append(summary);

    const body = document.createElement("div");
    body.className = "tool-run-body";
    body.dataset.toolRunBody = "true";

    const calls = Array.isArray(group.summary?.calls)
      ? group.summary.calls
      : collectToolRunCalls(group.entries);

    calls.forEach((record) => {
      const row = createExecutionCard({
        executeDisplay: null,
        isConversationBusy: false,
        isStreaming: false,
        messageId: record.id,
        outputResults: null,
        rerunningMessageId: options.rerunningMessageId,
        typedTool: createTypedToolDescriptorForCall(record)
      });

      // The row's identity is the CALL's, so an expanded run can be asserted row-by-row
      // against the same call ids the header counts.
      row.dataset.toolRunRowCallId = String(record.callId || "");
      body.append(row);
    });

    card.append(body);

    if (openState && typeof openState.setOpen === "function") {
      // Recorded OUTSIDE the DOM so the state survives the row rebuild that the next
      // render performs when a result lands.
      card.addEventListener("toggle", () => {
        openState.setOpen(key, card.open === true);
      });
    }

    return card;
  }

  // Progressive markdown for the LIVE preview only (item 3).
  //
  // Partial input is normal here: an unclosed fence renders as a code block that
  // keeps growing, and an unterminated emphasis or link degrades to text. The ONE
  // requirement is that a parse failure can never kill the paint, so every path has a
  // plain-text fallback and the committed path never comes through this function.
  function renderPreviewMarkdown(target, text) {
    // ONE policy, in `preview-markdown.js`: bounded work, partial-input tolerance, and a
    // plain-text fallback that never lets a partial document kill the paint. This
    // function only supplies the surface's renderer and plain-text painter.
    const mode = paintPreviewMarkdown(target, text, {
      className: buildAssistantMarkdownClassName(),
      renderMarkdown,
      setPlainText: setElementText
    });

    if (target?.classList) {
      if (mode === PREVIEW_PAINT_MODE.MARKDOWN) {
        target.classList.add("message-markdown");
      } else {
        target.classList.remove("message-markdown");
      }
    }
  }

  function getDocumentScroller() {
    return document.scrollingElement || document.documentElement;
  }

  function getMaxScrollTop(element) {
    return Math.max(0, element.scrollHeight - element.clientHeight);
  }

  function getMaxScrollLeft(element) {
    return Math.max(0, element.scrollWidth - element.clientWidth);
  }

  function isNearBottom(element) {
    return getMaxScrollTop(element) - element.scrollTop <= STICKY_SCROLL_THRESHOLD;
  }

  function createScrollSnapshot(element, options = {}) {
    if (!element) {
      return null;
    }

    return {
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      stickyBottom: options.forcePreserve === true ? false : isNearBottom(element)
    };
  }

  function restoreScrollSnapshot(element, snapshot, options = {}) {
    if (!element || !snapshot) {
      return;
    }

    element.scrollLeft = Math.min(snapshot.scrollLeft, getMaxScrollLeft(element));

    if (options.forcePreserve === true || !snapshot.stickyBottom) {
      element.scrollTop = Math.min(snapshot.scrollTop, getMaxScrollTop(element));
      return;
    }

    element.scrollTop = getMaxScrollTop(element);
  }

  function captureThreadScrollSnapshots(thread, options = {}) {
    const scroller = options.scroller || getDocumentScroller();
    const snapshots = {
      document: createScrollSnapshot(scroller, {
        forcePreserve: options.preserveScroll === true
      }),
      openExecutionCards: new Set(),
      nodes: new Map()
    };

    thread.querySelectorAll("[data-scroll-key]").forEach((element) => {
      snapshots.nodes.set(element.dataset.scrollKey, createScrollSnapshot(element));
    });

    thread.querySelectorAll("[data-execution-card][data-execution-message-id][open]").forEach((element) => {
      snapshots.openExecutionCards.add(element.dataset.executionMessageId);
    });

    return snapshots;
  }

  function restoreThreadScrollSnapshots(thread, snapshots, options = {}) {
    const scroller = options.scroller || getDocumentScroller();

    thread.querySelectorAll("[data-execution-card][data-execution-message-id]").forEach((element) => {
      if (snapshots?.openExecutionCards?.has(element.dataset.executionMessageId)) {
        element.open = true;
      }
    });

    restoreScrollSnapshot(scroller, snapshots?.document, {
      forcePreserve: options.preserveScroll === true
    });

    thread.querySelectorAll("[data-scroll-key]").forEach((element) => {
      restoreScrollSnapshot(element, snapshots?.nodes.get(element.dataset.scrollKey));
    });
  }

  function buildMessageDisplayGroups(history, options = {}) {
    const groups = [];
    const displayOnlyMessageIds = options.displayOnlyMessageIds || new Set();
    const outputOverrides = options.outputOverrides || {};

    // SMART GROUPING (chat-surface polish, item 1). Enabled by the owning chat
    // surface's view config; off means every typed entry keeps its own row, which is
    // what the order-contract suites pin.
    const groupToolRuns = options.groupToolRuns === true;
    // ONE scan of the whole list per render pass. The withheld set is a property of the
    // history, not of an index, and recomputing it inside `collectToolRun` made this
    // O(n²) on every streamed frame (chat-polish audit non-blocker b, 2026-10-27).
    const withheldCallIds = groupToolRuns ? collectWithheldCallIds(history) : null;
    // Same reasoning, and the same one-scan discipline: a typed RESULT entry carries no tool
    // name of its own, and a typed CALL carries no outcome of its own, so both are resolved
    // once per render from the sibling entry of the same call id (chat-polish-2 re-audit
    // blockers 1/2). Doing it per row would be O(n²) on the frame path.
    const typedToolCallFacts = collectTypedToolCallFacts(history);

    for (let index = 0; index < history.length; index += 1) {
      const message = history[index];

      if (groupToolRuns) {
        const run = collectToolRun(history, index, { withheldCallIds });
        const callCount = run ? run.entries.filter((entry) => entry.typedTool === "call").length : 0;

        // A TEN-CALL turn reading as one line is the win the owner asked for, and a run
        // of two or more keeps the collapsible card.
        //
        // ONE CALL IS ONE CHIP, NOT TWO ROWS (owner-reported live defect, 2026-10-27).
        // The old gate fell through for a single call on the premise that "one call is
        // already one row". That premise is false in the only sense a reader cares
        // about: one call stores TWO ENTRIES (its call and its result), and each entry
        // drew its own row. The owner saw the same call twice — arguments above
        // `No output yet.`, then `ARGUMENTS {}` above the real payload (the call entry
        // has no output, the result entry has no arguments).
        //
        // Folding it into a TOOL-RUN card would be worse, not better: a one-item summary
        // you must click to see one call. So a single call takes the STANDALONE chip
        // shape, built from `collectToolRunCalls` — the SAME per-call fold the grouped
        // card uses, so there is exactly one derivation of call+result pairing and a
        // second pairing reader cannot drift from it. The descriptor carries the call's
        // arguments AND its result's output, so the chip shows both panes in one click.
        // Nothing is invented: an unanswered call keeps `running` and no output.
        if (run && callCount === 1) {
          const [record] = collectToolRunCalls(run.entries);

          if (record) {
            groups.push({
              // The CALL's id, so the row keeps the identity (and the scroll keys) the
              // pre-fold call chip had.
              messageId: record.id,
              outputResults: null,
              provisional: false,
              typedTool: createTypedToolDescriptorForCall(record),
              type: "standalone-output"
            });
            // Consume the whole run: the result entry is this chip's output pane, not a
            // row of its own.
            index = run.endIndex;
            continue;
          }
        }

        if (run && callCount >= 2) {
          groups.push({
            entries: run.entries,
            key: toolRunKey(run.entries),
            summary: summarizeToolRun(run.entries),
            type: "tool-run"
          });
          index = run.endIndex;
          continue;
        }
      }

      const executeDisplay = message.role === "assistant" ? parseExecuteDisplayContent(message.content) : null;
      const standaloneOutputResults = getExecutionOutputResults(message);

      if (executeDisplay) {
        const nextMessage = history[index + 1];
        // TIER 3 PEEK-AHEAD, and it is deliberately narrow. The text protocol writes
        // an execution follow-up DIRECTLY under the message that produced it, so this
        // branch consumes that entry as the card's own output pane. A TYPED chip is a
        // different thing wearing the same shape (see `projectHistoryEntryForDisplay`),
        // and it is its own row, never a pane belonging to the message above it. A
        // marked entry is therefore never consumed: absorbing it made a
        // separator-bearing narration swallow the tool-call chip that followed it and
        // then report the swallowed output as a real execution (transcript-fidelity
        // audit, 2026-10-27).
        const nextIsTypedTool = Boolean(nextMessage?.typedTool);
        const outputResults = Array.isArray(outputOverrides[message.id])
          ? outputOverrides[message.id]
          : nextMessage && !nextIsTypedTool
            ? getExecutionOutputResults(nextMessage)
            : null;

        groups.push({
          sections: [
            {
              // An id in this set means the surface KNOWS this text was shown and
              // never executed (a Tier 1 turn that ended without a tool call), so
              // the chip settles instead of waiting for a result that cannot come.
              displayOnly: displayOnlyMessageIds.has(message.id),
              executeDisplay,
              message,
              outputResults,
              type: "execute"
            }
          ],
          type: "assistant-sequence"
        });

        if (outputResults) {
          index += 1;
        }

        continue;
      }

      if (standaloneOutputResults) {
        groups.push({
          messageId: message.id,
          outputResults: standaloneOutputResults,
          // A provisional chip is the live "running" row for a call whose arguments
          // completed (item 2). The flag travels with the group so both the card and
          // the row signature can see it: a running chip must never be reused as a
          // settled one, nor the reverse.
          provisional: message.provisional === true,
          // A typed chip gets an honest label and honest panes (item D) whether or not it
          // is grouped: the wording must not depend on how many siblings it happened to
          // have.
          typedTool: createTypedToolDescriptor(message, typedToolCallFacts),
          type: "standalone-output"
        });
        continue;
      }

      groups.push({
        message,
        type: "standard"
      });
    }

    return groups;
  }

  function getAttachmentsRenderSignature(attachments) {
    if (!Array.isArray(attachments) || !attachments.length) {
      return "";
    }

    return attachments
      .map((attachment) =>
        [
          attachment?.id || "",
          attachment?.name || "",
          attachment?.type || "",
          attachment?.size || 0,
          attachment?.lastModified || 0,
          attachment?.available === false ? "0" : "1"
        ].join("\u241f")
      )
      .join("\u241e");
  }

  function getExecutionResultsRenderSignature(results) {
    if (!Array.isArray(results) || !results.length) {
      return "";
    }

    return results
      .map((result) =>
        [
          String(result?.status || ""),
          Array.isArray(result?.outputLines) ? result.outputLines.join("\u240a") : ""
        ].join("\u241f")
      )
      .join("\u241e");
  }

  function getMessageRenderSignature(message) {
    if (!message || typeof message !== "object") {
      return "";
    }

    return [
      message.id || "",
      message.role || "",
      message.kind || "",
      message.streaming === true ? "1" : "0",
      String(message.content || ""),
      getAttachmentsRenderSignature(message.attachments)
    ].join("\u241f");
  }

  function getGroupRenderKey(group) {
    if (!group || typeof group !== "object") {
      return "";
    }

    if (group.type === "assistant-sequence") {
      return `assistant-sequence:${group.sections.map((section) => section?.message?.id || "").join("|")}`;
    }

    if (group.type === "standalone-output") {
      return `standalone-output:${group.messageId || ""}`;
    }

    if (group.type === "tool-run") {
      return String(group.key || toolRunKey(group.entries));
    }

    return `standard:${group.message?.id || ""}`;
  }

  function getGroupRenderSignature(group, options = {}) {
    if (!group || typeof group !== "object") {
      return "";
    }

    const avatarSignature = group.showAvatar === false ? "avatar:continuation" : "avatar:lead";

    if (group.type === "assistant-sequence") {
      return [
        avatarSignature,
        group.sections
        .map((section) => {
          if (section?.type === "execute") {
            // The RESOLVED chip state is part of the signature on purpose. It is
            // derived from surface state that is not in the message itself (is the
            // conversation still busy?), so without it a row built while the turn
            // was live is reused when the turn ends and the chip keeps spinning.
            // Keying on the resolved state makes that transition un-skippable.
            const cardState = resolveExecutionCardState({
              displayOnly: section.displayOnly === true,
              // Part of the signature for the same reason the busy flag is: the row built
              // for a typed-tier turn must not be reused with a legacy `Writing N lines`
              // summary, and the mark is what makes its reading terminal.
              displayOnlyTier: isTier1DisplayOnlyTurn(section.message),
              hasError: executionResultsHaveError(section.outputResults),
              hasResults: Array.isArray(section.outputResults) && section.outputResults.length > 0,
              isConversationBusy: options.isConversationBusy,
              isRerunning: section?.message?.id === options.rerunningMessageId,
              isStreaming: Boolean(section.message.streaming)
            });

            return [
              "execute",
              getMessageRenderSignature(section.message),
              getExecutionResultsRenderSignature(section.outputResults),
              cardState.pendingState,
              section?.message?.id === options.rerunningMessageId ? "rerunning" : ""
            ].join("\u241f");
          }

          return ["text", getMessageRenderSignature(section.message)].join("\u241f");
        })
        .join("\u241e")
      ].join("\u241f");
    }

    if (group.type === "tool-run") {
      // Outcomes are part of the signature: a run whose last result lands must not
      // be reused with the previous summary line, and an expanded card's contents
      // change as each call settles.
      return [
        avatarSignature,
        String(group.key || ""),
        group.entries.map((entry) => `${entry.id}:${entry.typedToolOutcome || ""}`).join("\u241e"),
        options.toolRunOpenState?.isOpen?.(String(group.key || "")) === true ? "open" : "closed"
      ].join("\u241f");
    }

    if (group.type === "standalone-output") {
      // THE RESOLVED OUTCOME IS PART OF THE SIGNATURE. A provisional chip's rows are
      // REBUILT as state lands, and a row keyed only on "provisional" would be reused
      // when the dispatch event settles it — which is precisely how a chip keeps a
      // spinner after the work finished. This is the same class of defect the execute
      // section's busy-state signature fixed; the outcome travels with it.
      //
      // THE DESCRIPTOR'S OWN TEXT IS PART OF IT TOO, for the same reason and one more.
      // A single call now folds its result into its chip, so the payload lives in the
      // DESCRIPTOR and not in `outputResults`. Without these terms the row built before
      // the result landed (empty output, `No output yet.`) would be REUSED afterwards and
      // the chip would keep claiming no output forever — the exact "settled but never
      // repainted" class this campaign has already fixed twice. Arguments and the tool
      // name ride along for free because an entry that changes identity must not reuse a
      // row either.
      return [
        avatarSignature,
        group.messageId || "",
        group.provisional === true ? "provisional" : "settled",
        String(group.typedTool?.name || ""),
        String(group.typedTool?.outcome || ""),
        String(group.typedTool?.argumentsText || ""),
        String(group.typedTool?.outputText || group.typedTool?.resultText || ""),
        getExecutionResultsRenderSignature(group.outputResults)
      ].join("\u241f");
    }

    return [avatarSignature, getMessageRenderSignature(group.message)].join("\u241f");
  }

  function setRowRenderState(row, group, options = {}) {
    if (!row) {
      return row;
    }

    row.__spaceThreadRenderKey = getGroupRenderKey(group);
    row.__spaceThreadRenderSignature = getGroupRenderSignature(group, options);
    row.__spaceThreadShowAvatar = group?.showAvatar !== false;
    return row;
  }

  function buildGroupRow(group, options = {}) {
    let row = null;

    if (group.type === "assistant-sequence") {
      row = createMessageRow("assistant", createAssistantSequenceBubble(group, options), "terminal-row", {
        showAvatar: group.showAvatar !== false
      });

      // A STREAMING sequence row must still be findable by id (chat-polish-2 item C). A
      // message carrying an execution separator renders as an assistant-sequence, and
      // without this mark `updateStreamingAssistantMessage` could never locate the row: every
      // delta fell through to a full thread re-render, which is why the prose above a tool
      // card sat frozen and unformatted while the card itself updated. The id is the
      // streaming message's own, so the existing in-place patch (and its narration repaint)
      // reaches the row exactly as it does for a text turn.
      const streamingSection = group.sections.find((section) => Boolean(section?.message?.streaming));

      if (streamingSection) {
        row.dataset.streamingMessageId = streamingSection.message.id;
      }
    } else if (group.type === "tool-run") {
      row = createMessageRow("assistant", createToolRunCard(group, options), "terminal-row tool-run-row", {
        showAvatar: group.showAvatar !== false
      });
    } else if (group.type === "standalone-output") {
      row = createMessageRow(
        "assistant",
        createStandaloneExecutionOutputBubble(group.outputResults, group.messageId, {
          provisional: group.provisional === true,
          typedTool: group.typedTool || null
        }),
        "terminal-row execution-output-row",
        {
          showAvatar: group.showAvatar !== false
        }
      );
    } else if (group.message.role === "assistant" && group.message.streaming) {
      row = createStreamingAssistantRow(group.message, {
        ...options,
        showAvatar: group.showAvatar !== false
      });
    } else {
      row = createMessageRow(group.message.role, createStandardMessageBubble(group.message), "", {
        showAvatar: group.showAvatar !== false
      });
    }

    return setRowRenderState(row, group, options);
  }

  function buildStreamingRenderGroup(message, options = {}) {
    const executeDisplay = parseExecuteDisplayContent(message?.content);
    const showAvatar = options.showAvatar !== false;

    if (executeDisplay) {
      return {
        sections: [
          {
            executeDisplay,
            message,
            showAvatar,
            outputResults: null,
            type: "execute"
          }
        ],
        showAvatar,
        type: "assistant-sequence"
      };
    }

    return {
      message,
      showAvatar,
      type: "standard"
    };
  }

  function getGroupSpeakerRole(group) {
    if (!group || typeof group !== "object") {
      return "";
    }

    if (
      group.type === "assistant-sequence" ||
      group.type === "standalone-output" ||
      group.type === "tool-run"
    ) {
      return "assistant";
    }

    return typeof group.message?.role === "string" ? group.message.role : "";
  }

  function applyAvatarGrouping(groups) {
    if (!Array.isArray(groups) || !groups.length) {
      return [];
    }

    let previousSpeakerRole = "";

    return groups.map((group) => {
      const speakerRole = getGroupSpeakerRole(group);
      const showAvatar = !groupConsecutiveAvatars || !speakerRole || speakerRole !== previousSpeakerRole;

      if (speakerRole) {
        previousSpeakerRole = speakerRole;
      }

      return {
        ...group,
        showAvatar,
        speakerRole
      };
    });
  }

  function renderMessages(thread, history, options = {}) {
    if (!thread) {
      return;
    }

    const queuedMessages = Array.isArray(options.queuedMessages) ? options.queuedMessages : [];
    const renderedMessages = queuedMessages.length ? [...history, ...queuedMessages] : history;
    const groups = renderedMessages.length ? applyAvatarGrouping(buildMessageDisplayGroups(renderedMessages, options)) : [];

    // BEFORE THE EMPTY-STATE EARLY RETURN, ALWAYS. That return exists so a settled empty
    // session is not rebuilt on every paint, but it also runs on the paint that ENDS a
    // turn — and this lane's own first draft put the sync after it, so the clear was
    // skipped and the indicator outlived its turn (caught by a headless probe, not by
    // review). The clear must run on every paint path, including the ones that draw
    // nothing.
    syncTurnProgress(thread, renderedMessages, options);

    if (!groups.length && thread.classList.contains("is-empty")) {
      return;
    }

    const scrollSnapshots = captureThreadScrollSnapshots(thread, options);

    if (!groups.length) {
      const builder =
        typeof options.createEmptyState === "function"
          ? options.createEmptyState
          : createEmptyState;
      const emptyState = builder
        ? builder({
            emptyStateText:
              typeof options.emptyStateText === "string" && options.emptyStateText.trim()
                ? options.emptyStateText.trim()
                : defaultEmptyStateText
          })
        : buildDefaultEmptyState(options.emptyStateText || defaultEmptyStateText);

      thread.innerHTML = "";
      thread.classList.add("is-empty");
      thread.append(emptyState || buildDefaultEmptyState(options.emptyStateText || defaultEmptyStateText));
      // THE DEAD-AIR CASE. A fresh chat whose first turn is already in flight has no rows
      // at all, and this branch is the whole paint. Synced AFTER the wipe, because the
      // wipe took the previous indicator with it.
      syncTurnProgress(thread, renderedMessages, options);
      window.requestAnimationFrame(() => {
        restoreThreadScrollSnapshots(thread, scrollSnapshots, options);
      });
      return;
    }

    const wasEmpty = thread.classList.contains("is-empty");
    // THE INDICATOR IS NOT A HISTORY ROW. `existingRows` is compared POSITIONALLY against
    // the group list, so leaving the turn-progress row in it would shift every index by
    // one and rebuild the whole thread on each paint. It is filtered out here and synced
    // separately, which keeps the row diff exactly as it was.
    const existingRows = wasEmpty
      ? []
      : Array.from(thread.children).filter((child) => child?.dataset?.turnProgress === undefined);
    let stablePrefixLength = 0;
    const comparisonCount = Math.min(existingRows.length, groups.length);

    thread.classList.remove("is-empty");

    if (wasEmpty) {
      thread.innerHTML = "";
    }

    while (stablePrefixLength < comparisonCount) {
      const existingRow = existingRows[stablePrefixLength];
      const group = groups[stablePrefixLength];

      if (
        !existingRow ||
        existingRow.__spaceThreadRenderKey !== getGroupRenderKey(group) ||
        existingRow.__spaceThreadRenderSignature !== getGroupRenderSignature(group, options)
      ) {
        break;
      }

      stablePrefixLength += 1;
    }

    for (let index = existingRows.length - 1; index >= stablePrefixLength; index -= 1) {
      existingRows[index].remove();
    }

    for (let index = stablePrefixLength; index < groups.length; index += 1) {
      thread.append(buildGroupRow(groups[index], options));
    }

    // Synced AFTER the rows so it sits last, and BEFORE the scroll restore so the extra
    // height it adds is part of what the restore measures.
    syncTurnProgress(thread, renderedMessages, options);

    window.requestAnimationFrame(() => {
      restoreThreadScrollSnapshots(thread, scrollSnapshots, options);
    });
  }

  function updateStreamingAssistantMessage(thread, message, options = {}) {
    if (!thread || !message || message.role !== "assistant" || message.streaming !== true) {
      return false;
    }

    const scroller = options.scroller || getDocumentScroller();
    const stickyBottom = Boolean(scroller) && isNearBottom(scroller);
    const row = thread.querySelector(`[data-streaming-message-id="${message.id}"]`);
    const executeDisplay = parseExecuteDisplayContent(message.content);
    const showAvatar = row?.__spaceThreadShowAvatar !== false;

    if (!row) {
      return false;
    }

    if (!executeDisplay) {
      const textBlock = row.querySelector("[data-streaming-content]");

      if (!textBlock) {
        return false;
      }

      // PAINT THE TAIL SLICE, NOT THE WHOLE PREVIEW (chat-polish-2 re-audit blocker 1).
      //
      // Once a chip has split the preview, the row carrying the plain preview id is only the
      // TAIL segment: the frozen segments above it hold their own slices. Repainting this row
      // with the full accumulated text therefore duplicated every segment above it, and the
      // duplication grew with each delta (the patch returns true, so no full re-render
      // repaired it until the next chip or commit).
      //
      // `options.previewTailContent` comes from `resolvePreviewTailContent`, i.e. from the
      // projection itself, so there is still ONE derivation of what the tail holds. `null`
      // means "the preview was not split" and the whole content is what this row holds.
      const tailContent =
        typeof options.previewTailContent === "string" ? options.previewTailContent : null;
      const previewSource = tailContent === null ? message.content || "Streaming..." : tailContent;

      // Same preview path as the row build: this node exists only while streaming.
      renderPreviewMarkdown(textBlock, previewSource);
      // The PHASE is part of what the user reads while this row streams ("Thinking..." →
      // "Writing 12 lines of code..." → "Writing response..."), and this patch is the only
      // painter running per delta. Same classifier, same live content.
      syncTurnProgressLabel(thread, message.content);
      setRowRenderState(
        row,
        buildStreamingRenderGroup(message, {
          showAvatar
        }),
        options
      );

      if (stickyBottom && scroller) {
        scroller.scrollTop = getMaxScrollTop(scroller);
      }

      return true;
    }

    if (!patchStreamingExecutionRow(row, message)) {
      const existingExecutionCard = row.querySelector("[data-execution-card]");
      const wasOpen = existingExecutionCard?.open === true;
      const nextRow = createStreamingAssistantRow(message, {
        ...options,
        showAvatar
      });
      setRowRenderState(
        nextRow,
        buildStreamingRenderGroup(message, {
          showAvatar
        }),
        options
      );

      if (wasOpen) {
        const nextExecutionCard = nextRow.querySelector("[data-execution-card]");

        if (nextExecutionCard) {
          nextExecutionCard.open = true;
        }
      }

      row.replaceWith(nextRow);
    } else {
      setRowRenderState(
        row,
        buildStreamingRenderGroup(message, {
          showAvatar
        }),
        options
      );
    }

    // Same phase sync as the text branch: a turn that streams a tool card also changes
    // phase (`Preparing code...` → `Writing N lines of code...` → `Writing response...`)
    // and this patch is the only painter running while it does.
    syncTurnProgressLabel(thread, message.content);

    if (stickyBottom && scroller) {
      scroller.scrollTop = getMaxScrollTop(scroller);
    }

    return true;
  }

  async function copyTextToClipboard(text) {
    if (typeof text !== "string" || !text.length) {
      return false;
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to the temporary textarea copy path below.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();

    const copied = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
    textarea.remove();
    return copied;
  }

  function findExecuteSection(history, messageId, outputOverrides = {}) {
    const messageIndex = history.findIndex((message) => message.id === messageId && message.role === "assistant");

    if (messageIndex === -1) {
      return null;
    }

    const message = history[messageIndex];
    const executeDisplay = parseExecuteDisplayContent(message.content);

    if (!executeDisplay) {
      return null;
    }

    const nextMessage = history[messageIndex + 1];
    const outputResults = Array.isArray(outputOverrides[messageId])
      ? outputOverrides[messageId]
      : nextMessage
        ? getExecutionOutputResults(nextMessage)
        : null;

    return {
      executeDisplay,
      message,
      outputResults
    };
  }

  function getAssistantMessageCopyText(history, messageId, outputOverrides = {}) {
    const executeSection = findExecuteSection(history, messageId, outputOverrides);

    if (executeSection?.outputResults?.length) {
      return {
        kind: "result",
        text: getTerminalOutputText(executeSection.outputResults)
      };
    }

    const message = history.find((entry) => entry.id === messageId && entry.role === "assistant");

    if (!message) {
      return {
        kind: "",
        text: ""
      };
    }

    const text = stripExecuteBlocks(message.content).trim() || String(message.content || "").trim();
    return {
      kind: "response",
      text
    };
  }

  return {
    autoResizeTextarea,
    // Exposed so the typed-transcript ORDER contract is testable at the real code
    // path: typed `tool_call` / `tool_result` entries must draw in stored order, so a
    // chip sits between the prose that introduced it and the prose that follows.
    buildMessageDisplayGroups,
    copyTextToClipboard,
    findExecuteSection,
    // Exposed so the LABEL VOCABULARIES are assertable directly: the Tier 3 wording
    // (code lines) and the typed wording (tool name · outcome) are different languages
    // and neither may drift into the other (chat-polish-2 item D).
    formatExecutionSummaryLabel,
    formatTypedToolLabel,
    // Exposed so the ICON and TONE vocabulary for a typed chip is assertable at the real
    // code path, not asserted against a fixture's expectations table. Resolving a chip's
    // state is the one place that decides which icon and tone the user sees, and before
    // this export the settle suite could only confirm the LABEL while the icon half sat
    // in a vacuous assertion (P3 chip-settle audit N2).
    resolveTypedToolCardState,
    // Exposed so the render-reuse contract is testable at the real code path: the
    // execute-section signature must CHANGE when a chip settles, or the row built
    // mid-turn is reused and its spinner never stops.
    getGroupRenderSignature,
    getAssistantMessageCopyText,
    getTerminalInputText,
    getTerminalOutputText,
    renderMessages,
    summarizeLlmConfig,
    summarizeSystemPrompt,
    updateStreamingAssistantMessage
  };
}
