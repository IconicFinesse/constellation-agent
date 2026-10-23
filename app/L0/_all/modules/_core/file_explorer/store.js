import { closeDialog, openDialog } from "/modules/_core/visual/forms/dialog.js";
import { positionPopover } from "/modules/_core/visual/chrome/popover.js";
import { showToast } from "/modules/_core/visual/chrome/toast.js";

const HOME_REQUEST_PATH = "~/";
const MAX_TEXT_EDIT_FILE_BYTES = 1024 * 1024;
const ROOT_DISPLAY_PATH = "/";
const LIST_PREVIEW_LIMIT = 3;

function createPathStateMap() {
  return Object.create(null);
}

function createActionMenuPosition() {
  return {
    left: 12,
    maxHeight: 240,
    top: 12
  };
}

function normalizeRequestPath(value) {
  const rawValue = String(value ?? "").trim().replaceAll("\\", "/");

  if (!rawValue || rawValue === ROOT_DISPLAY_PATH) {
    return "";
  }

  if (rawValue === "~") {
    return HOME_REQUEST_PATH;
  }

  return rawValue;
}

function stripTrailingSlashes(value) {
  return String(value ?? "").replace(/\/+$/u, "");
}

function isDirectoryPath(path) {
  return String(path ?? "").endsWith("/");
}

function toDisplayPath(path) {
  return String(path ?? "") || ROOT_DISPLAY_PATH;
}

function getPathSegments(path) {
  return stripTrailingSlashes(path).split("/").filter(Boolean);
}

function getPathName(path) {
  const segments = getPathSegments(path);
  return segments[segments.length - 1] || ROOT_DISPLAY_PATH;
}

function getParentPath(path) {
  const normalizedPath = normalizeRequestPath(path);

  if (!normalizedPath) {
    return "";
  }

  const segments = getPathSegments(normalizedPath);

  if (segments.length <= 1) {
    return "";
  }

  const hasLeadingSlash = normalizedPath.startsWith("/");
  return `${hasLeadingSlash ? "/" : ""}${segments.slice(0, -1).join("/")}/`;
}

function buildChildPath(parentPath, name, isDirectory) {
  const normalizedParentPath = normalizeRequestPath(parentPath);
  const parentPrefix = normalizedParentPath ? `${stripTrailingSlashes(normalizedParentPath)}/` : "";
  return `${parentPrefix}${String(name ?? "").trim()}${isDirectory ? "/" : ""}`;
}

function isSameOrDescendantPath(ancestorPath, candidatePath) {
  const ancestorBase = stripTrailingSlashes(ancestorPath);
  const candidateBase = stripTrailingSlashes(candidatePath);

  return Boolean(
    ancestorBase &&
      candidateBase &&
      (candidateBase === ancestorBase || candidateBase.startsWith(`${ancestorBase}/`))
  );
}

function compareEntries(left, right) {
  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1;
  }

  return (
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base"
    }) || left.path.localeCompare(right.path)
  );
}

function buildEntries(paths) {
  return (Array.isArray(paths) ? paths : [])
    .map((path) => {
      const isDirectory = isDirectoryPath(path);

      return {
        icon: isDirectory ? "folder" : "description",
        isDirectory,
        name: getPathName(path),
        path
      };
    })
    .sort(compareEntries);
}

function createClipboardItems(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    isDirectory: entry.isDirectory === true,
    name: entry.name,
    path: entry.path
  }));
}

function readErrorMessage(error) {
  return String(error?.message || "Failed to load files.");
}

function isPermissionError(error) {
  const message = readErrorMessage(error).toLowerCase();
  return message.includes("status 403") || message.includes("read access denied") || message.includes("write access denied");
}

function isNotFoundError(error) {
  const message = readErrorMessage(error).toLowerCase();
  return (
    message.includes("status 404") ||
    message.includes("path not found") ||
    message.includes("file not found")
  );
}

function hashPath(path) {
  let hash = 0;

  for (const character of String(path ?? "")) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }

  return `${Math.abs(hash).toString(36)}-${String(path ?? "").length}`;
}

function formatCountLabel(count, singularLabel, pluralLabel = `${singularLabel}s`) {
  return `${count} ${count === 1 ? singularLabel : pluralLabel}`;
}

