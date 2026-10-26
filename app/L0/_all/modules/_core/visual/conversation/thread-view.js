import { renderMarkdown } from "/modules/_core/framework/js/markdown-frontmatter.js";

const EXECUTION_STATUS_LINE_PATTERN = /^execution\s+(.+)$/iu;
const EXECUTION_PRINT_LINE_PATTERN = /^(log|info|warn|error|debug|dir|table|assert)(:\s*|↓)$/iu;
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
  hasError = false,
  hasResults = false,
  isConversationBusy = false,
  isRerunning = false,
  isStreaming = false
} = {}) {
  if (isStreaming) {
    return { iconName: "edit_note", pendingState: "generating", tone: "is-writing" };
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

  function getExecutionOutputLineModifier(line) {
    const trimmed = typeof line === "string" ? line.trim() : "";

    if (!trimmed) {
      return "is-muted";
    }

    if (/^execution\s+/iu.test(trimmed)) {
      return "is-meta";
    }

    if (/^result(?::\s*|↓)$/iu.test(trimmed)) {
      return "is-result";
    }

    if (/^warn(?::\s*|↓)$/iu.test(trimmed)) {
      return "is-warn";
    }

    if (/^error(?::\s*|↓)$/iu.test(trimmed)) {
      return "is-error";
    }

    if (EXECUTION_PRINT_LINE_PATTERN.test(trimmed)) {
      return "is-print";
    }

    return "";
  }

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
    executeDisplay,
    isConversationBusy,
    isStreaming,
    messageId,
    outputResults,
    rerunningMessageId
  }) {
    const lineCount = getExecuteDisplayLineCount(executeDisplay);
    const displayOutputResults = rerunningMessageId === messageId ? null : outputResults;
    const summaryState = resolveExecutionCardState({
      displayOnly,
      hasError: executionResultsHaveError(displayOutputResults),
      hasResults: Array.isArray(displayOutputResults) && displayOutputResults.length > 0,
      isConversationBusy,
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
    summaryTitle.textContent = formatExecutionSummaryLabel(lineCount, pendingState, displayOutputResults);

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

    const outputBody = document.createElement("div");
    outputBody.className = "execution-output-list";
    outputBody.dataset.executionOutputList = "true";
    appendTerminalOutput(outputBody, displayOutputResults || [], pendingState);

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

    if (message.streaming) {
      bubble.classList.add("is-streaming");
    }

    if (message.kind === "queued") {
      bubble.classList.add("is-queued");
    }

    if (message.role === "assistant") {
      bubble.classList.add("assistant-message-shell");

      if (message.streaming) {
        bubble.dataset.streamingMessageId = message.id;
        const streamingBlock = document.createElement("p");
        streamingBlock.className = "message-content";
        streamingBlock.dataset.streamingContent = "true";
        streamingBlock.textContent = message.content || "Streaming...";
        bubble.append(streamingBlock);
        bubble.append(createAssistantMessageActionRow(message));
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

    if (group.sections.some((section) => Boolean(section.message.streaming))) {
      bubble.classList.add("is-streaming");
    }

    group.sections.forEach((section) => {
      const sectionElement = document.createElement("div");
      sectionElement.className = "assistant-sequence-section assistant-message-shell";

      if (section.type === "execute") {
        if (section.executeDisplay.narration) {
          const narrationBlock = createExecutionNarrationBlock(section.executeDisplay.narration);

          if (narrationBlock) {
            narrationBlock.dataset.executionNarration = "true";
            sectionElement.append(narrationBlock);
          }
        }

        sectionElement.append(
          createExecutionCard({
            displayOnly: section.displayOnly === true,
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
      return true;
    }

    const nextNarration = createExecutionNarrationBlock(narrationText);

    if (!nextNarration) {
      existingNarration?.remove();
      return true;
    }

    nextNarration.dataset.executionNarration = "true";

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

    bubble.classList.add("is-streaming");
    row.dataset.streamingMessageId = message.id;
    const lineCount = getExecuteDisplayLineCount(executeDisplay);
    const summaryState = getExecutionSummaryState([], "generating");

    status.className = `execution-status ${summaryState.tone}`;
    setElementText(statusIcon, summaryState.iconName);
    setElementText(summaryTitle, formatExecutionSummaryLabel(lineCount, "generating", []));
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

  function createStandaloneExecutionOutputBubble(outputResults, messageId = "") {
    const bubble = document.createElement("article");
    bubble.className = "message-bubble is-terminal-output";
    bubble.append(
      createExecutionCard({
        executeDisplay: null,
        isConversationBusy: false,
        isStreaming: false,
        messageId,
        outputResults,
        rerunningMessageId: ""
      })
    );
    return bubble;
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

    for (let index = 0; index < history.length; index += 1) {
      const message = history[index];
      const executeDisplay = message.role === "assistant" ? parseExecuteDisplayContent(message.content) : null;
      const standaloneOutputResults = getExecutionOutputResults(message);

      if (executeDisplay) {
        const nextMessage = history[index + 1];
        const outputResults = Array.isArray(outputOverrides[message.id])
          ? outputOverrides[message.id]
          : nextMessage
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

    if (group.type === "standalone-output") {
      return [
        avatarSignature,
        group.messageId || "",
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
    } else if (group.type === "standalone-output") {
      row = createMessageRow(
        "assistant",
        createStandaloneExecutionOutputBubble(group.outputResults, group.messageId),
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

    if (group.type === "assistant-sequence" || group.type === "standalone-output") {
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
      window.requestAnimationFrame(() => {
        restoreThreadScrollSnapshots(thread, scrollSnapshots, options);
      });
      return;
    }

    const wasEmpty = thread.classList.contains("is-empty");
    const existingRows = wasEmpty ? [] : Array.from(thread.children);
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

      textBlock.textContent = message.content || "Streaming...";
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
    copyTextToClipboard,
    findExecuteSection,
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
