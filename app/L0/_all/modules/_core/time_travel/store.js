const PAGE_SIZE = 100;
const MAX_DIFF_DISPLAY_BYTES = 1000 * 1000;
const NO_TEXT_DIFF_MESSAGE = "No text diff is available for this file.";
const DIFF_TOO_LARGE_MESSAGE = "This diff is larger than 1 MB, so Time Travel will not render it.";
const PREVIEW_FILE_LIMIT = 10;
const PREVIEW_FILE_ROWS = 3;
const GIT_REPOSITORY_PATTERN = "**/.git/";
const TEXT_ENCODER = typeof TextEncoder === "function" ? new TextEncoder() : null;

function getRuntime() {
  const runtime = globalThis.space;

  if (
    !runtime?.api?.gitHistoryDiff ||
    !runtime?.api?.gitHistoryList ||
    !runtime?.api?.gitHistoryPreview ||
    !runtime?.api?.gitHistoryRollback ||
    !runtime?.api?.gitHistoryRevert ||
    !runtime?.api?.call
  ) {
    throw new Error("Git history API helpers are not available.");
  }

  return runtime;
}

function logTimeTravelError(context, error) {
  console.error(`[time-travel] ${context}`, error);
}

function normalizeFileAction(value = "") {
  const action = String(value || "").trim().toLowerCase();

  if (action === "added" || action === "deleted" || action === "modified") {
    return action;
  }

  return "modified";
}

function getFileName(filePath = "") {
  const normalizedPath = String(filePath || "").replace(/\\/gu, "/");
  const parts = normalizedPath.split("/").filter(Boolean);

  return parts.at(-1) || normalizedPath || "file";
}

function stripTrailingSlash(value = "") {
  const text = String(value || "");

  return text.endsWith("/") ? text.slice(0, -1) : text;
}

function normalizeRepositoryPath(value = "") {
  const rawPath = String(value || "").trim().replace(/\\/gu, "/").replace(/^\/app\//u, "");

  if (!rawPath) {
    return "";
  }

  if (rawPath === "~") {
    return rawPath;
  }

  return `${stripTrailingSlash(rawPath)}/`;
}

function getRepositoryPathName(value = "") {
  const path = normalizeRepositoryPath(value);
  const parts = stripTrailingSlash(path).split("/").filter(Boolean);

  return parts.at(-1) || "My folder";
}

function parseRepositoryPath(value = "") {
  const path = normalizeRepositoryPath(value);
  const match = path.match(/^(L1|L2)\/([^/]+)\/$/u);

  if (!match) {
    return {
      icon: "folder",
      label: getRepositoryPathName(path),
      ownerId: "",
      ownerType: "",
      path
    };
  }

  return {
    icon: match[1] === "L1" ? "groups" : "person",
    label: getRepositoryPathName(path),
    ownerId: match[2],
    ownerType: match[1] === "L1" ? "group" : "user",
    path
  };
}

function normalizeRepositoryEntry(value = "") {
  const parsedPath = parseRepositoryPath(value);

  return {
    ...parsedPath,
    id: parsedPath.path
  };
}

function parseApiErrorStatus(error) {
  const match = String(error?.message || "").match(/\bstatus\s+(\d+)\b/u);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function extractRevertConflictPath(detail = "") {
  const match = String(detail || "").match(/cannot apply cleanly for\s+(.+?)\s+with the /iu);
  return match?.[1] ? String(match[1]).trim() : "";
}

function describeTimeTravelActionError(error, { action = "", phase = "execute" } = {}) {
  const details = String(error?.message || "").trim();
  const statusCode = parseApiErrorStatus(error);
  const fallbackSummary = phase === "preview"
    ? "Unable to preview affected files."
    : action === "revert"
      ? "Unable to revert changes."
      : "Unable to travel in time.";

  if (action === "revert" && phase !== "preview" && statusCode === 409) {
    const filePath = extractRevertConflictPath(details);

    return {
      details,
      hint: "Use Time Travel to move back directly, or revert a newer point first.",
      summary: filePath
        ? "Cannot revert because " + filePath + " has newer changes."
        : "Cannot revert because newer changes now affect the same file."
    };
  }

  return {
    details: details && details !== fallbackSummary ? details : "",
    hint: "",
    summary: fallbackSummary
  };
}

function normalizeCommitFile(file = {}) {
  if (typeof file === "string") {
    return {
      action: "modified",
      name: getFileName(file),
      oldPath: "",
      path: file,
      status: "M"
    };
  }

  const path = String(file?.path || file?.filePath || "");

  return {
    action: normalizeFileAction(file?.action),
    name: getFileName(path),
    oldPath: String(file?.oldPath || ""),
    path,
    status: String(file?.status || "")
  };
}

function normalizeCommit(commit = {}) {
  const files = Array.isArray(commit.files)
    ? commit.files.map(normalizeCommitFile).filter((file) => file.path)
    : Array.isArray(commit.changedFiles)
      ? commit.changedFiles.map(normalizeCommitFile).filter((file) => file.path)
      : [];

  return {
    changedFiles: files.map((file) => file.path),
    files,
    hash: String(commit.hash || ""),
    message: String(commit.message || ""),
    shortHash: String(commit.shortHash || commit.hash || "").slice(0, 7),
    timestamp: String(commit.timestamp || "")
  };
}

function classifyDiffLine(line = "") {
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "meta";
  }

  if (line.startsWith("@@")) {
    return "hunk";
  }

  if (line.startsWith("+")) {
    return "added";
  }

  if (line.startsWith("-")) {
    return "deleted";
  }

  return "context";
}

function formatDiffLines(patch = "") {
  const lines = String(patch || "").split(/\r?\n/u);

  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }

  return lines.map((line, index) => ({
    id: index,
    text: line || " ",
    type: classifyDiffLine(line)
  }));
}

