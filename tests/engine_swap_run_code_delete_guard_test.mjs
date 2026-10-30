// BUG-014: A DELETE INSIDE `run_code` MUST NOT EXECUTE SILENTLY.
//
// THE DEFECT (live evidence, not re-derived here). The destructive-confirmation gate
// guards only the typed `file_delete` tool. A delete written as one step inside a bigger
// `run_code` job ran instantly with no confirmation: plain "delete this file" requests
// used the gated typed tool 6/6, while deletes that were STEPS INSIDE BIGGER JOBS took
// the ungated code path 7/9. The agent's majority habit for multi-step work is batching
// into one code block, so the gate was bypassed exactly when a job was complex. Every
// ungated delete reached the file layer as `space.api.fileDelete(...)` inside `run_code`:
// a lone call, a single statement in a larger block, and one call with an array of two
// paths. All targets were files; no case used a raw filesystem handle.
//
// THE DESIGN (decided upstream). Scope the sandbox, not the client. `space.api` is a
// page-wide singleton with SEVEN first-party `fileDelete` callers and no gate — the human
// Files delete dialog among them — so the shared client's behaviour is untouched. The
// `run_code` execution scope instead gets its own `space` facade whose `api.fileDelete`
// always throws a model-facing coaching error naming the typed `file_delete` tool.
//
// WHAT THIS SUITE PINS:
//   1. every observed delete shape throws, and the message names `file_delete`;
//   2. NOTHING is deleted — the real file layer is never reached (proved against the real
//      `createApiClient` and its transport, not a lookalike);
//   3. every other facade method is a faithful pass-through — same function, same
//      arguments, same return value — so `fileWrite({operation: "append"})` from code
//      still works exactly as it does today;
//   4. the real `globalThis.space.api.fileDelete` is UNCHANGED and still callable, because
//      the Files dialog and six other first-party callers depend on it;
//   5. the facade's enumerable surface equals the real client's, with `fileDelete` the one
//      and only difference.
//
// THIS IS A GUARDRAIL, NOT A SECURITY BOUNDARY. The executed block runs in this realm, so
// code that deliberately goes around the facade (`globalThis.space.api.fileDelete`, a
// saved client reference, a raw backend call) still deletes without consent. What the
// guard buys is that the model's NATURAL batched path fails loudly and routes to the
// gated tool — which covers 7 of 7 observed ungated deletes. The suite asserts the loud
// failure and never claims the path is closed.
//
// Hermetic: no network, no DOM, no app-data writes. The transport is a stub that records
// requests; `globalThis.space.extend` is stubbed because the onscreen module registers a
// plan validator at import time.

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

// `execution.js` calls `globalThis.space.extend(...)` while loading, so the stub must
// exist before the dynamic import below runs.
const previousSpace = globalThis.space;
const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;

if (!globalThis.space || typeof globalThis.space.extend !== "function") {
  globalThis.space = { extend(_meta, value) { return value; } };
}

if (!globalThis.window) {
  globalThis.window = { location: { origin: "http://localhost" } };
}

// Dynamic import, not a static one: this suite must LINK on a pristine tree (where the
// facade does not exist yet) so the failure is a behavioural assertion instead of a
// module-resolution wall that hides which behaviour is missing.
const executionModule = await import(
  "../app/L0/_all/modules/_core/onscreen_agent/execution.js"
);

// ============================================================================
// fixtures
// ============================================================================

const ALL_DELETE_SHAPES = [
  ["lone string path", 'space.api.fileDelete("L2/alice/notes.txt")'],
  ["array of two paths", 'space.api.fileDelete(["L2/alice/a.txt", "L2/alice/b.txt"])'],
  ["{paths:[...]} batch", 'space.api.fileDelete({ paths: ["L2/alice/a.txt", "L2/alice/b.txt"] })'],
  ["{path} single entry", 'space.api.fileDelete({ path: "L2/alice/notes.txt" })'],
  ["{files:[...]} array", 'space.api.fileDelete({ files: ["L2/alice/a.txt"] })'],
  ["no argument at all", "space.api.fileDelete()"]
];

// A target window is any object: `createExecutionScope` reads `space`, the window alias
// keys and `console` off it, and stores its own bookkeeping under its own keys.
function makeTargetWindow(space) {
  return { space };
}

