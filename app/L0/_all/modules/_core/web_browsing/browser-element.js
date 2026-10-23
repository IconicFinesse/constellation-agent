const X_BROWSER_TAG_NAME = "x-browser";
const BROWSER_FRAME_TITLE_PREFIX = "Browser frame";

function normalizeAttributeText(value) {
  return String(value ?? "").trim();
}

function parseBooleanAttribute(element, name) {
  if (!element?.hasAttribute?.(name)) {
    return false;
  }

  const value = normalizeAttributeText(element.getAttribute(name)).toLowerCase();
  return value !== "false" && value !== "0" && value !== "no" && value !== "off";
}

function createIcon(name) {
  const icon = document.createElement("x-icon");
  icon.textContent = name;
  return icon;
}

function createToolbarButton(iconName, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "space-browser-nav-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.appendChild(createIcon(iconName));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function getStore(storeProvider) {
  return typeof storeProvider === "function" ? storeProvider() : null;
}

function isWebviewSurface(store) {
  return Boolean(store?.usesDesktopWebviewSurface);
}

function isNativeSurface(store) {
  return Boolean(store?.usesNativeDesktopSurface);
}

export function defineBrowserElement(storeProvider) {
  if (
    typeof globalThis.customElements === "undefined" ||
    typeof globalThis.HTMLElement === "undefined" ||
    globalThis.customElements.get(X_BROWSER_TAG_NAME)
  ) {
    return;
  }

  class SpaceBrowserElement extends HTMLElement {
    static get observedAttributes() {
      return ["controls", "src", "data-browser-id"];
    }

    connectedCallback() {
      this.__spaceBrowserConnected = true;
      this.classList.add("space-browser");
      this.setupBrowserSurface();
    }

    disconnectedCallback() {
      this.__spaceBrowserConnected = false;
      const store = getStore(storeProvider);
      store?.unregisterBrowserElement?.(this);
      this.cleanupRenderedSurface();
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (!this.__spaceBrowserConnected || oldValue === newValue) {
        return;
      }

      if (name === "controls") {
        this.syncToolbar();
        return;
      }

      if (name === "src") {
        getStore(storeProvider)?.updateBrowserElementSource?.(this, newValue);
        return;
      }

      if (name === "data-browser-id") {
        this.setupBrowserSurface({ force: true });
      }
    }

    get browserId() {
      return normalizeAttributeText(this.dataset?.browserId || this.getAttribute("data-browser-id"));
    }

    setupBrowserSurface(options = {}) {
      const store = getStore(storeProvider);
      if (!store || typeof store.registerBrowserElement !== "function") {
        return;
      }

      const browser = store.registerBrowserElement(this, {
        force: options.force === true,
        src: this.getAttribute("src")
      });
      if (!browser?.id) {
        return;
      }

      this.__spaceBrowserId = browser.id;
      this.syncStructure(browser);
      this.updateBrowserState(browser);
    }

    cleanupRenderedSurface() {
      const store = getStore(storeProvider);
      const browserId = this.__spaceBrowserId || this.browserId;

      if (this.__spaceBrowserIframe) {
        store?.unregisterIframe?.(browserId, this.__spaceBrowserIframe);
      }

      if (this.__spaceBrowserWebview) {
        store?.unregisterWebview?.(browserId, this.__spaceBrowserWebview);
      }

      if (this.__spaceBrowserMode === "native") {
        store?.unregisterBrowserSurface?.(browserId, this);
      }

      this.__spaceBrowserIframe = null;
      this.__spaceBrowserWebview = null;
      this.__spaceBrowserNativeId = "";
      this.__spaceBrowserMode = "";
    }

    syncStructure(browser = null) {
      const store = getStore(storeProvider);
      const browserState = browser || store?.getBrowser?.(this.browserId);
      if (!browserState?.id) {
        return;
      }

      this.syncToolbar();

      if (!this.__spaceBrowserFrameShell?.isConnected || this.__spaceBrowserFrameShell.parentElement !== this) {
        this.__spaceBrowserFrameShell = document.createElement("div");
        this.__spaceBrowserFrameShell.className = "space-browser-frame-shell";
        this.appendChild(this.__spaceBrowserFrameShell);
      }

      this.syncFrame(browserState);
    }

    syncToolbar() {
      const controlsEnabled = parseBooleanAttribute(this, "controls");
      this.classList.toggle("has-controls", controlsEnabled);

      if (!controlsEnabled) {
        this.__spaceBrowserToolbar?.remove();
        this.__spaceBrowserToolbar = null;
        this.__spaceBrowserAddressInput = null;
        this.__spaceBrowserBackButton = null;
        this.__spaceBrowserForwardButton = null;
        return;
      }

      if (this.__spaceBrowserToolbar?.isConnected && this.__spaceBrowserToolbar.parentElement === this) {
        return;
      }

      const toolbar = document.createElement("form");
      toolbar.className = "space-browser-toolbar";
      toolbar.setAttribute("aria-label", "Browser controls");

      const actions = document.createElement("div");
      actions.className = "space-browser-toolbar-actions";

      const backButton = createToolbarButton("arrow_back", "Back", () => {
        const store = getStore(storeProvider);
        const browserId = this.browserId;
        if (browserId) {
          void store?.goBack?.(browserId);
        }
      });
      const forwardButton = createToolbarButton("arrow_forward", "Forward", () => {
        const store = getStore(storeProvider);
        const browserId = this.browserId;
        if (browserId) {
          void store?.goForward?.(browserId);
        }
      });
      const reloadButton = createToolbarButton("refresh", "Reload", () => {
        const store = getStore(storeProvider);
        const browserId = this.browserId;
        if (browserId) {
          void store?.reloadFrame?.(browserId);
        }
      });

      const addressInput = document.createElement("input");
      addressInput.type = "text";
      addressInput.className = "space-browser-address-field";
      addressInput.setAttribute("aria-label", "Browser address");
      addressInput.autocapitalize = "off";
      addressInput.autocomplete = "off";
      addressInput.autocorrect = "off";
      addressInput.spellcheck = false;
      addressInput.addEventListener("input", () => {
        const browserId = this.browserId;
        if (browserId) {
          getStore(storeProvider)?.updateAddressValue?.(browserId, addressInput.value);
        }
      });

      toolbar.addEventListener("submit", (event) => {
        event.preventDefault();
        const browserId = this.browserId;
        if (browserId) {
          void getStore(storeProvider)?.navigateToAddress?.(browserId);
        }
      });

      actions.append(backButton, forwardButton, reloadButton);
      toolbar.append(actions, addressInput);
      this.insertBefore(toolbar, this.firstChild);

      this.__spaceBrowserToolbar = toolbar;
      this.__spaceBrowserAddressInput = addressInput;
      this.__spaceBrowserBackButton = backButton;
      this.__spaceBrowserForwardButton = forwardButton;

      const browser = getStore(storeProvider)?.getBrowser?.(this.browserId);
      this.updateBrowserState(browser);
    }

    syncFrame(browser) {
      const store = getStore(storeProvider);
      const frameShell = this.__spaceBrowserFrameShell;
      if (!store || !frameShell || !browser?.id) {
        return;
      }

      const nextMode = isWebviewSurface(store)
        ? "webview"
        : isNativeSurface(store)
          ? "native"
          : "iframe";

      if (this.__spaceBrowserMode === nextMode) {
        const currentFrame = frameShell.querySelector?.("webview, iframe");
        if (nextMode === "native" && this.__spaceBrowserNativeId === browser.id) {
          return;
        }

        if (currentFrame?.id === browser.id) {
          return;
        }
      }

      this.cleanupRenderedSurface();
      frameShell.replaceChildren();
      this.__spaceBrowserMode = nextMode;

      if (nextMode === "native") {
        this.__spaceBrowserNativeId = browser.id;
        store.registerBrowserSurface(browser.id, this);
        return;
      }

      if (nextMode === "webview") {
        const webview = document.createElement("webview");
        webview.id = browser.id;
        webview.setAttribute("partition", store.webviewPartition(browser.id));
        webview.className = "space-browser-frame space-browser-webview";
        frameShell.appendChild(webview);
        this.__spaceBrowserWebview = webview;
        store.registerWebview(browser.id, webview, browser.frameSrc);
        return;
      }

      const iframe = document.createElement("iframe");
      iframe.id = browser.id;
      iframe.name = browser.id;
      iframe.className = "space-browser-frame";
      iframe.title = `${BROWSER_FRAME_TITLE_PREFIX} ${browser.id}`;
      iframe.src = browser.frameSrc;
      iframe.setAttribute("data-space-inject", "/modules/_core/web_browsing/browser-frame-inject.js");
      iframe.addEventListener("load", (event) => {
        store.handleFrameLoad(browser.id, event);
      });
      frameShell.appendChild(iframe);
      this.__spaceBrowserIframe = iframe;
      store.registerIframe(browser.id, iframe);
    }

    updateBrowserState(browser = null) {
      const store = getStore(storeProvider);
      const browserState = browser || store?.getBrowser?.(this.browserId);
      if (!browserState) {
        return;
      }

      if (this.__spaceBrowserAddressInput && document.activeElement !== this.__spaceBrowserAddressInput) {
        this.__spaceBrowserAddressInput.value = browserState.addressValue || browserState.currentUrl || browserState.frameSrc || "";
      }

      if (this.__spaceBrowserBackButton) {
        this.__spaceBrowserBackButton.disabled = Boolean(browserState.bridgeStateReady && !browserState.canGoBack);
      }

      if (this.__spaceBrowserForwardButton) {
        this.__spaceBrowserForwardButton.disabled = Boolean(browserState.bridgeStateReady && !browserState.canGoForward);
      }
    }
  }

  globalThis.customElements.define(X_BROWSER_TAG_NAME, SpaceBrowserElement);
}
