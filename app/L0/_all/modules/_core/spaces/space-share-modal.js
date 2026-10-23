import { closeDialog, openDialog } from "/modules/_core/visual/forms/dialog.js";
import { buildSpaceRootPath } from "/modules/_core/spaces/storage.js";
import {
  getSpaceDisplayTitle,
  normalizeSpaceAgentInstructions,
  normalizeSpaceIcon,
  normalizeSpaceIconColor,
  normalizeSpaceTitle
} from "/modules/_core/spaces/space-metadata.js";
import { showToast } from "/modules/_core/visual/chrome/toast.js";
import { encryptSharePayload, ensureWebCrypto } from "/pages/res/share-crypto.js";

const STORE_NAME = "spacesShareModal";
const CLOUD_SHARE_MAX_BYTES = 2 * 1024 * 1024;

let activeRequest = null;

function getRuntime() {
  const runtime = globalThis.space;

  if (!runtime?.api || !runtime?.fw?.createStore) {
    throw new Error("The Space runtime is not available.");
  }

  return runtime;
}

function createRequestId() {
  return `spaces-share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCloudShareBaseUrl(value) {
  const candidate = String(value || "").trim();

  if (!candidate) {
    return "";
  }

  const normalizedInput = /^https?:\/\//iu.test(candidate) ? candidate : `https://${candidate}`;

  try {
    const normalizedUrl = new URL(normalizedInput);
    normalizedUrl.hash = "";
    normalizedUrl.search = "";
    normalizedUrl.pathname = "";
    return normalizedUrl.toString().replace(/\/$/u, "");
  } catch {
    return "";
  }
}

function normalizeOpenOptions(options = {}) {
  const runtime = globalThis.space;
  const runtimeCurrentSpace = runtime?.spaces?.current || runtime?.current || null;
  const currentSpace = options.currentSpace && typeof options.currentSpace === "object"
    ? options.currentSpace
    : runtimeCurrentSpace;
  const spaceId = String(options.spaceId || currentSpace?.id || runtime?.spaces?.currentId || "").trim();

  if (!spaceId) {
    throw new Error("An open space is required.");
  }

  return {
    currentSpace,
    spaceId,
    spaceTitle: getSpaceDisplayTitle(options.spaceTitle ?? currentSpace?.title ?? spaceId)
  };
}

function sanitizeFileSegment(value, fallback = "space") {
  const candidate = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return candidate || fallback;
}

function createDownloadFilename(spaceId, spaceTitle) {
  return `${sanitizeFileSegment(spaceTitle || spaceId, spaceId || "space")}.zip`;
}

function createCloudShareCreateUrl(baseUrl, encryption = null) {
  const url = new URL("/api/cloud_share_create", baseUrl);

  if (encryption?.encrypted === true) {
    url.searchParams.set("encrypted", "true");
    url.searchParams.set("cipher", String(encryption.cipher || "AES-GCM"));
    url.searchParams.set("iv", String(encryption.iv || ""));
    url.searchParams.set("iterations", String(Number(encryption.iterations) || 0));
    url.searchParams.set("kdf", String(encryption.kdf || "PBKDF2-SHA-256"));
    url.searchParams.set("salt", String(encryption.salt || ""));
  }

  return url.toString();
}

function createAnchorDownload(url, filename) {
  const documentObject = globalThis.document;

  if (!documentObject?.body) {
    return;
  }

  const link = documentObject.createElement("a");
  link.href = url;
  link.download = filename;
  documentObject.body.append(link);
  link.click();
  link.remove();
}

function createErrorMessage(error, fallback) {
  return String(error?.message || fallback || "Unexpected error.");
}

function logShareModalError(action, error) {
  console.error(`[spacesShareModal] ${action}`, error);
}

function createLoggedErrorMessage(action, error, fallback) {
  logShareModalError(action, error);
  return createErrorMessage(error, fallback);
}

function normalizeDialogElement(dialogElement) {
  return dialogElement instanceof HTMLDialogElement ? dialogElement : null;
}

function hasMeaningfulSpaceMetadata(spaceRecord) {
  if (!spaceRecord || typeof spaceRecord !== "object") {
    return false;
  }

  if (Array.isArray(spaceRecord.widgetIds) && spaceRecord.widgetIds.length > 0) {
    return true;
  }

  return Boolean(
    normalizeSpaceTitle(spaceRecord.title) ||
      normalizeSpaceAgentInstructions(spaceRecord.agentInstructions ?? spaceRecord.specialInstructions) ||
      normalizeSpaceIcon(spaceRecord.icon) ||
      normalizeSpaceIconColor(spaceRecord.iconColor)
  );
}

