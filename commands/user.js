import fs from "node:fs";
import path from "node:path";

import { createUser, setUserPassword } from "../server/lib/auth/user_manage.js";
import {
  AUTH_KEYS_FILENAME,
  PASSWORD_SEAL_KEY_ENV_NAME,
  SESSION_HMAC_KEY_ENV_NAME,
  buildAuthDataDir
} from "../server/lib/auth/keys_manage.js";
import { addGroupEntry } from "../server/lib/customware/group_files.js";
import { flushGitHistoryCommits } from "../server/lib/customware/git_history.js";
import { normalizeEntityId } from "../server/lib/customware/layout.js";
import { createRuntimeParams } from "../server/lib/utils/runtime_params.js";

const PASSWORD_SEAL_KEY_NAME = "password_seal_key";

function buildLegacySupervisorAuthKeysPath(projectRoot) {
  return path.join(String(projectRoot || ""), "supervisor", "auth", AUTH_KEYS_FILENAME);
}

function readPasswordSealKeyText(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return String(parsed?.[PASSWORD_SEAL_KEY_NAME] || "").trim();
  } catch {
    return "";
  }
}

function sameSecretKeyText(left, right) {
  return Buffer.from(String(left || ""), "base64url").equals(
    Buffer.from(String(right || ""), "base64url")
  );
}

// Sealing and opening a verifier must use the same backend key material. A running
// `space supervise` child only accepts verifiers sealed by the key source it was
// started with, so surface the realistic mismatch setups before writing anything.
// This helper is read-only on purpose: loadAuthKeys() would create a key store.
function reportAuthKeySourceWarnings(projectRoot) {
  const injectedSealKey = String(process.env[PASSWORD_SEAL_KEY_ENV_NAME] || "").trim();
  const injectedSessionKey = String(process.env[SESSION_HMAC_KEY_ENV_NAME] || "").trim();

  if (injectedSealKey || injectedSessionKey) {
    console.warn(
      `[user] Sealing this verifier with ${PASSWORD_SEAL_KEY_ENV_NAME}/${SESSION_HMAC_KEY_ENV_NAME} from the environment; every space serve or space supervise process must receive the same values or login fails with "Invalid username or password".`
    );
    return;
  }

  const legacyFilePath = buildLegacySupervisorAuthKeysPath(projectRoot);
  const legacySealKey = readPasswordSealKeyText(legacyFilePath);

  if (!legacySealKey) {
    return;
  }

  const canonicalFilePath = path.join(
    buildAuthDataDir(projectRoot, process.env),
    AUTH_KEYS_FILENAME
  );
  const canonicalSealKey = readPasswordSealKeyText(canonicalFilePath);

  if (canonicalSealKey && sameSecretKeyText(legacySealKey, canonicalSealKey)) {
    return;
  }

  console.warn(
    `[user] A different supervisor auth-key store exists at ${legacyFilePath}.`
  );
  console.warn(
    "[user] space supervise migrates that store only when the canonical auth-key file is absent, so users sealed with it stay unreadable until they are re-sealed with the active key source."
  );
}

function takeFlagValue(args, index, flagName) {
  const value = String(args[index + 1] || "");

  if (!value) {
    throw new Error(`Missing value for ${flagName}.`);
  }

  return value;
}

function normalizeGroupList(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => normalizeEntityId(value))
    .filter(Boolean);
}

function parseCreateArgs(args) {
  const options = {
    force: false,
    fullName: "",
    groups: [],
    password: "",
    username: ""
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!options.username && !arg.startsWith("--")) {
      options.username = arg;
      continue;
    }

    if (arg === "--password") {
      options.password = takeFlagValue(args, index, "--password");
      index += 1;
      continue;
    }

    if (arg === "--full-name") {
      options.fullName = takeFlagValue(args, index, "--full-name");
      index += 1;
      continue;
    }

    if (arg === "--groups") {
      options.groups.push(...normalizeGroupList(takeFlagValue(args, index, "--groups")));
      index += 1;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    throw new Error(`Unknown user create argument: ${arg}`);
  }

  if (!options.username || !options.password) {
    throw new Error(
      "Usage: node space user create <username> --password <password> [--full-name <name>] [--groups <group[,group...]>] [--force]"
    );
  }

  options.groups = [...new Set(options.groups)].sort((left, right) => left.localeCompare(right));
  return options;
}