// A recording stub client: proves argument and return faithfulness WITHOUT the real
// transport, so a pass-through failure cannot be blamed on the network shape.
function makeStubClient() {
  const calls = [];
  const make = (name) => (...args) => {
    calls.push({ args, name });
    return `${name}:result`;
  };

  return {
    calls,
    client: {
      call: make("call"),
      fileCopy: make("fileCopy"),
      fileDelete: make("fileDelete"),
      fileInfo: make("fileInfo"),
      fileList: make("fileList"),
      fileMove: make("fileMove"),
      fileRead: make("fileRead"),
      fileWrite: make("fileWrite"),
      health: make("health"),
      userSelfInfo: make("userSelfInfo")
    }
  };
}

async function executeCode(space, code) {
  const targetWindow = makeTargetWindow(space);
  const context = executionModule.createExecutionContext({ targetWindow });

  return context.execute(code);
}

// ============================================================================
// 1 — the refusal itself
// ============================================================================

test("a delete from inside run_code THROWS, and the message names the typed file_delete tool", async () => {
  const { client, calls } = makeStubClient();
  const result = await executeCode({ api: client }, 'space.api.fileDelete("L2/alice/notes.txt")');

  assert.equal(result.status, "error", "the delete must fail LOUDLY, not return a value");
  assert.ok(result.error, "the failure must carry a model-facing error object");
  assert.match(
    result.error.message,
    /file_delete/u,
    "the message must name the gated typed tool the model should use instead"
  );
  assert.match(
    result.error.message,
    /run_code/u,
    "the message must name where the delete came from, so the model can connect cause and rule"
  );
  assert.match(
    result.error.message,
    /not permitted|refused/u,
    "the message must say plainly that the action is refused"
  );
  assert.match(
    result.error.message,
    /Nothing was deleted/u,
    "the message must state the outcome, not leave the model guessing whether it half-ran"
  );
  assert.match(
    result.error.message,
    /confirm/u,
    "the message must say the typed tool asks the user first — that is the reason to route there"
  );

  assert.equal(calls.length, 0, "the real file layer was reached: the guard is a no-op");
});

// ============================================================================
// 2 — every observed shape, including the batch trap
// ============================================================================

for (const [label, code] of ALL_DELETE_SHAPES) {
  test(`refuses the ${label} shape` , async () => {
    const { client, calls } = makeStubClient();
    const result = await executeCode({ api: client }, code);

    assert.equal(result.status, "error", `the ${label} shape did not throw`);
    assert.match(result.error.message, /file_delete/u);
    assert.equal(
      calls.filter((call) => call.name === "fileDelete").length,
      0,
      `the ${label} shape reached the real client`
    );
  });
}

test("a delete reached through a variable or a nested call still throws", async () => {
  const { client, calls } = makeStubClient();
  const code = [
    "const api = space.api;",
    'await api.fileDelete("L2/alice/notes.txt");'
  ].join("\n");
  const result = await executeCode({ api: client }, code);

  assert.equal(result.status, "error");
  assert.equal(calls.length, 0);
});

test("a delete STEP inside a larger multi-op block refuses the whole block rather than half-running it", async () => {
  const { client, calls } = makeStubClient();
  const code = [
    'const info = await space.api.fileInfo("L2/alice/notes.txt");',
    'await space.api.fileWrite({ path: "L2/alice/log.txt", content: info + "\\n", operation: "append" });',
    'await space.api.fileDelete("L2/alice/notes.txt");'
  ].join("\n");
  const result = await executeCode({ api: client }, code);

  assert.equal(result.status, "error");
  assert.equal(
    calls.filter((call) => call.name === "fileDelete").length,
    0,
    "the delete in the middle of a batched job must not run"
  );
});

// ============================================================================
// 3 — nothing deleted, proved against the REAL client and its transport
// ============================================================================

function makeRecordingTransport() {
  const requests = [];
  const transport = async (url, init = {}) => {
    const href = String(url);
    const endpoint = href.slice(href.lastIndexOf("/") + 1).split("?")[0];
    let body = init.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // leave the raw string; only JSON is interesting to these assertions
      }
    }

    requests.push({ body, endpoint, method: init.method });

    return new Response(JSON.stringify({ endpoint, ok: true }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };

  return { requests, transport };
}

