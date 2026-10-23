import fs from "node:fs";
import path from "node:path";

import { normalizePathSegment } from "../utils/app_files.js";

function stripTrailingSlash(value) {
  const text = String(value || "");
  return text.endsWith("/") ? text.slice(0, -1) : text;
}

function normalizeEntityId(value) {
  const normalized = normalizePathSegment(value);

  if (!normalized || normalized.includes("/")) {
    return "";
  }

  return normalized;
}

function normalizeConfiguredPath(value) {
  return String(value ?? "").trim();
}

function getConfiguredCustomwarePath(runtimeParams) {
  if (runtimeParams && typeof runtimeParams.get === "function") {
    return normalizeConfiguredPath(runtimeParams.get("CUSTOMWARE_PATH", ""));
  }

  return normalizeConfiguredPath(process.env.CUSTOMWARE_PATH);
}

function getAppPathRoots(projectRoot, runtimeParams) {
  const normalizedProjectRoot = path.resolve(String(projectRoot || ""));
  const appRootDir = path.join(normalizedProjectRoot, "app");
  const l0Dir = path.join(appRootDir, "L0");
  const configuredCustomwarePath = getConfiguredCustomwarePath(runtimeParams);
  const customwareRootDir = configuredCustomwarePath
    ? path.resolve(normalizedProjectRoot, configuredCustomwarePath)
    : "";
  const l1Dir = customwareRootDir ? path.join(customwareRootDir, "L1") : path.join(appRootDir, "L1");
  const l2Dir = customwareRootDir ? path.join(customwareRootDir, "L2") : path.join(appRootDir, "L2");

  return {
    appRootDir,
    customwareRootDir,
    l0Dir,
    l1Dir,
    l2Dir,
    projectRoot: normalizedProjectRoot,
    usesExternalCustomware: Boolean(
      customwareRootDir && path.resolve(customwareRootDir) !== path.resolve(appRootDir)
    )
  };
}

function ensureCustomwareDirectories(projectRoot, runtimeParams) {
  const roots = getAppPathRoots(projectRoot, runtimeParams);

  if (!roots.customwareRootDir) {
    return roots;
  }

  fs.mkdirSync(roots.l1Dir, { recursive: true });
  fs.mkdirSync(roots.l2Dir, { recursive: true });
  return roots;
}

