const SEARCH_DEBOUNCE_MS = 180;
const DEFAULT_AREA = "l2_self";
const FILE_BROWSER_PLACEHOLDER_TITLE = "Use the Files tab to browse module folders.";

const baseAreaOptions = Object.freeze([
  {
    description: "Show modules installed in your own L2 directory.",
    emptyDescription: "Modules installed into your L2 directory will appear here.",
    label: "L2 / mine",
    value: "l2_self"
  },
  {
    description: "Show readable and writable modules installed in L1 group directories.",
    emptyDescription: "Modules installed into accessible L1 group directories will appear here.",
    label: "L1 / groups",
    value: "l1"
  }
]);

const adminAreaOptions = Object.freeze([
  {
    description: "Show aggregated L2 modules across user directories.",
    emptyDescription: "User L2 modules will appear here once they are installed.",
    label: "L2 / users",
    value: "l2_users"
  }
]);

function createEmptyPendingMap() {
  return Object.create(null);
}

function getAdminPageStore() {
  if (!globalThis.Alpine || typeof globalThis.Alpine.store !== "function") {
    return null;
  }

  return globalThis.Alpine.store("adminPage");
}

function isAbortError(error) {
  const message = String(error?.message || "");
  return error?.name === "AbortError" || /abort/i.test(message);
}

function stripGitSuffix(pathname) {
  return String(pathname || "").replace(/\.git$/u, "").replace(/\/+$/u, "");
}

function formatPlural(value, singular, plural) {
  return value === 1 ? singular : plural;
}

function toRepositoryBrowserUrl(remoteUrl) {
  const normalizedRemoteUrl = String(remoteUrl || "").trim();

  if (!normalizedRemoteUrl) {
    return null;
  }

  try {
    if (/^https?:\/\//iu.test(normalizedRemoteUrl)) {
      const url = new URL(normalizedRemoteUrl);
      url.username = "";
      url.password = "";
      url.hash = "";
      url.search = "";
      url.pathname = stripGitSuffix(url.pathname);
      return url.toString().replace(/\/+$/u, "");
    }

    if (/^(git|ssh):\/\//iu.test(normalizedRemoteUrl)) {
      const url = new URL(normalizedRemoteUrl);
      return `https://${url.host}${stripGitSuffix(url.pathname)}`;
    }
  } catch {
    // Fall back to scp-like parsing below.
  }

  const scpLikeMatch = normalizedRemoteUrl.match(/^(?:[^@]+@)?([^:]+):(.+)$/u);

  if (!scpLikeMatch) {
    return null;
  }

  return `https://${scpLikeMatch[1]}/${stripGitSuffix(scpLikeMatch[2].replace(/^\/+/u, ""))}`;
}

