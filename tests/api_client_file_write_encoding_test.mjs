import test from "node:test";
import assert from "node:assert/strict";

import { createApiClient } from "../app/L0/_all/modules/_core/framework/js/api-client.js";

const realFetch = globalThis.fetch;
const realWindow = globalThis.window;

function createCapturingFetch(captured) {
  return async (url, init) => {
    captured.push({ init, url: String(url) });

    return new Response(JSON.stringify({ ok: true }), {
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

test("fileWrite coerces a lone encoding object argument to its encoding string", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });
    await client.fileWrite("~/docs/notes.txt", "pan", { encoding: "utf8" });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "http://api.test/api/file_write");
    assert.equal(captured[0].init.method, "POST");

    const body = JSON.parse(captured[0].init.body);
    assert.equal(body.path, "~/docs/notes.txt");
    assert.equal(body.content, "pan");
    assert.equal(body.encoding, "utf8");
  });
});

test("fileWrite keeps string encodings and falls back to utf8 for omitted encodings", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await client.fileWrite("~/docs/a.txt", "a", "base64");
    let body = JSON.parse(captured[0].init.body);
    assert.equal(body.encoding, "base64");

    await client.fileWrite("~/docs/b.txt", "b");
    body = JSON.parse(captured[1].init.body);
    assert.equal(body.encoding, "utf8");

    await client.fileWrite("~/docs/c.txt", "c", null);
    body = JSON.parse(captured[2].init.body);
    assert.equal(body.encoding, "utf8");
  });
});

test("fileWrite rejects a rich options object as the encoding argument with the accepted form", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await assert.rejects(
      client.fileWrite("~/docs/d.txt", "d", { encoding: "utf8", operation: "append" }),
      (error) => {
        assert.match(error.message, /Unsupported fileWrite encoding/u);
        assert.ok(String(error.message).includes('The encoding must be a string such as "utf8" or "base64"'));
        assert.ok(String(error.message).includes('{ path, content, operation }'));
        return true;
      }
    );

    await assert.rejects(
      client.fileWrite("~/docs/e.txt", "e", 42),
      /Unsupported fileWrite encoding/u
    );

    assert.equal(captured.length, 0);
  });
});

test("object-form and batch writes keep normalizing their encoding fields", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await client.fileWrite({ content: "x", encoding: { encoding: "utf8" }, operation: "append", path: "~/docs/f.txt" });
    let body = JSON.parse(captured[0].init.body);
    assert.equal(body.encoding, "utf8");
    assert.equal(body.operation, "append");

    await client.fileWrite([{ content: "y", path: "~/docs/g.txt" }, { content: "z", encoding: "base64", path: "~/docs/h.txt" }]);
    body = JSON.parse(captured[1].init.body);
    assert.equal(body.encoding, "utf8");
    assert.equal(body.files.length, 2);

    await assert.rejects(
      client.fileWrite({ content: "q", encoding: { encoding: "utf8", extra: true }, path: "~/docs/i.txt" }),
      /Unsupported fileWrite encoding/u
    );
  });
});

test("fileWrite never sends a request when the encoding argument is rejected", async () => {
  await withCapturedFetch(async (captured) => {
    const client = createApiClient({ basePath: "/api" });

    await assert.rejects(client.fileWrite("~/j.txt", "j", { fancy: true }), /Unsupported fileWrite encoding/u);
    assert.equal(captured.length, 0);
  });
});
