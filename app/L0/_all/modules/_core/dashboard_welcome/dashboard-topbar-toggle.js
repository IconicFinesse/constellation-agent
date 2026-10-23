import { showToast } from "/modules/_core/visual/chrome/toast.js";
import {
  loadDashboardPrefs,
  setDashboardWelcomeHidden,
  subscribeDashboardWelcomeHiddenChange
} from "/modules/_core/dashboard_welcome/dashboard-prefs.js";

function logDashboardWelcomeError(context, error) {
  console.error(`[dashboard-welcome] ${context}`, error);
}

globalThis.dashboardWelcomeTopbarToggle = function dashboardWelcomeTopbarToggle() {
  return {
    dashboardWelcomeHiddenChangeCleanup: null,
    hidden: false,
    ready: false,
    savingPreference: false,

    async init() {
      this.dashboardWelcomeHiddenChangeCleanup = subscribeDashboardWelcomeHiddenChange((nextHidden) => {
        this.hidden = nextHidden;
      });

      try {
        const prefs = await loadDashboardPrefs();
        this.hidden = prefs.welcomeHidden;
      } catch (error) {
        logDashboardWelcomeError("topbar toggle init failed", error);
        showToast(String(error?.message || "Unable to load the dashboard welcome setting."), {
          tone: "error"
        });
      } finally {
        this.ready = true;
      }
    },

    destroy() {
      if (typeof this.dashboardWelcomeHiddenChangeCleanup === "function") {
        this.dashboardWelcomeHiddenChangeCleanup();
      }

      this.dashboardWelcomeHiddenChangeCleanup = null;
    },

    async showWelcome() {
      if (this.savingPreference || !this.hidden) {
        return;
      }

      this.savingPreference = true;

      try {
        await setDashboardWelcomeHidden(false);
        this.hidden = false;
      } catch (error) {
        logDashboardWelcomeError("topbar toggle showWelcome failed", error);
        showToast(String(error?.message || "Unable to save that setting."), {
          tone: "error"
        });
      } finally {
        this.savingPreference = false;
      }
    }
  };
};
