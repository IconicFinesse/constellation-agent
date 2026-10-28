#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSimpleYaml,
  parseYamlScalar,
  serializeSimpleYaml,
  SimpleYamlError
} from "../app/L0/_all/modules/_core/framework/js/yaml-lite.js";
import { parseAdminAgentParamsText } from "../app/L0/_all/modules/_core/admin/views/agent/llm-params.js";
import { parseOnscreenAgentParamsText } from "../app/L0/_all/modules/_core/onscreen_agent/llm-params.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const YAML_DIRECTORIES = ["app", "server", "tests"];

async function main() {
  verifyScalarParsing();
  verifyFlowStrictness();
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

// A plain scalar may not START with a flow indicator or a quote. Before this
// rule an unterminated `[1, 2` parsed successfully as the STRING "[1, 2", so a
// corrupt manifest silently carried a string where a list belonged. Each case
// below is a silent-type-corruption shape, asserted to THROW; the paired
// balanced cases must still parse, so the rule cannot pass by rejecting
// everything.
function verifyFlowStrictness() {
  const rejected = ["a: [1, 2", "a: {b: 1", "a: [1, 2}", "a: {b: 1]", "a: 'unterminated", 'a: "unterminated', "a: ]", "a: }"];

  for (const sourceText of rejected) {
    assert.throws(
      () => parseSimpleYaml(sourceText),
      SimpleYamlError,
      `expected a parse error for: ${JSON.stringify(sourceText)}`
    );
  }

  const accepted = [
    ["a: [1, 2]", { a: [1, 2] }],
    ["a: {b: 1}", { a: { b: 1 } }],
    ["a: []", { a: [] }],
    ["a: {}", { a: {} }],
    ["a: 'x'", { a: "x" }],
    ['a: "x"', { a: "x" }],
    // A bracket AFTER the first character is ordinary scalar content, never a
    // flow collection, so the strictness rule must not touch these.
    ["a: x[1", { a: "x[1" }],
    ["a: plain }", { a: "plain }" }]
  ];

  for (const [sourceText, expected] of accepted) {
    assert.deepEqual(parseSimpleYaml(sourceText), expected, sourceText);
  }

  // The round-trip proof: the string a corrupt parse used to produce is still
  // representable, but only through quoting, so parse(serialize(x)) == x.
  for (const value of ["[1, 2", "{b: 1", "'odd", '"odd']) {
    const serialized = serializeSimpleYaml({ a: value });
    assert.deepEqual(parseSimpleYaml(serialized), { a: value }, serialized);
  }
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
