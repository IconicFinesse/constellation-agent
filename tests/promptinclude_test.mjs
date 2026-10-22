import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const {
  buildPromptIncludeSystemPromptItems,
  buildPromptIncludeSystemPromptSection,
  buildPromptIncludeSystemPromptSections,
  buildPromptIncludeTransientItems,
  buildPromptIncludeTransientSection,
  listPromptIncludePaths,
  SYSTEM_PROMPT_INCLUDE_FILE_PATTERN,
  TRANSIENT_PROMPT_INCLUDE_FILE_PATTERN
} = await import("../app/L0/_all/mod/_core/promptinclude/promptinclude.js");

function withStubbedSpace(testContext, spaceRuntime) {
  const previousSpace = globalThis.space;

  testContext.after(() => {
    if (previousSpace === undefined) {
      delete globalThis.space;
      return;
    }

    globalThis.space = previousSpace;
  });

  globalThis.space = spaceRuntime;
}

test("buildPromptIncludeSystemPromptSection returns the required stable instructions", () => {
  assert.equal(
    buildPromptIncludeSystemPromptSection(),
    [
      "## prompt includes",
      "*.system.include.md files auto-injected below into system prompt",
      "use for durable rules preferences instructions",
      "*.transient.include.md files auto-injected into transient context",
      "use for durable notes knowledge project context",
      "create/edit/delete persist across conversations",
      "never just acknowledge verbally always persist to file",
      "alphabetical by full path within each include type"
    ].join("\n")
  );
});

test("listPromptIncludePaths sorts unique prompt include paths by full logical path", async (testContext) => {
  withStubbedSpace(testContext, {
    api: {
      async call(endpointName, options) {
        assert.equal(endpointName, "file_paths");
        assert.equal(options?.method, "POST");
        assert.deepEqual(options?.body, {
          patterns: [SYSTEM_PROMPT_INCLUDE_FILE_PATTERN, TRANSIENT_PROMPT_INCLUDE_FILE_PATTERN]
        });

        return {
          [SYSTEM_PROMPT_INCLUDE_FILE_PATTERN]: [
            "L2/usr/workdir/z-last.system.include.md",
            "/L1/_all/a-first.system.include.md"
          ],
          [TRANSIENT_PROMPT_INCLUDE_FILE_PATTERN]: [
            "L2/usr/workdir/z-last.transient.include.md",
            "L2/usr/workdir/z-last.transient.include.md"
          ]
        };
      },
      async fileRead() {
        throw new Error("fileRead should not be called when only listing prompt includes.");
      }
    }
  });

  const promptIncludePaths = await listPromptIncludePaths();

  assert.deepEqual(promptIncludePaths, [
    "L1/_all/a-first.system.include.md",
    "L2/usr/workdir/z-last.system.include.md",
    "L2/usr/workdir/z-last.transient.include.md"
  ]);
});

test("buildPromptIncludeSystemPromptSections reads system include files after the instructions block", async (testContext) => {
  withStubbedSpace(testContext, {
    api: {
      async call(endpointName, options) {
        assert.equal(endpointName, "file_paths");
        assert.equal(options?.method, "POST");
        assert.deepEqual(options?.body, {
          patterns: [SYSTEM_PROMPT_INCLUDE_FILE_PATTERN]
        });

        return {
          [SYSTEM_PROMPT_INCLUDE_FILE_PATTERN]: [
            "L2/usr/workdir/z-last.system.include.md",
            "L2/usr/workdir/a-first.system.include.md"
          ]
        };
      },
      async fileRead(options) {
        assert.deepEqual(options, {
          files: [
            "L2/usr/workdir/a-first.system.include.md",
            "L2/usr/workdir/z-last.system.include.md"
          ]
        });

        return {
          files: [
            {
              path: "L2/usr/workdir/z-last.system.include.md",
              content: "second rule"
            },
            {
              path: "L2/usr/workdir/a-first.system.include.md",
              content: "first rule"
            }
          ]
        };
      }
    }
  });

  const systemPromptSections = await buildPromptIncludeSystemPromptSections();

  assert.deepEqual(systemPromptSections, [
    [
      "## prompt includes",
      "*.system.include.md files auto-injected below into system prompt",
      "use for durable rules preferences instructions",
      "*.transient.include.md files auto-injected into transient context",
      "use for durable notes knowledge project context",
      "create/edit/delete persist across conversations",
      "never just acknowledge verbally always persist to file",
      "alphabetical by full path within each include type"
    ].join("\n"),
    "source: /L2/usr/workdir/a-first.system.include.md\nfirst rule",
    "source: /L2/usr/workdir/z-last.system.include.md\nsecond rule"
  ]);
});

