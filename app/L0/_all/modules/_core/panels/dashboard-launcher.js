import { listPanels } from "/modules/_core/panels/panel-index.js";

function logDashboardPanelsError(context, error) {
  console.error(`[panels-dashboard] ${context}`, error);
}

function buildFallbackHref(routePath) {
  return `#/${String(routePath || "").replace(/^\/?#+\/?/u, "")}`;
}

globalThis.panelsDashboardLauncher = function panelsDashboardLauncher() {
  return {
    entries: [],
    loadErrorText: "",
    loading: false,

    async init() {
      await this.loadPanels();
    },

    get hasEntries() {
      return this.entries.length > 0;
    },

    hrefFor(routePath) {
      return globalThis.space.router?.createHref?.(routePath) || buildFallbackHref(routePath);
    },

    async loadPanels() {
      this.loading = true;
      this.loadErrorText = "";

      try {
        this.entries = await listPanels();
      } catch (error) {
        logDashboardPanelsError("loadPanels failed", error);
        this.loadErrorText = String(error?.message || "Unable to load panels.");
      } finally {
        this.loading = false;
      }
    },

    async openPanel(routePath) {
      if (!routePath) {
        return;
      }

      if (globalThis.space.router?.goTo) {
        await globalThis.space.router.goTo(routePath, {
          scrollMode: "top"
        });
        return;
      }

      globalThis.location.hash = buildFallbackHref(routePath);
    }
  };
};
