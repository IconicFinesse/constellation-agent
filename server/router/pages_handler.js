import fs from "node:fs/promises";
import path from "node:path";

import { hasAnyPasswordUser } from "../lib/auth/user_files.js";
import { areGuestUsersAllowed, isSingleUserApp } from "../lib/utils/runtime_params.js";
import { runTrackedMutation } from "../runtime/request_mutations.js";
import { createNoStoreHeaders, sendFile, sendJson, sendNotFound, sendRedirect } from "./responses.js";

const LEGACY_ROUTE_REDIRECTS = new Map([
  ["/index.html", "/"],
  ["/login.html", "/login"],
  ["/enter.html", "/enter"],
  ["/admin.html", "/admin"]
]);

const LOGOUT_ROUTE = "/logout";
const PAGE_RESOURCE_PREFIX = "/pages/res/";
const ROOT_PAGE_RESOURCE_ALIASES = new Map([
  ["/favicon.ico", "/res/favicon.ico"],
  ["/favicon-16x16.png", "/res/favicon-16x16.png"],
  ["/favicon-32x32.png", "/res/favicon-32x32.png"],
  ["/apple-touch-icon.png", "/res/apple-touch-icon.png"],
  ["/android-chrome-192x192.png", "/res/android-chrome-192x192.png"],
  ["/android-chrome-512x512.png", "/res/android-chrome-512x512.png"],
  ["/site.webmanifest", "/res/site.webmanifest"],
  ["/robots.txt", "/robots.txt"],
  ["/llms.txt", "/llms.txt"],
  ["/llms-full.txt", "/llms-full.txt"],
  ["/sitemap.xml", "/sitemap.xml"]
]);
const FRONTEND_CONFIG_META_NAME = "space-config";
const LOGIN_HAS_USERS_PARAM_NAME = "HAS_USERS";
const ENTER_GUARD_PLACEHOLDER = "<!-- SPACE_SINGLE_USER_ENTER_GUARD -->";
const ENTER_GUARD_SCRIPT_TAG = '    <script src="/pages/res/enter-guard.js"></script>';
const PROJECT_VERSION_PLACEHOLDER = "<!-- SPACE_PROJECT_VERSION -->";
const SHARE_SPACE_ROUTE_PATTERN = /^\/share\/space\/([A-Za-z0-9]{8})$/u;

function createSessionCleanupHeaders(requestContext, auth) {
  if (
    requestContext?.user?.shouldClearSessionCookie &&
    auth &&
    typeof auth.createClearedSessionCookieHeader === "function"
  ) {
    return {
      "Set-Cookie": auth.createClearedSessionCookieHeader()
    };
  }

  return {};
}

function createClearedSessionHeaders(auth) {
  if (auth && typeof auth.createClearedSessionCookieHeader === "function") {
    return {
      "Set-Cookie": auth.createClearedSessionCookieHeader()
    };
  }

  return {};
}

