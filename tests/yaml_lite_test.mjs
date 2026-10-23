#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSimpleYaml,
  parseYamlScalar,
  serializeSimpleYaml
} from "../app/L0/_all/modules/_core/framework/js/yaml-lite.js";
import { parseAdminAgentParamsText } from "../app/L0/_all/modules/_core/admin/views/agent/llm-params.js";
import { parseOnscreenAgentParamsText } from "../app/L0/_all/modules/_core/onscreen_agent/llm-params.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const YAML_DIRECTORIES = ["app", "server", "tests"];

async function main() {
  verifyScalarParsing();
  verifySerializerCompatibility();
  verifyCompactNestedParsing();
  verifyRoundTrips();
  verifyParamsParsing();
  await verifyRepoYamlCorpus();
  console.log("yaml_lite_test: ok");
}

function verifyScalarParsing() {
  assert.equal(parseYamlScalar(" 42 "), 42);
  assert.equal(parseYamlScalar(" true "), true);
  assert.equal(parseYamlScalar(""), "");
  assert.deepEqual(parseYamlScalar("[one, two, 3]"), ["one", "two", 3]);
}

function verifySerializerCompatibility() {
  const samples = [
    {
      expected: "{}\n",
      name: "empty object",
      value: {}
    },
    {
      expected: "{}\n",
      name: "null root defaults to empty object",
      value: null
    },
    {
      expected: "[]\n",
      name: "empty array",
      value: []
    },
    {
      expected: "a:\n",
      name: "undefined value",
      value: { a: undefined }
    },
    {
      expected: "a: {}\nb: []\nc:\n",
      name: "nested empties",
      value: { a: {}, b: [], c: null }
    },
    {
      expected: "renderer: |\n  a\n  b\n",
      name: "multiline string with trailing newline",
      value: { renderer: "a\nb\n" }
    },
    {
      expected: "renderer: |-\n  a\n  b\n",
      name: "multiline string without trailing newline",
      value: { renderer: "a\nb" }
    },
    {
      expected: "yes: \"true\"\nnum: \"01\"\nempty: \"\"\nspaced: \" hi \"\ncolon: \"a: b\"\nhash: \"a # b\"\n",
      name: "ambiguous strings are quoted",
      value: {
        yes: "true",
        num: "01",
        empty: "",
        spaced: " hi ",
        colon: "a: b",
        hash: "a # b"
      }
    }
  ];

  for (const sample of samples) {
    assert.equal(serializeSimpleYaml(sample.value), sample.expected, sample.name);
  }
}

function verifyCompactNestedParsing() {
  const sourceText = [
    "items:",
    "  - rank: 1",
    "    name: first",
    "    failed_cases:",
    "      - a",
    "      - b",
    "  - rank: 2",
    "    name: second",
    "matrix:",
    "  - - 1",
    "    - 2",
    "  - - 3",
    "    - 4",
    "renderer: |-",
    "  line one",
    "  line two",
    ""
  ].join("\n");

  assert.deepEqual(parseSimpleYaml(sourceText), {
    items: [
      {
        rank: 1,
        name: "first",
        failed_cases: ["a", "b"]
      },
      {
        rank: 2,
        name: "second"
      }
    ],
    matrix: [
      [1, 2],
      [3, 4]
    ],
    renderer: "line one\nline two"
  });
}

function verifyRoundTrips() {
  const cases = [
    {
      name: "deep nested object",
      value: {
        name: "demo",
        enabled: true,
        count: 3,
        ratio: 1.5,
        tags: ["alpha", "beta", "gamma"],
        nested: {
          emptyMap: {},
          emptyList: [],
          profile: {
            title: "captain",
            flags: [true, false, null],
            scores: [1, 2, 3],
            meta: {
              owner: "pan",
              retries: 2,
              config: {
                mode: "strict",
                thresholds: [0.1, 0.5, 0.9]
              }
            }
          },
          matrix: [
            [1, 2],
            [3, 4]
          ],
          items: [
            {
              id: "first",
              values: ["a", "b"]
            },
            {
              id: "second",
              values: ["c"],
              options: {
                active: true,
                retries: 1
              }
            }
          ]
        }
      }
    },
    {
      name: "widget-like object",
      value: {
        id: "weather-prostejov",
        name: "Weather",
        cols: 4,
        rows: 3,
        renderer: "async (parent) => {\n  parent.textContent = \"hello\";\n}\n"
      }
    }
  ];

  for (const testCase of cases) {
    const serialized = serializeSimpleYaml(testCase.value);
    const parsed = parseSimpleYaml(serialized);
    assert.deepEqual(parsed, testCase.value, testCase.name);
  }
}

function verifyParamsParsing() {
  const paramsText = [
    "temperature:0.2",
    "stop:",
    "  - END",
    "metadata:",
    "  retries: 2",
    ""
  ].join("\n");

  const expected = {
    temperature: 0.2,
    stop: ["END"],
    metadata: {
      retries: 2
    }
  };

  assert.deepEqual(parseOnscreenAgentParamsText(paramsText), expected);
  assert.deepEqual(parseAdminAgentParamsText(paramsText), expected);
  assert.throws(() => parseOnscreenAgentParamsText("- bad\n"), /LLM params must be YAML key: value pairs/u);
}

async function verifyRepoYamlCorpus() {
  const yamlFiles = [];

  for (const directory of YAML_DIRECTORIES) {
    await collectYamlFiles(path.join(ROOT_DIR, directory), yamlFiles);
  }

  for (const filePath of yamlFiles) {
    const sourceText = await fs.readFile(filePath, "utf8");

    assert.doesNotThrow(() => {
      parseSimpleYaml(sourceText);
    }, path.relative(ROOT_DIR, filePath));
  }
}

async function collectYamlFiles(currentPath, results) {
  const entries = await fs.readdir(currentPath, {
    withFileTypes: true
  });

  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await collectYamlFiles(absolutePath, results);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!/\.ya?ml$/iu.test(entry.name)) {
      continue;
    }

    results.push(absolutePath);
  }
}

main().catch((error) => {
  console.error("yaml_lite_test: failed");
  console.error(error);
  process.exitCode = 1;
});