function formatByteSize(value) {
  const size = Number(value);

  if (!Number.isFinite(size) || size < 1024) {
    return `${Math.max(0, Math.round(size || 0))} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatNamePreview(entries, limit = LIST_PREVIEW_LIMIT) {
  const names = (Array.isArray(entries) ? entries : [])
    .map((entry) => String(entry?.name || "").trim())
    .filter(Boolean);

  if (!names.length) {
    return "";
  }

  const visibleNames = names.slice(0, limit);
  const remainingCount = names.length - visibleNames.length;
  return remainingCount > 0 ? `${visibleNames.join(", ")} +${remainingCount} more` : visibleNames.join(", ");
}

function ensureZipFilename(value) {
  const candidate = String(value || "").trim() || "download";
  return candidate.toLowerCase().endsWith(".zip") ? candidate : `${candidate}.zip`;
}

function validateChildName(name) {
  if (!name) {
    return "Name must not be empty.";
  }

  if (name === "." || name === "..") {
    return "Name must not be a relative path marker.";
  }

  if (name.includes("/") || name.includes("\\")) {
    return "Name must not include slashes.";
  }

  return "";
}

function formatDownloadErrorMessage(entry, error) {
  const entryLabel = entry?.name || getPathName(entry?.path || "");

  if (isPermissionError(error)) {
    return `You do not have permission to download ${entryLabel || "this item"}.`;
  }

  if (isNotFoundError(error)) {
    return `${entryLabel || "This item"} is no longer available for download.`;
  }

  return readErrorMessage(error);
}

const filesModel = {
  actionMenuAnchor: null,
  actionMenuPosition: createActionMenuPosition(),
  actionMenuRenderToken: 0,
  actionMenuSource: null,
  clipboardExpanded: false,
  clipboardItems: [],
  clipboardMode: "",
  createDialogError: "",
  createDialogKind: "file",
  createDialogSaving: false,
  createDraftName: "",
  currentPath: HOME_REQUEST_PATH,
  deleteDialogEntries: [],
  deleteDialogError: "",
  deleteDialogSaving: false,
  directoryPath: null,
  draftPath: HOME_REQUEST_PATH,
  editorDialogError: "",
  editorDialogLoading: false,
  editorDialogPath: "",
  editorDialogRequestId: 0,
  editorDialogSaving: false,
  editorDraftContent: "",
  entries: [],
  errorDetail: "",
  errorTitle: "",
  highlightedPath: "",
  loaded: false,
  loading: false,
  noticeText: "",
  noticeTone: "info",
  operationBusy: false,
  pathStates: createPathStateMap(),
  refs: {},
  renameDialogEntry: null,
  renameDialogError: "",
  renameDialogSaving: false,
  renameDraftName: "",
  requestId: 0,
  selectedPaths: [],

  mount(refs = {}) {
    this.refs = refs;

    if (!this.loaded && !this.loading) {
      void this.navigateTo(HOME_REQUEST_PATH);
    }
  },

  unmount() {
    this.captureCurrentDirectoryState();
    this.closeActionMenu();
    this.closeCreateDialog();
    this.closeDeleteDialog();
    this.closeEditorDialog();
    this.closeRenameDialog();
    this.refs = {};
  },

  get actionMenuActions() {
    return this.buildActionDescriptors(this.actionMenuEntries);
  },

  get actionMenuEntries() {
    return this.getEntriesForActionSource(this.actionMenuSource);
  },

  get actionMenuStyle() {
    return {
      left: `${this.actionMenuPosition.left}px`,
      maxHeight: `${this.actionMenuPosition.maxHeight}px`,
      top: `${this.actionMenuPosition.top}px`
    };
  },

  get isActionMenuOpen() {
    return Boolean(this.actionMenuSource);
  },

  get activeDescendantId() {
    return this.highlightedPath ? this.getEntryDomId(this.highlightedPath) : null;
  },

  get canGoUp() {
    return normalizeRequestPath(this.currentPath) !== "";
  },

  get canPasteClipboard() {
    return Boolean(this.clipboardItems.length && this.directoryPath && !this.isWorking);
  },

  get canCreateInCurrentDirectory() {
    return Boolean(this.directoryPath && !this.isWorking && !this.errorTitle);
  },

  get canSelectAllEntries() {
    return Boolean(
      this.entries.length &&
      this.selectedEntries.length < this.entries.length &&
      !this.isWorking
    );
  },

  get clipboardActionLabel() {
    return this.clipboardMode === "cut" ? "Cut queue" : "Copy queue";
  },

  get clipboardExpandedToggleLabel() {
    return this.clipboardExpanded ? "Hide list" : "Show list";
  },

  get clipboardLabel() {
    const itemCount = this.clipboardItems.length;

    if (!itemCount) {
      return "";
    }

    const suffix = this.clipboardMode === "cut" ? "cut" : "copied";
    return `${formatCountLabel(itemCount, "item")} ${suffix}`;
  },

  get clipboardPreviewText() {
    return formatNamePreview(this.clipboardItems);
  },

  get editorDialogTitle() {
    return this.editorDialogPath ? `Edit ${getPathName(this.editorDialogPath)}` : "Edit file";
  },

  get createDialogPathPreview() {
    const name = this.createDraftName.trim();

    if (!name || !this.directoryPath) {
      return this.directoryPath || "";
    }

    return buildChildPath(this.directoryPath, name, this.createDialogKind === "folder");
  },

  get createDialogTitle() {
    return this.createDialogKind === "folder" ? "New folder" : "New file";
  },

  get hasClipboard() {
    return this.clipboardItems.length > 0;
  },

  get hasSelection() {
    return this.selectedPaths.length > 0;
  },

  get isWorking() {
    return (
      this.loading ||
      this.operationBusy ||
      this.createDialogSaving ||
      this.renameDialogSaving ||
      this.deleteDialogSaving ||
      this.editorDialogLoading ||
      this.editorDialogSaving
    );
  },

  get itemCountLabel() {
    return formatCountLabel(this.entries.length, "item");
  },

  get renameDialogTitle() {
    return this.renameDialogEntry ? `Rename ${this.renameDialogEntry.name}` : "Rename item";
  },

  get selectedEntries() {
    return this.entries.filter((entry) => this.isSelected(entry.path));
  },

  get selectionLabel() {
    return formatCountLabel(this.selectedPaths.length, "selected item");
  },

  get selectionPreviewText() {
    return formatNamePreview(this.selectedEntries);
  },

  buildActionDescriptors(entries) {
    if (!Array.isArray(entries) || !entries.length) {
      return [];
    }

    const isSingleEntry = entries.length === 1;
    const allFiles = entries.every((entry) => entry.isDirectory !== true);
    const descriptors = [];

    if (isSingleEntry) {
      descriptors.push({
        id: "rename",
        icon: "edit_square",
        label: "Rename"
      });
    }

    if (isSingleEntry && allFiles) {
      descriptors.push({
        id: "edit",
        icon: "article",
        label: "Edit"
      });
    }

    if (isSingleEntry) {
      descriptors.push({
        id: "download",
        icon: "download",
        label: "Download"
      });
    }

    descriptors.push({
      id: "cut",
      icon: "content_cut",
      label: "Cut"
    });
    descriptors.push({
      id: "copy",
      icon: "content_copy",
      label: "Copy"
    });
    descriptors.push({
      danger: true,
      icon: "delete",
      id: "remove",
      label: "Remove"
    });

    return descriptors;
  },

  captureCurrentDirectoryState() {
    if (typeof this.directoryPath !== "string") {
      return;
    }

    const pathState = this.getOrCreatePathState(this.directoryPath);
    pathState.highlightedPath = this.highlightedPath;

    if (this.refs.list) {
      pathState.scrollTop = this.refs.list.scrollTop;
    }
  },

  captureScroll() {
    if (typeof this.directoryPath !== "string" || !this.refs.list) {
      return;
    }

    this.getOrCreatePathState(this.directoryPath).scrollTop = this.refs.list.scrollTop;
    this.closeActionMenu();
  },

  clearClipboard() {
    this.clipboardExpanded = false;
    this.clipboardItems = [];
    this.clipboardMode = "";
  },

  clearNotice() {
    this.noticeText = "";
    this.noticeTone = "info";
  },

  clearSelection(options = {}) {
    if (!this.selectedPaths.length) {
      return;
    }

    this.selectedPaths = [];

    if (this.actionMenuSource?.kind === "selection") {
      this.closeActionMenu();
    }

    if (options.focusList) {
      this.focusList({
        preventScroll: true
      });
    }
  },

  selectAllEntries(options = {}) {
    if (!this.entries.length) {
      return;
    }

    this.selectedPaths = this.entries.map((entry) => entry.path);

    if (this.actionMenuSource?.kind === "entry") {
      this.closeActionMenu();
    }

    if (options.focusList) {
      this.focusList({
        preventScroll: true
      });
    }
  },

  closeActionMenu() {
    this.actionMenuRenderToken += 1;
    this.actionMenuAnchor = null;
    this.actionMenuPosition = createActionMenuPosition();
    this.actionMenuSource = null;
  },

  closeDeleteDialog() {
    closeDialog(this.refs.deleteDialog);
    this.deleteDialogEntries = [];
    this.deleteDialogError = "";
    this.deleteDialogSaving = false;
  },

  closeCreateDialog() {
    closeDialog(this.refs.createDialog);
    this.createDialogError = "";
    this.createDialogKind = "file";
    this.createDialogSaving = false;
    this.createDraftName = "";
  },

  closeEditorDialog() {
    closeDialog(this.refs.editorDialog);
    this.editorDialogError = "";
    this.editorDialogLoading = false;
    this.editorDialogPath = "";
    this.editorDialogRequestId += 1;
    this.editorDialogSaving = false;
    this.editorDraftContent = "";
  },

  closeRenameDialog() {
    closeDialog(this.refs.renameDialog);
    this.renameDialogEntry = null;
    this.renameDialogError = "";
    this.renameDialogSaving = false;
    this.renameDraftName = "";
  },

  async downloadEntry(entry) {
    if (!entry) {
      return;
    }

    try {
      if (entry.isDirectory) {
        await space.api.call("folder_download", {
          method: "HEAD",
          query: {
            path: entry.path
          }
        });
      } else {
        await space.api.fileInfo(entry.path);
      }
    } catch (error) {
      showToast(formatDownloadErrorMessage(entry, error), {
        tone: "error"
      });
      return;
    }

    const documentObject = globalThis.document;

    if (!documentObject?.body) {
      return;
    }

    let url;

    if (entry.isDirectory) {
      url = space.api.folderDownloadUrl(entry.path);
    } else {
      url = new URL(globalThis.window?.location?.origin || globalThis.location?.origin || "http://localhost");
      url.pathname = `/${entry.path}`;
      url = url.toString();
    }

    const link = documentObject.createElement("a");
    link.href = url;
    link.download = entry.isDirectory
      ? ensureZipFilename(entry.name || getPathName(entry.path))
      : entry.name || getPathName(entry.path);
    documentObject.body.append(link);
    link.click();
    link.remove();
  },

  focusList(options = {}) {
    const list = this.refs.list;

    if (!list) {
      return;
    }

    try {
      list.focus({
        preventScroll: options.preventScroll === true
      });
    } catch {
      list.focus();
    }
  },

  getEntriesForActionSource(source) {
    if (!source || typeof source !== "object") {
      return [];
    }

    if (source.kind === "selection") {
      return this.selectedEntries;
    }

    if (source.kind === "entry" && typeof source.path === "string") {
      const entry = this.getEntry(source.path);
      return entry ? [entry] : [];
    }

    return [];
  },

  getEntry(path) {
    return this.entries.find((entry) => entry.path === path) || null;
  },

  getEntryDomId(path) {
    return `file-explorer-entry-${hashPath(path)}`;
  },

  getOrCreatePathState(path) {
    const pathKey = typeof path === "string" ? path : "";

    if (!Object.prototype.hasOwnProperty.call(this.pathStates, pathKey)) {
      this.pathStates[pathKey] = {
        highlightedPath: "",
        scrollTop: 0
      };
    }

    return this.pathStates[pathKey];
  },

  hasEntry(path) {
    return this.entries.some((entry) => entry.path === path);
  },

  hasEntryNamed(name) {
    return this.entries.some((entry) => entry.name === name);
  },

  handleListKeydown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (event.key !== "Tab") {
      this.closeActionMenu();
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.selectRelativeEntry(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        this.selectRelativeEntry(-1);
        return;
      case "ArrowRight":
        if (!this.highlightedPath) {
          return;
        }

        event.preventDefault();
        void this.openHighlightedEntry({
          focusList: true
        });
        return;
      case "ArrowLeft":
        if (!this.canGoUp) {
          return;
        }

        event.preventDefault();
        void this.navigateUp({
          focusList: true
        });
        return;
      case " ":
      case "Spacebar":
        if (!this.highlightedPath) {
          return;
        }

        event.preventDefault();
        this.toggleHighlightedSelection({
          focusList: true
        });
        return;
      default:
        return;
    }
  },

  isSelected(path) {
    return this.selectedPaths.includes(path);
  },

  async navigateHome(options = {}) {
    return this.navigateTo(HOME_REQUEST_PATH, options);
  },

  async navigateTo(path, options = {}) {
    const requestedPath = normalizeRequestPath(path);
    const requestId = this.requestId + 1;

    this.captureCurrentDirectoryState();
    this.clearNotice();
    this.closeActionMenu();
    this.clearSelection();
    this.requestId = requestId;
    this.loading = true;
    this.entries = [];
    this.highlightedPath = "";
    this.directoryPath = null;
    this.errorTitle = "";
    this.errorDetail = "";
    this.currentPath = toDisplayPath(requestedPath);
    this.draftPath = toDisplayPath(requestedPath);

    try {
      const resolvedRequest = await this.resolveDirectoryRequest(requestedPath, requestId);

      if (!resolvedRequest || requestId !== this.requestId) {
        return;
      }

      this.applyDirectoryResult(resolvedRequest.result, {
        focusList: options.focusList === true,
        highlightPath: options.highlightPath || resolvedRequest.highlightPath || ""
      });
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }

      const displayPath = toDisplayPath(requestedPath);

      this.currentPath = displayPath;
      this.draftPath = displayPath;
      this.loaded = true;
      this.errorTitle = isPermissionError(error)
        ? "Access denied"
        : isNotFoundError(error)
          ? "Path not found"
          : "Unable to open folder";
      this.errorDetail = isPermissionError(error)
        ? `You are not allowed to view ${displayPath}.`
        : isNotFoundError(error)
          ? `No folder was found at ${displayPath}.`
          : readErrorMessage(error);
    } finally {
      if (requestId === this.requestId) {
        this.loading = false;
      }
    }
  },

  async navigateUp(options = {}) {
    if (!this.canGoUp) {
      return;
    }

    return this.navigateTo(getParentPath(this.currentPath), options);
  },

  positionActionMenu() {
    if (!this.isActionMenuOpen || !this.refs.actionMenu || !this.actionMenuAnchor) {
      return;
    }

    this.actionMenuPosition = positionPopover(this.refs.actionMenu, this.actionMenuAnchor, {
      align: "end"
    });
  },

  openActionMenu(source, anchor) {
    this.actionMenuRenderToken += 1;
    const renderToken = this.actionMenuRenderToken;
    this.actionMenuAnchor = anchor || null;
    this.actionMenuSource = source || null;

    globalThis.requestAnimationFrame(() => {
      if (!this.isActionMenuOpen || this.actionMenuRenderToken !== renderToken) {
        return;
      }

      this.positionActionMenu();

      globalThis.requestAnimationFrame(() => {
        if (!this.isActionMenuOpen || this.actionMenuRenderToken !== renderToken) {
          return;
        }

        this.positionActionMenu();
      });
    });
  },

  toggleActionMenuForEntry(path, event) {
    const entry = this.getEntry(path);
    const anchor = event?.currentTarget || null;

    if (!entry || this.hasSelection || this.isWorking) {
      return;
    }

    if (this.actionMenuSource?.kind === "entry" && this.actionMenuSource.path === path) {
      this.closeActionMenu();
      return;
    }

    this.selectEntry(path, {
      focusList: true,
      scrollIntoView: false
    });

    this.openActionMenu({
      kind: "entry",
      path
    }, anchor);
  },

  toggleActionMenuForSelection(event) {
    const anchor = event?.currentTarget || null;

    if (!this.selectedEntries.length || this.isWorking) {
      return;
    }

    if (this.actionMenuSource?.kind === "selection") {
      this.closeActionMenu();
      return;
    }

    this.openActionMenu({
      kind: "selection"
    }, anchor);
  },

  openDeleteDialog(entries) {
    this.deleteDialogEntries = createClipboardItems(entries).map((entry) => ({
      ...entry
    }));
    this.deleteDialogError = "";
    this.deleteDialogSaving = false;
    openDialog(this.refs.deleteDialog);
  },

  openCreateDialog(kind) {
    if (!this.canCreateInCurrentDirectory) {
      return;
    }

    this.clearNotice();
    this.closeActionMenu();
    this.createDialogError = "";
    this.createDialogKind = kind === "folder" ? "folder" : "file";
    this.createDialogSaving = false;
    this.createDraftName = "";
    openDialog(this.refs.createDialog);
  },

  openCreateFileDialog() {
    this.openCreateDialog("file");
  },

  openCreateFolderDialog() {
    this.openCreateDialog("folder");
  },

  async openEditorDialog(entry) {
    if (!entry || entry.isDirectory) {
      return;
    }

    this.clearNotice();

    let info;

    try {
      info = await space.api.fileInfo(entry.path);
    } catch (error) {
      this.setNotice(readErrorMessage(error), "error");
      return;
    }

    if (info?.isDirectory) {
      this.setNotice("Only files can be edited.", "error");
      return;
    }

    if (Number(info?.size) > MAX_TEXT_EDIT_FILE_BYTES) {
      this.setNotice(
        `File is too large to edit in the browser (${formatByteSize(info.size)}). Limit is 1 MB.`,
        "error"
      );
      return;
    }

    this.editorDialogError = "";
    this.editorDialogLoading = true;
    this.editorDialogPath = entry.path;
    this.editorDialogRequestId += 1;
    this.editorDialogSaving = false;
    this.editorDraftContent = "";
    const requestId = this.editorDialogRequestId;

    openDialog(this.refs.editorDialog);

    try {
      const result = await space.api.fileRead(entry.path, "utf8");

      if (requestId !== this.editorDialogRequestId) {
        return;
      }

      this.editorDraftContent = String(result?.content ?? "");
    } catch (error) {
      if (requestId !== this.editorDialogRequestId) {
        return;
      }

      this.editorDialogError = readErrorMessage(error);
    } finally {
      if (requestId === this.editorDialogRequestId) {
        this.editorDialogLoading = false;
      }
    }
  },

  openHighlightedEntry(options = {}) {
    if (!this.highlightedPath) {
      return;
    }

    return this.openEntry(this.highlightedPath, options);
  },

  openRenameDialog(entry) {
    if (!entry) {
      return;
    }

    this.renameDialogEntry = {
      ...entry
    };
    this.renameDialogError = "";
    this.renameDialogSaving = false;
    this.renameDraftName = entry.name;
    openDialog(this.refs.renameDialog);
  },

  async openEntry(path, options = {}) {
    const entry = this.getEntry(path);

    if (!entry) {
      return;
    }

    this.selectEntry(path, {
      focusList: options.focusList === true,
      scrollIntoView: false
    });

    if (!entry.isDirectory) {
      return;
    }

    return this.navigateTo(entry.path, options);
  },

  async handleEntryDoubleClick(path, options = {}) {
    const entry = this.getEntry(path);

    if (!entry) {
      return;
    }

    this.selectEntry(path, {
      focusList: options.focusList === true,
      scrollIntoView: false
    });

    if (entry.isDirectory) {
      return this.navigateTo(entry.path, options);
    }

    return this.openEditorDialog(entry);
  },

  async pasteClipboardIntoCurrentDirectory() {
    if (!this.canPasteClipboard) {
      return;
    }

    const transfers = this.clipboardItems.map((item) => ({
      fromPath: item.path,
      toPath: buildChildPath(this.directoryPath, item.name, item.isDirectory)
    }));

    this.operationBusy = true;
    this.clearNotice();

    try {
      if (this.clipboardMode === "cut") {
        await space.api.fileMove({
          entries: transfers
        });
      } else {
        await space.api.fileCopy({
          entries: transfers
        });
      }

      this.clearClipboard();

      await this.navigateTo(this.directoryPath || HOME_REQUEST_PATH, {
        focusList: true,
        highlightPath: transfers[0]?.toPath || ""
      });
    } catch (error) {
      this.setNotice(readErrorMessage(error), "error");
    } finally {
      this.operationBusy = false;
    }
  },

  pruneClipboardPaths(paths) {
    const removedPaths = Array.isArray(paths) ? paths.filter(Boolean) : [];

    if (!removedPaths.length || !this.clipboardItems.length) {
      return;
    }

    this.clipboardItems = this.clipboardItems.filter(
      (item) => !removedPaths.some((removedPath) => isSameOrDescendantPath(removedPath, item.path))
    );

    if (!this.clipboardItems.length) {
      this.clearClipboard();
    }
  },

  removeClipboardItem(path) {
    if (!path) {
      return;
    }

    this.clipboardItems = this.clipboardItems.filter((item) => item.path !== path);

    if (!this.clipboardItems.length) {
      this.clearClipboard();
    }
  },

  resolveHighlightedPath(preferredPath) {
    if (preferredPath && this.hasEntry(preferredPath)) {
      return preferredPath;
    }

    return this.entries[0]?.path || "";
  },

  async resolveDirectoryRequest(path, requestId) {
    const result = await space.api.fileList(path, false);

    if (requestId !== this.requestId) {
      return null;
    }

    if (isDirectoryPath(result?.path) || (path === "" && result?.path === "")) {
      return {
        highlightPath: "",
        result
      };
    }

    const highlightPath = String(result?.path || "");
    const parentPath = getParentPath(highlightPath);
    const parentResult = await space.api.fileList(parentPath, false);

    if (requestId !== this.requestId) {
      return null;
    }

    return {
      highlightPath,
      result: parentResult
    };
  },

  restoreDirectoryState(path, options = {}) {
    const pathState = this.getOrCreatePathState(path);
    const highlightedPath = this.resolveHighlightedPath(options.highlightPath || pathState.highlightedPath);
    const shouldRestoreScrollTop = Number.isFinite(pathState.scrollTop) && !options.highlightPath;

    this.highlightedPath = highlightedPath;
    pathState.highlightedPath = highlightedPath;

    globalThis.requestAnimationFrame(() => {
      const list = this.refs.list;

      if (!list) {
        return;
      }

      list.scrollTop = shouldRestoreScrollTop ? pathState.scrollTop : 0;

      if (options.focusList) {
        this.focusList({
          preventScroll: true
        });
      }

      if (this.highlightedPath && (!shouldRestoreScrollTop || options.highlightPath)) {
        this.scrollEntryIntoView(this.highlightedPath);
      }
    });
  },

  async refresh(options = {}) {
    const refreshPath = this.currentPath || HOME_REQUEST_PATH;
    return this.navigateTo(refreshPath, options);
  },

  scrollEntryIntoView(path) {
    const entryElement = globalThis.document?.getElementById(this.getEntryDomId(path));
    entryElement?.scrollIntoView({
      block: "nearest"
    });
  },

  selectEntry(path, options = {}) {
    if (!this.hasEntry(path)) {
      return;
    }

    this.highlightedPath = path;

    if (typeof this.directoryPath === "string") {
      this.getOrCreatePathState(this.directoryPath).highlightedPath = path;
    }

    if (options.focusList) {
      this.focusList({
        preventScroll: true
      });
    }

    if (options.scrollIntoView !== false) {
      globalThis.requestAnimationFrame(() => this.scrollEntryIntoView(path));
    }
  },

  selectRelativeEntry(offset) {
    if (this.entries.length === 0) {
      return;
    }

    const currentIndex = this.entries.findIndex((entry) => entry.path === this.highlightedPath);
    const nextIndex =
      currentIndex === -1
        ? offset > 0
          ? 0
          : this.entries.length - 1
        : Math.min(Math.max(currentIndex + offset, 0), this.entries.length - 1);
    const nextPath = this.entries[nextIndex]?.path;

    if (nextPath) {
      this.selectEntry(nextPath, {
        focusList: true
      });
    }
  },

  setClipboard(mode, entries) {
    const normalizedMode = mode === "cut" ? "cut" : "copy";
    this.clipboardExpanded = false;
    this.clipboardItems = createClipboardItems(entries);
    this.clipboardMode = this.clipboardItems.length ? normalizedMode : "";
  },

  setDraftPath(value) {
    this.draftPath = String(value ?? "");
  },

  setNotice(message, tone = "info") {
    this.noticeText = String(message || "").trim();
    this.noticeTone = tone === "error" ? "error" : "info";
  },

  submitActionMenuAction(actionId) {
    const entries = this.actionMenuEntries.slice();

    if (!entries.length) {
      this.closeActionMenu();
      return;
    }

    switch (actionId) {
      case "copy":
        this.setClipboard("copy", entries);
        this.clearSelection();
        this.closeActionMenu();
        return;
      case "cut":
        this.setClipboard("cut", entries);
        this.clearSelection();
        this.closeActionMenu();
        return;
      case "download":
        void this.downloadEntry(entries[0]);
        this.closeActionMenu();
        return;
      case "edit":
        this.closeActionMenu();
        void this.openEditorDialog(entries[0]);
        return;
      case "remove":
        this.closeActionMenu();
        this.openDeleteDialog(entries);
        return;
      case "rename":
        this.closeActionMenu();
        this.openRenameDialog(entries[0]);
        return;
      default:
        this.closeActionMenu();
    }
  },

  async submitDeleteDialog() {
    const entries = this.deleteDialogEntries.slice();

    if (!entries.length || this.deleteDialogSaving) {
      return;
    }

    this.deleteDialogError = "";
    this.deleteDialogSaving = true;

    try {
      await space.api.fileDelete({
        paths: entries.map((entry) => entry.path)
      });
      this.pruneClipboardPaths(entries.map((entry) => entry.path));
      this.clearSelection();
      this.closeDeleteDialog();
      await this.navigateTo(this.directoryPath || HOME_REQUEST_PATH, {
        focusList: true
      });
    } catch (error) {
      this.deleteDialogError = readErrorMessage(error);
    } finally {
      this.deleteDialogSaving = false;
    }
  },

  async submitCreateDialog() {
    const name = this.createDraftName.trim();
    const isDirectory = this.createDialogKind === "folder";
    const validationError = validateChildName(name);

    if (this.createDialogSaving) {
      return;
    }

    if (!this.directoryPath) {
      this.createDialogError = "Open a writable folder before creating an item.";
      return;
    }

    if (validationError) {
      this.createDialogError = validationError;
      return;
    }

    const nextPath = buildChildPath(this.directoryPath, name, isDirectory);

    if (this.hasEntryNamed(name)) {
      this.createDialogError = "An item with that name already exists.";
      return;
    }

    this.createDialogError = "";
    this.createDialogSaving = true;

    try {
      await space.api.fileWrite(nextPath, "", "utf8");
      this.closeCreateDialog();
      await this.navigateTo(this.directoryPath || HOME_REQUEST_PATH, {
        focusList: true,
        highlightPath: nextPath
      });
    } catch (error) {
      this.createDialogError = readErrorMessage(error);
    } finally {
      this.createDialogSaving = false;
    }
  },

  async submitDraftPath(options = {}) {
    return this.navigateTo(this.draftPath, options);
  },

  async submitEditorDialog() {
    if (!this.editorDialogPath || this.editorDialogSaving || this.editorDialogLoading) {
      return;
    }

    this.editorDialogError = "";
    this.editorDialogSaving = true;

    try {
      await space.api.fileWrite(this.editorDialogPath, this.editorDraftContent, "utf8");
      this.closeEditorDialog();
      this.focusList({
        preventScroll: true
      });
    } catch (error) {
      this.editorDialogError = readErrorMessage(error);
    } finally {
      this.editorDialogSaving = false;
    }
  },

  async submitRenameDialog() {
    const entry = this.renameDialogEntry;
    const nextName = this.renameDraftName.trim();

    if (!entry || this.renameDialogSaving) {
      return;
    }

    if (!nextName) {
      this.renameDialogError = "Name must not be empty.";
      return;
    }

    if (nextName.includes("/") || nextName.includes("\\")) {
      this.renameDialogError = "Name must not include slashes.";
      return;
    }

    const nextPath = buildChildPath(getParentPath(entry.path), nextName, entry.isDirectory);

    if (nextPath === entry.path) {
      this.closeRenameDialog();
      return;
    }

    this.renameDialogError = "";
    this.renameDialogSaving = true;

    try {
      await space.api.fileMove(entry.path, nextPath);
      this.closeRenameDialog();
      await this.navigateTo(this.directoryPath || HOME_REQUEST_PATH, {
        focusList: true,
        highlightPath: nextPath
      });
    } catch (error) {
      this.renameDialogError = readErrorMessage(error);
    } finally {
      this.renameDialogSaving = false;
    }
  },

  toggleClipboardExpanded() {
    if (!this.clipboardItems.length) {
      return;
    }

    this.clipboardExpanded = !this.clipboardExpanded;
  },

  toggleHighlightedSelection(options = {}) {
    if (!this.highlightedPath) {
      return;
    }

    this.toggleSelection(this.highlightedPath, options);
  },

  toggleSelection(path, options = {}) {
    if (!this.hasEntry(path)) {
      return;
    }

    const nextSelectedPaths = this.isSelected(path)
      ? this.selectedPaths.filter((selectedPath) => selectedPath !== path)
      : [...this.selectedPaths, path];

    this.selectedPaths = nextSelectedPaths;

    if (this.highlightedPath !== path) {
      this.selectEntry(path, {
        focusList: options.focusList === true,
        scrollIntoView: options.scrollIntoView !== false
      });
    } else if (options.focusList) {
      this.focusList({
        preventScroll: true
      });
    }

    if (this.selectedPaths.length && this.actionMenuSource?.kind === "entry") {
      this.closeActionMenu();
    }

    if (!this.selectedPaths.length && this.actionMenuSource?.kind === "selection") {
      this.closeActionMenu();
    }
  }
};

filesModel.applyDirectoryResult = function applyDirectoryResult(result, options = {}) {
  const directoryPath = String(result?.path ?? "");

  this.directoryPath = directoryPath;
  this.currentPath = toDisplayPath(directoryPath);
  this.draftPath = toDisplayPath(directoryPath);
  this.entries = buildEntries(result?.paths);
  this.errorTitle = "";
  this.errorDetail = "";
  this.loaded = true;

  this.restoreDirectoryState(directoryPath, {
    focusList: options.focusList === true,
    highlightPath: options.highlightPath || ""
  });
};

const fileExplorer = space.fw.createStore("fileExplorer", filesModel);

export { fileExplorer };
