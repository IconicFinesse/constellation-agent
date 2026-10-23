import "/modules/_core/spaces/store.js";
import { showToast } from "/modules/_core/visual/chrome/toast.js";

function logDashboardSpacesError(context, error) {
  console.error(`[spaces-dashboard] ${context}`, error);
}

export async function createDashboardSpace(options = {}) {
  try {
    return await globalThis.space.spaces.createSpace(options);
  } catch (error) {
    logDashboardSpacesError("createDashboardSpace failed", error);
    showToast(String(error?.message || "Unable to create a space."), {
      tone: "error"
    });
    throw error;
  }
}
