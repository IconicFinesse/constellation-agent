import { createDashboardSpace } from "/modules/_core/spaces/dashboard-actions.js";

globalThis.spacesDashboardTopbarNewSpace = function spacesDashboardTopbarNewSpace() {
  return {
    creating: false,

    async createSpace() {
      if (this.creating) {
        return;
      }

      this.creating = true;

      try {
        await createDashboardSpace();
      } finally {
        this.creating = false;
      }
    }
  };
};
