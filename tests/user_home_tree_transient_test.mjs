import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUserHomeFileTreeLines,
  buildUserHomeFileTreeTransientSection,
  USER_HOME_FILE_TREE_DEFAULTS,
  USER_HOME_FILE_TREE_TRANSIENT_KEY
} from "../app/L0/_all/mod/_core/onscreen_agent/prompt-context.js";

test("buildUserHomeFileTreeTransientSection shows an empty root when no files are present", () => {
  assert.deepEqual(buildUserHomeFileTreeTransientSection({ paths: [] }), {
    content: [
      "~/",
      "  # empty"
    ].join("\n"),
    heading: "user home files",
    key: USER_HOME_FILE_TREE_TRANSIENT_KEY,
    order: 100
  });
});

test("USER_HOME_FILE_TREE_DEFAULTS exposes the current prompt budget", () => {
  assert.deepEqual(USER_HOME_FILE_TREE_DEFAULTS, {
    maxDepth: 5,
    maxFilesPerFolder: 20,
    maxFoldersPerFolder: 20,
    maxLines: 250
  });
});

test("buildUserHomeFileTreeLines omits .git directories and their descendants", () => {
  assert.deepEqual(
    buildUserHomeFileTreeLines(
      [
        "~/.git/",
        "~/.git/config",
        "~/.git/objects/ab/cd",
        "~/config/",
        "~/config/app.yaml",
        "~/user.yaml"
      ],
      {
        maxLines: 20
      }
    ),
    [
      "~/",
      "  config/",
      "    app.yaml",
      "  user.yaml"
    ]
  );
});

test("buildUserHomeFileTreeLines lists folders first and caps per-folder folders and files", () => {
  assert.deepEqual(
    buildUserHomeFileTreeLines(
      [
        "~/delta/",
        "~/beta/",
        "~/alpha/",
        "~/gamma/",
        "~/c.txt",
        "~/a.txt",
        "~/b.txt"
      ],
      {
        maxFilesPerFolder: 2,
        maxFoldersPerFolder: 2,
        maxLines: 20
      }
    ),
    [
      "~/",
      "  alpha/",
      "  beta/",
      "  # 2 more folders",
      "  a.txt",
      "  b.txt",
      "  # 1 more files"
    ]
  );
});

test("buildUserHomeFileTreeLines marks undisplayed children at the depth limit", () => {
  assert.deepEqual(
    buildUserHomeFileTreeLines(
      [
        "~/projects/app/src/index.js",
        "~/projects/app/README.md"
      ],
      {
        maxDepth: 2,
        maxLines: 20
      }
    ),
    [
      "~/",
      "  projects/",
      "    app/",
      "      # 1 more folders (max depth)",
      "      # 1 more files (max depth)"
    ]
  );
});

test("buildUserHomeFileTreeLines keeps a visible line-limit summary when the tree is truncated", () => {
  assert.deepEqual(
    buildUserHomeFileTreeLines(
      [
        "~/alpha/a/1.txt",
        "~/alpha/b/2.txt",
        "~/beta.txt"
      ],
      {
        maxDepth: 4,
        maxFilesPerFolder: 8,
        maxFoldersPerFolder: 8,
        maxLines: 4
      }
    ),
    [
      "~/",
      "  alpha/",
      "    # 2 more folders (line limit)",
      "  beta.txt"
    ]
  );
});
