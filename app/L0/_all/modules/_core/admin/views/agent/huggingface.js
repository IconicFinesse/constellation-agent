export function mapManagerStateToAdminState(snapshot = {}) {
  return {
    activeDtype: String(snapshot.activeDtype || ""),
    activeModelId: String(snapshot.activeModelId || ""),
    error: String(snapshot.error || ""),
    isLoadingModel: snapshot.isLoadingModel === true,
    isWorkerBooting: snapshot.isWorkerBooting === true,
    isWorkerReady: snapshot.isWorkerReady === true,
    loadProgress: {
      progress: Number.isFinite(Number(snapshot.loadProgress?.progress))
        ? Math.max(0, Math.min(1, Number(snapshot.loadProgress.progress)))
        : 0,
      status: String(snapshot.loadProgress?.status || ""),
      stepLabel: String(snapshot.loadProgress?.stepLabel || ""),
      text: String(snapshot.loadProgress?.stepLabel || ""),
      timeElapsed: 0
    },
    loadingModelLabel: String(snapshot.loadingModelLabel || ""),
    savedModels: Array.isArray(snapshot.savedModels) ? [...snapshot.savedModels] : [],
    statusText: String(snapshot.statusText || ""),
    webgpuSupported: snapshot.webgpuSupported !== false
  };
}
