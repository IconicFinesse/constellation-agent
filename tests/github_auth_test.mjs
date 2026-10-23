import assert from "node:assert/strict";
import test from "node:test";

import { buildGitAuthConfigArgs } from "../commands/lib/supervisor/git_releases.js";
import {
  buildBasicAuthHeader,
  isGitHubRemoteUrl,
  resolveGitAuth
} from "../server/lib/git/shared.js";

test("github remotes use SPACE_GITHUB_TOKEN", () => {
  const remoteUrl = "https://github.com/IconicFinesse/constellation-agent.git";
  const env = {
    GH_TOKEN: "gh-token",
    GITHUB_TOKEN: "github-token",
    SPACE_GIT_TOKEN: "space-git-token",
    SPACE_GITHUB_TOKEN: "space-github-token"
  };

  assert.equal(isGitHubRemoteUrl(remoteUrl), true);
  assert.deepEqual(resolveGitAuth(remoteUrl, {}, env), {
    token: "space-github-token",
    username: "git"
  });
});

test("github remotes do not send auth when SPACE_GITHUB_TOKEN is missing", () => {
  const remoteUrl = "https://github.com/IconicFinesse/constellation-agent.git";
  const env = {
    GH_TOKEN: "gh-token",
    GITHUB_TOKEN: "github-token",
    SPACE_GIT_TOKEN: "space-git-token"
  };

  assert.equal(buildBasicAuthHeader(remoteUrl, {}, env), "");
  assert.deepEqual(buildGitAuthConfigArgs(remoteUrl, env), []);
});

test("supervisor injects git authorization header only when github token is configured", () => {
  const remoteUrl = "https://github.com/IconicFinesse/constellation-agent.git";
  const args = buildGitAuthConfigArgs(remoteUrl, {
    SPACE_GITHUB_TOKEN: "secret-token"
  });

  assert.equal(args.length, 2);
  assert.equal(args[0], "-c");
  assert.match(args[1], /^http\.extraHeader=Authorization: Basic /);
});