const { createApiClient } = await import(
  "../app/L0/_all/modules/_core/framework/js/api-client.js"
);

test("NOTHING is deleted: no file_delete request leaves the page for any refused shape", async () => {
  const { requests, transport } = makeRecordingTransport();
  const realClient = createApiClient({ basePath: "/api" });
  globalThis.fetch = transport;

  try {
    const targetWindow = makeTargetWindow({ api: realClient });
    const context = executionModule.createExecutionContext({ targetWindow });

    for (const [, code] of ALL_DELETE_SHAPES) {
      const result = await context.execute(code);
      assert.equal(result.status, "error", `shape did not refuse: ${code}`);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(
    requests.filter((request) => request.endpoint === "file_delete").length,
    0,
    "a file_delete request reached the backend through the run_code scope"
  );
});

// ============================================================================
// 4 — faithful pass-through
// ============================================================================

const PASS_THROUGH_CALLS = [
  ["fileWrite", [{ content: "x", operation: "append", path: "L2/alice/notes.txt" }]],
  ["fileRead", ["L2/alice/notes.txt"]],
  ["fileList", ["~/", true]],
  ["fileCopy", ["L2/alice/a.txt", "L2/alice/b.txt"]],
  ["fileMove", ["L2/alice/a.txt", "L2/alice/b.txt"]],
  ["fileInfo", ["L2/alice/notes.txt"]],
  ["call", ["user_self_info", { method: "GET" }]]
];

for (const [method, args] of PASS_THROUGH_CALLS) {
  test(`${method} stays a faithful pass-through inside the same scope`, async () => {
    const { client, calls } = makeStubClient();
    const argumentSource = JSON.stringify(args);
    const result = await executeCode(
      { api: client },
      `return { value: await space.api.${method}(...${argumentSource}) };`
    );

    assert.equal(result.status, "success", result.error?.message);
    assert.deepEqual(result.result, { value: `${method}:result` }, "the return value changed");
    assert.equal(calls.length, 1, `the real client was not called exactly once for ${method}`);
    assert.equal(calls[0].name, method);
    assert.deepEqual(calls[0].args, args, "the arguments were reshaped on the way through");
  });
}

test("an append write still reaches the real client with its operation intact", async () => {
  const { requests, transport } = makeRecordingTransport();
  const realClient = createApiClient({ basePath: "/api" });
  globalThis.fetch = transport;

  try {
    const targetWindow = makeTargetWindow({ api: realClient });
    const context = executionModule.createExecutionContext({ targetWindow });
    const result = await context.execute([
      'await space.api.fileWrite({ path: "L2/alice/log.txt", content: "line", operation: "append" });',
      "return \"written\";"
    ].join("\n"));

    assert.equal(result.status, "success", result.error?.message);
    assert.equal(result.result, "written");
  } finally {
    globalThis.fetch = previousFetch;
  }

  const write = requests.find((request) => request.endpoint === "file_write");
  assert.ok(write, "the append write never left the page — the facade broke fileWrite");
  assert.equal(write.body.operation, "append", "the operation was dropped on the way through");
  assert.equal(write.body.path, "L2/alice/log.txt");
  assert.equal(write.body.content, "line");
});

// ============================================================================
// 5 — the real client survives
// ============================================================================

test("the real globalThis.space.api.fileDelete is UNCHANGED and still callable", async () => {
  const { requests, transport } = makeRecordingTransport();
  const realClient = createApiClient({ basePath: "/api" });
  const originalFileDelete = realClient.fileDelete;
  const runtimeSpace = { api: realClient };
  const savedGlobalSpace = globalThis.space;

  globalThis.space = runtimeSpace;
  globalThis.fetch = transport;

  try {
    // Drive a refused delete through the code scope first: it must not mutate anything.
    const targetWindow = makeTargetWindow(runtimeSpace);
    const context = executionModule.createExecutionContext({ targetWindow });
    const refused = await context.execute('space.api.fileDelete("L2/alice/notes.txt")');
    assert.equal(refused.status, "error");

    assert.equal(
      globalThis.space.api.fileDelete,
      originalFileDelete,
      "the shared client's fileDelete was replaced — the Files dialog would break"
    );

    // The human Files delete path still deletes.
    await globalThis.space.api.fileDelete("L2/alice/notes.txt");
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.space = savedGlobalSpace;
  }

  const deletes = requests.filter((request) => request.endpoint === "file_delete");
  assert.equal(deletes.length, 1, "the product's own delete path must still reach the backend");
  assert.equal(deletes[0].body.path, "L2/alice/notes.txt");
});

// ============================================================================
// 6 — the surface parity claim
// ============================================================================

test("every enumerable key of the real client exists on the facade, and only fileDelete differs", async () => {
  const realClient = createApiClient({ basePath: "/api" });
  const facade = executionModule.createRunCodeSpaceFacade({ api: realClient });

  assert.ok(facade, "the facade factory must exist — this is the BUG-014 guard");

  const realKeys = Object.keys(realClient).sort();
  const facadeKeys = Object.keys(facade.api).sort();

  assert.deepEqual(facadeKeys, realKeys, "the facade invented or lost an api key");

  const differing = [];

  for (const key of realKeys) {
    if (facade.api[key] === realClient[key]) {
      continue;
    }

    differing.push(key);
  }

  assert.deepEqual(differing, ["fileDelete"], "a method other than fileDelete was altered");

  for (const key of realKeys) {
    if (key === "fileDelete") {
      continue;
    }

    assert.equal(
      facade.api[key],
      realClient[key],
      `${key} is not the real client's own function — identity changed on the way through`
    );
  }

  assert.equal(typeof realClient.fileDelete, "function", "the real client still has its own delete");
  assert.throws(() => facade.api.fileDelete("L2/alice/notes.txt"), /file_delete/u);
});

test("the facade delegates the rest of the runtime namespace untouched", async () => {
  const realSpace = {
    api: { fileDelete() { return "real"; } },
    chat: { messages: [] },
    skills: { load() { return "loaded"; } },
    utils: { yaml: { parse() { return {}; } } }
  };
  const facade = executionModule.createRunCodeSpaceFacade(realSpace);

  assert.equal(facade.chat, realSpace.chat, "a non-api runtime key was reshaped");
  assert.equal(facade.skills, realSpace.skills);
  assert.equal(facade.utils, realSpace.utils);
  assert.equal(facade.api.fileDelete, executionModule.createRunCodeSpaceFacade(realSpace).api.fileDelete, "the refusal must be one stable function");
  assert.throws(() => facade.api.fileDelete("x"), /file_delete/u);
});

test("a runtime with no api still yields a usable facade instead of throwing at build time", () => {
  const facade = executionModule.createRunCodeSpaceFacade({ chat: { messages: [] } });

  assert.equal(facade.chat.messages.length, 0);
  assert.throws(() => facade.api.fileDelete("x"), /file_delete/u);
});

// ============================================================================
// 7 — the guard is loud, not a silent no-op
// ============================================================================

test("the refusal is not a generic error: it carries its own name and code", async () => {
  const { client } = makeStubClient();
  const result = await executeCode({ api: client }, 'space.api.fileDelete("L2/alice/notes.txt")');

  // The surface's `createExecutionError` projects `{message, name, stack, text}`, so the
  // name is what survives into a tool result the model reads.
  assert.equal(result.error.name, "RunCodeDeleteRefusedError");
  assert.notEqual(result.error.message, "Error", "a bare Error message is a silent-ish failure");

  // The `code` is carried on the error the facade throws — read it at the source, because
  // the surface projection deliberately keeps only the four fields above.
  const facade = executionModule.createRunCodeSpaceFacade({ api: client });
  let thrown = null;

  try {
    facade.api.fileDelete("L2/alice/notes.txt");
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown, "the facade must THROW; a silent no-op is the defect this lane closes");
  assert.equal(thrown.name, "RunCodeDeleteRefusedError");
  assert.equal(thrown.code, "run_code_delete_refused");
  assert.equal(thrown.message, executionModule.formatRunCodeDeleteRefusal());
});

test.after(() => {
  globalThis.space = previousSpace;
  globalThis.window = previousWindow;
  globalThis.fetch = previousFetch;
});