function isAbsolutePathWithinRoot(absoluteRoot, absolutePath) {
  const relativePath = path.relative(absoluteRoot, absolutePath);

  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeRelativeAbsolutePath(value) {
  return String(value || "").replaceAll(path.sep, "/");
}

function resolveProjectPathFromAbsolute(projectRoot, absolutePath, options = {}) {
  const roots = getAppPathRoots(projectRoot, options.runtimeParams);
  const normalizedAbsolutePath = path.resolve(String(absolutePath || ""));
  const isDirectory = Boolean(options.isDirectory);
  const candidates = [
    {
      absoluteRoot: roots.l1Dir,
      projectRoot: "/app/L1/"
    },
    {
      absoluteRoot: roots.l2Dir,
      projectRoot: "/app/L2/"
    },
    {
      absoluteRoot: roots.l0Dir,
      projectRoot: "/app/L0/"
    },
    {
      absoluteRoot: roots.appRootDir,
      projectRoot: "/app/"
    }
  ];

  for (const candidate of candidates) {
    if (!isAbsolutePathWithinRoot(candidate.absoluteRoot, normalizedAbsolutePath)) {
      continue;
    }

    const relativePath = normalizeRelativeAbsolutePath(
      path.relative(candidate.absoluteRoot, normalizedAbsolutePath)
    );

    if (
      candidate.projectRoot === "/app/" &&
      roots.usesExternalCustomware &&
      (relativePath === "L1" ||
        relativePath === "L2" ||
        relativePath.startsWith("L1/") ||
        relativePath.startsWith("L2/"))
    ) {
      return "";
    }

    if (!relativePath) {
      return isDirectory ? candidate.projectRoot : stripTrailingSlash(candidate.projectRoot);
    }

    return isDirectory
      ? `${candidate.projectRoot}${stripTrailingSlash(relativePath)}/`
      : `${candidate.projectRoot}${relativePath}`;
  }

  return "";
}

function resolveProjectAbsolutePath(projectRoot, projectPath, runtimeParams) {
  const normalizedProjectPath = normalizeAppProjectPath(projectPath, {
    allowAppRoot: true,
    isDirectory: String(projectPath || "").endsWith("/")
  });

  if (!normalizedProjectPath) {
    return "";
  }

  const roots = getAppPathRoots(projectRoot, runtimeParams);

  if (normalizedProjectPath === "/app/") {
    return roots.appRootDir;
  }

  let match = normalizedProjectPath.match(/^\/app\/L0(?:\/(.*))?$/u);

  if (match) {
    return match[1] ? path.join(roots.l0Dir, match[1]) : roots.l0Dir;
  }

  match = normalizedProjectPath.match(/^\/app\/L1(?:\/(.*))?$/u);

  if (match) {
    return match[1] ? path.join(roots.l1Dir, match[1]) : roots.l1Dir;
  }

  match = normalizedProjectPath.match(/^\/app\/L2(?:\/(.*))?$/u);

  if (match) {
    return match[1] ? path.join(roots.l2Dir, match[1]) : roots.l2Dir;
  }

  return path.join(roots.appRootDir, normalizedProjectPath.slice("/app/".length));
}

function listProjectScanRoots(projectRoot, projectPathPrefix, runtimeParams) {
  const roots = getAppPathRoots(projectRoot, runtimeParams);
  const normalizedPrefix = normalizePathSegment(projectPathPrefix || "");
  const scanRoots = [];

  function addRoot(targetPath) {
    const normalizedTargetPath = path.resolve(String(targetPath || ""));

    if (!scanRoots.includes(normalizedTargetPath)) {
      scanRoots.push(normalizedTargetPath);
    }
  }

  if (!normalizedPrefix) {
    addRoot(roots.projectRoot);
    return scanRoots;
  }

  if (normalizedPrefix === "app") {
    addRoot(roots.appRootDir);
    addRoot(roots.l1Dir);
    addRoot(roots.l2Dir);
    return scanRoots;
  }

  if (normalizedPrefix === "app/L0" || normalizedPrefix.startsWith("app/L0/")) {
    addRoot(path.join(roots.l0Dir, normalizedPrefix.slice("app/L0".length).replace(/^\/+/u, "")));
    return scanRoots;
  }

  if (normalizedPrefix === "app/L1" || normalizedPrefix.startsWith("app/L1/")) {
    addRoot(path.join(roots.l1Dir, normalizedPrefix.slice("app/L1".length).replace(/^\/+/u, "")));
    return scanRoots;
  }

  if (normalizedPrefix === "app/L2" || normalizedPrefix.startsWith("app/L2/")) {
    addRoot(path.join(roots.l2Dir, normalizedPrefix.slice("app/L2".length).replace(/^\/+/u, "")));
    return scanRoots;
  }

  addRoot(path.join(roots.projectRoot, normalizedPrefix));
  return scanRoots;
}

function normalizeAppProjectPath(value, options = {}) {
  const rawValue = String(value || "").trim().replaceAll("\\", "/");
  const isDirectory = Boolean(options.isDirectory) || rawValue.endsWith("/");
  let normalized = "";

  try {
    normalized = normalizePathSegment(rawValue);
  } catch {
    return "";
  }

  if (!normalized) {
    return options.allowAppRoot ? "/app/" : "";
  }

  if (normalized === "app") {
    return "/app/";
  }

  const appRelativePath = normalized.startsWith("app/") ? normalized : `app/${normalized}`;
  const projectPath = `/${stripTrailingSlash(appRelativePath)}`;

  return isDirectory ? `${projectPath}/` : projectPath;
}

function normalizeModuleRequestPath(value) {
  const normalized = normalizePathSegment(value);

  if (!normalized.startsWith("mod/")) {
    return "";
  }

  return `/${normalized}`;
}

function parseModuleDirectoryRequestPath(value) {
  const normalizedPath = normalizeModuleRequestPath(value);
  const match = normalizedPath.match(/^\/mod\/([^/]+)\/([^/]+)\/?$/u);

  if (!match) {
    return null;
  }

  const authorId = normalizeEntityId(match[1]);
  const repositoryId = normalizeEntityId(match[2]);

  if (!authorId || !repositoryId) {
    return null;
  }

  return {
    authorId,
    repositoryId,
    requestPath: `/mod/${authorId}/${repositoryId}`
  };
}

function parseModuleExtensionRequestPath(requestPath) {
  const match = String(requestPath || "").match(/^\/mod\/([^/]+)\/([^/]+)\/ext\/(.+)$/u);

  if (!match) {
    return null;
  }

  const authorId = normalizeEntityId(match[1]);
  const repositoryId = normalizeEntityId(match[2]);
  const extensionPath = normalizePathSegment(match[3]);

  if (!authorId || !repositoryId || !extensionPath) {
    return null;
  }

  return {
    authorId,
    extensionPath,
    moduleRequestPath: `/mod/${authorId}/${repositoryId}`,
    repositoryId,
    requestPath: `/mod/${authorId}/${repositoryId}/ext/${extensionPath}`
  };
}

function parseProjectModuleDirectoryPath(projectPath) {
  let match = String(projectPath || "").match(/^\/app\/L0\/([^/]+)\/(mod\/[^/]+\/[^/]+)\/$/u);

  if (match) {
    const ownerId = normalizeEntityId(match[1]);
    const requestPathInfo = parseModuleDirectoryRequestPath(match[2]);

    if (!ownerId || !requestPathInfo) {
      return null;
    }

    return {
      layer: "L0",
      ownerId,
      ownerType: "group",
      projectPath: String(projectPath),
      ...requestPathInfo
    };
  }

  match = String(projectPath || "").match(/^\/app\/L1\/([^/]+)\/(mod\/[^/]+\/[^/]+)\/$/u);

  if (match) {
    const ownerId = normalizeEntityId(match[1]);
    const requestPathInfo = parseModuleDirectoryRequestPath(match[2]);

    if (!ownerId || !requestPathInfo) {
      return null;
    }

    return {
      layer: "L1",
      ownerId,
      ownerType: "group",
      projectPath: String(projectPath),
      ...requestPathInfo
    };
  }

  match = String(projectPath || "").match(/^\/app\/L2\/([^/]+)\/(mod\/[^/]+\/[^/]+)\/$/u);

  if (!match) {
    return null;
  }

  const ownerId = normalizeEntityId(match[1]);
  const requestPathInfo = parseModuleDirectoryRequestPath(match[2]);

  if (!ownerId || !requestPathInfo) {
    return null;
  }

  return {
    layer: "L2",
    ownerId,
    ownerType: "user",
    projectPath: String(projectPath),
    ...requestPathInfo
  };
}

function parseProjectModuleFilePath(projectPath) {
  let match = String(projectPath || "").match(/^\/app\/L0\/([^/]+)\/(mod\/.+)$/u);

  if (match) {
    const ownerId = normalizeEntityId(match[1]);

    if (!ownerId) {
      return null;
    }

    return {
      layer: "L0",
      ownerId,
      ownerType: "group",
      projectPath: String(projectPath),
      requestPath: `/${match[2]}`
    };
  }

  match = String(projectPath || "").match(/^\/app\/L1\/([^/]+)\/(mod\/.+)$/u);

  if (match) {
    const ownerId = normalizeEntityId(match[1]);

    if (!ownerId) {
      return null;
    }

    return {
      layer: "L1",
      ownerId,
      ownerType: "group",
      projectPath: String(projectPath),
      requestPath: `/${match[2]}`
    };
  }

  match = String(projectPath || "").match(/^\/app\/L2\/([^/]+)\/(mod\/.+)$/u);

  if (match) {
    const ownerId = normalizeEntityId(match[1]);

    if (!ownerId) {
      return null;
    }

    return {
      layer: "L2",
      ownerId,
      ownerType: "user",
      projectPath: String(projectPath),
      requestPath: `/${match[2]}`
    };
  }

  return null;
}

function parseProjectModuleExtensionFilePath(projectPath) {
  if (String(projectPath || "").endsWith("/")) {
    return null;
  }

  const modulePathInfo = parseProjectModuleFilePath(projectPath);

  if (!modulePathInfo) {
    return null;
  }

  const extensionRequestPathInfo = parseModuleExtensionRequestPath(modulePathInfo.requestPath);

  if (!extensionRequestPathInfo) {
    return null;
  }

  return {
    ...modulePathInfo,
    ...extensionRequestPathInfo,
    projectPath: String(projectPath)
  };
}

function parseGroupConfigProjectPath(projectPath) {
  let match = String(projectPath || "").match(/^\/app\/L0\/([^/]+)\/group\.yaml$/u);

  if (match) {
    const groupId = normalizeEntityId(match[1]);

    if (!groupId) {
      return null;
    }

    return {
      groupId,
      layer: "L0",
      projectPath: String(projectPath)
    };
  }

  match = String(projectPath || "").match(/^\/app\/L1\/([^/]+)\/group\.yaml$/u);

  if (match) {
    const groupId = normalizeEntityId(match[1]);

    if (!groupId) {
      return null;
    }

    return {
      groupId,
      layer: "L1",
      projectPath: String(projectPath)
    };
  }

  return null;
}

function parseProjectUserDirectoryPath(projectPath) {
  const match = String(projectPath || "").match(/^\/app\/L2\/([^/]+)\/$/u);

  if (!match) {
    return null;
  }

  const username = normalizeEntityId(match[1]);

  if (!username) {
    return null;
  }

  return {
    layer: "L2",
    projectPath: String(projectPath),
    username
  };
}

function parseProjectUserConfigPath(projectPath) {
  const match = String(projectPath || "").match(/^\/app\/L2\/([^/]+)\/user\.yaml$/u);

  if (!match) {
    return null;
  }

  const username = normalizeEntityId(match[1]);

  if (!username) {
    return null;
  }

  return {
    layer: "L2",
    projectPath: String(projectPath),
    username
  };
}

function parseProjectUserLoginsPath(projectPath) {
  const match = String(projectPath || "").match(/^\/app\/L2\/([^/]+)\/metadata\/logins\.json$/u);

  if (!match) {
    return null;
  }

  const username = normalizeEntityId(match[1]);

  if (!username) {
    return null;
  }

  return {
    layer: "L2",
    projectPath: String(projectPath),
    username
  };
}

function parseProjectUserPasswordPath(projectPath) {
  const match = String(projectPath || "").match(/^\/app\/L2\/([^/]+)\/metadata\/password\.json$/u);

  if (!match) {
    return null;
  }

  const username = normalizeEntityId(match[1]);

  if (!username) {
    return null;
  }

  return {
    layer: "L2",
    projectPath: String(projectPath),
    username
  };
}

function parseAppProjectPath(projectPath) {
  const normalizedProjectPath = normalizeAppProjectPath(projectPath, {
    allowAppRoot: true,
    isDirectory: String(projectPath || "").endsWith("/")
  });

  if (!normalizedProjectPath) {
    return null;
  }

  if (normalizedProjectPath === "/app/") {
    return {
      kind: "app-root",
      layer: "",
      ownerId: "",
      ownerType: "",
      pathWithinOwner: "",
      projectPath: normalizedProjectPath
    };
  }

  let match = normalizedProjectPath.match(/^\/app\/(L0|L1|L2)\/$/u);

  if (match) {
    return {
      kind: "layer-root",
      layer: match[1],
      ownerId: "",
      ownerType: "",
      pathWithinOwner: "",
      projectPath: normalizedProjectPath
    };
  }

  match = normalizedProjectPath.match(/^\/app\/(L0|L1)\/([^/]+)(?:\/(.*))?$/u);

  if (match) {
    const ownerId = normalizeEntityId(match[2]);

    if (!ownerId) {
      return null;
    }

    return {
      kind: "owner-path",
      layer: match[1],
      ownerId,
      ownerType: "group",
      pathWithinOwner: stripTrailingSlash(match[3] || ""),
      projectPath: normalizedProjectPath
    };
  }

  match = normalizedProjectPath.match(/^\/app\/L2\/([^/]+)(?:\/(.*))?$/u);

  if (!match) {
    return null;
  }

  const ownerId = normalizeEntityId(match[1]);

  if (!ownerId) {
    return null;
  }

  return {
    kind: "owner-path",
    layer: "L2",
    ownerId,
    ownerType: "user",
    pathWithinOwner: stripTrailingSlash(match[2] || ""),
    projectPath: normalizedProjectPath
  };
}

export {
  ensureCustomwareDirectories,
  getAppPathRoots,
  normalizeAppProjectPath,
  normalizeEntityId,
  parseModuleDirectoryRequestPath,
  normalizeModuleRequestPath,
  listProjectScanRoots,
  parseAppProjectPath,
  parseModuleExtensionRequestPath,
  parseGroupConfigProjectPath,
  parseProjectModuleDirectoryPath,
  parseProjectModuleExtensionFilePath,
  parseProjectModuleFilePath,
  parseProjectUserConfigPath,
  parseProjectUserDirectoryPath,
  parseProjectUserLoginsPath,
  parseProjectUserPasswordPath,
  resolveProjectAbsolutePath,
  resolveProjectPathFromAbsolute
};
