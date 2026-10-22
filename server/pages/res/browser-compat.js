(function (global) {
  var NAMESPACE = "SpaceBrowserCompatibility";
  var FRONTEND_CONFIG_META_NAME = "space-config";
  var cachedPromise = null;
  var cachedResult = null;
  var hasRenderedFailure = false;
  var STORAGE_TEST_KEY = "__space_browser_compat_test__";

  function createProblem(id, label, detail) {
    return {
      detail: String(detail || "").trim(),
      id: String(id || "").trim(),
      label: String(label || "").trim()
    };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hasFunction(target, name) {
    return Boolean(target && typeof target[name] === "function");
  }

  function readFrontendConfigValue(paramName, fallback) {
    try {
      var documentObject = global && global.document;
      var normalizedName = String(paramName || "").trim().toUpperCase();

      if (!normalizedName || !documentObject || typeof documentObject.querySelector !== "function") {
        return fallback;
      }

      var metaTag = documentObject.querySelector(
        'meta[name="' + FRONTEND_CONFIG_META_NAME + '"][data-space-param="' + normalizedName + '"]'
      );

      if (!metaTag) {
        return fallback;
      }

      var type = String((metaTag.dataset && metaTag.dataset.spaceType) || "text").trim().toLowerCase();
      var content = String(metaTag.content || "");

      if (type === "boolean") {
        return content === "true";
      }

      if (type === "number") {
        var numericValue = Number(content);
        return isFinite(numericValue) ? numericValue : fallback;
      }

      return content;
    } catch (error) {
      return fallback;
    }
  }

  function passwordLoginUsesWebCrypto() {
    // Single-user runtime returns an implicit principal, skips password SCRAM and
    // switches userCrypto to its bypass state, so no client-side crypto.subtle
    // consumer remains. Multi-user always keeps that dependency once signed in.
    return readFrontendConfigValue("SINGLE_USER_APP", false) !== true;
  }

  function canUseStorage(storageName) {
    try {
      var storage = global && global[storageName];

      if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
        return false;
      }

      storage.setItem(STORAGE_TEST_KEY, "1");
      storage.removeItem(STORAGE_TEST_KEY);
      return true;
    } catch (error) {
      return false;
    }
  }

  function supportsModernJavascriptSyntax() {
    try {
      return Boolean(
        new Function(
          "const probe = async () => ({ ok: ({ value: true })?.value ?? false }); return probe;"
        )()
      );
    } catch (error) {
      return false;
    }
  }

  function collectSyncProblems() {
    var problems = [];
    var cryptoApi = global && global.crypto;
    var subtle = cryptoApi && cryptoApi.subtle;
    var missingCryptoParts = [];

    if (!supportsModernJavascriptSyntax()) {
      problems.push(
        createProblem(
          "modern-javascript",
          "Modern JavaScript syntax",
          "Constellation Agent uses async functions, optional chaining, nullish coalescing, and other current JavaScript syntax in its public shells and app runtime."
        )
      );
    }

    if (typeof global.Promise !== "function") {
      problems.push(
        createProblem(
          "promise",
          "Promises",
          "The login flow and browser runtime require JavaScript Promise support."
        )
      );
    }

    if (typeof global.Proxy !== "function") {
      problems.push(
        createProblem(
          "proxy",
          "JavaScript Proxy",
          "The app runtime uses Proxy-based state and data binding."
        )
      );
    }

    if (typeof global.Map !== "function" || typeof global.Set !== "function") {
      problems.push(
        createProblem(
          "map-set",
          "Map and Set",
          "The frontend framework and caches require JavaScript Map and Set support."
        )
      );
    }

    if (typeof global.queueMicrotask !== "function") {
      problems.push(
        createProblem(
          "queue-microtask",
          "queueMicrotask",
          "The frontend framework uses queueMicrotask during app bootstrap."
        )
      );
    }

    if (typeof global.fetch !== "function") {
      problems.push(
        createProblem(
          "fetch",
          "Fetch API",
          "Login, API calls, and module loading require the browser Fetch API."
        )
      );
    }

    if (typeof global.URL !== "function" || typeof global.URLSearchParams !== "function") {
      problems.push(
        createProblem(
          "url",
          "URL parsing",
          "Launcher routing and request handling require URL and URLSearchParams support."
        )
      );
    }

    if (typeof global.MutationObserver !== "function") {
      problems.push(
        createProblem(
          "mutation-observer",
          "MutationObserver",
          "The frontend framework and extension loader require MutationObserver."
        )
      );
    }

    if (typeof global.requestAnimationFrame !== "function") {
      problems.push(
        createProblem(
          "request-animation-frame",
          "requestAnimationFrame",
          "The public shells use requestAnimationFrame for layout and motion."
        )
      );
    }

    if (typeof global.matchMedia !== "function") {
      problems.push(
        createProblem(
          "match-media",
          "matchMedia",
          "The public shells use matchMedia for reduced-motion handling."
        )
      );
    }

    if (typeof global.TextEncoder !== "function" || typeof global.TextDecoder !== "function") {
      problems.push(
        createProblem(
          "text-codecs",
          "TextEncoder and TextDecoder",
          "Password login, streaming, and user crypto require browser text codec support."
        )
      );
    }

    if (!canUseStorage("sessionStorage")) {
      problems.push(
        createProblem(
          "session-storage",
          "sessionStorage access",
          "Constellation Agent uses sessionStorage for launcher access, login handoff, and per-session user crypto state."
        )
      );
    }

    if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
      missingCryptoParts.push("crypto.getRandomValues");
    }

    // Password login proofs and the per-user userCrypto record are the only hard
    // crypto.subtle consumers in the public shells. Single-user runtime bypasses
    // both, so it must not demand a secure context just to reach the launcher.
    var passwordLoginNeedsCrypto = passwordLoginUsesWebCrypto();

    if (passwordLoginNeedsCrypto) {
      if (!subtle) {
        missingCryptoParts.push("crypto.subtle");
      } else {
        if (typeof subtle.importKey !== "function") {
          missingCryptoParts.push("crypto.subtle.importKey");
        }
        if (typeof subtle.digest !== "function") {
          missingCryptoParts.push("crypto.subtle.digest");
        }
        if (typeof subtle.sign !== "function") {
          missingCryptoParts.push("crypto.subtle.sign");
        }
        if (typeof subtle.deriveBits !== "function") {
          missingCryptoParts.push("crypto.subtle.deriveBits");
        }
        if (typeof subtle.encrypt !== "function") {
          missingCryptoParts.push("crypto.subtle.encrypt");
        }
        if (typeof subtle.decrypt !== "function") {
          missingCryptoParts.push("crypto.subtle.decrypt");
        }
      }
    }

    if (missingCryptoParts.length > 0) {
      var cryptoDetail = passwordLoginNeedsCrypto
        ? "Password login and user crypto require " + missingCryptoParts.join(", ") + "."
        : "Constellation Agent needs " + missingCryptoParts.join(", ") + ".";

      if (global.isSecureContext === false) {
        cryptoDetail += " This page is not running in a secure context.";

        if (passwordLoginNeedsCrypto) {
          cryptoDetail +=
            " Use HTTPS or localhost, or run the server with SINGLE_USER_APP=true to skip password login and its Web Crypto requirement.";
        }
      }

      problems.push(createProblem("web-crypto", "Web Crypto", cryptoDetail));
    }

    return problems;
  }

  function buildModuleImportFactory(sourceText) {
    try {
      return new Function(
        "return import(" +
          JSON.stringify(
            "data:text/javascript;charset=utf-8," + encodeURIComponent(String(sourceText || ""))
          ) +
          ");"
      );
    } catch (error) {
      return null;
    }
  }

  function probeDynamicImport() {
    return new Promise(function (resolve) {
      var factory = buildModuleImportFactory("export default 1;");
      var result;

      if (!factory) {
        resolve(
          createProblem(
            "dynamic-import",
            "Dynamic import()",
            "Constellation Agent loads browser modules with dynamic import()."
          )
        );
        return;
      }

      try {
        result = factory();
      } catch (error) {
        resolve(
          createProblem(
            "dynamic-import",
            "Dynamic import()",
            "Constellation Agent loads browser modules with dynamic import()."
          )
        );
        return;
      }

      if (!result || typeof result.then !== "function") {
        resolve(
          createProblem(
            "dynamic-import",
            "Dynamic import()",
            "Constellation Agent loads browser modules with dynamic import()."
          )
        );
        return;
      }

      result.then(
        function () {
          resolve(null);
        },
        function () {
          resolve(
            createProblem(
              "dynamic-import",
              "Dynamic import()",
              "Constellation Agent loads browser modules with dynamic import()."
            )
          );
        }
      );
    });
  }

  function probeTopLevelAwait() {
    return new Promise(function (resolve) {
      var factory = buildModuleImportFactory("await 0; export default 1;");
      var result;

      if (!factory) {
        resolve(
          createProblem(
            "top-level-await",
            "Top-level await in modules",
            "The authenticated app shell boots from a module that uses top-level await."
          )
        );
        return;
      }

      try {
        result = factory();
      } catch (error) {
        resolve(
          createProblem(
            "top-level-await",
            "Top-level await in modules",
            "The authenticated app shell boots from a module that uses top-level await."
          )
        );
        return;
      }

      if (!result || typeof result.then !== "function") {
        resolve(
          createProblem(
            "top-level-await",
            "Top-level await in modules",
            "The authenticated app shell boots from a module that uses top-level await."
          )
        );
        return;
      }

      result.then(
        function () {
          resolve(null);
        },
        function () {
          resolve(
            createProblem(
              "top-level-await",
              "Top-level await in modules",
              "The authenticated app shell boots from a module that uses top-level await."
            )
          );
        }
      );
    });
  }

  function buildFailureHtml(result) {
    var missing = result && result.missing ? result.missing : [];
    var html =
      '<p class="browser-compat-eyebrow">Browser compatibility check failed</p>' +
      '<h2 class="browser-compat-title">Browser Not Supported</h2>' +
      '<p class="browser-compat-copy">Constellation Agent cannot run in this browser because it is missing:</p>' +
      '<ul class="browser-compat-list">';
    var index;
    var item;

    for (index = 0; index < missing.length; index += 1) {
      item = missing[index];
      html +=
        "<li><strong>" +
        escapeHtml(item.label) +
        ".</strong> " +
        escapeHtml(item.detail) +
        "</li>";
    }

    html += "</ul>";

    var note = "Use a current version of Chrome, Edge, Firefox, or Safari.";

    if (passwordLoginUsesWebCrypto()) {
      note +=
        " If Web Crypto is unavailable, open Constellation Agent over HTTPS or localhost, or run the server with SINGLE_USER_APP=true to skip password login.";
    }

    html += '<p class="browser-compat-note">' + note + "</p>";

    return html;
  }

  function renderFailure(result) {
    var documentObject = global.document;
    var target;
    var interactiveNodes;
    var index;

    if (hasRenderedFailure || !documentObject || !documentObject.querySelector) {
      return result;
    }

    if (!result || result.ok) {
      return result;
    }

    target = documentObject.querySelector("[data-space-browser-compat-target]");
    interactiveNodes = documentObject.querySelectorAll("[data-space-browser-compat-hide-on-fail]");

    if (documentObject.body && typeof documentObject.body.setAttribute === "function") {
      documentObject.body.setAttribute("data-space-browser-compat", "blocked");
    }

    for (index = 0; index < interactiveNodes.length; index += 1) {
      interactiveNodes[index].setAttribute("hidden", "hidden");
    }

    if (target) {
      target.innerHTML = buildFailureHtml(result);
      target.removeAttribute("hidden");
    }

    hasRenderedFailure = true;
    return result;
  }

  function finalizeResult(result) {
    cachedResult = {
      missing: result && result.missing ? result.missing : [],
      ok: Boolean(result && result.ok)
    };
    cachedPromise = null;
    renderFailure(cachedResult);
    return cachedResult;
  }

  function check() {
    var syncProblems;

    if (cachedResult) {
      if (typeof global.Promise === "function") {
        return global.Promise.resolve(cachedResult);
      }

      return cachedResult;
    }

    if (cachedPromise) {
      return cachedPromise;
    }

    syncProblems = collectSyncProblems();

    if (syncProblems.length > 0 || typeof global.Promise !== "function") {
      return finalizeResult({
        missing: syncProblems,
        ok: syncProblems.length === 0
      });
    }

    cachedPromise = global.Promise.resolve()
      .then(function () {
        return probeDynamicImport();
      })
      .then(function (dynamicImportProblem) {
        if (dynamicImportProblem) {
          syncProblems.push(dynamicImportProblem);
          return null;
        }

        return probeTopLevelAwait();
      })
      .then(function (topLevelAwaitProblem) {
        if (topLevelAwaitProblem) {
          syncProblems.push(topLevelAwaitProblem);
        }

        return finalizeResult({
          missing: syncProblems,
          ok: syncProblems.length === 0
        });
      })
      .catch(function () {
        syncProblems.push(
          createProblem(
            "module-loading",
            "Browser module loading",
            "Constellation Agent could not verify JavaScript module support in this browser."
          )
        );

        return finalizeResult({
          missing: syncProblems,
          ok: false
        });
      });

    return cachedPromise;
  }

  global[NAMESPACE] = {
    check: check,
    getResult: function () {
      return cachedResult;
    },
    renderFailure: renderFailure
  };

  check();
})(typeof window !== "undefined" ? window : globalThis);
