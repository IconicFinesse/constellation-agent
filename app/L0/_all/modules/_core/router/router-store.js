import { importComponent } from "/modules/_core/framework/js/components.js";
import {
  DEFAULT_ROUTE_PATH,
  parseRouteTarget
} from "/modules/_core/router/route-path.js";

const SCROLL_STORAGE_KEY = "space.router.scrollPositions";
let routerMagicRegistered = false;

function loadScrollPositions() {
  try {
    const rawValue = globalThis.sessionStorage?.getItem(SCROLL_STORAGE_KEY);
    const parsed = rawValue ? JSON.parse(rawValue) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistScrollPositions(scrollPositions) {
  try {
    globalThis.sessionStorage?.setItem(
      SCROLL_STORAGE_KEY,
      JSON.stringify(scrollPositions || {})
    );
  } catch {
    // Ignore storage failures and keep routing live.
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const parseHashLocation = globalThis.space.extend(
  import.meta,
  async function parseHashLocation(hash, options = {}) {
    return parseRouteTarget(hash, options);
  }
);

const rememberRouteScrollPosition = globalThis.space.extend(
  import.meta,
  async function rememberRouteScrollPosition(store, routeKey = store.current?.key) {
    if (!routeKey || !store.refs.viewport) {
      return;
    }

    store.scrollPositions[routeKey] = Math.max(store.refs.viewport.scrollTop || 0, 0);
    persistScrollPositions(store.scrollPositions);
  }
);

const loadRouteComponent = globalThis.space.extend(
  import.meta,
  async function loadRouteComponent(store, route, loadId) {
    if (!store.refs.outlet) {
      return null;
    }

    const mount = document.createElement("div");
    mount.className = "router-route-mount";
    mount.dataset.routeKey = route.key;
    mount.dataset.routePath = route.path;
    store.refs.outlet.replaceChildren(mount);

    await importComponent(route.viewPath, mount);

    if (loadId !== store.loadId) {
      mount.remove();
      return null;
    }

    return mount;
  }
);

const restoreRouteScrollPosition = globalThis.space.extend(
  import.meta,
  async function restoreRouteScrollPosition(store, routeKey = store.current?.key, options = {}) {
    const viewport = store.refs.viewport;

    if (!viewport) {
      return;
    }

    await new Promise((resolve) => requestAnimationFrame(resolve));

    if (options.scrollTo) {
      store.scrollToElement(options.scrollTo, options.scrollOptions);
      return;
    }

    const savedTop = Number(store.scrollPositions[routeKey]);
    const top =
      options.mode === "top"
        ? 0
        : Number.isFinite(savedTop)
          ? savedTop
          : 0;

    viewport.scrollTo({
      behavior: options.behavior || "auto",
      top
    });
  }
);

const syncCurrentRoute = globalThis.space.extend(
  import.meta,
  async function syncCurrentRoute(store, options = {}) {
    const route = await parseHashLocation(globalThis.location.hash, {
      defaultPath: store.defaultPath
    });
    const loadId = ++store.loadId;

    store.error = "";
    store.loading = true;
    store.current = route;
    if (store.refs.viewport) {
      store.refs.viewport.dataset.routePath = route.path;
    }
    if (store.refs.stageInner) {
      store.refs.stageInner.dataset.routePath = route.path;
    }

    try {
      await loadRouteComponent(store, route, loadId);

      if (loadId !== store.loadId) {
        return;
      }

      await restoreRouteScrollPosition(store, route.key, {
        mode: options.scrollMode || "auto",
        scrollOptions: options.scrollOptions,
        scrollTo: options.scrollTo
      });
    } catch (error) {
      if (loadId !== store.loadId) {
        return;
      }

      console.error("[router] route load failed", {
        error,
        route
      });
      store.error = error instanceof Error ? error.message : String(error || "Unknown route error");
      store.renderRouteError(route, store.error);
      await restoreRouteScrollPosition(store, route.key, { mode: "top" });
    } finally {
      if (loadId === store.loadId) {
        store.loading = false;
      }
    }
  }
);

const goToRoute = globalThis.space.extend(
  import.meta,
  "router/goTo",
  async function goToRoute(store, target, options = {}) {
    await rememberRouteScrollPosition(store, store.current?.key);

    const nextTarget = store.buildTarget(target, options);

    if (nextTarget.hash === globalThis.location.hash) {
      await syncCurrentRoute(store, {
        scrollMode: options.scrollMode || "auto",
        scrollOptions: options.scrollOptions,
        scrollTo: options.scrollTo
      });
      return;
    }

    if (options.replace === true) {
      globalThis.location.replace(nextTarget.href);
      return;
    }

    globalThis.location.hash = nextTarget.hash;
  }
);

const goBackRoute = globalThis.space.extend(
  import.meta,
  "router/back",
  async function goBackRoute(store, fallback = store.defaultPath) {
    await rememberRouteScrollPosition(store, store.current?.key);

    if (globalThis.history.length > 1) {
      globalThis.history.back();
      return;
    }

    await store.replaceTo(fallback, { scrollMode: "auto" });
  }
);

const scrollToElementRoute = globalThis.space.extend(
  import.meta,
  "router/scrollToElement",
  async function scrollToElementRoute(store, target, options = {}) {
    if (!target) {
      return;
    }

    const escapedTarget =
      typeof target === "string" && globalThis.CSS && typeof globalThis.CSS.escape === "function"
        ? globalThis.CSS.escape(target)
        : String(target || "");
    const selector =
      typeof target === "string" && /^([#.[])/u.test(target)
        ? target
        : typeof target === "string"
          ? `[data-route-id="${escapedTarget}"], #${escapedTarget}`
          : "";
    const element =
      typeof target === "string"
        ? store.refs.outlet?.querySelector(selector)
        : target;

    element?.scrollIntoView({
      behavior: options.behavior || "smooth",
      block: options.block || "start",
      inline: options.inline || "nearest"
    });
  }
);

const model = {
  current: parseRouteTarget("", { defaultPath: DEFAULT_ROUTE_PATH }),
  defaultPath: DEFAULT_ROUTE_PATH,
  error: "",
  handleHashChangeBound: null,
  handlePageHideBound: null,
  loadId: 0,
  loading: false,
  previousScrollRestoration: "",
  refs: {},
  scrollPositions: loadScrollPositions(),

  mount(refs = {}) {
    this.refs = refs;
    this.handleHashChangeBound = () => {
      void this.handleHashChange();
    };
    this.handlePageHideBound = () => {
      void rememberRouteScrollPosition(this);
    };

    if ("scrollRestoration" in globalThis.history) {
      this.previousScrollRestoration = globalThis.history.scrollRestoration;
      globalThis.history.scrollRestoration = "manual";
    }

    globalThis.addEventListener("hashchange", this.handleHashChangeBound);
    globalThis.addEventListener("pagehide", this.handlePageHideBound);

    globalThis.space.router = this;

    if (!parseRouteTarget(globalThis.location.hash, { defaultPath: this.defaultPath }).explicit) {
      void this.replaceTo(this.defaultPath, { scrollMode: "top" });
      return;
    }

    void syncCurrentRoute(this, { scrollMode: "auto" });
  },

  unmount() {
    void rememberRouteScrollPosition(this);

    if (this.handleHashChangeBound) {
      globalThis.removeEventListener("hashchange", this.handleHashChangeBound);
    }

    if (this.handlePageHideBound) {
      globalThis.removeEventListener("pagehide", this.handlePageHideBound);
    }

    if ("scrollRestoration" in globalThis.history && this.previousScrollRestoration) {
      globalThis.history.scrollRestoration = this.previousScrollRestoration;
    }

    this.handleHashChangeBound = null;
    this.handlePageHideBound = null;

    if (this.refs.stageInner) {
      delete this.refs.stageInner.dataset.routePath;
    }

    if (this.refs.viewport) {
      delete this.refs.viewport.dataset.routePath;
    }

    this.refs = {};
  },

  async handleHashChange() {
    await rememberRouteScrollPosition(this, this.current?.key);
    await syncCurrentRoute(this, { scrollMode: "auto" });
  },

  buildTarget(target, options = {}) {
    const targetObject =
      target && typeof target === "object" && !Array.isArray(target)
        ? target
        : { path: target };

    return parseRouteTarget(targetObject, {
      defaultPath: this.defaultPath,
      params: options.params
    });
  },

  createHref(target, options = {}) {
    return this.buildTarget(target, options).href;
  },

  async goTo(target, options = {}) {
    await goToRoute(this, target, options);
  },

  async replaceTo(target, options = {}) {
    await this.goTo(target, {
      ...options,
      replace: true
    });
  },

  async back(fallback = this.defaultPath) {
    await goBackRoute(this, fallback);
  },

  async goBack(fallback = this.defaultPath) {
    await this.back(fallback);
  },

  getParam(name, fallback = "") {
    return this.current.params?.[name] ?? fallback;
  },

  scrollTo(top = 0, options = {}) {
    this.refs.viewport?.scrollTo({
      behavior: options.behavior || "smooth",
      top: Number.isFinite(top) ? top : 0
    });
  },

  scrollToTop(options = {}) {
    this.scrollTo(0, options);
  },

  scrollToElement(target, options = {}) {
    void scrollToElementRoute(this, target, options);
  },

  renderRouteError(route, message) {
    if (!this.refs.outlet) {
      return;
    }

    const safeMessage = escapeHtml(message);
    const safePath = escapeHtml(route.path);
    const safeViewPath = escapeHtml(route.viewPath);

    this.refs.outlet.innerHTML = `
      <section class="space-panel router-route-state">
        <div class="space-card space-info-card space-card--warning">
          <p><x-icon>error</x-icon> ${safeMessage}</p>
          <p>Resolved route: <code>${safePath}</code></p>
          <p>Resolved view: <code>${safeViewPath}</code></p>
        </div>
      </section>
    `;
  }
};

const router = space.fw.createStore("router", model);

function registerRouterMagic() {
  const register = () => {
    if (!globalThis.Alpine || routerMagicRegistered) {
      return;
    }

    globalThis.Alpine.magic("router", () => router);
    routerMagicRegistered = true;
  };

  if (globalThis.Alpine) {
    register();
    return;
  }

  document.addEventListener("alpine:init", register, { once: true });
}

registerRouterMagic();
globalThis.space.router = router;

export { router };