test("buildPromptIncludeSystemPromptItems returns keyed ordered prompt items", async (testContext) => {
  withStubbedSpace(testContext, {
    api: {
      async call(endpointName, options) {
        assert.equal(endpointName, "file_paths");
        assert.equal(options?.method, "POST");
        assert.deepEqual(options?.body, {
          patterns: [SYSTEM_PROMPT_INCLUDE_FILE_PATTERN]
        });

        return {
          [SYSTEM_PROMPT_INCLUDE_FILE_PATTERN]: [
            "L2/usr/workdir/z-last.system.include.md",
            "L2/usr/workdir/a-first.system.include.md"
          ]
        };
      },
      async fileRead(options) {
        assert.deepEqual(options, {
          files: [
            "L2/usr/workdir/a-first.system.include.md",
            "L2/usr/workdir/z-last.system.include.md"
          ]
        });

        return {
          files: [
            {
              path: "L2/usr/workdir/z-last.system.include.md",
              content: "second rule"
            },
            {
              path: "L2/usr/workdir/a-first.system.include.md",
              content: "first rule"
            }
          ]
        };
      }
    }
  });

  const systemPromptItems = await buildPromptIncludeSystemPromptItems();

  assert.deepEqual(systemPromptItems, {
    "promptinclude:instructions": {
      order: 140,
      trimAllowed: false,
      value: buildPromptIncludeSystemPromptSection()
    },
    "promptinclude:system:L2/usr/workdir/a-first.system.include.md": {
      order: 150,
      sourcePath: "L2/usr/workdir/a-first.system.include.md",
      trimAllowed: undefined,
      trimPriority: 30,
      value: "first rule"
    },
    "promptinclude:system:L2/usr/workdir/z-last.system.include.md": {
      order: 151,
      sourcePath: "L2/usr/workdir/z-last.system.include.md",
      trimAllowed: undefined,
      trimPriority: 30,
      value: "second rule"
    }
  });
});

test("buildPromptIncludeTransientSection reads transient include files and formats one fenced block per include", async (testContext) => {
  withStubbedSpace(testContext, {
    api: {
      async call(endpointName, options) {
        assert.equal(endpointName, "file_paths");
        assert.equal(options?.method, "POST");
        assert.deepEqual(options?.body, {
          patterns: [TRANSIENT_PROMPT_INCLUDE_FILE_PATTERN]
        });

        return {
          [TRANSIENT_PROMPT_INCLUDE_FILE_PATTERN]: [
            "L2/usr/workdir/z-last.transient.include.md",
            "L2/usr/workdir/a-first.transient.include.md"
          ]
        };
      },
      async fileRead(options) {
        assert.deepEqual(options, {
          files: [
            "L2/usr/workdir/a-first.transient.include.md",
            "L2/usr/workdir/z-last.transient.include.md"
          ]
        });

        return {
          files: [
            {
              path: "L2/usr/workdir/z-last.transient.include.md",
              content: "# Z Last\n"
            },
            {
              path: "L2/usr/workdir/a-first.transient.include.md",
              content: "Line before\n```\ninside\n```"
            }
          ]
        };
      }
    }
  });

  const transientSection = await buildPromptIncludeTransientSection();

  assert.deepEqual(transientSection, {
    content: [
      "/L2/usr/workdir/a-first.transient.include.md",
      "````",
      "Line before\n```\ninside\n```",
      "````",
      "",
      "/L2/usr/workdir/z-last.transient.include.md",
      "```",
      "# Z Last\n",
      "```"
    ].join("\n"),
    heading: "prompt includes",
    key: "prompt-includes",
    order: 0
  });
});

test("buildPromptIncludeTransientItems returns keyed prompt items and preserves explicit metadata", async () => {
  const transientItems = await buildPromptIncludeTransientItems({
    entries: [
      {
        content: "first body",
        heading: "Custom heading",
        key: "custom-transient-item",
        order: 222,
        path: "L2/usr/workdir/custom.transient.include.md",
        trimAllowed: false,
        trimPriority: 7
      },
      {
        content: "second body",
        path: "L2/usr/workdir/second.transient.include.md"
      }
    ],
    order: 90
  });

  assert.deepEqual(transientItems, {
    "custom-transient-item": {
      heading: "Custom heading",
      order: 222,
      sourcePath: "L2/usr/workdir/custom.transient.include.md",
      trimAllowed: false,
      trimPriority: 7,
      value: "```\nfirst body\n```"
    },
    "promptinclude:transient:L2/usr/workdir/second.transient.include.md": {
      heading: "/L2/usr/workdir/second.transient.include.md",
      order: 91,
      sourcePath: "L2/usr/workdir/second.transient.include.md",
      trimAllowed: undefined,
      trimPriority: 30,
      value: "```\nsecond body\n```"
    }
  });
});
