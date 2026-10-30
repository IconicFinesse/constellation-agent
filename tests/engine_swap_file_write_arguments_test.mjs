// Focused coverage for BUG-011: positional write arguments that JavaScript
// silently discards.
//
// The defect: `space.api.fileWrite(path, content, encoding)` has three
// parameters. A model calling
//
//   space.api.fileWrite(path, "line\n", "utf8", { operation: "append" })
//
// had its fourth argument thrown away with no error, `createFileWriteRequest`
// emitted `{ content, encoding, path }` with no `operation`, and the server
// treated the call as a FULL REPLACE. The file was clobbered to the new content
// and a success result came back — silent data loss observed twice in a real
// beta run, both times in exactly that four-argument form.
//
// The sibling hole is `fileList(path, recursive)`, whose boolean second slot
// received options objects from models and from the typed `file_list` dispatch
// adapter: the object was stringified into `recursive=[object Object]` and every
// filter inside it (`access`, `writableOnly`, `gitRepositories`) was dropped, so
// a caller asking for writable paths silently received a readable listing.
//
// What this locks down:
//   - the four-argument positional write THROWS, names `operation`, and names
//     the object form, the batch form, and the typed tool as the retry shapes
//   - no request is sent when a call is rejected
//   - the three-argument form, the object form and the batch form are unchanged
//     (existing append behaviour stays byte-identical)
//   - the options object in `fileList`'s second slot keeps its filters, a real
//     boolean still works, and a third positional argument throws
//   - the typed `file_list` tool keeps `access`/`writableOnly` on the wire
//
// Hermetic: no network (fetch is replaced with a capturer), no disk, no browser.

import test from "node:test";
import assert from "node:assert/strict";

import { createApiClient } from "../app/L0/_all/modules/_core/framework/js/api-client.js";
import { createDispatchPipeline } from "../app/L0/_all/modules/_core/framework/js/engine-swap/dispatch-pipeline.js";
import { createDestructiveGate } from "../app/L0/_all/modules/_core/framework/js/engine-swap/destructive-gate.js";
import { createToolRegistry } from "../app/L0/_all/modules/_core/framework/js/engine-swap/tool-registry.js";

const realFetch = globalThis.fetch;
const realWindow = globalThis.window;

function createCapturingFetch(captured) {
  return async (url, init) => {
    captured.push({ init, url: String(url) });

    return new Response(JSON.stringify({ access: "read", content: "x", encoding: "utf8", ok: true, path: "~/", paths: [] }), {
      headers: {
        "content-type": "application/json"
      },
      status: 200
    });
  };
}

function withCapturedFetch(run) {
  const captured = [];
  globalThis.fetch = createCapturingFetch(captured);
  globalThis.window = { location: { origin: "http://api.test" } };

  return Promise.resolve()
    .then(() => run(captured))
    .finally(() => {
      globalThis.fetch = realFetch;

      if (realWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = realWindow;
      }
    });
}

function bodyOf(entry) {
  return JSON.parse(entry.init.body);
}

function queryOf(entry) {
  return new URL(entry.url).searchParams;
}

// --- the defect ------------------------------------------------------------

test("fileWrite throws when a fourth positional argument would be dropped", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await assert.rejects(
      client.fileWrite("~/docs/notes.txt", "line\n", "utf8", { operation: "append" }),
      (error) => {
        assert.match(error.message, /Unsupported fileWrite arguments/u);
        assert.match(error.message, /4 positional arguments/u);
        // The coaching must name the exact retry shapes, not just complain.
        assert.ok(String(error.message).includes("operation"));
        assert.ok(String(error.message).includes('{ path, content, operation: "append" | "prepend" | "insert" }'));
        assert.ok(String(error.message).includes("{ files: [...] }"));
        assert.ok(String(error.message).includes("file_write"));
        return true;
      }
    );

    // Nothing may reach the wire: a rejected call must not clobber anything.
    assert.equal(captured.length, 0);
  });
});

test("fileWrite still throws for a fifth argument too", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await assert.rejects(
      client.fileWrite("~/docs/a.txt", "a", "utf8", { operation: "append" }, { extra: true }),
      /Unsupported fileWrite arguments/u
    );

    assert.equal(captured.length, 0);
  });
});