function getTextByteLength(value = "") {
  const text = String(value || "");

  if (!text) {
    return 0;
  }

  if (TEXT_ENCODER) {
    return TEXT_ENCODER.encode(text).length;
  }

  if (typeof Blob === "function") {
    return new Blob([text]).size;
  }

  return text.length;
}

function readGapPixels(element) {
  const style = globalThis.getComputedStyle?.(element);
  const rawGap = style?.columnGap || style?.gap || "0";
  const gap = Number.parseFloat(rawGap);

  return Number.isFinite(gap) ? gap : 0;
}

function measureElementWidth(element) {
  return element?.getBoundingClientRect?.().width || 0;
}

function fitsInPreviewRows(itemWidths, containerWidth, gap) {
  let row = 1;
  let rowWidth = 0;
  let visibleCount = 0;

  for (const itemWidth of itemWidths) {
    const width = Math.min(itemWidth, containerWidth);
    const nextWidth = rowWidth === 0 ? width : rowWidth + gap + width;

    if (nextWidth <= containerWidth) {
      rowWidth = nextWidth;
      visibleCount += 1;
      continue;
    }

    row += 1;
    if (row > PREVIEW_FILE_ROWS) {
      break;
    }

    rowWidth = width;
    visibleCount += 1;
  }

  return visibleCount;
}

