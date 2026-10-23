import "./extensions.js";
import * as initializer from "./initializer.js";
import { initializeRuntime } from "./runtime.js";
import * as _modals from "./modals.js";
import * as _components from "./components.js";
import * as _icons from "./icons.js";
import { registerAlpineMagic } from "./confirmClick.js";
import { HTML_EXTENSION_READY_ATTRIBUTE } from "./extensions.js";

initializeRuntime({
  proxyPath: "/api/proxy"
});

// initialize required elements
await initializer.initialize();

// import alpine library
// @ts-ignore
await import("./alpine.min.js");

const Alpine = globalThis.Alpine;

const warnAlpine = (message, el) => {
  console.warn(`Alpine Warning: ${message}`, el);
};

const insertTeleportNode = (node, target, modifiers = []) => {
  if (modifiers.includes("prepend") && target.parentNode) {
    target.parentNode.insertBefore(node, target);
    return;
  }

  if (modifiers.includes("append") && target.parentNode) {
    target.parentNode.insertBefore(node, target.nextSibling);
    return;
  }

  target.appendChild(node);
};


// add x-destroy directive to alpine
Alpine.directive(
    "destroy",
    (_el, { expression }, { evaluateLater, cleanup }) => {
      const onDestroy = evaluateLater(expression);
      cleanup(() => onDestroy());
    }
  );

  // add x-create directive to alpine
  Alpine.directive(
    "create",
    (_el, { expression }, { evaluateLater }) => {
      const onCreate = evaluateLater(expression);
      onCreate();
    }
  );

  Alpine.directive(
    "inject",
    (el, { modifiers, expression }, { cleanup }) => {
      if (el.tagName.toLowerCase() !== "template") {
        warnAlpine("x-inject can only be used on a <template> tag", el);
        return;
      }

      const selector = typeof expression === "string" ? expression.trim() : "";
      if (!selector) return;

      const injected = el.content.cloneNode(true).firstElementChild;
      if (!injected) return;

      let disposed = false;
      let observer = null;
      let invalidSelector = false;

      el._x_teleport = injected;
      injected._x_teleportBack = el;
      el.setAttribute("data-teleport-template", true);
      injected.setAttribute("data-teleport-target", true);

      if (Array.isArray(el._x_forwardEvents)) {
        el._x_forwardEvents.forEach((eventName) => {
          injected.addEventListener(eventName, (event) => {
            event.stopPropagation();
            el.dispatchEvent(new event.constructor(event.type, event));
          });
        });
      }

      Alpine.addScopeToNode(injected, {}, el);

      const stopObserver = () => {
        if (!observer) return;
        observer.disconnect();
        observer = null;
      };

      const findTarget = () => {
        if (invalidSelector) return null;

        try {
          const target = document.querySelector(selector);
          if (!(target instanceof Element)) {
            return null;
          }

          if (
            target.tagName.toLowerCase() === "x-extension" &&
            target.getAttribute(HTML_EXTENSION_READY_ATTRIBUTE) !== "true"
          ) {
            return null;
          }

          return target;
        } catch (error) {
          invalidSelector = true;
          warnAlpine(`Invalid x-inject selector: "${selector}"`, el);
          console.error(error);
          return null;
        }
      };

      const mountIntoTarget = (target) => {
        if (disposed || !target) return;

        if (injected.parentNode === target) {
          return;
        }

        Alpine.mutateDom(() => {
          insertTeleportNode(injected, target, modifiers);

          if (!injected._x_marker) {
            Alpine.skipDuringClone(() => {
              Alpine.initTree(injected);
            })();
          }
        });
      };

      const reconcileMount = () => {
        const target = findTarget();
        if (!target) return;

        mountIntoTarget(target);
      };

      reconcileMount();

      if (typeof MutationObserver === "function") {
        observer = new MutationObserver(() => {
          if (disposed || !el.isConnected || invalidSelector) {
            stopObserver();
            return;
          }

          reconcileMount();
        });

        observer.observe(document.documentElement, {
          attributeFilter: [HTML_EXTENSION_READY_ATTRIBUTE],
          attributes: true,
          childList: true,
          subtree: true
        });
      }

      el._x_teleportPutBack = () => {
        reconcileMount();
      };

      cleanup(() => {
        disposed = true;
        stopObserver();

        Alpine.mutateDom(() => {
          injected.remove();
          if (injected._x_marker) {
            Alpine.destroyTree(injected);
          }
        });
      });
    }
  ).before("teleport");

  const resolveSelector = (expression, evaluateLater, cb) => {
    if (typeof expression !== "string" || !expression.trim()) return;

    if (/^[\s]*["']/.test(expression)) {
      const getSelector = evaluateLater(expression);
      getSelector((evaluated) => {
        if (typeof evaluated !== "string" || !evaluated.trim()) return;
        cb(evaluated.trim());
      });
      return;
    }

    cb(expression.trim());
  };

  const moveOnNextTick = (el, expression, evaluateLater, fn) => {
    Alpine.nextTick(() => {
      resolveSelector(expression, evaluateLater, (selector) => fn(el, selector));
    });
  };

  Alpine.directive(
    "move-to-start",
    (el, { expression }, { evaluateLater }) => {
      moveOnNextTick(el, expression, evaluateLater, (_el, selector) => {
        const parent = document.querySelector(selector);
        if (!parent) return;
        parent.insertBefore(_el, parent.firstChild);
      });
    }
  );

  Alpine.directive(
    "move-to-end",
    (el, { expression }, { evaluateLater }) => {
      moveOnNextTick(el, expression, evaluateLater, (_el, selector) => {
        const parent = document.querySelector(selector);
        if (!parent) return;
        parent.appendChild(_el);
      });
    }
  );

  Alpine.directive(
    "move-to",
    (el, { expression, modifiers, value }, { evaluateLater }) => {
      const orderModifier = Array.isArray(modifiers)
        ? modifiers.find((m) => /^\d+$/.test(m))
        : null;

      const orderRaw = orderModifier ?? value;
      const order = Number(orderRaw);
      if (!Number.isFinite(order)) return;

      moveOnNextTick(el, expression, evaluateLater, (_el, selector) => {
        const parent = document.querySelector(selector);
        if (!parent) return;

        const index = Math.max(0, Math.floor(order));
        const beforeNode = parent.children.item(index) ?? null;
        parent.insertBefore(_el, beforeNode);
      });
    }
  );

  Alpine.directive(
    "move-before",
    (el, { expression }, { evaluateLater }) => {
      moveOnNextTick(el, expression, evaluateLater, (_el, selector) => {
        const ref = document.querySelector(selector);
        if (!ref || !ref.parentElement) return;
        ref.parentElement.insertBefore(_el, ref);
      });
    }
  );

  Alpine.directive(
    "move-after",
    (el, { expression }, { evaluateLater }) => {
      moveOnNextTick(el, expression, evaluateLater, (_el, selector) => {
        const ref = document.querySelector(selector);
        if (!ref || !ref.parentElement) return;
        ref.parentElement.insertBefore(_el, ref.nextSibling);
      });
    }
  );

  // run every second if the component is active
  Alpine.directive(
    "every-second",
    (_el, { expression }, { evaluateLater, cleanup }) => {
      const onTick = evaluateLater(expression);
      const intervalId = setInterval(() => onTick(), 1000);
      cleanup(() => clearInterval(intervalId));
    }
  );

  // run every minute if the component is active
  Alpine.directive(
    "every-minute",
    (_el, { expression }, { evaluateLater, cleanup }) => {
      const onTick = evaluateLater(expression);
      const intervalId = setInterval(() => onTick(), 60_000);
      cleanup(() => clearInterval(intervalId));
    }
  );

  // run every hour if the component is active
  Alpine.directive(
    "every-hour",
    (_el, { expression }, { evaluateLater, cleanup }) => {
      const onTick = evaluateLater(expression);
      const intervalId = setInterval(() => onTick(), 3_600_000);
      cleanup(() => clearInterval(intervalId));
    }
  );


  // clone existing global store into standalone instance
  globalThis.Alpine.magic('instantiate', () => (src) => {
  const out = {};
  const desc = Object.getOwnPropertyDescriptors(src);

  for (const k in desc) {
    const d = desc[k];

    if (d.get || d.set || typeof d.value === "function") {
      Object.defineProperty(out, k, d);
    } else {
      const v = d.value;
      Object.defineProperty(out, k, {
        ...d,
        value: Array.isArray(v)
          ? v.map(i => (i && typeof i === "object" ? { ...i } : i))
          : v && typeof v === "object"
          ? { ...v }
          : v
      });
    }
  }

  return out;
});


// register $confirmClick magic helper for inline button confirmations
registerAlpineMagic();
