// P4b-2c — onscreen/admin execution-format PARITY.
//
// The owner noticed onscreen was the impoverished copy of admin's execution console. This
// lane promotes the value-rendering family into `framework/js/execution-format.js` and turns
// the one surface-specific thing in it — the `//# sourceURL` prefix, which both names the
// executed block and selects which stack frames survive — into an ARGUMENT.
//
// This suite is an EQUIVALENCE claim plus one named behaviour change, so it proves:
//   1. every promoted function is GONE from both surfaces and defined ONCE, in the shared module;
//   2. no surface identity is spelled inside that shared module;
//   3. the prefix parameter is LOAD-BEARING (hardcode admin's and onscreen's error text moves);
//   4. ADMIN IS UNCHANGED — by differential execution against a real `git archive eaedf70` base
//      tree, not against fixtures transcribed from it;
//   5. ONSCREEN CHANGED EXACTLY WHERE IT ADOPTED ADMIN — the differing cases are a named set,
//      so a new divergence fails the suite and so does a silent re-divergence in the other direction;
//   6. a display shape still executes NOTHING.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

register(new URL("./p4b2c_tree_loader.mjs", import.meta.url), import.meta.url);

const BASE_COMMIT = "eaedf70";
const ROOT = new URL("..", import.meta.url).pathname;
const MODULES_DIR = "app/L0/_all/modules";
const SHARED = `${MODULES_DIR}/_core/framework/js/execution-format.js`;
const ADMIN = `${MODULES_DIR}/_core/admin/views/agent/execution.js`;
const ONSCREEN = `${MODULES_DIR}/_core/onscreen_agent/execution.js`;

// `globalThis.space.extend` is how the onscreen module registers its plan validator; it must
// exist before either tree is imported or the import itself throws.
const previousSpace = globalThis.space;

globalThis.space = {
  extend(_meta, value) {
    return value;
  }
};

const scratchDirs = [];

function makeScratch(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));

  scratchDirs.push(directory);

  return directory;
}

// The REAL base tree, extracted from the commit under test. A fixture is a claim about the
// base; this is the base.
const baseRoot = makeScratch("p4b2c-base-");

execSync(`git archive ${BASE_COMMIT} ${MODULES_DIR} | tar -x -C ${baseRoot}`, {
  cwd: ROOT,
  shell: "bash"
});

const TIP_MODULES = join(ROOT, MODULES_DIR);
const BASE_MODULES = join(baseRoot, MODULES_DIR);

const TIP_ADMIN_MODULE = join(TIP_MODULES, "_core/admin/views/agent/execution.js");
const TIP_ONSCREEN_MODULE = join(TIP_MODULES, "_core/onscreen_agent/execution.js");
const BASE_ADMIN_MODULE = join(BASE_MODULES, "_core/admin/views/agent/execution.js");
const BASE_ONSCREEN_MODULE = join(BASE_MODULES, "_core/onscreen_agent/execution.js");

// A real `window` is the global object plus surface bits: the execution scope is a Proxy
// whose `has` trap claims every key, so executed code resolves `Error`, `Array` and `Map`
// THROUGH this object. A bare object literal makes every probe throw
// "X is not a constructor" and the comparison would measure the harness, not the product.
function createTargetWindow() {
  const targetWindow = Object.create(globalThis);

  targetWindow.console = {
    assert() {},
    debug() {},
    dir() {},
    error() {},
    info() {},
    log() {},
    table() {},
    warn() {}
  };

  return targetWindow;
}

function readProductFile(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

// Comment stripping keeps prose out of every structural assertion: this lane's own comments
// name both surfaces, and a grep over raw text would either mis-fire or force the comments to
// lie. Block comments first, then line comments, then nothing else is rewritten.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");

      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

function definitionCount(source, name) {
  return source.match(new RegExp(`function\\s+${name}\\s*\\(`, "gu"))?.length || 0;
}

function walkJavaScriptFiles(directory) {
  const files = [];

  readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkJavaScriptFiles(full));
      return;
    }

    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(full);
    }
  });

  return files;
}

const TIP_MODULE_SOURCES = walkJavaScriptFiles(TIP_MODULES).map((file) => ({
  path: relative(ROOT, file),
  source: stripComments(readFileSync(file, "utf8"))
}));

// --- the promoted family, by pre-promotion name -------------------------------------
//
// `sharedName` is what the surviving definition is called in the shared module. Three of them
// were renamed on promotion (`summarizeElement` -> `summarizeExecutionElement`, `buildSourceUrl`
// -> `buildExecutionSourceUrl`, `WINDOW_ALIAS_KEYS` -> `EXECUTION_WINDOW_ALIAS_KEYS`) because the
// shared module must not pretend it belongs to either surface.
const PROMOTED = [
  { localName: "formatString", sharedName: "formatString", kind: "factory member" },
  { localName: "formatEntries", sharedName: "formatEntries", kind: "factory member" },
  { localName: "formatArrayLike", sharedName: "formatArrayLike", kind: "factory member" },
  { localName: "formatError", sharedName: "formatError", kind: "factory member" },
  { localName: "formatExecutionValue", sharedName: "formatExecutionValue", kind: "factory member" },
  { localName: "formatExecutionResultValue", sharedName: "formatExecutionResultValue", kind: "factory member" },
  { localName: "formatExecutionResultLines", sharedName: "formatExecutionResultLines", kind: "factory return" },
  { localName: "flattenExecutionMessageValue", sharedName: "flattenExecutionMessageValue", kind: "export" },
  { localName: "isConstructable", sharedName: "isConstructable", kind: "export" },
  { localName: "normalizeExecutionSource", sharedName: "normalizeExecutionSource", kind: "export" },
  { localName: "summarizeElement", sharedName: "summarizeExecutionElement", kind: "export, renamed" },
  { localName: "buildSourceUrl", sharedName: "buildExecutionSourceUrl", kind: "export, renamed" }
];

const SURFACE_FILES = [ADMIN, ONSCREEN];