function buildIgnoredSpacePaths(spaceRoot) {
  const withSlash = String(spaceRoot || "");
  const withoutSlash = withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;

  return new Set([
    withSlash,
    withoutSlash,
    `${withoutSlash}/space.yaml`,
    `${withoutSlash}/widgets`,
    `${withoutSlash}/widgets/`,
    `${withoutSlash}/data`,
    `${withoutSlash}/data/`,
    `${withoutSlash}/assets`,
    `${withoutSlash}/assets/`
  ]);
}

async function spaceFolderHasExtraContent(spaceId) {
  const runtime = getRuntime();
  const spaceRoot = buildSpaceRootPath(spaceId);
  const listResult = await runtime.api.fileList(spaceRoot, true);
  const paths = Array.isArray(listResult?.paths) ? listResult.paths : [];
  const ignoredPaths = buildIgnoredSpacePaths(spaceRoot);
  const prefix = spaceRoot.endsWith("/") ? spaceRoot.slice(0, -1) : spaceRoot;

  return paths.some((entryPath) => {
    const normalizedPath = String(entryPath || "");
    return normalizedPath.startsWith(prefix) && !ignoredPaths.has(normalizedPath);
  });
}

async function shouldPromptForOverwrite(spaceId, currentSpace) {
  if (hasMeaningfulSpaceMetadata(currentSpace)) {
    return true;
  }

  try {
    return await spaceFolderHasExtraContent(spaceId);
  } catch {
    return true;
  }
}

function buildSpaceDownloadPath(spaceId) {
  return buildSpaceRootPath(spaceId);
}

function createSpaceDownloadUrl(spaceId) {
  const runtime = getRuntime();
  return runtime.api.folderDownloadUrl(buildSpaceDownloadPath(spaceId));
}

async function readResponseErrorMessage(response, fallback) {
  let payload = null;

  try {
    payload = await response.clone().json();
  } catch {}

  if (payload && typeof payload === "object" && String(payload.error || "").trim()) {
    return String(payload.error).trim();
  }

  try {
    const text = String(await response.text()).trim();

    if (text) {
      return text;
    }
  } catch {}

  return fallback;
}

async function verifySpaceArchiveDownload(spaceId) {
  const runtime = getRuntime();

  await runtime.api.call("folder_download", {
    method: "HEAD",
    query: {
      path: buildSpaceDownloadPath(spaceId)
    }
  });
}