function parsePasswordArgs(args) {
  const options = {
    password: "",
    username: ""
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!options.username && !arg.startsWith("--")) {
      options.username = arg;
      continue;
    }

    if (arg === "--password") {
      options.password = takeFlagValue(args, index, "--password");
      index += 1;
      continue;
    }

    throw new Error(`Unknown user password argument: ${arg}`);
  }

  if (!options.username || !options.password) {
    throw new Error("Usage: node space user password <username> --password <password>");
  }

  return options;
}

export const help = {
  name: "user",
  summary: "Manage L2 users and passwords.",
  usage: [
    "node space user create <username> --password <password> [--full-name <name>] [--groups <group[,group...]>] [--force]",
    "node space user password <username> --password <password>"
  ],
  description:
    "Creates L2 users, stores user metadata in user.yaml, stores the password verifier in metadata/password.json, and clears existing login sessions in metadata/logins.json when the password changes. When CUSTOMWARE_PATH is configured the writable L2 tree lives under CUSTOMWARE_PATH/L2. User creation may also add the user to writable L1 groups.",
  arguments: [
    {
      name: "<username>",
      description: "User id under the logical L2/<username>/ root, stored under CUSTOMWARE_PATH/L2 when configured."
    }
  ],
  options: [
    {
      flag: "create",
      description: "Create a user directory with user.yaml, metadata/password.json, metadata/logins.json, and mod/."
    },
    {
      flag: "password",
      description: "Reset a user's password and clear existing sessions."
    },
    {
      flag: "--full-name <name>",
      description: "Full name written to user.yaml. Defaults to the user id."
    },
    {
      flag: "--password <password>",
      description: "Password used for create or password subcommands."
    },
    {
      flag: "--groups <group[,group...]>",
      description: "Comma-separated groups to add during user creation. Missing writable L1 groups are created automatically."
    },
    {
      flag: "--force",
      description: "Replace the full user directory during create."
    }
  ],
  examples: [
    "node space user create alice --password secret123",
    "node space user create alice --password secret123 --full-name \"Alice Example\"",
    "node space user create alice --password secret123 --groups _admin,team-red",
    "node space user password alice --password newsecret456"
  ]
};

export async function execute(context) {
  const subcommand = String(context.args[0] || "").trim().toLowerCase();
  const subcommandArgs = context.args.slice(1);
  const runtimeParams = await createRuntimeParams(context.projectRoot, {
    env: context.originalEnv
  });

  if (subcommand === "create") {
    const options = parseCreateArgs(subcommandArgs);
    reportAuthKeySourceWarnings(context.projectRoot);
    const result = createUser(context.projectRoot, options.username, options.password, {
      force: options.force,
      fullName: options.fullName,
      runtimeParams
    });
    for (const groupId of options.groups) {
      addGroupEntry(context.projectRoot, groupId, "user", result.username, {
        runtimeParams
      });
    }
    await flushGitHistoryCommits({ throwOnError: true });
    const groupSummary = options.groups.length ? ` and added to ${options.groups.join(", ")}` : "";
    console.log(`Created user ${result.username}${groupSummary}`);
    return 0;
  }

  if (subcommand === "password" || subcommand === "passwd") {
    const options = parsePasswordArgs(subcommandArgs);
    reportAuthKeySourceWarnings(context.projectRoot);
    const result = setUserPassword(context.projectRoot, options.username, options.password, {
      runtimeParams
    });
    await flushGitHistoryCommits({ throwOnError: true });
    console.log(`Updated password for ${result.username}`);
    return 0;
  }

  throw new Error(
    'Unknown user subcommand. Use "node space help user" for available subcommands.'
  );
}

export const __test = {
  reportAuthKeySourceWarnings
};