// --- the shapes that must keep working -------------------------------------

test("the three-argument positional form still sends a plain replace", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await client.fileWrite("~/docs/replace.txt", "whole\n", "utf8");

    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "http://api.test/api/file_write");
    assert.equal(captured[0].init.method, "POST");
    assert.deepEqual(bodyOf(captured[0]), {
      content: "whole\n",
      encoding: "utf8",
      path: "~/docs/replace.txt"
    });
    assert.equal(bodyOf(captured[0]).operation, undefined);
  });
});

test("the object form still sends its append operation", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await client.fileWrite({ content: "line\n", operation: "append", path: "~/docs/append.txt" });

    assert.equal(captured.length, 1);
    assert.deepEqual(bodyOf(captured[0]), {
      content: "line\n",
      encoding: "utf8",
      operation: "append",
      path: "~/docs/append.txt"
    });
  });
});

test("the object form still sends insert anchors", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await client.fileWrite({ after: "anchor", content: "line\n", operation: "insert", path: "~/docs/insert.txt" });

    assert.deepEqual(bodyOf(captured[0]), {
      after: "anchor",
      content: "line\n",
      encoding: "utf8",
      operation: "insert",
      path: "~/docs/insert.txt"
    });
  });
});

test("the batch files form is unchanged", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await client.fileWrite({
      files: [
        { content: "a", path: "~/docs/a.txt" },
        { content: "b", path: "~/docs/b.txt" }
      ]
    });

    assert.deepEqual(bodyOf(captured[0]), {
      encoding: "utf8",
      files: [
        { content: "a", path: "~/docs/a.txt" },
        { content: "b", path: "~/docs/b.txt" }
      ]
    });
  });
});

// --- the sibling hole: fileList's second slot ------------------------------

test("fileList keeps an options object passed in the recursive slot", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await client.fileList("~/", { access: "write", writableOnly: true });

    const query = queryOf(captured[0]);
    assert.equal(query.get("path"), "~/");
    assert.equal(query.get("access"), "write");
    assert.equal(query.get("writableOnly"), "true");
    // The defect's signature: the object stringified into the recursive flag.
    assert.notEqual(query.get("recursive"), "[object Object]");
    assert.equal(query.get("recursive"), "false");
  });
});

test("fileList still honours a real boolean and the options-object form", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await client.fileList("~/", true);
    assert.equal(queryOf(captured[0]).get("recursive"), "true");

    await client.fileList({ access: "write", path: "~/", recursive: true, writableOnly: true });
    const query = queryOf(captured[1]);
    assert.equal(query.get("recursive"), "true");
    assert.equal(query.get("access"), "write");
    assert.equal(query.get("writableOnly"), "true");
  });
});

test("fileList throws when a third positional argument would be dropped", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await assert.rejects(
      client.fileList("~/", false, { access: "write" }),
      (error) => {
        assert.match(error.message, /Unsupported fileList arguments/u);
        assert.match(error.message, /3 positional arguments/u);
        assert.ok(String(error.message).includes("access"));
        assert.ok(String(error.message).includes("writableOnly"));
        assert.ok(String(error.message).includes("file_list"));
        return true;
      }
    );

    assert.equal(captured.length, 0);
  });
});

// --- the typed tool must not lose its filters either -----------------------

test("the typed file_list tool keeps access and writableOnly on the wire", async () => {
  await withCapturedFetch(async (captured) => {
    const api = createApiClient({ basePath: "/api" });
    const pipeline = createDispatchPipeline({
      api,
      gate: createDestructiveGate(),
      registry: createToolRegistry()
    });

    const outcome = await pipeline.dispatchToolCall({
      argumentsJson: JSON.stringify({ access: "write", path: "~/", recursive: true, writableOnly: true }),
      callId: "call-1",
      name: "file_list"
    });

    assert.equal(outcome.status, "ok");
    assert.equal(captured.length, 1);

    const query = queryOf(captured[0]);
    assert.equal(query.get("path"), "~/");
    assert.equal(query.get("access"), "write");
    assert.equal(query.get("writableOnly"), "true");
    assert.equal(query.get("recursive"), "true");
  });
});