async function fetchSpaceArchiveBytes(spaceId) {
  const response = await fetch(createSpaceDownloadUrl(spaceId), {
    credentials: "same-origin"
  });

  if (!response.ok) {
    throw new Error(await readResponseErrorMessage(response, "Unable to create the ZIP."));
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function importSpaceArchive(spaceId, mode, payloadBytes) {
  const runtime = getRuntime();
  const query = mode === "replace"
    ? {
        mode,
        spaceId
      }
    : undefined;

  return runtime.api.call("space_import", {
    method: "POST",
    query,
    headers: {
      "Content-Type": "application/zip"
    },
    body: payloadBytes
  });
}

async function createCloudShare(baseUrl, payloadBytes, encryption = null) {
  const response = await fetch(createCloudShareCreateUrl(baseUrl, encryption), {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream"
    },
    body: payloadBytes
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(String(payload?.error || "Unable to upload the cloud share."));
  }

  return payload;
}

async function copyTextToClipboard(text) {
  if (!globalThis.navigator?.clipboard?.writeText) {
    return false;
  }

  await globalThis.navigator.clipboard.writeText(text);
  return true;
}

const model = {
  activeRequestId: "",
  refs: {},
  archiveErrorText: "",
  archiveStatusText: "",
  busyAction: "",
  cloudErrorText: "",
  cloudShareBaseUrl: "",
  cloudSharePassword: "",
  cloudStatusText: "",
  currentSpace: null,
  shareUrl: "",
  spaceId: "",
  spaceTitle: "",

  get canShareToCloud() {
    return Boolean(this.cloudShareBaseUrl);
  },

  get cloudShareHostLabel() {
    if (!this.cloudShareBaseUrl) {
      return "";
    }

    try {
      return new URL(this.cloudShareBaseUrl).host;
    } catch {
      return this.cloudShareBaseUrl.replace(/^https?:\/\//iu, "");
    }
  },

  get hasShareUrl() {
    return Boolean(this.shareUrl);
  },

  get isBusy() {
    return Boolean(this.busyAction);
  },

  get isCloudShareBusy() {
    return this.busyAction === "cloud";
  },

  get isDownloadBusy() {
    return this.busyAction === "download";
  },

  get isImportBusy() {
    return this.busyAction === "import";
  },

  clearArchiveFeedback() {
    this.archiveErrorText = "";
    this.archiveStatusText = "";
  },

  clearCloudFeedback() {
    this.cloudErrorText = "";
    this.cloudStatusText = "";
  },

  resetState() {
    this.activeRequestId = "";
    this.archiveErrorText = "";
    this.archiveStatusText = "";
    this.busyAction = "";
    this.cloudErrorText = "";
    this.cloudShareBaseUrl = "";
    this.cloudSharePassword = "";
    this.cloudStatusText = "";
    this.currentSpace = null;
    this.shareUrl = "";
    this.spaceId = "";
    this.spaceTitle = "";
  },

  mount(refs = {}) {
    this.refs = {
      shareDialog: normalizeDialogElement(refs.shareDialog)
    };
  },

  unmount() {
    const dialogElement = normalizeDialogElement(this.refs?.shareDialog);

    if (dialogElement?.open) {
      closeDialog(dialogElement);
    }

    this.refs = {};
    activeRequest = null;
    this.resetState();
  },

  async openShareDialog(options = {}) {
    const dialogElement = normalizeDialogElement(this.refs?.shareDialog);

    if (!dialogElement) {
      throw new Error("The space share dialog is not mounted.");
    }

    if (activeRequest || dialogElement.open) {
      throw new Error("The space share modal is already open.");
    }

    const runtime = getRuntime();
    const normalizedOptions = normalizeOpenOptions(options);
    const request = {
      id: createRequestId(),
      result: null
    };

    activeRequest = request;
    this.activeRequestId = request.id;
    this.busyAction = "";
    this.cloudShareBaseUrl = normalizeCloudShareBaseUrl(runtime.config?.get("CLOUD_SHARE_URL", ""));
    this.cloudSharePassword = "";
    this.currentSpace = normalizedOptions.currentSpace;
    this.clearArchiveFeedback();
    this.clearCloudFeedback();
    this.shareUrl = "";
    this.spaceId = normalizedOptions.spaceId;
    this.spaceTitle = normalizedOptions.spaceTitle;

    try {
      openDialog(dialogElement);
    } catch (error) {
      if (activeRequest?.id === request.id) {
        activeRequest = null;
      }

      this.resetState();
      throw error;
    }

    return request.result;
  },

  closeShareDialog() {
    if (this.isBusy) {
      return false;
    }

    const dialogElement = normalizeDialogElement(this.refs?.shareDialog);

    if (dialogElement?.open) {
      closeDialog(dialogElement);
    }

    activeRequest = null;
    this.resetState();
    return true;
  },

  async closeShareModal() {
    return this.closeShareDialog();
  },

  async downloadZip() {
    if (this.isBusy || !this.spaceId) {
      return;
    }

    this.busyAction = "download";
    this.clearArchiveFeedback();
    this.archiveStatusText = "Preparing ZIP download...";

    try {
      await verifySpaceArchiveDownload(this.spaceId);
      createAnchorDownload(
        createSpaceDownloadUrl(this.spaceId),
        createDownloadFilename(this.spaceId, this.spaceTitle)
      );
      this.archiveStatusText = "ZIP download started.";
    } catch (error) {
      this.archiveErrorText = createLoggedErrorMessage("downloadZip", error, "Unable to download the ZIP.");
      this.archiveStatusText = "";
    } finally {
      this.busyAction = "";
    }
  },

  chooseImportFile(inputElement) {
    if (this.isBusy || !(inputElement instanceof HTMLInputElement)) {
      return;
    }

    inputElement.value = "";
    inputElement.click();
  },

  async handleImportFileChange(event) {
    const inputElement = event?.target;
    const archiveFile = inputElement?.files?.[0] || null;

    if (inputElement instanceof HTMLInputElement) {
      inputElement.value = "";
    }

    if (!archiveFile || this.isBusy || !this.spaceId) {
      return;
    }

    this.busyAction = "import";
    this.clearArchiveFeedback();
    this.archiveStatusText = "Importing ZIP...";

    try {
      const shouldPrompt = await shouldPromptForOverwrite(this.spaceId, this.currentSpace);
      const mode = shouldPrompt
        ? (globalThis.confirm(
            `Overwrite "${this.spaceTitle}"? Click Cancel to keep it and import the ZIP as a new space instead.`
          )
            ? "replace"
            : "import")
        : "replace";
      const result = await importSpaceArchive(this.spaceId, mode, new Uint8Array(await archiveFile.arrayBuffer()));
      const runtime = getRuntime();
      const currentSpaceTitle = this.spaceTitle;
      const importedSpaceId = String(result?.spaceId || "").trim();
      const importedSpaceTitle = String(result?.title || importedSpaceId || "Imported").trim() || "Imported";

      if (!importedSpaceId) {
        throw new Error("The import did not return a destination space.");
      }

      this.busyAction = "";
      this.closeShareDialog();

      if (mode === "replace") {
        await runtime.spaces.reloadCurrentSpace();
        showToast(`Replaced "${currentSpaceTitle}".`, {
          tone: "success"
        });
        return;
      }

      await runtime.spaces.openSpace(importedSpaceId);
      showToast(`Imported "${importedSpaceTitle}".`, {
        tone: "success"
      });
    } catch (error) {
      const message = createLoggedErrorMessage("handleImportFileChange", error, "Unable to import the ZIP.");

      if (activeRequest?.id === this.activeRequestId) {
        this.archiveErrorText = message;
        this.archiveStatusText = "";
        this.busyAction = "";
        return;
      }

      showToast(message, {
        tone: "error"
      });
    }
  },

  async shareToCloud() {
    if (this.isBusy || !this.spaceId || !this.canShareToCloud) {
      return;
    }

    this.busyAction = "cloud";
    this.clearCloudFeedback();
    this.shareUrl = "";
    this.cloudStatusText = "Creating ZIP...";

    try {
      const archiveBytes = await fetchSpaceArchiveBytes(this.spaceId);
      const password = String(this.cloudSharePassword || "").trim();
      let uploadBytes = archiveBytes;
      let encryption = null;

      if (password) {
        ensureWebCrypto();
        this.cloudStatusText = "Encrypting ZIP...";
        const encryptedPayload = await encryptSharePayload(archiveBytes, password);
        uploadBytes = encryptedPayload.payloadBytes;
        encryption = encryptedPayload.encryption;
      }

      if (uploadBytes.byteLength > CLOUD_SHARE_MAX_BYTES) {
        throw new Error("Cloud shares must be 2 MB or smaller.");
      }

      this.cloudStatusText = "Uploading cloud share...";
      const shareResponse = await createCloudShare(this.cloudShareBaseUrl, uploadBytes, encryption);
      const shareUrl = String(shareResponse?.shareUrl || shareResponse?.url || "").trim();

      if (!shareUrl) {
        throw new Error("The cloud share server did not return a share URL.");
      }

      this.shareUrl = shareUrl;
      this.cloudStatusText = password ? "Protected cloud share ready." : "Cloud share ready.";
      showToast("Cloud share created.", {
        tone: "success"
      });
    } catch (error) {
      this.cloudErrorText = createLoggedErrorMessage("shareToCloud", error, "Unable to create the cloud share.");
      this.cloudStatusText = "";
    } finally {
      this.busyAction = "";
    }
  },

  async copyShareUrl(inputElement) {
    if (!this.shareUrl) {
      return;
    }

    this.cloudErrorText = "";

    try {
      if (await copyTextToClipboard(this.shareUrl)) {
        showToast("Share link copied.", {
          tone: "success"
        });
        return;
      }
    } catch (error) {
      this.cloudErrorText = createLoggedErrorMessage("copyShareUrl", error, "Unable to copy the share link.");
      return;
    }

    if (inputElement instanceof HTMLInputElement) {
      inputElement.focus();
      inputElement.select();
      showToast("Share link selected.", {
        tone: "success"
      });
      return;
    }

    this.cloudErrorText = createLoggedErrorMessage(
      "copyShareUrl",
      new Error("Unable to copy the share link."),
      "Unable to copy the share link."
    );
  },

  openShareUrl() {
    if (!this.shareUrl) {
      return;
    }

    globalThis.open(this.shareUrl, "_blank", "noopener");
  }
};

const runtime = getRuntime();
const store = runtime.fw.createStore(STORE_NAME, model);

export async function openSpaceShareModal(options = {}) {
  return store.openShareDialog(options);
}

runtime.spaces = runtime.spaces || {};
runtime.spaces.openShareModal = openSpaceShareModal;