const moduleListModel = {
  activeRequestController: null,
  area: DEFAULT_AREA,
  error: null,
  loaded: false,
  loading: false,
  modules: [],
  pendingRemovals: createEmptyPendingMap(),
  requestId: 0,
  search: "",
  searchDebounceHandle: 0,

  get areaOptions() {
    const options = [...baseAreaOptions];

    if (getAdminPageStore()?.isCurrentUserAdmin) {
      options.push(...adminAreaOptions);
    }

    return options;
  },

  get currentAreaOption() {
    return this.areaOptions.find((option) => option.value === this.area) || this.areaOptions[0];
  },

  get emptyDescription() {
    return this.currentAreaOption?.emptyDescription || "Installed modules will appear here.";
  },

  get emptyTitle() {
    return "No modules installed";
  },

  createQuery() {
    const query = {
      area: this.area || DEFAULT_AREA
    };
    const normalizedSearch = String(this.search || "").trim();

    if (normalizedSearch) {
      query.search = normalizedSearch;
    }

    return query;
  },

  async load() {
    const requestId = this.requestId + 1;
    const requestController = new AbortController();

    this.requestId = requestId;
    this.activeRequestController?.abort();
    this.activeRequestController = requestController;
    this.loading = true;
    this.error = null;

    try {
      const result = await space.api.call("module_list", {
        query: this.createQuery(),
        signal: requestController.signal
      });

      if (requestId !== this.requestId) {
        return;
      }

      this.modules = Array.isArray(result) ? result : [];
      this.loaded = true;
    } catch (error) {
      if (requestController.signal.aborted || isAbortError(error)) {
        return;
      }

      if (requestId !== this.requestId) {
        return;
      }

      this.error = error.message || "Failed to load modules.";
    } finally {
      if (this.activeRequestController === requestController) {
        this.activeRequestController = null;
      }

      if (requestId === this.requestId) {
        this.loading = false;
      }
    }
  },

  clearSearchDebounce() {
    if (!this.searchDebounceHandle) {
      return;
    }

    globalThis.clearTimeout(this.searchDebounceHandle);
    this.searchDebounceHandle = 0;
  },

  scheduleSearchLoad() {
    this.clearSearchDebounce();
    this.searchDebounceHandle = globalThis.setTimeout(() => {
      this.searchDebounceHandle = 0;
      void this.load();
    }, SEARCH_DEBOUNCE_MS);
  },

  setArea(value) {
    const normalizedArea = String(value || "").trim() || DEFAULT_AREA;

    if (normalizedArea === this.area) {
      return;
    }

    this.area = normalizedArea;
    this.clearSearchDebounce();
    void this.load();
  },

  setSearch(value) {
    const normalizedSearch = String(value || "");

    if (normalizedSearch === this.search) {
      return;
    }

    this.search = normalizedSearch;
    this.scheduleSearchLoad();
  },

  async refresh() {
    this.clearSearchDebounce();
    await this.load();
  },

  formatGitSummary(git) {
    if (!git) {
      return "No Git checkout";
    }

    if (git.error) {
      return `Git error: ${git.error}`;
    }

    const ref = git.branch || (git.shortCommit ? `detached @ ${git.shortCommit}` : "unknown ref");
    return git.shortCommit ? `${ref} (${git.shortCommit})` : ref;
  },

  formatModuleName(mod) {
    return `${mod.authorId}/${mod.repositoryId}`;
  },

  formatOwner(mod) {
    if (mod.aggregated) {
      const ownerCount = Number(mod.ownerCount) || 0;
      return `${ownerCount} ${formatPlural(ownerCount, "user", "users")}`;
    }

    if (mod.ownerType === "group") {
      return mod.ownerId;
    }

    return mod.ownerId;
  },

  formatOwnerPreview(mod) {
    if (!mod.aggregated || !Array.isArray(mod.ownerPreview) || mod.ownerPreview.length === 0) {
      return "";
    }

    const ownerCount = Number(mod.ownerCount) || mod.ownerPreview.length;
    const remainder = ownerCount - mod.ownerPreview.length;
    const preview = mod.ownerPreview.join(", ");

    if (remainder <= 0) {
      return preview;
    }

    return `${preview} +${remainder}`;
  },

  getOwnerIcon(mod) {
    if (mod.aggregated || mod.ownerType === "user-aggregate") {
      return "groups";
    }

    return mod.ownerType === "group" ? "groups" : "person";
  },

  getRepositoryUrl(mod) {
    return toRepositoryBrowserUrl(mod?.git?.remoteUrl || "");
  },

  canOpenRepository(mod) {
    return Boolean(this.getRepositoryUrl(mod));
  },

  canOpenFileBrowser() {
    return false;
  },

  canRemove(mod) {
    return Boolean(!mod.aggregated && mod.path && mod.canWrite && !this.isRemoving(mod));
  },

  isRemoving(mod) {
    return this.pendingRemovals[mod.id] === true;
  },

  getFileBrowserTitle() {
    return FILE_BROWSER_PLACEHOLDER_TITLE;
  },

  getRemoveTitle(mod) {
    if (this.isRemoving(mod)) {
      return "Removing module...";
    }

    if (mod.aggregated) {
      return "Open a specific user module view before removing aggregated entries.";
    }

    if (!mod.canWrite) {
      return "You do not have write access to this module.";
    }

    return "Remove module";
  },

  getRepositoryTitle(mod) {
    return this.canOpenRepository(mod) ? "Open repository" : "No Git repository remote available.";
  },

  async removeModule(mod) {
    if (!this.canRemove(mod)) {
      return;
    }

    const confirmed = globalThis.confirm(`Remove module ${this.formatModuleName(mod)} from ${mod.path}?`);

    if (!confirmed) {
      return;
    }

    this.pendingRemovals = {
      ...this.pendingRemovals,
      [mod.id]: true
    };
    this.error = null;

    try {
      await space.api.call("module_remove", {
        body: {
          path: mod.path
        },
        method: "POST"
      });

      await this.load();
    } catch (error) {
      this.error = error.message || "Failed to remove module.";
    } finally {
      const nextPendingRemovals = {
        ...this.pendingRemovals
      };

      delete nextPendingRemovals[mod.id];
      this.pendingRemovals = nextPendingRemovals;
    }
  },

  openRepository(mod) {
    const repositoryUrl = this.getRepositoryUrl(mod);

    if (!repositoryUrl) {
      return;
    }

    globalThis.open(repositoryUrl, "_blank", "noopener,noreferrer");
  }
};

const adminModules = space.fw.createStore("adminModules", moduleListModel);

export { adminModules };
