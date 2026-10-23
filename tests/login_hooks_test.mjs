import assert from "node:assert/strict";
import test from "node:test";

import {
  ANY_LOGIN_EXTENSION_POINT,
  FIRST_LOGIN_EXTENSION_POINT,
  LOGIN_HOOKS_STATE_PATH,
  buildLoginHooksStateContent,
  executeLoginHooksBootstrap,
  isLoginNavigation
} from "../app/L0/_all/modules/_core/login_hooks/login-hooks.js";

test("buildLoginHooksStateContent returns a stable marker payload", () => {
  assert.equal(
    buildLoginHooksStateContent({
      firstLoginCompletedAt: "2026-04-09T10:11:12.000Z"
    }),
    [
      "{",
      '  "first_login_completed": true,',
      '  "first_login_completed_at": "2026-04-09T10:11:12.000Z",',
      '  "version": 1',
      "}",
      ""
    ].join("\n")
  );
});

test("isLoginNavigation only matches same-origin /login referrers", () => {
  assert.equal(
    isLoginNavigation({
      origin: "http://space.test",
      referrer: "http://space.test/login"
    }),
    true
  );

  assert.equal(
    isLoginNavigation({
      origin: "http://space.test",
      referrer: "http://space.test/enter"
    }),
    false
  );

  assert.equal(
    isLoginNavigation({
      origin: "http://space.test",
      referrer: "http://other.test/login"
    }),
    false
  );
});

test("executeLoginHooksBootstrap runs first-login and any-login hooks when the marker is missing after login", async () => {
  const calls = [];
  const writes = [];

  const result = await executeLoginHooksBootstrap({
    extensionCaller: async (extensionPoint, context) => {
      calls.push({ context, extensionPoint });
    },
    now: "2026-04-09T10:11:12.000Z",
    origin: "http://space.test",
    referrer: "http://space.test/login",
    runtime: {
      api: {
        async fileInfo(path) {
          assert.equal(path, LOGIN_HOOKS_STATE_PATH);
          throw new Error("status 404");
        },
        async fileWrite(path, content, encoding) {
          writes.push({ content, encoding, path });
          return { path };
        },
        async userSelfInfo() {
          return {
            fullName: "Alice Example",
            groups: ["_all"],
            managedGroups: [],
            username: "alice"
          };
        }
      }
    }
  });

  assert.deepEqual(
    calls.map((entry) => ({
      extensionPoint: entry.extensionPoint,
      isFirstLogin: entry.context.isFirstLogin,
      isLoginNavigation: entry.context.isLoginNavigation,
      markerPath: entry.context.markerPath,
      username: entry.context.username
    })),
    [
      {
        extensionPoint: FIRST_LOGIN_EXTENSION_POINT,
        isFirstLogin: true,
        isLoginNavigation: true,
        markerPath: LOGIN_HOOKS_STATE_PATH,
        username: "alice"
      },
      {
        extensionPoint: ANY_LOGIN_EXTENSION_POINT,
        isFirstLogin: true,
        isLoginNavigation: true,
        markerPath: LOGIN_HOOKS_STATE_PATH,
        username: "alice"
      }
    ]
  );

  assert.deepEqual(writes, [
    {
      content: buildLoginHooksStateContent({
        firstLoginCompletedAt: "2026-04-09T10:11:12.000Z"
      }),
      encoding: "utf8",
      path: LOGIN_HOOKS_STATE_PATH
    }
  ]);

  assert.deepEqual(result, {
    identity: {
      fullName: "Alice Example",
      groups: ["_all"],
      managedGroups: [],
      username: "alice"
    },
    isFirstLogin: true,
    isLoginNavigation: true,
    markerExists: false,
    ranAnyLogin: true,
    ranFirstLogin: true
  });
});

test("executeLoginHooksBootstrap only runs any-login hooks when the first-login marker already exists", async () => {
  const calls = [];

  const result = await executeLoginHooksBootstrap({
    extensionCaller: async (extensionPoint, context) => {
      calls.push({ context, extensionPoint });
    },
    origin: "http://space.test",
    referrer: "http://space.test/login",
    runtime: {
      api: {
        async fileInfo(path) {
          assert.equal(path, LOGIN_HOOKS_STATE_PATH);
          return {
            path
          };
        },
        async fileWrite() {
          throw new Error("fileWrite should not run when the marker exists.");
        },
        async userSelfInfo() {
          return {
            fullName: "Alice Example",
            groups: ["_all"],
            managedGroups: [],
            username: "alice"
          };
        }
      }
    }
  });

  assert.deepEqual(
    calls.map((entry) => ({
      extensionPoint: entry.extensionPoint,
      isFirstLogin: entry.context.isFirstLogin,
      isLoginNavigation: entry.context.isLoginNavigation
    })),
    [
      {
        extensionPoint: ANY_LOGIN_EXTENSION_POINT,
        isFirstLogin: false,
        isLoginNavigation: true
      }
    ]
  );

  assert.deepEqual(result, {
    identity: {
      fullName: "Alice Example",
      groups: ["_all"],
      managedGroups: [],
      username: "alice"
    },
    isFirstLogin: false,
    isLoginNavigation: true,
    markerExists: true,
    ranAnyLogin: true,
    ranFirstLogin: false
  });
});

test("executeLoginHooksBootstrap only runs first-login hooks when the marker is missing outside a login navigation", async () => {
  const calls = [];
  const writes = [];

  const result = await executeLoginHooksBootstrap({
    extensionCaller: async (extensionPoint, context) => {
      calls.push({ context, extensionPoint });
    },
    now: "2026-04-09T10:11:12.000Z",
    origin: "http://space.test",
    referrer: "http://space.test/enter",
    runtime: {
      api: {
        async fileInfo() {
          throw new Error("File not found.");
        },
        async fileWrite(path, content, encoding) {
          writes.push({ content, encoding, path });
          return { path };
        },
        async userSelfInfo() {
          return {
            fullName: "Alice Example",
            groups: ["_all"],
            managedGroups: [],
            username: "alice"
          };
        }
      }
    }
  });

  assert.deepEqual(
    calls.map((entry) => entry.extensionPoint),
    [FIRST_LOGIN_EXTENSION_POINT]
  );

  assert.deepEqual(writes, [
    {
      content: buildLoginHooksStateContent({
        firstLoginCompletedAt: "2026-04-09T10:11:12.000Z"
      }),
      encoding: "utf8",
      path: LOGIN_HOOKS_STATE_PATH
    }
  ]);

  assert.deepEqual(result, {
    identity: {
      fullName: "Alice Example",
      groups: ["_all"],
      managedGroups: [],
      username: "alice"
    },
    isFirstLogin: true,
    isLoginNavigation: false,
    markerExists: false,
    ranAnyLogin: false,
    ranFirstLogin: true
  });
});
