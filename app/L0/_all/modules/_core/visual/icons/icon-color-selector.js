import { closeModal, openModal } from "/modules/_core/framework/js/modals.js";
import {
  loadMaterialSymbolNames,
  normalizeIconHexColor,
  normalizeMaterialSymbolName
} from "/modules/_core/visual/icons/material-symbols.js";

const MODAL_PATH = "/modules/_core/visual/icons/icon-color-selector-modal.html";
const STORE_NAME = "visualIconColorSelector";
const DEFAULT_PAGE_SIZE = 100;
const FALLBACK_PREVIEW_COLOR = "#94bcff";
const FALLBACK_PREVIEW_ICON = "image";
const NONE_PREVIEW_ICON = "hide_image";

let activeRequest = null;

function clampNumber(value, min, max) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.floor(numericValue)));
}

function formatIconOptionLabel(iconName) {
  const normalizedName = normalizeMaterialSymbolName(iconName);

  if (!normalizedName) {
    return "Untitled icon";
  }

  return normalizedName
    .split("_")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizeSelectorOptions(options = {}) {
  const defaultIcon = normalizeMaterialSymbolName(options.defaultIcon);
  const defaultColor = normalizeIconHexColor(options.defaultColor);
  const requestedPageSize = Number(options.pageSize);
  const defaultPreviewIcon =
    normalizeMaterialSymbolName(options.defaultPreviewIcon) || defaultIcon || FALLBACK_PREVIEW_ICON;
  const defaultPreviewColor =
    normalizeIconHexColor(options.defaultPreviewColor) || defaultColor || FALLBACK_PREVIEW_COLOR;

  return {
    allowNone: options.allowNone === true,
    color: normalizeIconHexColor(options.color),
    defaultColor,
    defaultIcon,
    defaultPreviewColor,
    defaultPreviewIcon,
    icon: normalizeMaterialSymbolName(options.icon),
    pageSize: Number.isFinite(requestedPageSize) ? clampNumber(requestedPageSize, 24, 120) : DEFAULT_PAGE_SIZE,
    resetLabel: String(options.resetLabel || "Reset to defaults").trim() || "Reset to defaults"
  };
}

function getVisualRuntime() {
  const runtime = globalThis.space && typeof globalThis.space === "object" ? globalThis.space : (globalThis.space = {});
  runtime.visual = runtime.visual || {};
  return runtime.visual;
}

function getFrameworkRuntime() {
  const runtime = globalThis.space;

  if (!runtime?.fw?.createStore) {
    throw new Error("space.fw.createStore(...) is not available.");
  }

  return runtime;
}

const model = {
  activeRequestId: "",
  allowNone: false,
  catalog: [],
  defaultColor: "",
  defaultIcon: "",
  defaultPreviewColor: FALLBACK_PREVIEW_COLOR,
  defaultPreviewIcon: FALLBACK_PREVIEW_ICON,
  isClosing: false,
  loadErrorText: "",
  loadingCatalog: false,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  resetLabel: "Reset to defaults",
  searchDraft: "",
  selectedColor: "",
  selectedIcon: "",

  get canGoToNextPage() {
    return this.currentPageNumber < this.pageCount;
  },

  get canGoToPreviousPage() {
    return this.currentPageNumber > 1;
  },

  get colorInputValue() {
    return this.selectedColor || this.defaultPreviewColor || FALLBACK_PREVIEW_COLOR;
  },

  get colorValueLabel() {
    return (this.selectedColor || this.defaultColor || this.defaultPreviewColor || FALLBACK_PREVIEW_COLOR).toUpperCase();
  },

  get currentPageNumber() {
    return clampNumber(this.page, 1, this.pageCount);
  },

  get filteredIcons() {
    const normalizedQuery = normalizeMaterialSymbolName(this.searchDraft);

    if (!normalizedQuery) {
      return this.catalog;
    }

    return this.catalog.filter((iconName) => iconName.includes(normalizedQuery));
  },

  get isNoneSelected() {
    return this.allowNone && !this.selectedIcon;
  },

  get pageCount() {
    return Math.max(1, Math.ceil(this.filteredIcons.length / this.pageSize));
  },

  get pageSummary() {
    const totalMatches = this.filteredIcons.length;

    if (!totalMatches) {
      if (this.searchDraft.trim()) {
        return `No icons match "${this.searchDraft.trim()}".`;
      }

      return "No Material icons available.";
    }

    const startIndex = ((this.currentPageNumber - 1) * this.pageSize) + 1;
    const endIndex = startIndex + this.visibleIcons.length - 1;
    return `Showing ${startIndex}-${endIndex} of ${totalMatches} icons`;
  },

  get paginationLabel() {
    if (!this.filteredIcons.length) {
      return "Page 1 of 1";
    }

    return `Page ${this.currentPageNumber} of ${this.pageCount}`;
  },

  get previewColorValue() {
    if (this.isNoneSelected) {
      return "rgba(184, 196, 218, 0.86)";
    }

    return this.selectedColor || this.defaultPreviewColor || FALLBACK_PREVIEW_COLOR;
  },

  get previewIconName() {
    if (this.isNoneSelected) {
      return NONE_PREVIEW_ICON;
    }

    return this.selectedIcon || this.defaultPreviewIcon || FALLBACK_PREVIEW_ICON;
  },

  get resetButtonLabel() {
    return this.resetLabel;
  },

  get selectionHelpLabel() {
    if (this.isNoneSelected) {
      return "No icon will be returned when you apply this selection.";
    }

    if (!this.selectedIcon) {
      return "Using the provided default icon until you choose a custom one.";
    }

    return `Color ${this.colorValueLabel}`;
  },

  get selectionSummaryLabel() {
    if (this.isNoneSelected) {
      return "No icon selected";
    }

    if (!this.selectedIcon) {
      return `Default: ${formatIconOptionLabel(this.defaultPreviewIcon)}`;
    }

    return formatIconOptionLabel(this.selectedIcon);
  },

  get visibleIcons() {
    const startIndex = (this.currentPageNumber - 1) * this.pageSize;
    return this.filteredIcons.slice(startIndex, startIndex + this.pageSize);
  },

  async ensureCatalogLoaded() {
    if (this.catalog.length || this.loadingCatalog) {
      return this.catalog;
    }

    this.loadingCatalog = true;
    this.loadErrorText = "";

    try {
      const iconNames = await loadMaterialSymbolNames();
      this.catalog = Array.isArray(iconNames) ? [...iconNames] : [];
      return this.catalog;
    } catch (error) {
      this.loadErrorText = String(error?.message || "Unable to load Material icons.");
      console.error("[visual-icon-selector] ensureCatalogLoaded failed", error);
      return [];
    } finally {
      this.loadingCatalog = false;
    }
  },

  focusSearchField(element) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    requestAnimationFrame(() => {
      if (!this.activeRequestId || !element.isConnected) {
        return;
      }

      element.focus();
      element.select?.();
    });
  },

  formatIconOptionLabel,

  goToNextPage() {
    if (!this.canGoToNextPage) {
      return;
    }

    this.page = this.currentPageNumber + 1;
  },

  goToPreviousPage() {
    if (!this.canGoToPreviousPage) {
      return;
    }

    this.page = this.currentPageNumber - 1;
  },

  handleSearchInput() {
    this.page = 1;
  },

  async openSelector(options = {}) {
    if (activeRequest) {
      throw new Error("The icon selector is already open.");
    }

    const normalizedOptions = normalizeSelectorOptions(options);
    const request = {
      id: `icon-selector-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      result: null
    };

    activeRequest = request;
    this.activeRequestId = request.id;
    this.allowNone = normalizedOptions.allowNone;
    this.defaultColor = normalizedOptions.defaultColor;
    this.defaultIcon = normalizedOptions.defaultIcon;
    this.defaultPreviewColor = normalizedOptions.defaultPreviewColor;
    this.defaultPreviewIcon = normalizedOptions.defaultPreviewIcon;
    this.isClosing = false;
    this.loadErrorText = "";
    this.page = 1;
    this.pageSize = normalizedOptions.pageSize;
    this.resetLabel = normalizedOptions.resetLabel;
    this.searchDraft = "";
    this.selectedColor = normalizedOptions.color;
    this.selectedIcon = normalizedOptions.icon;

    void this.ensureCatalogLoaded();

    try {
      await openModal(MODAL_PATH, () => {
        if (activeRequest?.id === request.id) {
          activeRequest = null;
          this.resetState();
        }

        return true;
      });
    } catch (error) {
      if (activeRequest?.id === request.id) {
        activeRequest = null;
      }

      this.resetState();
      throw error;
    }

    return request.result;
  },

  async applySelection() {
    await this.finishSelection({
      color: this.selectedColor,
      icon: this.selectedIcon
    });
  },

  async cancelSelection() {
    await this.finishSelection(null);
  },

  resetState() {
    this.activeRequestId = "";
    this.allowNone = false;
    this.defaultColor = "";
    this.defaultIcon = "";
    this.defaultPreviewColor = FALLBACK_PREVIEW_COLOR;
    this.defaultPreviewIcon = FALLBACK_PREVIEW_ICON;
    this.isClosing = false;
    this.loadErrorText = "";
    this.page = 1;
    this.pageSize = DEFAULT_PAGE_SIZE;
    this.resetLabel = "Reset to defaults";
    this.searchDraft = "";
    this.selectedColor = "";
    this.selectedIcon = "";
  },

  async resetToDefaults() {
    await this.finishSelection({
      color: this.defaultColor,
      icon: this.defaultIcon
    });
  },

  selectIcon(iconName) {
    this.selectedIcon = normalizeMaterialSymbolName(iconName);
  },

  selectNone() {
    if (!this.allowNone) {
      return;
    }

    this.selectedIcon = "";
  },

  updateColor(colorValue) {
    const normalizedColor = normalizeIconHexColor(colorValue);

    if (!normalizedColor) {
      return;
    }

    this.selectedColor = normalizedColor;
  },

  async finishSelection(result) {
    if (!activeRequest || this.isClosing) {
      return;
    }

    activeRequest.result = result && typeof result === "object"
      ? {
          color: normalizeIconHexColor(result.color),
          icon: normalizeMaterialSymbolName(result.icon)
        }
      : null;

    this.isClosing = true;

    try {
      await closeModal(MODAL_PATH);
    } finally {
      this.isClosing = false;
    }
  }
};

const frameworkRuntime = getFrameworkRuntime();
const store = frameworkRuntime.fw.createStore(STORE_NAME, model);

export async function openIconColorSelector(options = {}) {
  return store.openSelector(options);
}

const visualRuntime = getVisualRuntime();
visualRuntime.openIconColorSelector = openIconColorSelector;