function escapeHtmlAttribute(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function buildFrontendConfigMetaTags(runtimeParams) {
  const entries =
    runtimeParams && typeof runtimeParams.listFrontendExposed === "function"
      ? runtimeParams.listFrontendExposed()
      : [];

  if (entries.length === 0) {
    return "";
  }

  return entries
    .map(
      (entry) =>
        `    <meta name="${FRONTEND_CONFIG_META_NAME}" data-space-param="${escapeHtmlAttribute(entry.name)}" data-space-type="${escapeHtmlAttribute(entry.type)}" content="${escapeHtmlAttribute(entry.content)}" />`
    )
    .join("\n");
}

// Derived deployment state for the public login shell. This is not an operator-set
// runtime parameter, so it is injected here instead of living in params.yaml. It is
// safe to disclose: a zero-account instance has nothing to enumerate, and the shell
// must stop presenting a password form for accounts that cannot exist yet.
function injectLoginAccountState(sourceText, options = {}) {
  if (String(options.pageName || "") !== "login.html") {
    return sourceText;
  }

  const metaTag = `    <meta name="${FRONTEND_CONFIG_META_NAME}" data-space-param="${LOGIN_HAS_USERS_PARAM_NAME}" data-space-type="boolean" content="${options.hasPasswordUser ? "true" : "false"}" />`;

  if (/<\/head>/iu.test(sourceText)) {
    return sourceText.replace(/<\/head>/iu, `${metaTag}
  </head>`);
  }

  return `${metaTag}
${sourceText}`;
}

// Build-derived provenance for the running build. Like `HAS_USERS`, this is not an
// operator-set runtime parameter, so it is injected here instead of living in
// params.yaml — but it is emitted through the SAME `space-config` meta channel, so
// the frontend reads it with the existing `space.config.get(...)` and no second
// mechanism exists. Engine-swap artifacts use it to say which build produced them.
function injectProvenanceMetaTags(sourceText, options = {}) {
  const appCommit = String(options.appCommit || "").trim();
  const appVersion = String(options.appVersion || "").trim();

  if (!appCommit && !appVersion) {
    return sourceText;
  }

  const metaTags = [
    appCommit
      ? `    <meta name="${FRONTEND_CONFIG_META_NAME}" data-space-param="SPACE_APP_COMMIT" data-space-type="text" content="${escapeHtmlAttribute(appCommit)}" />`
      : "",
    appVersion
      ? `    <meta name="${FRONTEND_CONFIG_META_NAME}" data-space-param="SPACE_APP_VERSION" data-space-type="text" content="${escapeHtmlAttribute(appVersion)}" />`
      : ""
  ]
    .filter(Boolean)
    .join("\n");

  if (!metaTags) {
    return sourceText;
  }

  if (/<\/head>/iu.test(sourceText)) {
    return sourceText.replace(/<\/head>/iu, `${metaTags}\n  </head>`);
  }

  return `${metaTags}\n${sourceText}`;
}

function injectFrontendConfigMetaTags(sourceText, runtimeParams) {
  const metaTags = buildFrontendConfigMetaTags(runtimeParams);

  if (!metaTags) {
    return sourceText;
  }

  if (/<\/head>/iu.test(sourceText)) {
    return sourceText.replace(/<\/head>/iu, `${metaTags}\n  </head>`);
  }

  return `${metaTags}\n${sourceText}`;
}

function hasEnterLauncherAccess(requestContext, runtimeParams) {
  return Boolean(requestContext?.user?.isAuthenticated) || isSingleUserApp(runtimeParams);
}

function injectEnterGuard(sourceText, options = {}) {
  const pageName = String(options.pageName || "");

  if (!sourceText.includes(ENTER_GUARD_PLACEHOLDER)) {
    return sourceText;
  }

  if (
    !["index.html", "admin.html"].includes(pageName) ||
    !hasEnterLauncherAccess(options.requestContext, options.runtimeParams)
  ) {
    return sourceText.replace(ENTER_GUARD_PLACEHOLDER, "");
  }

  return sourceText.replace(ENTER_GUARD_PLACEHOLDER, ENTER_GUARD_SCRIPT_TAG);
}

function injectProjectVersion(sourceText, projectVersion) {
  if (!sourceText.includes(PROJECT_VERSION_PLACEHOLDER)) {
    return sourceText;
  }

  return sourceText.replaceAll(
    PROJECT_VERSION_PLACEHOLDER,
    escapeHtmlAttribute(projectVersion || "unknown")
  );
}

async function sendPageHtml(res, filePath, options = {}) {
  let sourceText;

  try {
    sourceText = await fs.readFile(filePath, "utf8");
  } catch {
    sendNotFound(res, options.headers);
    return;
  }

  const body = injectLoginAccountState(
    injectFrontendConfigMetaTags(
      injectProvenanceMetaTags(
        injectProjectVersion(
          injectEnterGuard(sourceText, {
            pageName: options.pageName,
            requestContext: options.requestContext,
            runtimeParams: options.runtimeParams
          }),
          options.projectVersion
        ),
        {
          appCommit: options.appCommit,
          appVersion: options.appVersion
        }
      ),
      options.runtimeParams
    ),
    options
  );

  res.writeHead(200, createNoStoreHeaders({
    ...(options.headers || {}),
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "text/html; charset=utf-8"
  }));
  res.end(body);
}

async function handleLogoutRequest(res, options = {}) {
  const { auth, requestContext } = options;

  try {
    if (
      requestContext?.user?.isAuthenticated &&
      auth &&
      typeof auth.revokeSession === "function"
    ) {
      await runTrackedMutation(options, async () =>
        auth.revokeSession(requestContext.user.sessionToken, requestContext.user.username)
      );
    }
  } catch {
    sendJson(res, 500, {
      error: "Internal server error"
    });
    return;
  }

  sendRedirect(res, "/login", createClearedSessionHeaders(auth));
}

function resolvePathWithinRoot(rootDir, requestPath) {
  const filePath = path.resolve(rootDir, `.${requestPath}`);
  const relativePath = path.relative(rootDir, filePath);

  if (
    relativePath === "" ||
    relativePath === "." ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return filePath;
}

function resolveSharePageRequest(pagesDir, pathname) {
  const normalizedPath = path.posix.normalize(pathname || "/");

  if (normalizedPath !== "/" && normalizedPath.endsWith("/")) {
    const trimmedPath = normalizedPath.slice(0, -1);

    if (SHARE_SPACE_ROUTE_PATTERN.test(trimmedPath)) {
      return {
        kind: "redirect",
        location: trimmedPath
      };
    }
  }

  if (!SHARE_SPACE_ROUTE_PATTERN.test(normalizedPath)) {
    return null;
  }

  return {
    filePath: resolvePathWithinRoot(pagesDir, "/share_space.html"),
    kind: "file",
    pageName: "share_space.html"
  };
}

function resolvePageRequest(pagesDir, pathname) {
  const normalizedPath = path.posix.normalize(pathname || "/");

  if (LEGACY_ROUTE_REDIRECTS.has(normalizedPath)) {
    return {
      kind: "redirect",
      location: LEGACY_ROUTE_REDIRECTS.get(normalizedPath)
    };
  }

  if (normalizedPath !== "/" && normalizedPath.endsWith("/")) {
    return {
      kind: "redirect",
      location: normalizedPath.slice(0, -1)
    };
  }

  const pageName =
    normalizedPath === "/"
      ? "index.html"
      : normalizedPath.match(/^\/([a-z0-9_-]+)$/i)?.[1]
        ? `${normalizedPath.slice(1)}.html`
        : "";

  if (!pageName) {
    return null;
  }

  return {
    filePath: resolvePathWithinRoot(pagesDir, `/${pageName}`),
    kind: "file",
    pageName
  };
}

function resolvePageResourceRequest(pagesDir, pathname) {
  const normalizedPath = path.posix.normalize(pathname || "/");

  if (!normalizedPath.startsWith(PAGE_RESOURCE_PREFIX)) {
    return null;
  }

  return {
    filePath: resolvePathWithinRoot(pagesDir, normalizedPath.slice("/pages".length)),
    kind: "resource"
  };
}

function resolveRootPageResourceRequest(pagesDir, pathname) {
  const normalizedPath = path.posix.normalize(pathname || "/");
  const aliasedPath = ROOT_PAGE_RESOURCE_ALIASES.get(normalizedPath);

  if (!aliasedPath) {
    return null;
  }

  return {
    filePath: resolvePathWithinRoot(pagesDir, aliasedPath),
    kind: "resource"
  };
}

async function handlePageRequest(res, requestUrl, options = {}) {
  const { auth, pagesDir, projectRoot, requestContext, runtimeParams } = options;

  if (requestUrl.pathname === LOGOUT_ROUTE) {
    await handleLogoutRequest(res, options);
    return;
  }

  const pageResourceRequest = resolvePageResourceRequest(pagesDir, requestUrl.pathname);
  const rootPageResourceRequest = resolveRootPageResourceRequest(pagesDir, requestUrl.pathname);
  const resourceRequest = pageResourceRequest || rootPageResourceRequest;

  if (resourceRequest) {
    if (!resourceRequest.filePath) {
      sendNotFound(res, createSessionCleanupHeaders(requestContext, auth));
      return;
    }

    sendFile(res, resourceRequest.filePath, {
      headers: createNoStoreHeaders(createSessionCleanupHeaders(requestContext, auth))
    });
    return;
  }

  const sharePageRequest = resolveSharePageRequest(pagesDir, requestUrl.pathname);

  if (sharePageRequest) {
    if (sharePageRequest.kind === "redirect") {
      sendRedirect(res, sharePageRequest.location, createSessionCleanupHeaders(requestContext, auth));
      return;
    }

    if (!areGuestUsersAllowed(runtimeParams)) {
      sendNotFound(res, createSessionCleanupHeaders(requestContext, auth));
      return;
    }

    if (!sharePageRequest.filePath) {
      sendNotFound(res, createSessionCleanupHeaders(requestContext, auth));
      return;
    }

    await sendPageHtml(res, sharePageRequest.filePath, {
      appCommit: options.appCommit,
      appVersion: options.projectVersion,
      headers: createSessionCleanupHeaders(requestContext, auth),
      pageName: sharePageRequest.pageName,
      projectVersion: options.projectVersion,
      requestContext,
      runtimeParams
    });
    return;
  }

  const pageRequest = resolvePageRequest(pagesDir, requestUrl.pathname);

  if (!pageRequest) {
    sendNotFound(res);
    return;
  }

  if (pageRequest.kind === "redirect") {
    sendRedirect(res, pageRequest.location, createSessionCleanupHeaders(requestContext, auth));
    return;
  }

  const isLoginPage = pageRequest.pageName === "login.html";
  const isEnterPage = pageRequest.pageName === "enter.html";
  const canAccessEnterPage = hasEnterLauncherAccess(requestContext, runtimeParams);

  if (isEnterPage && !canAccessEnterPage) {
    sendRedirect(res, "/login", createSessionCleanupHeaders(requestContext, auth));
    return;
  }

  if (isLoginPage && requestContext?.user?.isAuthenticated) {
    sendRedirect(res, "/", createSessionCleanupHeaders(requestContext, auth));
    return;
  }

  if (!isLoginPage && !isEnterPage && !requestContext?.user?.isAuthenticated) {
    sendRedirect(res, "/login", createSessionCleanupHeaders(requestContext, auth));
    return;
  }

  if (!pageRequest.filePath) {
    sendNotFound(res);
    return;
  }

  const hasPasswordUser =
    !isLoginPage || !projectRoot
      ? true
      : hasAnyPasswordUser(projectRoot, runtimeParams);

  await sendPageHtml(res, pageRequest.filePath, {
    appCommit: options.appCommit,
    appVersion: options.projectVersion,
    hasPasswordUser,
    headers: createSessionCleanupHeaders(requestContext, auth),
    pageName: pageRequest.pageName,
    projectVersion: options.projectVersion,
    requestContext,
    runtimeParams
  });
}

export { handlePageRequest };