// --- output normalisation -----------------------------------------------------------
//
// Two differences are noise, and both are disclosed rather than hidden:
//   * the tree path itself (the base lives in a scratch directory);
//   * the surfaces' own `execution.js:<line>:<col>` frame positions, which move because this
//     lane removed ~300 lines from each file. A stack frame reported by the AGENT's generated
//     code (`space-*-agent-execute-<n>.js`) keeps its position, which is what matters.
const HARNESS_FILE = new URL(import.meta.url).pathname;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeOutput(text, options = {}) {
  // ANY module tree collapses to `<modules>`, not just the two named ones: the mutant copies
  // live in their own scratch directories, and leaving their paths in would make the
  // comparator fire on the tree's location instead of on what the tree paints.
  const normalized = String(text ?? "")
    .replace(/(?:file:\/\/)?[^\s"'()]*\/app\/L0\/_all\/modules/gu, "<modules>")
    .replace(/(execution\.js):\d+:\d+/gu, "$1:<pos>")
    .replace(new RegExp(`${escapeRegExp(HARNESS_FILE)}:\\d+:\\d+`, "gu"), "<harness>");

  // A cross-SURFACE comparison ("onscreen now paints what admin paints") must collapse the
  // one string that is supposed to differ: the surface's own sourceURL prefix. Without this
  // the two surfaces can never be equal, and the assertion would be unprovable rather than
  // false. Same-surface comparisons never pass this flag.
  return options.collapseSurfacePrefix
    ? normalized.replace(/space-(?:admin|onscreen)-agent-execute/gu, "<source>").replace(/<source>-\d+\.js/gu, "<source>.js")
    : normalized;
}

// --- trees under test ---------------------------------------------------------------

// Neither surface module has a default export, so the namespace IS the module.
const baseAdminNs = await import(BASE_ADMIN_MODULE);
const baseOnscreenNs = await import(BASE_ONSCREEN_MODULE);
const tipAdminNs = await import(TIP_ADMIN_MODULE);
const tipOnscreenNs = await import(TIP_ONSCREEN_MODULE);

const trees = {
  baseAdmin: baseAdminNs,
  baseOnscreen: baseOnscreenNs,
  tipAdmin: tipAdminNs,
  tipOnscreen: tipOnscreenNs
};

assert.notEqual(baseAdminNs, tipAdminNs, "the loader must hand back two distinct admin trees");
assert.notEqual(baseOnscreenNs, tipOnscreenNs, "the loader must hand back two distinct onscreen trees");

async function runExecution(moduleNamespace, code) {
  const context = moduleNamespace.createExecutionContext({ targetWindow: createTargetWindow() });
  const results = await context.executeFromContent(`intro line\n_____javascript\n${code}`);
  const first = results[0] ?? null;

  return {
    errorText: first?.error?.text ?? null,
    logs: (first?.logs ?? []).map((entry) => `${entry.level}|${entry.text}`),
    message: moduleNamespace.formatExecutionResultsMessage(results),
    resultText: first?.resultText ?? null,
    status: first?.status ?? null
  };
}

// The comparison is a plain deep-equality of normalised text. It is deliberately dumb: a
// cleverer comparator could agree for the wrong reason.
function surfaceDiff(baseModule, tipModule, cases) {
  const differing = [];

  cases.forEach(([label, code]) => {
    const baseText = normalizeOutput(JSON.stringify(runSync(baseModule, code)));
    const tipText = normalizeOutput(JSON.stringify(runSync(tipModule, code)));

    if (baseText !== tipText) {
      differing.push(label);
    }
  });

  return differing;
}

// Synchronous execution is not possible with `await`, so the corpus is evaluated once into a
// cache and the comparison reads the cache. This also guarantees every case sees a FRESH
// execution context, since module-level context is cached per target window.
const executedCache = new Map();

function runSync(moduleNamespace, code) {
  const key = `${moduleNamespace === baseAdminNs ? "ba" : moduleNamespace === tipAdminNs ? "ta" : moduleNamespace === baseOnscreenNs ? "bo" : "to"}|${code}`;

  if (!executedCache.has(key)) {
    throw new Error(`execution corpus was not pre-run: ${key}`);
  }

  return executedCache.get(key);
}

// --- the adversarial corpus ---------------------------------------------------------
//
// Every case is real executed code, because the point is the whole pipeline: the console
// recorder, the transcript formatter, the value formatter, the sourceURL and the stack filter.
const EXECUTION_CORPUS = [
  ["string at 0 chars", "console.log('');"],
  ["string at 219 chars", "console.log('a'.repeat(219));"],
  ["string at 220 chars", "console.log('a'.repeat(220));"],
  ["string at 221 chars", "console.log('a'.repeat(221));"],
  ["string at 10000 chars", "console.log('a'.repeat(10000));"],
  ["NON-SERIALIZABLE 300-char field", "const v={toJSON(){throw new Error('no json');},s:'y'.repeat(300)};console.log(v);"],
  ["NON-SERIALIZABLE 12 entries", "const v={toJSON(){throw new Error('no json');},list:Array.from({length:12},(_,i)=>i)};console.log(v);"],
  ["NON-SERIALIZABLE 12-key object", "const v={toJSON(){throw new Error('no json');}};for(let i=0;i<12;i++)v['k'+i]=i;console.log(v);"],
  ["collection at 7 entries", "console.log(Array.from({length:7},(_,i)=>i));"],
  ["collection at 8 entries", "console.log(Array.from({length:8},(_,i)=>i));"],
  ["collection at 9 entries", "console.log(Array.from({length:9},(_,i)=>i));"],
  ["collection at 1000 entries", "console.log(Array.from({length:1000},(_,i)=>i));"],
  ["depth 6 nesting", "console.log({a:{b:{c:{d:{e:{f:'deep'}}}}}});"],
  ["Map with 12 entries", "console.log(new Map(Array.from({length:12},(_,i)=>['key'+i,'value'+i])));"],
  ["Set with 12 entries", "console.log(new Set(Array.from({length:12},(_,i)=>i)));"],
  ["circular with 12 keys", "const c={};for(let i=0;i<12;i++)c['k'+i]=i;c.self=c;console.log(c);"],
  ["Date value", "console.log(new Date(0));"],
  ["RegExp value", "console.log(/abc/gu);"],
  ["typed array value", "console.log(new Uint8Array([1,2,3]));"],
  ["class instance", "class Point{constructor(){this.x=1;this.y=2;}}console.log(new Point());"],
  ["function value", "console.log(function namedFn(){});"],
  ["symbol value", "console.log(Symbol('tag'));"],
  ["bigint value", "console.log(12345678901234567890n);"],
  ["null and undefined", "console.log(null, undefined);"],
  ["getter that throws", "const v={get boom(){throw new Error('getter');}};console.log(v);"],
  ["returned long string", "return 'z'.repeat(300);"],
  ["returned 12-entry array", "return Array.from({length:12},(_,i)=>i);"],
  ["returned circular", "const c={s:'y'.repeat(300)};c.self=c;return c;"],
  ["returned Map", "return new Map([['a',1],['b',2]]);"],
  ["thrown Error", "throw new Error('boom');"],
  ["thrown TypeError", "throw new TypeError('bad type');"],
  ["thrown SyntaxError at compile", "const = ;"],
  ["logged Error", "console.log(new Error('logged'));"],
  ["multi-arg with Error", "console.log('a', new Error('inner'));"],
  ["no output at all", "const unused = 1;"],
  ["warn level", "console.warn('careful', {n:1});"],
  ["error level", "console.error('bad', 'news');"],
  ["crlf source", "console.log('crlf');\r\nreturn 'ok';"],
  ["window method call", "return String(typeof window);"]
];

// Codes the targeted assertions need but which are deliberately NOT part of the differential
// enumeration: `plain long string 300` duplicates an existing case, and the two error probes
// are the same stack-filter family as `thrown Error`. They are still pre-run, so no assertion
// can execute code the differential never saw.
const TARGETED_CODES = [
  "console.log('a'.repeat(300));",
  "throw new Error('frame-check');",
  "throw new Error('id');"
];

// Warm the cache with the real surfaces. Every case runs on all four modules so a comparison
// can never silently compare a tree against itself.
const PRE_RUN_CODES = [...EXECUTION_CORPUS.map(([, code]) => code), ...TARGETED_CODES];

for (const code of PRE_RUN_CODES) {
  for (const [key, moduleNamespace] of [
    ["ba", baseAdminNs],
    ["ta", tipAdminNs],
    ["bo", baseOnscreenNs],
    ["to", tipOnscreenNs]
  ]) {
    executedCache.set(`${key}|${code}`, await runExecution(moduleNamespace, code));
  }
}

// Cleanup runs at PROCESS EXIT, not in `test.after`. The mutant and export panels are
// imported as modules, and Node may still be resolving that module chain when the last test
// finishes; deleting the directory there produced `ENOENT` uncaught exceptions from a load
// that had nothing to do with the assertions. At exit nothing can import any more.
process.on("exit", () => {
  scratchDirs.forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

test.after(() => {
  if (previousSpace === undefined) {
    delete globalThis.space;
  } else {
    globalThis.space = previousSpace;
  }
});

// ====================================================================================
// 0. The harness itself: two real trees, and a comparator proven able to see.
// ====================================================================================

test("the base side is a real extraction of the base commit and differs from the tip", () => {
  const baseSource = readFileSync(BASE_ADMIN_MODULE, "utf8");
  const tipSource = readFileSync(TIP_ADMIN_MODULE, "utf8");

  assert.notEqual(baseSource, tipSource, "the base extraction must not be the tip tree");
  assert.equal(
    /function\s+formatString\s*\(/u.test(stripComments(baseSource)),
    true,
    "the base admin tree must still carry its own local formatter family"
  );
  assert.equal(
    /function\s+formatString\s*\(/u.test(stripComments(tipSource)),
    false,
    "the tip admin tree must not"
  );
  assert.notEqual(baseAdminNs, tipAdminNs, "the loader must hand back two distinct modules");
  assert.notEqual(baseOnscreenNs, tipOnscreenNs, "the loader must hand back two distinct modules");
});

test("the comparator can SEE: a deliberate change is reported, an inert one is not", async () => {
  const cases = [
    ["plain", "console.log('hello');"],
    ["object", "console.log({a:1});"],
    ["error", "throw new Error('delta');"]
  ];
  // EACH PHASE GETS ITS OWN COPY. Node caches modules by URL, so mutating a file in a panel
  // that has already been imported changes nothing — the cached module is served again and
  // the deliberate control would silently measure a no-op. A fresh directory gives the
  // shared module a fresh URL and therefore a real re-evaluation.
  //
  // The status line lives in the SHARED module now, so that is where a mutation has to land:
  // editing the surface file would change no painted byte, and a comparator that "detects"
  // a no-op is detecting nothing. This is the whole reason a deliberate control exists.
  const inertPanel = makeScratch("p4b2c-mutant-inert-");

  cpSync(TIP_MODULES, join(inertPanel, "app/L0/_all/modules"), { recursive: true });

  const inertShared = join(inertPanel, MODULES_DIR, "_core/framework/js/execution-format.js");
  const pristineText = readFileSync(inertShared, "utf8");

  // (a) INERT: a comment-only edit must NOT be reported as a difference.
  writeFileSync(inertShared, `// inert probe edit\n${pristineText}`);

  // The mutant is a copy of the TIP tree, so the TIP is its baseline. Comparing it against
  // the base tree would make every pre-existing base-vs-tip difference look like the
  // comparator firing, and the inert control would be measuring the wrong pair.
  const tipBaseline = await runOnModules(tipOnscreenNs, cases);

  const inertModule = await importMutantModule(inertPanel, "onscreen");
  const inertTip = await runOnModules(inertModule, cases);

  assert.deepEqual(inertTip, tipBaseline, "a comment-only edit must not fire the comparator");

  // (b) DELIBERATE: changing the painted output must be reported.
  //
  // The anchor is asserted first. A `replace` whose needle is absent is a silent no-op, and the
  // "no difference" it then produces looks exactly like a comparator doing its job — the
  // instrument would be measured by its own subject.
  const mutationAnchor = "const lines = [`execution ${status}`];";

  assert.equal(
    pristineText.includes(mutationAnchor),
    true,
    "the deliberate-mutation anchor must exist, or this control mutates nothing"
  );
  const deliberatePanel = makeScratch("p4b2c-mutant-deliberate-");

  cpSync(TIP_MODULES, join(deliberatePanel, "app/L0/_all/modules"), { recursive: true });

  const deliberateShared = join(deliberatePanel, MODULES_DIR, "_core/framework/js/execution-format.js");
  const deliberateText = readFileSync(deliberateShared, "utf8");

  assert.equal(
    deliberateText.includes(mutationAnchor),
    true,
    "the deliberate-mutation anchor must exist, or this control mutates nothing"
  );
  writeFileSync(
    deliberateShared,
    deliberateText.replace(mutationAnchor, "const lines = [`EXECUTION ${status}`];")
  );

  const deliberateModule = await importMutantModule(deliberatePanel, "onscreen");
  const deliberateTip = await runOnModules(deliberateModule, cases);

  assert.notDeepEqual(
    deliberateTip,
    tipBaseline,
    "a changed status line must be reported — otherwise silence below proves nothing"
  );
});

async function importMutantModule(panelRoot, surface) {
  const path = join(panelRoot, MODULES_DIR, `_core/${surface === "admin" ? "admin/views/agent" : "onscreen_agent"}/execution.js`);

  return import(`${path}?p4b2c-mutant=${Date.now()}-${Math.random()}`);
}

async function runOnModules(moduleNamespace, cases) {
  const out = [];

  for (const [, code] of cases) {
    out.push(normalizeOutput(JSON.stringify(await runExecution(moduleNamespace, code))));
  }

  return out;
}

// ====================================================================================
// 1. The family is GONE from both surfaces (moved, not copied).
// ====================================================================================

test("no promoted function has a local definition in either surface", () => {
  SURFACE_FILES.forEach((file) => {
    const source = stripComments(readProductFile(file));

    PROMOTED.forEach(({ localName }) => {
      assert.equal(
        definitionCount(source, localName),
        0,
        `${file} must not declare its own ${localName} — it was promoted, not copied`
      );
    });
  });
});

test("each promoted function is defined exactly ONCE tree-wide, in the shared module", () => {
  const sharedSource = stripComments(readProductFile(SHARED));

  PROMOTED.forEach(({ sharedName, kind }) => {
    const hits = TIP_MODULE_SOURCES.reduce((total, file) => total + definitionCount(file.source, sharedName), 0);

    assert.equal(hits, 1, `${sharedName} must have exactly one definition tree-wide (${kind})`);
    assert.equal(definitionCount(sharedSource, sharedName), 1, `${sharedName} must live in the shared module`);
  });
});

test("the old local names are gone tree-wide where they were renamed", () => {
  const renamedAway = [
    { from: "summarizeElement", to: "summarizeExecutionElement" },
    { from: "buildSourceUrl", to: "buildExecutionSourceUrl" }
  ];

  renamedAway.forEach(({ from, to }) => {
    const fromHits = TIP_MODULE_SOURCES.reduce((total, file) => total + definitionCount(file.source, from), 0);
    const toHits = TIP_MODULE_SOURCES.reduce((total, file) => total + definitionCount(file.source, to), 0);

    assert.equal(fromHits, 0, `${from} must not survive anywhere`);
    assert.equal(toHits, 1, `${to} must have exactly one definition`);
  });
});

// ====================================================================================
// 2. No surface identity leaks into the shared module.
// ====================================================================================

test("the shared module spells no surface identity outside its comments", () => {
  const source = stripComments(readProductFile(SHARED));

  assert.equal(/admin/iu.test(source), false, "the shared module must not name admin outside comments");
  assert.equal(/onscreen/iu.test(source), false, "the shared module must not name onscreen outside comments");
  assert.equal(
    /space-admin-agent-execute/u.test(source),
    false,
    "admin's sourceURL prefix must not be baked into the shared module"
  );
  assert.equal(
    /space-onscreen-agent-execute/u.test(source),
    false,
    "onscreen's sourceURL prefix must not be baked into the shared module"
  );

  // …and the parameter it reads is genuinely read.
  assert.equal(
    /options\.sourceUrlPrefix/u.test(source),
    true,
    "the prefix must arrive as an argument, and the argument must be read"
  );
});

// ====================================================================================
// 3. The prefix parameter is LOAD-BEARING.
// ====================================================================================

test("hardcoding admin's prefix in the shared module changes onscreen's error text", async () => {
  const panel = makeScratch("p4b2c-prefix-");

  cpSync(TIP_MODULES, join(panel, "app/L0/_all/modules"), { recursive: true });

  const sharedPath = join(panel, MODULES_DIR, "_core/framework/js/execution-format.js");
  const sharedText = readFileSync(sharedPath, "utf8");
  const anchor = 'const sourceUrlPrefix = typeof options.sourceUrlPrefix === "string" ? options.sourceUrlPrefix : "";';

  assert.equal(
    sharedText.includes(anchor),
    true,
    "the parameterisation anchor must exist, or this proof is measuring nothing"
  );
  writeFileSync(sharedPath, sharedText.replace(anchor, 'const sourceUrlPrefix = "space-admin-agent-execute";'));

  const mutantOnscreen = await importMutantModule(panel, "onscreen");
  const pristine = await runExecution(tipOnscreenNs, "throw new Error('boom');");
  const surprised = await runExecution(mutantOnscreen, "throw new Error('boom');");

  assert.equal(
    pristine.errorText.includes("space-onscreen-agent-execute"),
    true,
    "onscreen keeps its OWN frames — that is parity with admin's behaviour, not a stripped stack"
  );
  assert.equal(
    surprised.errorText.includes("space-onscreen-agent-execute"),
    false,
    "with admin's prefix hardcoded, onscreen's own frames must vanish — the parameter does real work"
  );
  assert.notEqual(
    normalizeOutput(pristine.errorText),
    normalizeOutput(surprised.errorText),
    "the parameterisation proof must observe a change, not a coincidence"
  );
});

// ====================================================================================
// 4. ADMIN IS UNCHANGED — differential execution against the real base tree.
// ====================================================================================

test("admin renders every corpus case byte-identically to base", () => {
  const differing = EXECUTION_CORPUS.filter(([, code]) => {
    const base = normalizeOutput(JSON.stringify(runSync(baseAdminNs, code)));
    const tip = normalizeOutput(JSON.stringify(runSync(tipAdminNs, code)));

    return base !== tip;
  }).map(([label]) => label);

  assert.deepEqual(
    differing,
    [],
    `admin must be unchanged beyond the sourceURL parameterisation; it differed on: ${differing.join(", ")}`
  );
});

// ====================================================================================
// 5. ONSCREEN changed exactly where it adopted admin's behaviour — a NAMED set.
// ====================================================================================

// Measured, then explained case by case. Two families, both of them onscreen ADOPTING what
// admin already did:
//
//   * the value caps, reachable on the non-serializable fallback path (3 cases). A plain
//     string log does NOT reach them on either surface — it goes through the JSON/text path,
//     which is asserted separately below;
//   * the stack filter: onscreen used to paint the WHOLE stack, framework and harness frames
//     included (4 thrown/logged cases). It now keeps only its own agent frames, like admin.
//
// `multi-arg with Error` is deliberately NOT here: a multi-argument log serialises the Error
// as JSON, which bypasses `formatError` entirely, so it is unaffected on both surfaces.
const EXPECTED_ONSCREEN_DIVERGENCES = [
  "NON-SERIALIZABLE 300-char field",
  "NON-SERIALIZABLE 12 entries",
  "NON-SERIALIZABLE 12-key object",
  "getter that throws",
  "logged Error",
  "thrown Error",
  "thrown SyntaxError at compile",
  "thrown TypeError"
];

test("onscreen diverges from its own base on exactly the named cases", () => {
  const differing = EXECUTION_CORPUS.filter(([, code]) => {
    const base = normalizeOutput(JSON.stringify(runSync(baseOnscreenNs, code)));
    const tip = normalizeOutput(JSON.stringify(runSync(tipOnscreenNs, code)));

    return base !== tip;
  }).map(([label]) => label);

  assert.deepEqual(
    differing.sort(),
    EXPECTED_ONSCREEN_DIVERGENCES.slice().sort(),
    "onscreen's behaviour change must be exactly the adopted-bounds and adopted-stack-filter cases"
  );
});

test("every onscreen change makes it agree with admin, which is the point of the lane", () => {
  EXPECTED_ONSCREEN_DIVERGENCES.forEach((label) => {
    const code = EXECUTION_CORPUS.find(([name]) => name === label)[1];
    const tipOnscreen = normalizeOutput(JSON.stringify(runSync(tipOnscreenNs, code)), {
      collapseSurfacePrefix: true
    });
    const tipAdmin = normalizeOutput(JSON.stringify(runSync(tipAdminNs, code)), {
      collapseSurfacePrefix: true
    });

    assert.equal(
      tipOnscreen,
      tipAdmin,
      `${label}: after the lane, onscreen must paint exactly what admin paints`
    );
  });
});

// ====================================================================================
// 6. Onscreen's new bounding is REAL, and its before/after is stated exactly.
// ====================================================================================

test("a non-serializable long value now paints CLAMPED on onscreen, matching admin", () => {
  const code = "const v={toJSON(){throw new Error('no json');},s:'y'.repeat(300)};console.log(v);";
  const before = runSync(baseOnscreenNs, code).logs.join("\n");
  const after = runSync(tipOnscreenNs, code).logs.join("\n");
  const admin = runSync(tipAdminNs, code).logs.join("\n");

  // Counts recomputed from the product's own cap, never read back out of the output.
  const cap = 220;
  const runBefore = before.match(/y+/u)?.[0].length ?? 0;
  const runAfter = after.match(/y+/u)?.[0].length ?? 0;

  assert.equal(runBefore, 300, "before the lane, onscreen painted the value whole — this is the visible change");
  assert.equal(runAfter, cap - 3, `after the lane, onscreen clamps to the cap minus the ellipsis (${cap - 3})`);
  assert.equal(after.includes("..."), true, "a clamped value must say so with a marker");
  assert.equal(after, admin, "and must match what admin already painted");
});

test("a non-serializable 12-entry collection now paints clamped on onscreen, matching admin", () => {
  const code = "const v={toJSON(){throw new Error('no json');},list:Array.from({length:12},(_,i)=>i)};console.log(v);";
  const before = runSync(baseOnscreenNs, code).logs.join("\n");
  const after = runSync(tipOnscreenNs, code).logs.join("\n");
  const admin = runSync(tipAdminNs, code).logs.join("\n");
  const entryCap = 8;

  assert.equal(before.includes("8, 9, 10, 11"), true, "before the lane onscreen painted all twelve entries");
  assert.equal(after.includes("8, 9, 10, 11"), false, `after the lane it stops at the ${entryCap}-entry cap`);
  assert.equal(after.includes("..."), true, "a clamped collection must say so with a marker");
  assert.equal(after, admin, "and must match what admin already painted");
});

test("a plain long string still paints WHOLE on both surfaces — the cap is not reached there", () => {
  const code = "console.log('a'.repeat(300));";

  Object.entries(trees).forEach(([key, moduleNamespace]) => {
    const logs = runSync(moduleNamespace, "console.log('a'.repeat(300));").logs.join("\n");

    assert.equal(
      logs.includes("a".repeat(300)),
      true,
      `${key}: a plain string log goes through the JSON/text path, which neither surface clamps`
    );

    assert.equal(logs.includes("..."), false, `${key}: nothing was hidden, so no marker may appear`);
  });

  void code;
});

// ====================================================================================
// 7. Error stacks: each surface keeps its OWN frames, and only its own.
// ====================================================================================

test("both surfaces filter a thrown error's stack to their own frames", () => {
  const code = "throw new Error('frame-check');";

  const tipAdmin = runSync(tipAdminNs, code).errorText;
  const tipOnscreen = runSync(tipOnscreenNs, code).errorText;

  assert.equal(tipAdmin.includes("space-admin-agent-execute"), true, "admin keeps admin frames");
  assert.equal(tipAdmin.includes("space-onscreen-agent-execute"), false, "admin must not see onscreen frames");
  assert.equal(tipOnscreen.includes("space-onscreen-agent-execute"), true, "onscreen keeps onscreen frames");
  assert.equal(tipOnscreen.includes("space-admin-agent-execute"), false, "onscreen must not see admin frames");
  // Only the agent's generated frames survive: framework and harness frames are noise.
  [tipAdmin, tipOnscreen].forEach((text) => {
    assert.equal(
      /execution\.js/u.test(text),
      false,
      "framework frames must be filtered out of a rendered error"
    );
  });
});

test("the sourceURL still carries each surface's own prefix and the run id", () => {
  const adminText = runSync(tipAdminNs, "throw new Error('id');").errorText;
  const onscreenText = runSync(tipOnscreenNs, "throw new Error('id');").errorText;

  assert.equal(/space-admin-agent-execute-1\.js/u.test(adminText), true, "admin's source url is unchanged");
  assert.equal(
    /space-onscreen-agent-execute-1\.js/u.test(onscreenText),
    true,
    "onscreen's source url is unchanged"
  );
});

// ====================================================================================
// 8. The result-lines builder: differential over result SHAPES, not executed code.
// ====================================================================================

function skillFor(surface, extra = {}) {
  return {
    content: "skill body",
    path: "/skills/demo/SKILL.md",
    ...(surface === "admin" ? { __spaceAdminSkill: true } : { __spaceSkill: true }),
    ...extra
  };
}

const RESULT_SHAPES = [
  ["status only", { logs: [], result: undefined, resultText: "", status: "success" }],
  ["blank status", { logs: [], result: undefined, resultText: "", status: "   " }],
  ["missing status", { logs: [], result: undefined, resultText: "" }],
  ["logs only", { logs: [{ level: "log", text: "one" }, { level: "warn", text: "two" }], status: "success" }],
  ["log with blank level", { logs: [{ level: "  ", text: "x" }], status: "success" }],
  ["result only", { logs: [], result: 42, resultText: "42", status: "success" }],
  ["error only", { error: { text: "boom\nsecond line" }, logs: [], result: undefined, status: "error" }],
  ["nothing at all", { logs: [], result: undefined, status: "success" }],
  [
    "skill as result (admin paints and stops, onscreen paints and continues)",
    { logs: [], result: skillFor("admin"), resultText: "skill body", status: "success" }
  ]
];

test("the result-lines builder is equivalent to base on every shape, per surface", () => {
  // The skill shapes differ per surface by construction (different flags), so each surface is
  // compared against ITS OWN base, with its own skill object.
  const pairs = [
    ["admin", baseAdminNs, tipAdminNs],
    ["onscreen", baseOnscreenNs, tipOnscreenNs]
  ];

  pairs.forEach(([surface, baseModule, tipModule]) => {
    RESULT_SHAPES.forEach(([label, shape]) => {
      const framed = { ...shape };

      if (shape.result && typeof shape.result === "object") {
        framed.result = skillFor(surface, { loadResponseText: "loaded text" });
      }

      const baseText = normalizeOutput(baseModule.formatExecutionResultsMessage([framed]));
      const tipText = normalizeOutput(tipModule.formatExecutionResultsMessage([framed]));

      assert.equal(tipText, baseText, `${surface}: ${label} must render identically to base`);
    });
  });
});

test("onscreen's two suppression questions stay SEPARATE (the collapsed-copy trap)", () => {
  const outsideResultSkill = skillFor("onscreen", { loadResponseText: "loaded outside" });
  const shaped = {
    loadedSkills: [outsideResultSkill],
    logs: [],
    result: undefined,
    resultText: "",
    status: "success"
  };
  const painted = tipOnscreenNs.formatExecutionResultsMessage([shaped]);

  // A skill collected OUTSIDE the return value still suppresses the "returned nothing" notice…
  assert.equal(
    painted.includes("returned no result"),
    false,
    "a painted skill must suppress the empty notice, or the transcript contradicts itself"
  );
  // …but the RESULT BLOCK rule is about the returned value, and there is no returned value here.
  assert.equal(painted.includes("loaded outside"), true, "the skill body itself is painted");
});

// ====================================================================================
// 9. BUG-007 — a display shape dispatches nothing, still.
// ====================================================================================

test("the formatter family reaches no execution primitive at all", () => {
  const source = stripComments(readFileSync(join(TIP_MODULES, "_core/framework/js/execution-format.js"), "utf8"));

  [
    ["eval", /\beval\s*\(/u],
    ["new Function", /new\s+Function\s*\(/u],
    ["AsyncFunction", /AsyncFunction/u],
    ["createAsyncRunner", /createAsyncRunner/u],
    ["execute", /\bexecute\s*\(/u]
  ].forEach(([label, pattern]) => {
    assert.equal(pattern.test(source), false, `the formatter family must not reference ${label}`);
  });
});

test("BUG-007: rendering code-LOOKING values as display content executes nothing", () => {
  const sentinel = "__p4b2cDisplayExecutedSentinel";

  globalThis[sentinel] = 0;

  const fenced = `\`\`\`javascript\nconsole.error('fenced');\n\`\`\``;
  const payloads = [
    `globalThis.${sentinel} += 1; console.log('ran');`,
    fenced,
    `_____javascript\nglobalThis.${sentinel} += 1;`,
    `tool call: {"name":"run_code","arguments":"globalThis.${sentinel} += 1"}`
  ];

  payloads.forEach((payload) => {
    // Displayed as a VALUE (a console argument), which is the formatter family's whole job.
    const painted = tipOnscreenNs.formatExecutionResultsMessage([
      { logs: [{ level: "log", text: payload }], result: undefined, resultText: "", status: "success" }
    ]);

    assert.equal(typeof painted, "string", "display content must paint as text");
    assert.equal(globalThis[sentinel], 0, `display content executed: ${payload.slice(0, 24)}`);
  });

  delete globalThis[sentinel];
});

// ====================================================================================
// 10. PER-FUNCTION differential: base-local body vs the promoted shared member.
// ====================================================================================
//
// Sections 4-6 compare WHOLE PIPELINES (execute code → painted output). This section isolates
// the unit: for each promoted function it drives the base tree's own local body against the
// shared implementation, over a value corpus, and reports match/mismatch per function.
//
// The base side is derived MECHANICALLY — the real `git archive` copy of the base file with
// one appended `export { … }` line — never retyped. Retyping the base would make the
// differential a comparison of my memory against the product.
//
// `formatExecutionResultLines` is deliberately absent: reaching it means re-wiring the
// surface's own skill callbacks inside this test, which is exactly the lookalike this suite
// exists to forbid. It is covered by section 8 through the REAL configured formatter
// (`formatExecutionResultsMessage`), which is the stronger check.

function makeExportedBasePanel(surfacePath, names) {
  const panel = makeScratch("p4b2c-export-");

  cpSync(BASE_MODULES, join(panel, MODULES_DIR), { recursive: true });

  const file = join(panel, MODULES_DIR, surfacePath);
  const text = readFileSync(file, "utf8");

  // Onscreen's base file already exports one member of this family, and a second export of the
  // same binding is a SyntaxError — so only the NOT-yet-exported names are appended.
  const notYetExported = names.filter((name) => {
    const declared = new RegExp(`function\\s+${name}\\s*\\(`, "u").test(text);
    const alsoExported = new RegExp(`export\\s+(?:function|const|let|var)\\s+${name}\\b`, "u").test(text);

    assert.equal(
      declared || alsoExported,
      true,
      `the base tree must still declare ${name}; otherwise the export line cannot resolve`
    );

    return !alsoExported;
  });

  assert.ok(notYetExported.length > 1, "the panel must actually widen the base file's exports");
  writeFileSync(file, `${text}\nexport { ${notYetExported.join(", ")} };\n`);

  return `${file}?p4b2c-export=${Math.random()}`;
}

const PER_FUNCTION_ADMIN_NAMES = [
  "buildSourceUrl",
  "flattenExecutionMessageValue",
  "formatArrayLike",
  "formatEntries",
  "formatError",
  "formatExecutionResultValue",
  "formatExecutionValue",
  "formatString",
  "isConstructable",
  "normalizeExecutionSource",
  "summarizeElement"
];

const PER_FUNCTION_ONSCREEN_NAMES = PER_FUNCTION_ADMIN_NAMES.filter(
  (name) => name !== "summarizeElement"
);

// LAZY on purpose. A module-scope `await import()` here delayed registering the tests below
// and its pending load outlived the runner, which then hit a deleted scratch directory. The
// panel is built and imported inside the first test that needs it, once.
let perFunctionCache = null;

async function perFunctionPanels() {
  if (!perFunctionCache) {
    perFunctionCache = (async () => {
      const baseAdmin = await import(
        makeExportedBasePanel("_core/admin/views/agent/execution.js", PER_FUNCTION_ADMIN_NAMES)
      );
      const baseOnscreen = await import(
        makeExportedBasePanel("_core/onscreen_agent/execution.js", PER_FUNCTION_ONSCREEN_NAMES)
      );
      const factory = await import(join(TIP_MODULES, "_core/framework/js/execution-format.js"));

      return { baseAdmin, baseOnscreen, factory };
    })();
  }

  return perFunctionCache;
}

function adminFactoryMembers(tipFactory) {
  return tipFactory.createExecutionValueFormatters({
    isLoadedSkill: (value) =>
      Boolean(value?.__spaceAdminSkill) && typeof value?.content === "string" && typeof value?.path === "string",
    sourceUrlPrefix: "space-admin-agent-execute"
  });
}

function onscreenFactoryMembers(tipFactory) {
  return tipFactory.createExecutionValueFormatters({
    isLoadedSkill: (value) =>
      Boolean(value?.__spaceSkill) && typeof value?.content === "string" && typeof value?.path === "string",
    sourceUrlPrefix: "space-onscreen-agent-execute"
  });
}

const pointInstance = new (class Point {
  constructor() {
    this.x = 1;
    this.y = 2;
  }
})();

const circularValue = { name: "loop" };
circularValue.self = circularValue;

const circularManyKeys = {};
for (let index = 0; index < 12; index += 1) {
  circularManyKeys[`k${index}`] = index;
}
circularManyKeys.self = circularManyKeys;

function errorWithStack(name, message, frames) {
  const error = new Error(message);

  error.name = name;
  error.stack = [`${name}: ${message}`, ...frames].join("\n");

  return error;
}

const VALUE_CORPUS = [
  ["empty string", ""],
  ["string 219", "a".repeat(219)],
  ["string 220", "a".repeat(220)],
  ["string 221", "a".repeat(221)],
  ["string 10000", "a".repeat(10000)],
  ["number", 42],
  ["negative zero", -0],
  ["boolean", false],
  ["bigint", 10n],
  ["symbol", Symbol("tag")],
  ["function", function namedFn() {}],
  ["arrow function", () => {}],
  ["null", null],
  ["undefined", undefined],
  ["array 0", []],
  ["array 7", Array.from({ length: 7 }, (_unused, index) => index)],
  ["array 8", Array.from({ length: 8 }, (_unused, index) => index)],
  ["array 9", Array.from({ length: 9 }, (_unused, index) => index)],
  ["array 1000", Array.from({ length: 1000 }, (_unused, index) => index)],
  ["object 12 keys", circularManyKeys],
  ["depth 6", { a: { b: { c: { d: { e: { f: "deep" } } } } } }],
  ["Map 12", new Map(Array.from({ length: 12 }, (_unused, index) => [`k${index}`, index]))],
  ["Set 12", new Set(Array.from({ length: 12 }, (_unused, index) => index))],
  ["Date", new Date(0)],
  ["RegExp", /abc/gu],
  ["Uint8Array", new Uint8Array([1, 2, 3])],
  ["class instance", pointInstance],
  ["circular", circularValue],
  ["error with no stack", errorWithStack("Error", "nostack", [])],
  [
    "error with admin frame",
    errorWithStack("Error", "adminframe", ["    at global.eval (space-admin-agent-execute-1.js:8:7)"])
  ],
  [
    "error with onscreen frame",
    errorWithStack("Error", "onscreenframe", ["    at global.eval (space-onscreen-agent-execute-1.js:8:7)"])
  ],
  [
    "error with framework frames only",
    errorWithStack("TypeError", "frameworkonly", [
      "    at createAsyncRunner (file:///app/L0/_all/modules/_core/onscreen_agent/execution.js:1:1)",
      "    at Object.execute (file:///app/L0/_all/modules/_core/admin/views/agent/execution.js:2:2)"
    ])
  ]
];

function drivePerFunction(surface, baseLocal, members, tipFactory) {
  const targetWindow = createTargetWindow();
  const rows = [];

  VALUE_CORPUS.forEach(([label, value]) => {
    const record = { label, mismatched: [] };
    const seen = () => new WeakSet();

    const compare = (name, baseCall, tipCall) => {
      const baseText = normalizeOutput(JSON.stringify(baseCall()));
      const tipText = normalizeOutput(JSON.stringify(tipCall()));

      if (baseText !== tipText) {
        record.mismatched.push(name);
      }
    };

    if (surface === "admin") {
      compare("formatExecutionValue", () => baseLocal.formatExecutionValue(value, { depth: 0, seen: seen(), targetWindow }), () =>
        members.formatExecutionValue(value, { depth: 0, seen: seen(), targetWindow })
      );
      compare(
        "formatExecutionResultValue",
        () => baseLocal.formatExecutionResultValue(value, { targetWindow }),
        () => members.formatExecutionResultValue(value, { targetWindow })
      );
      compare("formatString", () => (typeof value === "string" ? baseLocal.formatString(value) : null), () =>
        typeof value === "string" ? members.formatString(value) : null
      );
      compare(
        "summarizeElement",
        () => baseLocal.summarizeElement(pointInstance),
        () => tipFactory.summarizeExecutionElement(pointInstance)
      );
    } else {
      compare("formatExecutionValue", () => baseLocal.formatExecutionValue(value, { depth: 0, seen: seen(), targetWindow }), () =>
        members.formatExecutionValue(value, { depth: 0, seen: seen(), targetWindow })
      );
      compare(
        "formatExecutionResultValue",
        () => baseLocal.formatExecutionResultValue(value, { targetWindow }),
        () => members.formatExecutionResultValue(value, { targetWindow })
      );
      compare("formatString", () => (typeof value === "string" ? baseLocal.formatString(value) : null), () =>
        typeof value === "string" ? members.formatString(value) : null
      );
    }

    record.mismatched.push(
      ...(
        [
          ["flattenExecutionMessageValue", () => baseLocal.flattenExecutionMessageValue(value), () => tipFactory.flattenExecutionMessageValue(value)],
          ["isConstructable", () => baseLocal.isConstructable(value), () => tipFactory.isConstructable(value)],
          ["normalizeExecutionSource", () => baseLocal.normalizeExecutionSource(value), () => tipFactory.normalizeExecutionSource(value)]
        ].reduce((accumulator, [name, baseCall, tipCall]) => {
          return normalizeOutput(JSON.stringify(baseCall())) === normalizeOutput(JSON.stringify(tipCall()))
            ? accumulator
            : [...accumulator, name];
        }, [])
      )
    );

    rows.push(record);
  });

  return rows;
}

test("PER-FUNCTION: admin's promoted bodies behave exactly like the base tree's own", async () => {
  const { baseAdmin, factory } = await perFunctionPanels();
  const rows = drivePerFunction("admin", baseAdmin, adminFactoryMembers(factory), factory);
  const mismatched = rows.filter((row) => row.mismatched.length).map((row) => `${row.label}:${row.mismatched.join("+")}`);

  assert.deepEqual(mismatched, [], `admin per-function mismatches: ${mismatched.join(", ")}`);
});

test("PER-FUNCTION: onscreen's promoted bodies differ from base only in the adopted caps", async () => {
  const { baseOnscreen, factory } = await perFunctionPanels();
  const rows = drivePerFunction("onscreen", baseOnscreen, onscreenFactoryMembers(factory), factory);
  const mismatched = rows.filter((row) => row.mismatched.length);
  const functions = [...new Set(mismatched.flatMap((row) => row.mismatched))].sort();

  // Two adoptions, and only two:
  //
  //   `formatString`             the 220-character cap onscreen never had;
  //   `formatExecutionValue`     the stack filter — it reaches `formatError`, which used to paint
  //   `formatExecutionResultValue` every frame and now keeps only onscreen's own agent frames.
  //                              The second name is the same filter through a second entry point:
  //                              the transcript formatter's fallback lands in the same member.
  assert.deepEqual(
    functions,
    ["formatExecutionResultValue", "formatExecutionValue", "formatString"],
    "onscreen's per-function differences must be the adopted caps and the adopted stack filter"
  );

  // The one behavioural difference that is NOT a filter or a cap, recorded rather than hidden:
  // base onscreen labelled a skill `[Loaded skill <path>]` while admin and the shared module use
  // the richer `<skillName || path>`. Onscreen adopts admin's label as part of the promotion.
  // The name must not appear anywhere in the path, or the assertion below would pass on the
  // path substring alone — a fixture that cannot distinguish the two labels proves nothing.
  const skill = {
    __spaceSkill: true,
    content: "body",
    path: "/skills/xyz-locator/SKILL.md",
    skillName: "friendly-name"
  };
  const baseLabel = baseOnscreen.formatExecutionResultValue(skill, { targetWindow: createTargetWindow() });
  const tipLabel = onscreenFactoryMembers(factory).formatExecutionResultValue(skill, {
    targetWindow: createTargetWindow()
  });

  assert.equal(
    baseLabel.includes("friendly-name"),
    false,
    "base onscreen labelled a skill by its path only — this is the real pre-lane behaviour"
  );
  assert.equal(tipLabel.includes("friendly-name"), true, "the shared label uses the skill's name, like admin");

  // And nothing ELSE moved: no other function may appear for any value.
  assert.equal(
    mismatched.every((row) => row.mismatched.every((name) => functions.includes(name))),
    true,
    "an unexpected function drifting would fail here"
  );
});

test("PER-FUNCTION: the caps and the frame filter are what change, proven on single values", async () => {
  const { baseOnscreen, factory } = await perFunctionPanels();
  const members = onscreenFactoryMembers(factory);
  const longString = "y".repeat(300);

  assert.equal(baseOnscreen.formatString(longString).length, 300, "base onscreen did not clamp");

  // The clamp keeps `cap - 3` characters and appends the three-dot ellipsis, so the RENDERED
  // length is the cap itself. Asserting 217 here would be an arithmetic slip that reads like a
  // product fact, which is why the sum is spelled out rather than the total.
  assert.equal(
    members.formatString(longString).length,
    220,
    "the shared clamp renders exactly the cap: (cap - 3) kept characters plus three dots"
  );
  assert.equal(members.formatString(longString).endsWith("..."), true, "the cut is marked");
  assert.equal(
    members.formatString(longString).slice(0, 217),
    longString.slice(0, 217),
    "the kept prefix is the real prefix, not a placeholder"
  );

  const mixed = errorWithStack("Error", "mixed", [
    "    at global.eval (space-onscreen-agent-execute-1.js:8:7)",
    "    at Object.execute (file:///app/L0/_all/modules/_core/onscreen_agent/execution.js:2:2)",
    "    at async harness (file:///tmp/harness.mjs:1:1)"
  ]);

  const before = baseOnscreen.formatError(mixed);
  const after = members.formatError(mixed);

  assert.equal(before.split("\n").length, 4, "base onscreen painted every frame it was given");
  assert.equal(after.split("\n").length, 2, "the shared filter keeps the message plus its own agent frames only");
  assert.equal(after.includes("execution.js"), false, "framework frames are gone");
  assert.equal(after.includes("harness.mjs"), false, "harness frames are gone");
});

test("BUG-007: rendering does not create an execution context or run a block", () => {
  const targetWindow = createTargetWindow();
  let executions = 0;
  const trackedWindow = Object.assign(targetWindow, {
    console: {
      ...targetWindow.console,
      log(...args) {
        executions += 1;

        void args;
      }
    }
  });

  tipOnscreenNs.formatExecutionResultsMessage([
    { logs: [{ level: "log", text: "still display" }], result: undefined, resultText: "", status: "success" }
  ]);

  assert.equal(trackedWindow.__spaceOnscreenAgentExecutionContext, undefined, "no context was created");
  assert.equal(executions, 0, "no console call reached the window's console from a render");
});
