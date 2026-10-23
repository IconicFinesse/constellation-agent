import {
  listPanels as listIndexedPanels,
  normalizePanelRoutePath
} from "/modules/_core/panels/panel-index.js";

function normalizeLookupText(value) {
  return String(value ?? "")
    .trim()
    .replace(/^#\/?/u, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function getRouter() {
  const router = globalThis.space?.router;

  if (!router || typeof router !== "object") {
    return null;
  }

  return router;
}

function createHrefForRoutePath(routePath) {
  const router = getRouter();

  if (router?.createHref) {
    return router.createHref(routePath);
  }

  return `#/${routePath}`;
}

function withPanelHref(panel) {
  return {
    ...panel,
    href: createHrefForRoutePath(panel.routePath)
  };
}

function toRoutePath(target) {
  if (target && typeof target === "object" && !Array.isArray(target)) {
    return normalizePanelRoutePath(
      target.routePath ?? target.path ?? target.href ?? target.hash
    );
  }

  return normalizePanelRoutePath(target);
}

export async function listPanels() {
  const panels = await listIndexedPanels();
  return panels.map(withPanelHref);
}

export async function findPanel(target) {
  const panels = await listPanels();
  const routePath = toRoutePath(target);

  if (routePath) {
    const exactRouteMatch = panels.find((panel) => panel.routePath === routePath);

    if (exactRouteMatch) {
      return exactRouteMatch;
    }
  }

  const normalizedTarget = normalizeLookupText(
    target && typeof target === "object" && !Array.isArray(target)
      ? target.name ?? target.title ?? target.routePath ?? target.path
      : target
  );

  if (!normalizedTarget) {
    return null;
  }

  return panels.find((panel) => {
    const normalizedName = normalizeLookupText(panel.name);
    const normalizedRoutePath = normalizeLookupText(panel.routePath);
    const normalizedHref = normalizeLookupText(panel.href);
    const normalizedModulePath = normalizeLookupText(panel.modulePath);

    return (
      normalizedName === normalizedTarget ||
      normalizedRoutePath === normalizedTarget ||
      normalizedHref === normalizedTarget ||
      normalizedModulePath === normalizedTarget
    );
  }) || null;
}

export async function resolvePanelRoutePath(target) {
  const panel = await findPanel(target);
  const routePath = panel?.routePath || toRoutePath(target);

  if (!routePath) {
    throw new Error(`Unable to resolve panel target: ${String(target ?? "")}`);
  }

  return routePath;
}

export async function createPanelHref(target) {
  const panel = await findPanel(target);

  if (panel?.href) {
    return panel.href;
  }

  return createHrefForRoutePath(await resolvePanelRoutePath(target));
}

export async function goToPanel(target, options = {}) {
  const panel = await findPanel(target);
  const routePath = panel?.routePath || await resolvePanelRoutePath(target);

  const router = getRouter();

  if (router?.goTo) {
    await router.goTo(routePath, {
      scrollMode: "top",
      ...options
    });
    return panel || { routePath };
  }

  globalThis.location.hash = `#/${routePath}`;
  return panel || { routePath };
}

export const navigateToPanel = goToPanel;
export const openPanel = goToPanel;
