import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAgentServer } from "../server/app.js";

// Covers the BUG-006 path fixes: doubled own-user shorthand collapses to the
// canonical location instead of creating silent nested duplicates, reads fall
// back to a bug-era nested copy when only the doubled path exists, and write
// rejections name the accepted forms.

async function withSeededServer(run, { seed } = {}) {
  const customwarePath = await mkdtemp(path.join(os.tmpdir(), "space-user-path-"));

  if (seed) {
    await seed(customwarePath);
  }

  const runtime = await createAgentServer({
    runtimeParamOverrides: {
      CUSTOMWARE_PATH: customwarePath,
      PORT: "0",
      SINGLE_USER_APP: "true"
    }
  });

  try {
    await runtime.listen();
    await run(runtime, customwarePath);
  } finally {
    await runtime.close();
    await rm(customwarePath, { recursive: true, force: true });
  }
}

async function postJson(runtime, pathname, body) {
  const response = await fetch(`${runtime.browserUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  let parsedBody = null;

  try {
    parsedBody = await response.json();
  } catch (error) {
    parsedBody = null;
  }

  return {
    body: parsedBody,
    response
  };
}

test("doubled own-user shorthand writes land at the canonical location", async () => {
  await withSeededServer(async (runtime, customwarePath) => {
    const writeResult = await postJson(runtime, "/api/file_write", {
      content: "hello",
      path: "~/L2/user/doubled.txt"
    });

    assert.equal(writeResult.response.status, 200);
    assert.equal(writeResult.body.path, "L2/user/doubled.txt");

    const canonicalContent = await readFile(
      path.join(customwarePath, "L2", "user", "doubled.txt"),
      "utf8"
    );
    assert.equal(canonicalContent, "hello");

    await assert.rejects(
      readFile(path.join(customwarePath, "L2", "user", "L2", "user", "doubled.txt"), "utf8"),
      /ENOENT/u
    );
  });
});

test("repeated own-user prefix stacking collapses all the way to the canonical path", async () => {
  await withSeededServer(async (runtime) => {
    const writeResult = await postJson(runtime, "/api/file_write", {
      content: "stacked",
      path: "~/L2/user/L2/user/tripled.txt"
    });

    assert.equal(writeResult.response.status, 200);
    assert.equal(writeResult.body.path, "L2/user/tripled.txt");
  });
});

test("plain canonical writes and single-file reads keep their exact shapes", async () => {
  await withSeededServer(async (runtime) => {
    const writeResult = await postJson(runtime, "/api/file_write", {
      content: "plain",
      path: "~/plain.txt"
    });
    assert.equal(writeResult.response.status, 200);
    assert.equal(writeResult.body.path, "L2/user/plain.txt");

    const readResult = await postJson(runtime, "/api/file_read", {
      path: "~/plain.txt"
    });
    assert.equal(readResult.response.status, 200);
    assert.deepEqual(readResult.body, {
      content: "plain",
      encoding: "utf8",
      path: "L2/user/plain.txt"
    });
  });
});

test("reads fall back to a bug-era doubled-path copy when only it exists", async () => {
  await withSeededServer(
    async (runtime) => {
      const canonicalRead = await postJson(runtime, "/api/file_read", {
        path: "~/legacy-note.txt"
      });
      assert.equal(canonicalRead.response.status, 200);
      assert.equal(canonicalRead.body.content, "bug era content");

      const doubledShorthandRead = await postJson(runtime, "/api/file_read", {
        path: "~/L2/user/legacy-note.txt"
      });
      assert.equal(doubledShorthandRead.response.status, 200);
      assert.equal(doubledShorthandRead.body.content, "bug era content");

      const writeResult = await postJson(runtime, "/api/file_write", {
        content: "rewritten",
        path: "~/legacy-note.txt"
      });
      assert.equal(writeResult.response.status, 200);
      assert.equal(writeResult.body.path, "L2/user/legacy-note.txt");
    },
    {
      seed: async (customwarePath) => {
        await mkdir(path.join(customwarePath, "L2", "user", "L2", "user"), { recursive: true });
        await writeFile(
          path.join(customwarePath, "L2", "user", "L2", "user", "legacy-note.txt"),
          "bug era content",
          "utf8"
        );
      }
    }
  );
});

test("object write encoding is rejected with the accepted forms in the message", async () => {
  await withSeededServer(async (runtime) => {
    const errorResult = await postJson(runtime, "/api/file_write", {
      content: "x",
      encoding: { encoding: "utf16" },
      path: "~/bad-encoding.txt"
    });

    assert.equal(errorResult.response.status, 400);
    assert.match(errorResult.body.error, /Unsupported write encoding/u);
    assert.ok(String(errorResult.body.error).includes('The encoding must be a string such as "utf8" or "base64"'));
    assert.ok(String(errorResult.body.error).includes('{ path, content, operation }'));
  });
});

test("unsupported delete operation is rejected with the supported list and file_delete pointer", async () => {
  await withSeededServer(async (runtime) => {
    const errorResult = await postJson(runtime, "/api/file_write", {
      content: "x",
      operation: "delete",
      path: "~/bad-operation.txt"
    });

    assert.equal(errorResult.response.status, 400);
    assert.match(errorResult.body.error, /Supported operations are/u);
    assert.ok(String(errorResult.body.error).includes('"replace" (default), "append", "prepend", and "insert"'));
    assert.match(errorResult.body.error, /use file_delete to remove a file/u);
  });
});

test("another user's name inside a doubled shorthand never escapes the own root", async () => {
  // In SINGLE_USER_APP mode the session user is the admin, so nested writes are
  // allowed on purpose. The property this lane owns is narrower and security
  // relevant: the own-user collapse must never rewrite a path that names another
  // user into a direct sibling of that user's root. `~/L2/someoneelse/...` must
  // stay nested under the session root instead of collapsing to
  // `L2/someoneelse/...`.
  await withSeededServer(async (runtime, customwarePath) => {
    const writeResult = await postJson(runtime, "/api/file_write", {
      content: "keep nested",
      path: "~/L2/someoneelse/their-copy.txt"
    });

    assert.equal(writeResult.response.status, 200);
    assert.equal(writeResult.body.path, "L2/user/L2/someoneelse/their-copy.txt");

    const nestedRead = await readFile(
      path.join(customwarePath, "L2", "user", "L2", "someoneelse", "their-copy.txt"),
      "utf8"
    );
    assert.equal(nestedRead, "keep nested");

    await assert.rejects(
      readFile(path.join(customwarePath, "L2", "someoneelse", "their-copy.txt"), "utf8"),
      /ENOENT/u
    );
  });
});
