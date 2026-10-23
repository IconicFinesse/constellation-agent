#!/usr/bin/env node

const { execFileSync } = require("node:child_process");

const RELEASE_TAG_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u;
// Fork releases use `vX.Y-fork.N`, where N is the fork release ordinal. It maps
// to the semver patch so each fork release stays distinct and monotonic for the
// desktop updater, while upstream-shaped `vX.Y.Z` tags keep their exact meaning.
const FORK_TAG_PATTERN = /^v?(\d+)\.(\d+)-fork\.(\d+)$/u;

function stripTagRefPrefix(value) {
  return String(value || "").trim().replace(/^refs\/tags\//u, "");
}

function parseReleaseVersion(value) {
  const normalized = stripTagRefPrefix(value);
  const forkMatch = FORK_TAG_PATTERN.exec(normalized);

  if (forkMatch) {
    const major = Number(forkMatch[1]);
    const minor = Number(forkMatch[2]);
    const forkOrdinal = Number(forkMatch[3]);

    return {
      rawValue: value,
      releaseTag: normalized.startsWith("v") ? normalized : `v${normalized}`,
      forkOrdinal,
      major,
      minor,
      patch: forkOrdinal,
      releaseVersion: `${major}.${minor}.${forkOrdinal}`,
      semver: `${major}.${minor}.${forkOrdinal}`
    };
  }

  const match = RELEASE_TAG_PATTERN.exec(normalized);

  if (!match) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2] || "0");
  const patch = Number(match[3] || "0");

  return {
    rawValue: value,
    releaseTag: normalized.startsWith("v") ? normalized : `v${normalized}`,
    major,
    minor,
    patch,
    releaseVersion: patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`,
    semver: `${major}.${minor}.${patch}`
  };
}

function normalizeBuildVersion(value) {
  const parsedReleaseVersion = parseReleaseVersion(value);
  if (parsedReleaseVersion) {
    return parsedReleaseVersion.semver;
  }

  const normalized = String(value || "").trim().replace(/^v/u, "");
  if (!normalized) {
    return "";
  }

  if (/^\d+\.\d+\.\d+$/u.test(normalized)) {
    return normalized;
  }

  if (/^\d+\.\d+$/u.test(normalized)) {
    return `${normalized}.0`;
  }

  if (/^\d+$/u.test(normalized)) {
    return `${normalized}.0.0`;
  }

  return "";
}

function resolveGitExactTag(options = {}) {
  try {
    return execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .trim()
      .split(/\s+/u)[0];
  } catch (_error) {
    return "";
  }
}

function resolveDesktopBuildVersion(options = {}) {
  const env = options.env || process.env;
  const candidates = [
    options.explicitValue,
    env.SPACE_APP_VERSION,
    env.SPACE_RELEASE_TAG,
    env.GITHUB_REF_NAME,
    resolveGitExactTag({ cwd: options.cwd }),
    options.packageVersion
  ];

  for (const candidate of candidates) {
    const normalized = normalizeBuildVersion(candidate);
    if (normalized) {
      return normalized;
    }
  }

  throw new Error("Could not resolve a desktop app version from the provided inputs.");
}

function parseCliArgs(argv) {
  const options = {
    json: false,
    value: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown release-version argument: ${arg}`);
    }

    if (options.value) {
      throw new Error("release-version accepts at most one positional tag or version.");
    }

    options.value = arg;
  }

  return options;
}

function runCli() {
  const options = parseCliArgs(process.argv.slice(2));
  const inputValue = options.value || process.env.SPACE_RELEASE_TAG || process.env.GITHUB_REF_NAME || "";
  const parsedReleaseVersion = parseReleaseVersion(inputValue);

  if (!parsedReleaseVersion) {
    throw new Error(`Could not parse release tag or version: ${inputValue || "<empty>"}`);
  }

  if (options.json) {
    console.log(JSON.stringify(parsedReleaseVersion));
    return;
  }

  console.log(parsedReleaseVersion.releaseVersion);
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  normalizeBuildVersion,
  parseReleaseVersion,
  resolveDesktopBuildVersion,
  resolveGitExactTag,
  stripTagRefPrefix
};
