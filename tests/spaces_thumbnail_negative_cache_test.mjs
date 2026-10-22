import assert from "node:assert/strict";
import module from "node:module";
import test from "node:test";

/**
 * Regression coverage for issue #15 (thumbnail half).
 *
 * Root cause: the thumbnail experiment deletes thumbnail paths it has no
 * evidence about. Every capture writes one format and then deletes the sibling
 * format, and clearSpaceThumbnailFiles deletes both formats. The server answers
 * a missing path with a hard 404, so a space without a thumbnail re-issues the
 * same failing delete on every capture (manifest save, layout save, post-save
 * reload). This suite pins the module-local negative cache: an observed absent
 * file is not probed again while the space record version is unchanged.
 */

const appModRootUrl = new URL("../app/L0/_all/mod/", import.meta.url).href;
const screenshotsStubUrl =
  "data:text/javascript," +
  encodeURIComponent("export const renderScreenshotCanvas = async () => ({ height: 300, width: 400 });\n");

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/skillset/ext/skills/screenshots/screenshots.js")) {
      return { url: screenshotsStubUrl, shortCircuit: true };
    }

    if (specifier.startsWith("/mod/")) {
      return {
        url: `${appModRootUrl}${specifier.slice("/mod/".length)}`,
        shortCircuit: true
      };
    }

    return nextResolve(specifier, context);
  }
});

class FakeHtmlElement {}

