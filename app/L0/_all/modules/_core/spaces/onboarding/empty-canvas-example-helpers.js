const ONBOARDING_EXAMPLE_WIDGETS_BASE_URL = new URL(
  "/modules/_core/spaces/onboarding/examples/",
  globalThis.location?.href || "http://localhost/"
).href;

export function getSpaceRuntime() {
  const runtime = globalThis.space;

  if (!runtime || typeof runtime !== "object") {
    throw new Error("Space runtime is not available.");
  }

  return runtime;
}

export function getRuntime() {
  return getSpaceRuntime();
}

export function getSpacesRuntime() {
  const runtime = getSpaceRuntime();

  if (!runtime.spaces || typeof runtime.spaces !== "object") {
    throw new Error("space.spaces runtime is not available.");
  }

  return runtime.spaces;
}

export function getOnscreenAgentRuntime() {
  const runtime = getSpaceRuntime();

  if (
    !runtime.onscreenAgent ||
    typeof runtime.onscreenAgent !== "object" ||
    typeof runtime.onscreenAgent.submitExamplePrompt !== "function"
  ) {
    throw new Error("space.onscreenAgent.submitExamplePrompt(...) is not available.");
  }

  return runtime.onscreenAgent;
}

export async function repositionCurrentSpace(options = {}) {
  const spacesRuntime = getSpacesRuntime();

  if (typeof spacesRuntime.repositionCurrentSpace !== "function") {
    return null;
  }

  return spacesRuntime.repositionCurrentSpace(options);
}

export async function submitPrompt(promptText, options = {}) {
  return getOnscreenAgentRuntime().submitExamplePrompt(promptText, options);
}

export async function sendPrompt(promptText, options = {}) {
  return submitPrompt(promptText, options);
}

function buildOnboardingExampleWidgetMetadata(options = {}) {
  const inputMetadata =
    options &&
    typeof (options.metadata ?? options.meta) === "object" &&
    (options.metadata ?? options.meta) &&
    !Array.isArray(options.metadata ?? options.meta)
      ? (options.metadata ?? options.meta)
      : {};

  return {
    ...inputMetadata,
    example: true
  };
}

function normalizeOnboardingExampleWidgetFileName(fileName) {
  const normalizedFileName = String(fileName ?? "")
    .replace(/\\/gu, "/")
    .trim()
    .replace(/^\/+|\/+$/gu, "");

  if (!normalizedFileName) {
    throw new Error(`Invalid onboarding example widget file name "${fileName}".`);
  }

  const pathSegments = normalizedFileName.split("/");

  if (
    !pathSegments.length ||
    pathSegments.some(
      (segment, index) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !/^[a-z0-9][a-z0-9._-]*$/iu.test(segment) ||
        (index === pathSegments.length - 1 && !segment.endsWith(".yaml"))
    )
  ) {
    throw new Error(`Invalid onboarding example widget file name "${fileName}".`);
  }

  return pathSegments.join("/");
}

export function resolveOnboardingExampleWidgetUrl(fileName) {
  const normalizedFileName = normalizeOnboardingExampleWidgetFileName(fileName);
  return new URL(normalizedFileName, ONBOARDING_EXAMPLE_WIDGETS_BASE_URL).href;
}

export async function loadOnboardingExampleWidgetSource(fileName) {
  const normalizedFileName = normalizeOnboardingExampleWidgetFileName(fileName);
  const response = await fetch(resolveOnboardingExampleWidgetUrl(normalizedFileName), {
    credentials: "same-origin"
  });

  if (!response.ok) {
    throw new Error(
      `Unable to read onboarding example widget "${normalizedFileName}": ${response.status} ${response.statusText}`
    );
  }

  return response.text();
}

export async function loadOnboardingExampleWidgetSources(fileNames) {
  const normalizedFileNames = Array.isArray(fileNames) ? fileNames : [fileNames];

  if (!normalizedFileNames.length) {
    throw new Error("At least one onboarding example widget file name is required.");
  }

  return Promise.all(
    normalizedFileNames.map(async (fileName) => ({
      fileName: normalizeOnboardingExampleWidgetFileName(fileName),
      source: await loadOnboardingExampleWidgetSource(fileName)
    }))
  );
}

export async function installOnboardingExampleWidget(fileName, options = {}) {
  const runtime = getSpaceRuntime();
  const spacesRuntime = getSpacesRuntime();
  const upsertOptions = { ...options };
  const refreshAfterInstall = upsertOptions.refresh !== false;
  const repositionAfterInstall = upsertOptions.reposition !== false && refreshAfterInstall;
  const currentSpaceId = String(runtime.current?.id || "").trim();
  const targetSpaceId = String(upsertOptions.spaceId || currentSpaceId || "").trim();

  delete upsertOptions.refresh;
  delete upsertOptions.reposition;

  if (typeof spacesRuntime.upsertWidget !== "function") {
    throw new Error("space.spaces.upsertWidget(...) is not available.");
  }

  const source = await loadOnboardingExampleWidgetSource(fileName);
  return spacesRuntime.upsertWidget({
    ...upsertOptions,
    ...(targetSpaceId ? { spaceId: targetSpaceId } : {}),
    refresh: refreshAfterInstall,
    resetCamera: Boolean(repositionAfterInstall && currentSpaceId && targetSpaceId === currentSpaceId),
    metadata: buildOnboardingExampleWidgetMetadata(upsertOptions),
    source
  });
}

export async function installOnboardingExampleWidgets(fileNames, options = {}) {
  const widgetEntries = await loadOnboardingExampleWidgetSources(fileNames);
  const runtime = getSpaceRuntime();
  const spacesRuntime = getSpacesRuntime();
  const refreshAfterInstall = options.refresh !== false;
  const repositionAfterInstall = options.reposition !== false && refreshAfterInstall;
  const upsertOptions = { ...options };
  const currentSpaceId = String(runtime.current?.id || "").trim();
  const targetSpaceId = String(upsertOptions.spaceId || currentSpaceId || "").trim();

  delete upsertOptions.refresh;
  delete upsertOptions.reposition;

  if (typeof spacesRuntime.upsertWidgets !== "function") {
    throw new Error("space.spaces.upsertWidgets(...) is not available.");
  }

  const installResult = await spacesRuntime.upsertWidgets({
    ...upsertOptions,
    refresh: refreshAfterInstall,
    resetCamera: Boolean(repositionAfterInstall && currentSpaceId && targetSpaceId === currentSpaceId),
    spaceId: targetSpaceId,
    widgets: widgetEntries.map((entry) => ({
      ...upsertOptions,
      metadata: buildOnboardingExampleWidgetMetadata(upsertOptions),
      source: entry.source
    }))
  });

  return Array.isArray(installResult?.widgetResults) ? installResult.widgetResults : [];
}
