import fs from "node:fs";
import {
  parseProjectUserConfigPath,
  parseProjectUserDirectoryPath,
  parseProjectUserLoginsPath,
  parseProjectUserPasswordPath,
  resolveProjectAbsolutePath
} from "../customware/layout.js";
import { parseSimpleYaml } from "../../../app/L0/_all/modules/_core/framework/js/yaml-lite.js";
import { inspectPasswordRecord } from "./passwords.js";

function createEmptyUserRecord(username) {
  return {
    fullName: "",
    hasPassword: false,
    loginsPath: "",
    passwordPath: "",
    projectDir: "",
    sessions: [],
    userConfigPath: "",
    username
  };
}

function createEmptyUserIndex() {
  return hydrateUserIndexSnapshot();
}

function ensureUser(users, username) {
  if (!users[username]) {
    users[username] = createEmptyUserRecord(username);
  }

  return users[username];
}

function readJsonObject(filePath) {
  try {
    const sourceText = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(sourceText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function hydrateUserIndexSnapshot(snapshot = {}) {
  const users =
    snapshot.users && typeof snapshot.users === "object" && !Array.isArray(snapshot.users)
      ? {
          ...snapshot.users
        }
      : Object.create(null);
  const sessions =
    snapshot.sessions && typeof snapshot.sessions === "object" && !Array.isArray(snapshot.sessions)
      ? {
          ...snapshot.sessions
        }
      : Object.create(null);
  const errors = Array.isArray(snapshot.errors) ? [...snapshot.errors] : [];

  return {
    errors,
    getSession(sessionVerifier) {
      const normalizedVerifier = String(sessionVerifier || "").trim();
      return normalizedVerifier ? sessions[normalizedVerifier] || null : null;
    },
    getUser(username) {
      const normalizedUsername = String(username || "").trim();
      return normalizedUsername ? users[normalizedUsername] || null : null;
    },
    hasUser(username) {
      return Boolean(this.getUser(username));
    },
    sessions,
    users
  };
}

function serializeUserIndexSnapshot(snapshot = {}) {
  const hydratedSnapshot = hydrateUserIndexSnapshot(snapshot);

  return {
    errors: [...hydratedSnapshot.errors],
    sessions: {
      ...hydratedSnapshot.sessions
    },
    users: {
      ...hydratedSnapshot.users
    }
  };
}

function buildUserIndexSnapshot(context = {}) {
  const filePaths = Array.isArray(context.filePaths) ? context.filePaths : [];
  const projectRoot = String(context.projectRoot || "");
  const users = Object.create(null);
  const sessions = Object.create(null);
  const errors = [];

  filePaths.forEach((projectPath) => {
    const userDirectoryInfo = parseProjectUserDirectoryPath(projectPath);

    if (userDirectoryInfo) {
      ensureUser(users, userDirectoryInfo.username).projectDir = projectPath;
    }
  });

  filePaths.forEach((projectPath) => {
    const userConfigInfo = parseProjectUserConfigPath(projectPath);

    if (!userConfigInfo) {
      return;
    }

    const userRecord = ensureUser(users, userConfigInfo.username);
    userRecord.userConfigPath = projectPath;

    try {
      const absolutePath = resolveProjectAbsolutePath(projectRoot, projectPath, context.runtimeParams);
      const parsedConfig = parseSimpleYaml(fs.readFileSync(absolutePath, "utf8"));
      userRecord.fullName = String(parsedConfig.full_name || "").trim() || userConfigInfo.username;
    } catch (error) {
      errors.push({
        message: `Failed to parse user.yaml: ${error.message}`,
        projectPath
      });
    }
  });

  filePaths.forEach((projectPath) => {
    const userPasswordInfo = parseProjectUserPasswordPath(projectPath);

    if (!userPasswordInfo) {
      return;
    }

    const userRecord = ensureUser(users, userPasswordInfo.username);
    userRecord.passwordPath = projectPath;

    try {
      const absolutePath = resolveProjectAbsolutePath(projectRoot, projectPath, context.runtimeParams);
      const parsedConfig = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
      const passwordRecord = inspectPasswordRecord(parsedConfig);
      userRecord.hasPassword = Boolean(passwordRecord);

      if (!passwordRecord) {
        errors.push({
          message: "Ignored invalid or unsealed password.json verifier.",
          projectPath
        });
      }
    } catch (error) {
      errors.push({
        message: `Failed to parse password.json: ${error.message}`,
        projectPath
      });
    }
  });

  filePaths.forEach((projectPath) => {
    const userLoginsInfo = parseProjectUserLoginsPath(projectPath);

    if (!userLoginsInfo) {
      return;
    }

    const userRecord = ensureUser(users, userLoginsInfo.username);
    userRecord.loginsPath = projectPath;

    let parsedLogins = {};

    try {
      const absolutePath = resolveProjectAbsolutePath(projectRoot, projectPath, context.runtimeParams);
      parsedLogins = readJsonObject(absolutePath);
    } catch (error) {
      errors.push({
        message: `Failed to parse logins.json: ${error.message}`,
        projectPath
      });
      return;
    }

    Object.entries(parsedLogins).forEach(([sessionVerifier, details]) => {
      const normalizedVerifier = String(sessionVerifier || "").trim();

      if (!normalizedVerifier) {
        return;
      }

      if (sessions[normalizedVerifier]) {
        errors.push({
          message: "Ignored duplicate session verifier across users.",
          projectPath,
          sessionVerifier: normalizedVerifier
        });
        return;
      }

      const sessionDetails =
        details && typeof details === "object" && !Array.isArray(details) ? { ...details } : {};

      const sessionRecord = {
        ...sessionDetails,
        loginsPath: projectPath,
        sessionVerifier: normalizedVerifier,
        username: userLoginsInfo.username
      };

      sessions[normalizedVerifier] = sessionRecord;
      userRecord.sessions.push(sessionRecord);
    });
  });

  Object.values(users).forEach((userRecord) => {
    if (!userRecord.fullName) {
      userRecord.fullName = userRecord.username;
    }

    userRecord.sessions.sort((left, right) =>
      String(left.sessionVerifier || "").localeCompare(String(right.sessionVerifier || ""))
    );
  });

  return hydrateUserIndexSnapshot({
    errors,
    sessions,
    users
  });
}

export {
  buildUserIndexSnapshot,
  createEmptyUserIndex,
  hydrateUserIndexSnapshot,
  serializeUserIndexSnapshot
};
