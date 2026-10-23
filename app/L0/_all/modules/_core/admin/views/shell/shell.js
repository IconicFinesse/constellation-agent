const HORIZONTAL_LAYOUT = "horizontal";
const VERTICAL_LAYOUT = "vertical";
const DEFAULT_MAIN_FRAME_URL = "/index.html";

function resolveRequestedMainFrameUrl(locationObject = globalThis.window?.location) {
  if (!locationObject) {
    return DEFAULT_MAIN_FRAME_URL;
  }

  const requestedUrl = new URLSearchParams(locationObject.search || "").get("url");

  if (!requestedUrl) {
    return DEFAULT_MAIN_FRAME_URL;
  }

  try {
    const resolvedUrl = new URL(requestedUrl, locationObject.href);

    if (resolvedUrl.origin !== locationObject.origin) {
      return DEFAULT_MAIN_FRAME_URL;
    }

    return `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}` || DEFAULT_MAIN_FRAME_URL;
  } catch {
    return DEFAULT_MAIN_FRAME_URL;
  }
}

const shellModel = {
  dragPointerId: null,
  dragging: false,
  layout: HORIZONTAL_LAYOUT,
  mainFrameUrl: resolveRequestedMainFrameUrl(),
  portraitQuery: null,
  refs: {},
  splitRatios: {
    [HORIZONTAL_LAYOUT]: 0.34,
    [VERTICAL_LAYOUT]: 0.32
  },
  syncLayoutHandler: null,

  mount(refs = {}) {
    this.refs = refs;
    this.portraitQuery = window.matchMedia("(orientation: portrait)");
    this.syncLayoutHandler = () => this.syncLayout();

    window.addEventListener("resize", this.syncLayoutHandler);

    if (typeof this.portraitQuery.addEventListener === "function") {
      this.portraitQuery.addEventListener("change", this.syncLayoutHandler);
    } else if (typeof this.portraitQuery.addListener === "function") {
      this.portraitQuery.addListener(this.syncLayoutHandler);
    }

    this.syncLayout();
  },

  unmount() {
    this.stopDrag();

    if (this.syncLayoutHandler) {
      window.removeEventListener("resize", this.syncLayoutHandler);
    }

    if (this.portraitQuery) {
      if (typeof this.portraitQuery.removeEventListener === "function") {
        this.portraitQuery.removeEventListener("change", this.syncLayoutHandler);
      } else if (typeof this.portraitQuery.removeListener === "function") {
        this.portraitQuery.removeListener(this.syncLayoutHandler);
      }
    }

    this.syncLayoutHandler = null;
    this.portraitQuery = null;
    this.refs = {};
  },

  getMainFrameUrl() {
    const frame = this.refs.mainFrame;

    if (!frame) {
      return null;
    }

    try {
      const href = frame.contentWindow?.location?.href;

      if (typeof href === "string" && href.length > 0 && href !== "about:blank") {
        return href;
      }
    } catch {
      // Ignore iframe access failures and fall back to the configured src.
    }

    const frameSrc = frame.getAttribute("src") || frame.src;

    if (typeof frameSrc !== "string" || frameSrc.length === 0) {
      return null;
    }

    return new URL(frameSrc, globalThis.window.location.href).href;
  },

  leaveAdminArea() {
    const targetUrl = this.getMainFrameUrl() || new URL(this.mainFrameUrl || DEFAULT_MAIN_FRAME_URL, globalThis.window.location.href).href;
    globalThis.window.location.assign(targetUrl);
  },

  getLayout() {
    return this.portraitQuery?.matches ? VERTICAL_LAYOUT : HORIZONTAL_LAYOUT;
  },

  getAxisSize() {
    return this.getLayout() === HORIZONTAL_LAYOUT ? window.innerWidth : window.innerHeight;
  },

  getMinPaneSize() {
    return this.getLayout() === HORIZONTAL_LAYOUT ? 300 : 240;
  },

  getMaxSplitSize() {
    const axisSize = this.getAxisSize();
    const minPaneSize = this.getMinPaneSize();
    return Math.max(minPaneSize, axisSize - minPaneSize - 12);
  },

  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },

  getCurrentSplitSize() {
    const currentSize = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--split-size")
    );

    if (Number.isFinite(currentSize) && currentSize > 0) {
      return currentSize;
    }

    return this.getAxisSize() * (this.splitRatios[this.layout] || 0.34);
  },

  applySplitSize(size) {
    const axisSize = Math.max(this.getAxisSize(), 1);
    const nextSize = this.clamp(size, this.getMinPaneSize(), this.getMaxSplitSize());

    document.documentElement.style.setProperty("--split-size", `${nextSize}px`);
    this.splitRatios[this.layout] = nextSize / axisSize;
  },

  syncLayout() {
    this.layout = this.getLayout();
    document.documentElement.dataset.layout = this.layout;

    const ratio = this.splitRatios[this.layout] || (this.layout === HORIZONTAL_LAYOUT ? 0.34 : 0.32);
    this.applySplitSize(this.getAxisSize() * ratio);
  },

  startDrag(event) {
    this.dragging = true;
    this.dragPointerId = typeof event.pointerId === "number" ? event.pointerId : null;
    document.body.dataset.dragging = "true";
    event.target.setPointerCapture?.(event.pointerId);
  },

  handlePointerMove(event) {
    if (!this.dragging) {
      return;
    }

    const nextSize = this.layout === HORIZONTAL_LAYOUT ? event.clientX : event.clientY;
    this.applySplitSize(nextSize);
  },

  stopDrag(event) {
    if (!this.dragging) {
      return;
    }

    if (event && this.dragPointerId !== null && event.pointerId !== this.dragPointerId) {
      return;
    }

    this.dragging = false;
    this.dragPointerId = null;
    delete document.body.dataset.dragging;
  },

  nudge(sizeDelta) {
    this.applySplitSize(this.getCurrentSplitSize() + sizeDelta);
  }
};

const adminShell = space.fw.createStore("adminShell", shellModel);

export { adminShell };