const model = {
  actionPreviewCommit: null,
  actionPreviewErrorDetails: "",
  actionPreviewErrorHint: "",
  actionPreviewErrorText: "",
  actionPreviewFiles: [],
  actionPreviewLoading: false,
  commits: [],
  currentHash: "",
  diffErrorText: "",
  diffFile: null,
  diffLoading: false,
  diffNoticeText: "",
  diffPatch: "",
  errorText: "",
  fileFilter: "",
  gitBackend: "",
  hasMore: false,
  historyPath: "~",
  historyResolvedPath: "",
  loading: false,
  pageIndex: 0,
  pageSize: PAGE_SIZE,
  pendingAction: "",
  previewLayouts: {},
  previewMeasureElements: new Map(),
  previewMeasureFrame: 0,
  previewMeasureRoot: null,
  previewResizeObserver: null,
  repositories: [],
  repositoryErrorText: "",
  repositoryLoading: false,
  rollingBack: false,
  selectedCommitSnapshot: null,
  selectedHash: "",
  statusText: "",
  statusTone: "",
  total: null,
  reverting: false,

  async init() {
    await this.loadHistory();
  },

  get hasCommits() {
    return this.commits.length > 0;
  },

  get hasRepositories() {
    return this.repositories.length > 0;
  },

  get currentRepositoryPath() {
    return normalizeRepositoryPath(this.historyResolvedPath || this.historyPath);
  },

  get currentRepositoryName() {
    return getRepositoryPathName(this.currentRepositoryPath);
  },

  get offset() {
    return this.pageIndex * this.pageSize;
  },

  get pageLabel() {
    const start = this.commits.length ? this.offset + 1 : 0;
    const end = this.offset + this.commits.length;

    if (this.total !== null) {
      return `${start}-${end} of ${this.total}`;
    }

    return this.hasMore ? `${start}-${end}` : `${start}-${end}`;
  },

  get selectedCommit() {
    const pageCommit = this.commits.find((commit) => commit.hash === this.selectedHash) || null;
    const snapshot = this.selectedCommitSnapshot?.hash === this.selectedHash ? this.selectedCommitSnapshot : null;

    return pageCommit || snapshot || this.commits[0] || null;
  },

  get selectedChangedFiles() {
    return [...(this.selectedCommit?.files || [])].sort((left, right) => left.path.localeCompare(right.path));
  },

  get selectedFileActionCounts() {
    const counts = {
      added: 0,
      deleted: 0,
      modified: 0
    };

    for (const file of this.selectedChangedFiles) {
      counts[normalizeFileAction(file?.action)] += 1;
    }

    return counts;
  },

  get actionPreviewChangedFiles() {
    return [...this.actionPreviewFiles].sort((left, right) => left.path.localeCompare(right.path));
  },

  get actionModalEyebrow() {
    return this.pendingAction === "revert" ? "Review Revert" : "Review Travel";
  },

  get actionModalTitle() {
    const timestamp = this.actionPreviewCommit?.timestamp;
    const relativeTime = timestamp ? this.formatRelativeTimestamp(timestamp) : "this point";

    return this.pendingAction === "revert"
      ? `Revert changes from ${relativeTime}`
      : `Travel in time to ${relativeTime}`;
  },

  get actionModalDescription() {
    return this.pendingAction === "revert"
      ? "This will create a new history point that undoes the affected files below."
      : "This will move your files, settings, spaces, and custom development to match the affected files below.";
  },

  get actionConfirmLabel() {
    if (this.pendingAction === "revert") {
      return this.reverting ? "Reverting..." : "Revert Changes";
    }

    return this.rollingBack ? "Travelling..." : "Travel In Time";
  },

  get actionConfirmIcon() {
    if (this.rollingBack || this.reverting) {
      return "hourglass_top";
    }

    return this.pendingAction === "revert" ? "undo" : "settings_backup_restore";
  },

  get canConfirmAction() {
    if (this.actionPreviewLoading || this.actionPreviewErrorText) {
      return false;
    }

    return this.pendingAction === "revert" ? this.canRevert : this.canRollback;
  },

  get diffLines() {
    return formatDiffLines(this.diffPatch);
  },

  get canGoPreviousPage() {
    return this.pageIndex > 0 && !this.loading && !this.rollingBack && !this.reverting;
  },

  get canGoNextPage() {
    return this.hasMore && !this.loading && !this.rollingBack && !this.reverting;
  },

  get canRollback() {
    return Boolean(
      this.selectedCommit &&
        this.selectedCommit.hash &&
        this.selectedCommit.hash !== this.currentHash &&
        !this.loading &&
        !this.rollingBack &&
        !this.reverting
    );
  },

  get canRevert() {
    return Boolean(
      this.selectedCommit &&
        this.selectedCommit.hash &&
        !this.loading &&
        !this.rollingBack &&
        !this.reverting
    );
  },

  isCurrentCommit(commit) {
    return Boolean(commit?.hash && commit.hash === this.currentHash);
  },

  isSelectedCommit(commit) {
    return Boolean(commit?.hash && commit.hash === this.selectedHash);
  },

  selectCommit(commit) {
    if (commit?.hash) {
      this.selectedHash = commit.hash;
      this.selectedCommitSnapshot = commit;
      this.setStatus("");
    }
  },

  getPreviewFiles(commit) {
    const files = Array.isArray(commit?.files) ? commit.files : [];
    const visibleCount = this.getPreviewVisibleCount(commit);

    return files.slice(0, visibleCount);
  },

  getRemainingFileCount(commit) {
    const files = Array.isArray(commit?.files) ? commit.files : [];

    return Math.max(0, files.length - this.getPreviewVisibleCount(commit));
  },

  getPreviewVisibleCount(commit) {
    const files = Array.isArray(commit?.files) ? commit.files : [];
    const fallbackCount = Math.min(PREVIEW_FILE_LIMIT, files.length);
    const layoutCount = Number(this.previewLayouts[commit?.hash]);

    return Number.isFinite(layoutCount) ? Math.max(0, Math.min(fallbackCount, layoutCount)) : fallbackCount;
  },

  async loadHistory(options = {}) {
    this.loading = true;
    this.errorText = "";

    if (Number.isFinite(Number(options.pageIndex))) {
      this.pageIndex = Math.max(0, Number(options.pageIndex));
    }

    const preserveSelection = options.preserveSelection !== false;
    const keepMissingSelection = Boolean(options.keepMissingSelection);
    const previousSelectedHash = preserveSelection ? this.selectedHash : "";
    const previousSelectedCommit = preserveSelection ? this.selectedCommit : null;

    try {
      const runtime = getRuntime();
      const result = await runtime.api.gitHistoryList({
        fileFilter: this.fileFilter,
        limit: this.pageSize,
        offset: this.offset,
        path: this.historyPath
      });
      const commits = Array.isArray(result?.commits)
        ? result.commits.map(normalizeCommit).filter((commit) => commit.hash)
        : [];

      this.commits = commits;
      this.previewLayouts = {};
      this.currentHash = String(result?.currentHash || commits[0]?.hash || "");
      this.gitBackend = String(result?.backend || "");
      this.historyResolvedPath = normalizeRepositoryPath(result?.path || this.historyPath);
      this.hasMore = Boolean(result?.hasMore);
      this.total = Number.isFinite(Number(result?.total)) ? Number(result.total) : null;
      const selectedFromPage = commits.find((commit) => commit.hash === previousSelectedHash) || null;
      const selectedCommit = selectedFromPage || (keepMissingSelection ? previousSelectedCommit : null) || commits[0] || null;

      this.selectedHash = selectedCommit?.hash || "";
      this.selectedCommitSnapshot = selectedCommit;
      this.setStatus(
        commits.length
          ? `Showing ${this.pageLabel} history point${commits.length === 1 ? "" : "s"}. ${this.gitBackend ? `(git: ${this.gitBackend})` : ""}`.trim()
          : this.fileFilter
            ? "No changes match that file filter."
            : "No history points yet. Save a file after Time Travel is enabled.",
        commits.length ? "success" : ""
      );
    } catch (error) {
      logTimeTravelError("loadHistory failed", error);
      this.commits = [];
      this.currentHash = "";
      this.gitBackend = "";
      this.historyResolvedPath = normalizeRepositoryPath(this.historyResolvedPath || this.historyPath);
      this.selectedHash = "";
      this.selectedCommitSnapshot = null;
      this.errorText = String(error?.message || "Unable to load Git history.");
      this.setStatus(this.errorText, "error");
    } finally {
      this.loading = false;
    }
  },

  async refreshHistory() {
    await this.loadHistory({
      keepMissingSelection: true,
      pageIndex: this.pageIndex
    });
  },

  async openRepositoryDialog() {
    if (this.rollingBack || this.reverting) {
      return;
    }

    if (!this.refs?.repositoryDialog?.open) {
      this.refs?.repositoryDialog?.showModal?.();
    }

    await this.loadRepositories();
  },

  closeRepositoryDialog() {
    this.refs?.repositoryDialog?.close?.();
  },

  async loadRepositories() {
    this.repositoryLoading = true;
    this.repositoryErrorText = "";

    try {
      const runtime = getRuntime();
      const result = await runtime.api.call("file_paths", {
        method: "POST",
        body: {
          access: "write",
          gitRepositories: true,
          patterns: [GIT_REPOSITORY_PATTERN]
        }
      });
      const paths = Array.isArray(result?.[GIT_REPOSITORY_PATTERN]) ? result[GIT_REPOSITORY_PATTERN] : [];

      this.repositories = paths
        .map(normalizeRepositoryEntry)
        .filter((repository) => repository.path)
        .sort((left, right) => left.path.localeCompare(right.path));
    } catch (error) {
      logTimeTravelError("loadRepositories failed", error);
      this.repositories = [];
      this.repositoryErrorText = String(error?.message || "Unable to find writable Git repositories.");
    } finally {
      this.repositoryLoading = false;
    }
  },

  isCurrentRepository(repository) {
    return Boolean(repository?.path && repository.path === this.currentRepositoryPath);
  },

  async selectRepository(repository) {
    const nextPath = normalizeRepositoryPath(repository?.path);

    if (!nextPath || this.loading || this.rollingBack || this.reverting) {
      return;
    }

    this.closeRepositoryDialog();

    if (nextPath === this.currentRepositoryPath) {
      return;
    }

    this.historyPath = nextPath;
    this.historyResolvedPath = nextPath;
    this.selectedHash = "";
    this.selectedCommitSnapshot = null;
    await this.loadHistory({
      pageIndex: 0,
      preserveSelection: false
    });
  },

  async applyFileFilter() {
    await this.loadHistory({
      pageIndex: 0
    });
  },

  async clearFileFilter() {
    if (!this.fileFilter) {
      return;
    }

    this.fileFilter = "";
    await this.loadHistory({
      keepMissingSelection: true,
      pageIndex: 0
    });
  },

  async goToPreviousPage() {
    if (!this.canGoPreviousPage) {
      return;
    }

    await this.loadHistory({
      pageIndex: this.pageIndex - 1,
      preserveSelection: false
    });
  },

  async goToNextPage() {
    if (!this.canGoNextPage) {
      return;
    }

    await this.loadHistory({
      pageIndex: this.pageIndex + 1,
      preserveSelection: false
    });
  },

  registerPreviewElement(element, commit) {
    if (!element || !commit?.hash) {
      return;
    }

    this.previewMeasureElements.set(commit.hash, {
      commit,
      element
    });

    if (!this.previewResizeObserver && typeof ResizeObserver === "function") {
      this.previewResizeObserver = new ResizeObserver(() => this.queuePreviewMeasure());
    }

    this.previewResizeObserver?.observe?.(element);
    this.queuePreviewMeasure();
  },

  queuePreviewMeasure() {
    if (this.previewMeasureFrame) {
      return;
    }

    this.previewMeasureFrame = globalThis.requestAnimationFrame?.(() => {
      this.previewMeasureFrame = 0;
      this.measurePreviewLayouts();
    }) || globalThis.setTimeout?.(() => {
      this.previewMeasureFrame = 0;
      this.measurePreviewLayouts();
    }, 0);
  },

  ensurePreviewMeasureRoot() {
    if (this.previewMeasureRoot?.isConnected) {
      return this.previewMeasureRoot;
    }

    const root = document.createElement("div");
    root.className = "time-travel-pill-measure";
    root.setAttribute("aria-hidden", "true");
    document.body.append(root);
    this.previewMeasureRoot = root;

    return root;
  },

  measurePreviewPillWidth(file) {
    const root = this.ensurePreviewMeasureRoot();
    const pill = document.createElement("span");
    pill.className = `time-travel-file-pill ${this.getFileActionClass(file)}`;
    pill.textContent = file?.name || getFileName(file?.path);
    root.append(pill);
    const width = measureElementWidth(pill);
    pill.remove();

    return width;
  },

  measureMorePillWidth(hiddenCount) {
    const root = this.ensurePreviewMeasureRoot();
    const pill = document.createElement("span");
    pill.className = "time-travel-file-pill is-more";
    pill.textContent = `+${hiddenCount} more`;
    root.append(pill);
    const width = measureElementWidth(pill);
    pill.remove();

    return width;
  },

  measurePreviewVisibleCount(commit, element) {
    const files = Array.isArray(commit?.files) ? commit.files : [];
    const total = files.length;
    const maxFileCount = Math.min(PREVIEW_FILE_LIMIT, total);
    const containerWidth = element?.clientWidth || 0;

    if (!total || !containerWidth) {
      return maxFileCount;
    }

    const gap = readGapPixels(element);
    const fileWidths = files
      .slice(0, maxFileCount)
      .map((file) => this.measurePreviewPillWidth(file));
    let visibleCount = maxFileCount;

    for (let index = 0; index < 6; index += 1) {
      const hiddenCount = total - visibleCount;
      const itemWidths = hiddenCount > 0
        ? [this.measureMorePillWidth(hiddenCount), ...fileWidths]
        : fileWidths;
      const itemVisibleCount = fitsInPreviewRows(itemWidths, containerWidth, gap);
      const nextVisibleCount = Math.max(
        0,
        Math.min(maxFileCount, hiddenCount > 0 ? itemVisibleCount - 1 : itemVisibleCount)
      );

      if (nextVisibleCount === visibleCount) {
        break;
      }

      visibleCount = nextVisibleCount;
    }

    return visibleCount;
  },

  measurePreviewLayouts() {
    const nextLayouts = {};

    for (const [hash, entry] of this.previewMeasureElements.entries()) {
      if (!entry.element?.isConnected) {
        this.previewMeasureElements.delete(hash);
        continue;
      }

      nextLayouts[hash] = this.measurePreviewVisibleCount(entry.commit, entry.element);
    }

    this.previewLayouts = nextLayouts;
  },

  clearActionPreviewError() {
    this.actionPreviewErrorDetails = "";
    this.actionPreviewErrorHint = "";
    this.actionPreviewErrorText = "";
  },

  setActionPreviewError(error, options = {}) {
    const nextError = describeTimeTravelActionError(error, options);
    this.actionPreviewErrorDetails = nextError.details;
    this.actionPreviewErrorHint = nextError.hint;
    this.actionPreviewErrorText = nextError.summary;
  },

  async openActionDialog(action) {
    const pendingAction = action === "revert" ? "revert" : "travel";
    const commit = this.selectedCommit;

    if (!commit || (pendingAction === "revert" ? !this.canRevert : !this.canRollback)) {
      return;
    }

    this.pendingAction = pendingAction;
    this.actionPreviewCommit = commit;
    this.actionPreviewFiles = [];
    this.clearActionPreviewError();
    this.actionPreviewLoading = true;
    this.refs?.actionDialog?.showModal?.();
    const previewAction = pendingAction;
    const previewHash = commit.hash;

    try {
      const runtime = getRuntime();
      const result = await runtime.api.gitHistoryPreview({
        commitHash: commit.hash,
        operation: pendingAction,
        path: this.historyPath
      });

      if (this.pendingAction === previewAction && this.actionPreviewCommit?.hash === previewHash) {
        this.actionPreviewFiles = Array.isArray(result?.files)
          ? result.files.map(normalizeCommitFile).filter((file) => file.path)
          : [];
      }
    } catch (error) {
      logTimeTravelError("openActionDialog failed", error);
      if (this.pendingAction === previewAction && this.actionPreviewCommit?.hash === previewHash) {
        this.setActionPreviewError(error, {
          action: previewAction,
          phase: "preview"
        });
      }
    } finally {
      if (this.pendingAction === previewAction && this.actionPreviewCommit?.hash === previewHash) {
        this.actionPreviewLoading = false;
      }
    }
  },

  closeActionDialog() {
    this.refs?.actionDialog?.close?.();
  },

  resetActionDialog() {
    if (this.rollingBack || this.reverting) {
      return;
    }

    this.actionPreviewCommit = null;
    this.clearActionPreviewError();
    this.actionPreviewFiles = [];
    this.actionPreviewLoading = false;
    this.pendingAction = "";
  },

  async confirmAction() {
    if (this.pendingAction === "revert") {
      await this.revertSelected();
      return;
    }

    await this.rollbackSelected();
  },

  async rollbackSelected() {
    const commit = this.actionPreviewCommit || this.selectedCommit;

    if (!commit || !this.canRollback) {
      return;
    }

    this.rollingBack = true;
    this.setStatus(`Travelling to ${this.formatRelativeTimestamp(commit.timestamp)}...`);

    try {
      const runtime = getRuntime();
      const result = await runtime.api.gitHistoryRollback({
        commitHash: commit.hash,
        path: this.historyPath
      });

      this.selectedHash = String(result?.hash || commit.hash);
      this.rollingBack = false;
      this.refs?.actionDialog?.close?.();
      await this.loadHistory({
        keepMissingSelection: true
      });
      this.setStatus("Travelled in time. Other history points are still available.", "success");
    } catch (error) {
      logTimeTravelError("rollbackSelected failed", error);
      this.setActionPreviewError(error, {
        action: "travel"
      });
      this.setStatus(this.actionPreviewErrorText, "error");
    } finally {
      this.rollingBack = false;
    }
  },

  async revertSelected() {
    const commit = this.actionPreviewCommit || this.selectedCommit;

    if (!commit || !this.canRevert) {
      return;
    }

    this.reverting = true;
    this.setStatus("Reverting changes...");

    try {
      const runtime = getRuntime();
      const result = await runtime.api.gitHistoryRevert({
        commitHash: commit.hash,
        path: this.historyPath
      });

      this.selectedHash = String(result?.hash || "");
      this.reverting = false;
      this.refs?.actionDialog?.close?.();
      await this.loadHistory({
        keepMissingSelection: true,
        pageIndex: 0
      });
      this.setStatus("Reverted those changes as a new history point.", "success");
    } catch (error) {
      logTimeTravelError("revertSelected failed", error);
      this.setActionPreviewError(error, {
        action: "revert"
      });
      this.setStatus(this.actionPreviewErrorText, "error");
    } finally {
      this.reverting = false;
    }
  },

  async openFileDiff(file) {
    const commit = this.selectedCommit;

    if (!commit?.hash || !file?.path) {
      return;
    }

    this.diffFile = file;
    this.diffPatch = "";
    this.diffErrorText = "";
    this.diffNoticeText = "";
    this.diffLoading = true;
    this.refs?.diffDialog?.showModal?.();

    try {
      const runtime = getRuntime();
      const result = await runtime.api.gitHistoryDiff({
        commitHash: commit.hash,
        filePath: file.path,
        path: this.historyPath
      });

      this.applyDiffResult(result, file);
    } catch (error) {
      logTimeTravelError("openFileDiff failed", error);
      this.diffErrorText = String(error?.message || "Unable to load file diff.");
    } finally {
      this.diffLoading = false;
    }
  },

  async openActionFileDiff(file) {
    const commit = this.actionPreviewCommit;

    if (!commit?.hash || !file?.path || !this.pendingAction) {
      return;
    }

    this.diffFile = file;
    this.diffPatch = "";
    this.diffErrorText = "";
    this.diffNoticeText = "";
    this.diffLoading = true;
    this.refs?.diffDialog?.showModal?.();

    try {
      const runtime = getRuntime();
      const result = await runtime.api.gitHistoryPreview({
        commitHash: commit.hash,
        filePath: file.path,
        operation: this.pendingAction,
        path: this.historyPath
      });

      this.applyDiffResult(result, file);
    } catch (error) {
      logTimeTravelError("openActionFileDiff failed", error);
      this.diffErrorText = String(error?.message || "Unable to load file diff.");
    } finally {
      this.diffLoading = false;
    }
  },

  closeDiffDialog() {
    this.refs?.diffDialog?.close?.();
    this.diffNoticeText = "";
    this.diffLoading = false;
  },

  mount(refs = {}) {
    this.refs = {
      actionDialog: refs.actionDialog || null,
      diffDialog: refs.diffDialog || null,
      repositoryDialog: refs.repositoryDialog || null
    };
  },

  formatRelativeTimestamp(value) {
    const timestamp = Date.parse(String(value || ""));

    if (!Number.isFinite(timestamp)) {
      return "Unknown time";
    }

    const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
    const units = [
      ["year", 31536000],
      ["month", 2592000],
      ["week", 604800],
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
      ["second", 1]
    ];
    const formatter = new Intl.RelativeTimeFormat(undefined, {
      numeric: "auto"
    });

    for (const [unit, seconds] of units) {
      if (Math.abs(diffSeconds) >= seconds || unit === "second") {
        return formatter.format(Math.round(diffSeconds / seconds), unit);
      }
    }

    return "just now";
  },

  formatFullTimestamp(value) {
    const timestamp = Date.parse(String(value || ""));

    if (!Number.isFinite(timestamp)) {
      return "Unknown date";
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(timestamp));
  },

  getFileActionIcon(file) {
    switch (normalizeFileAction(file?.action)) {
      case "added":
        return "add_circle";
      case "deleted":
        return "remove_circle";
      default:
        return "edit";
    }
  },

  getFileActionLabel(file) {
    switch (normalizeFileAction(file?.action)) {
      case "added":
        return "Added";
      case "deleted":
        return "Removed";
      default:
        return "Changed";
    }
  },

  getFileActionClass(file) {
    return `is-${normalizeFileAction(file?.action)}`;
  },

  applyDiffResult(result, file) {
    const patch = String(result?.patch || "");

    this.diffFile = normalizeCommitFile(result?.file || file);
    this.diffPatch = "";
    this.diffNoticeText = "";

    if (!patch) {
      this.diffPatch = NO_TEXT_DIFF_MESSAGE;
      return;
    }

    if (getTextByteLength(patch) > MAX_DIFF_DISPLAY_BYTES) {
      this.diffNoticeText = DIFF_TOO_LARGE_MESSAGE;
      return;
    }

    this.diffPatch = patch;
  },

  setStatus(text = "", tone = "") {
    this.statusText = String(text || "");
    this.statusTone = String(tone || "");
  }
};

globalThis.space.fw.createStore("timeTravel", model);
