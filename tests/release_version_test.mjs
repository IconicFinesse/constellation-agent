import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  normalizeBuildVersion,
  parseReleaseVersion,
  stripTagRefPrefix
} = require("../packaging/scripts/release-version.js");

test("plain semver tags keep their existing mapping", () => {
  const released = parseReleaseVersion("v0.40.0");
  assert.equal(released.releaseTag, "v0.40.0");
  assert.equal(released.semver, "0.40.0");
  assert.equal(released.releaseVersion, "0.40");

  const full = parseReleaseVersion("v1.2.3");
  assert.equal(full.semver, "1.2.3");
  assert.equal(full.releaseVersion, "1.2.3");
});

test("fork release tags parse with the fork ordinal as the patch", () => {
  const seventh = parseReleaseVersion("v0.66-fork.7");
  assert.notEqual(seventh, null, "v0.66-fork.7 must parse");
  assert.equal(seventh.releaseTag, "v0.66-fork.7");
  assert.equal(seventh.major, 0);
  assert.equal(seventh.minor, 66);
  assert.equal(seventh.patch, 7);
  assert.equal(seventh.semver, "0.66.7");
  assert.equal(seventh.releaseVersion, "0.66.7");

  const sixth = parseReleaseVersion("v0.66-fork.6");
  assert.equal(sixth.semver, "0.66.6");

  const first = parseReleaseVersion("v0.66-fork.1");
  assert.equal(first.semver, "0.66.1");
});

test("fork tags stay monotonic for the desktop updater", () => {
  const versions = ["v0.66-fork.1", "v0.66-fork.6", "v0.66-fork.7"]
    .map((tag) => parseReleaseVersion(tag).semver);
  assert.deepEqual(versions, ["0.66.1", "0.66.6", "0.66.7"]);
  const numeric = versions.map((v) => v.split(".").map(Number));
  for (let i = 1; i < numeric.length; i += 1) {
    const prev = numeric[i - 1];
    const cur = numeric[i];
    const greater = cur[0] > prev[0]
      || (cur[0] === prev[0] && cur[1] > prev[1])
      || (cur[0] === prev[0] && cur[1] === prev[1] && cur[2] > prev[2]);
    assert.equal(greater, true);
  }
});

test("refs/tags prefixes are stripped before parsing fork tags", () => {
  assert.equal(stripTagRefPrefix("refs/tags/v0.66-fork.7"), "v0.66-fork.7");
  const parsed = parseReleaseVersion("refs/tags/v0.66-fork.7");
  assert.equal(parsed.releaseTag, "v0.66-fork.7");
  assert.equal(parsed.semver, "0.66.7");
});

test("bare and prefixed fork versions normalize to semver", () => {
  assert.equal(normalizeBuildVersion("v0.66-fork.7"), "0.66.7");
  assert.equal(normalizeBuildVersion("0.66-fork.7"), "0.66.7");
});

test("unparseable input is still rejected", () => {
  assert.equal(parseReleaseVersion("v0.66-fork"), null);
  assert.equal(parseReleaseVersion("v0.66-fork."), null);
  assert.equal(parseReleaseVersion("nightly"), null);
  assert.equal(parseReleaseVersion(""), null);
});