class FakeCanvasElement extends FakeHtmlElement {
  constructor(rect) {
    super();
    this.isConnected = true;
    this.rect = rect;
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

class FakeGridElement extends FakeHtmlElement {
  constructor(widgets) {
    super();
    this.isConnected = true;
    this.widgets = widgets;
  }

  querySelectorAll() {
    return this.widgets;
  }
}

function createThumbnailEnv() {
  const deletes = [];
  const writes = [];
  const existingFiles = new Set();

  globalThis.HTMLElement = FakeHtmlElement;
  globalThis.FileReader = class FakeFileReader {
    readAsDataURL() {
      this.result = "data:image/webp;base64,QUJD";

      if (typeof this.onload === "function") {
        this.onload();
      }
    }
  };
  globalThis.window = {
    clearTimeout: (handle) => clearTimeout(handle),
    devicePixelRatio: 1,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs)
  };
  globalThis.document = {
    createElement() {
      return {
        height: 0,
        width: 0,
        getContext: () => ({
          drawImage() {},
          fillRect() {},
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "high"
        }),
        toBlob: (callback, type) => callback({ size: 16, type })
      };
    }
  };
  globalThis.space = {
    api: {
      async fileDelete(path) {
        const normalizedPath = String(path || "");
        const exists = existingFiles.has(normalizedPath);

        deletes.push({ path: normalizedPath, status: exists ? 200 : 404 });

        if (!exists) {
          throw new Error(`API file_delete failed with status 404: Path not found: ${normalizedPath}`);
        }

        existingFiles.delete(normalizedPath);
        return { path: normalizedPath };
      },
      async fileWrite(input) {
        const path = String(input?.path || "");

        writes.push({ path });
        existingFiles.add(path);
        return { path };
      }
    }
  };

  return {
    addExistingFile: (path) => existingFiles.add(path),
    createCanvasElement: () =>
      new FakeCanvasElement({ bottom: 300, height: 300, left: 0, right: 400, top: 0, width: 400 }),
    createGridElement: () =>
      new FakeGridElement([
        new FakeCanvasElement({ bottom: 140, height: 120, left: 20, right: 140, top: 20, width: 120 })
      ]),
    deletes,
    writes
  };
}

const thumbnailModule = await import("../app/L0/_all/mod/_core/spaces/thumbnail_experiment/index.js");

const {
  buildSpaceThumbnailUrlFromPath,
  captureSpaceThumbnailNow,
  clearSpaceThumbnailFiles,
  resolveListedSpaceThumbnailPath
} = thumbnailModule;

async function capture(env, spaceId, updatedAt) {
  return captureSpaceThumbnailNow({
    canvasElement: env.createCanvasElement(),
    gridElement: env.createGridElement(),
    spaceId,
    updatedAt,
    widgetCount: 1
  });
}

test("capture does not re-probe the sibling thumbnail format for an unchanged space version", async () => {
  const env = createThumbnailEnv();
  const spaceId = "space-thumb-capture-1";

  const firstResult = await capture(env, spaceId, "2026-05-01T00:00:00.000Z");
  const secondResult = await capture(env, spaceId, "2026-05-01T00:00:00.000Z");

  assert.equal(typeof firstResult.url, "string");
  assert.equal(firstResult.fileName, "thumbnail.webp");
  assert.equal(env.writes.length, 2);
  assert.deepEqual(
    env.deletes.map((entry) => entry.path),
    [`~/spaces/${spaceId}/thumbnail.jpg`],
    "the absent sibling format must be probed once, not on every capture"
  );
  assert.equal(env.deletes[0].status, 404);
  assert.equal(typeof secondResult.url, "string");
});

test("capture re-probes the sibling format after the space record version changes", async () => {
  const env = createThumbnailEnv();
  const spaceId = "space-thumb-capture-2";

  await capture(env, spaceId, "v1");
  await capture(env, spaceId, "v1");
  assert.equal(env.deletes.length, 1);

  await capture(env, spaceId, "v2");

  assert.deepEqual(
    env.deletes.map((entry) => entry.path),
    [`~/spaces/${spaceId}/thumbnail.jpg`, `~/spaces/${spaceId}/thumbnail.jpg`],
    "a new space version must be allowed to re-check the absent format"
  );
});

test("clear skips repeat probes while the version is unchanged", async () => {
  const env = createThumbnailEnv();
  const spaceId = "space-thumb-clear-1";

  const firstResult = await clearSpaceThumbnailFiles(spaceId, { updatedAt: "v1" });
  await clearSpaceThumbnailFiles(spaceId, { updatedAt: "v1" });

  assert.equal(firstResult.deleted, true);
  assert.equal(firstResult.url, "");
  assert.equal(env.deletes.length, 2, "the first clear probes both formats once");

  await clearSpaceThumbnailFiles(spaceId, { updatedAt: "v2" });

  assert.equal(env.deletes.length, 4, "a new space version re-arms both format checks");
});

test("clear keeps its single-argument call shape", async () => {
  const env = createThumbnailEnv();
  const spaceId = "space-thumb-clear-2";

  const result = await clearSpaceThumbnailFiles(spaceId);

  assert.deepEqual(result, { deleted: true, path: "", spaceId, url: "" });
  assert.equal(env.deletes.length, 2);

  await clearSpaceThumbnailFiles(spaceId);

  assert.equal(env.deletes.length, 2, "unversioned repeats stay suppressed");
});

test("a successful delete also marks the thumbnail file absent", async () => {
  const env = createThumbnailEnv();
  const spaceId = "space-thumb-clear-3";

  env.addExistingFile(`~/spaces/${spaceId}/thumbnail.webp`);
  env.addExistingFile(`~/spaces/${spaceId}/thumbnail.jpg`);

  await clearSpaceThumbnailFiles(spaceId, { updatedAt: "v3" });
  await clearSpaceThumbnailFiles(spaceId, { updatedAt: "v3" });

  assert.deepEqual(
    env.deletes.map((entry) => entry.status),
    [200, 200],
    "deleting existing thumbnails must not degrade into repeated probes"
  );
});

test("url building is suppressed for a known-absent thumbnail and restored by a listing match", async () => {
  const env = createThumbnailEnv();
  const spaceId = "space-thumb-url-1";

  await clearSpaceThumbnailFiles(spaceId, { updatedAt: "v1" });

  assert.equal(
    buildSpaceThumbnailUrlFromPath(`~/spaces/${spaceId}/thumbnail.jpg`, "v1"),
    "",
    "a known-absent thumbnail path must not produce a 404 url"
  );
  assert.equal(
    buildSpaceThumbnailUrlFromPath(`~/spaces/${spaceId}/assets/other.png`, "v1"),
    `/~/spaces/${spaceId}/assets/other.png?v=v1`,
    "non-thumbnail paths keep the plain url shape"
  );

  const listedPath = `L2/alice/spaces/${spaceId}/thumbnail.jpg`;

  assert.equal(resolveListedSpaceThumbnailPath(spaceId, [listedPath]), listedPath);
  assert.equal(
    buildSpaceThumbnailUrlFromPath(`~/spaces/${spaceId}/thumbnail.jpg`, "v1"),
    `/~/spaces/${spaceId}/thumbnail.jpg?v=v1`,
    "a listing match is positive evidence and re-enables the url"
  );
  assert.equal(
    buildSpaceThumbnailUrlFromPath(listedPath, "v1"),
    `/${listedPath}?v=v1`,
    "the cache key is shared across path forms"
  );
});
