// Focused engine-swap P4a-3a coverage: admin SAFE and CAPABLE, without adoption.
//
// The blocker this pins (recon-verified on `0905d21`): admin's `serializeHistory()`
// persisted only `{ attachments, content, id, kind, role }`, so a typed Tier 1 turn
// looked correct until a page reload erased every tool call and result from the
// transcript. Onscreen persists through `serializeHistoryMessages` +
// `serializeTypedHistoryFields` and has three projection seams admin lacked.
//
// THE TEST THAT MATTERS MOST is `a typed turn survives persist -> reload -> render`:
// it drives the REAL writer (`store.serializeHistoryMessages`), the REAL serialization
// boundary (`JSON.stringify`/`JSON.parse`, exactly what crosses `~/history/admin-chat.json`),
// the REAL reader (`normalizeStoredMessage`, exported for this purpose precisely so the
// test cannot re-implement it), and the REAL render projection. A green suite without
// this case would prove nothing about the actual defect.
//
// HONEST SCOPE — what the consent cases do and do NOT prove: `gate.hold()` is reachable
// only through the Tier 1 dispatch pipeline and the gate is created inside
// `tier1-session.js`, which admin cannot reach while it resolves Tier 3 and both flags
// are off. So the confirm bar ships INERT and these cases are UNIT-LEVEL ONLY: they set
// state, assert the descriptor and the template wiring, call the handlers, and assert
// the call order. They do NOT prove a hold ever appears in admin, that a click reaches a
// real gate, or that a confirmed deletion executes. Nobody should read "consent tested"
// here as "consent worked end-to-end"; end-to-end proof belongs to the adoption lane
// that gives admin a session (P4a-3 steps 3-5).
//
// Hermetic: no disk, no network, no DOM. The store is imported once behind a minimal
// `space` runtime because the product module builds its store at import time.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("./mod_specifier_loader.mjs", import.meta.url), import.meta.url);

const ADMIN_VIEW_DIR = new URL(
  "../app/L0/_all/modules/_core/admin/views/agent/",
  import.meta.url
);

function installRuntime() {
  const writes = [];
  const runtime = {
    api: {
      async fileRead() {
        return { content: "[]" };
      },
      async fileWrite(path, content) {
        writes.push({ content, path });

        return { ok: true };
      }
    },
    config: {
      get(_name, fallback = undefined) {
        return fallback;
      }
    },
    extend(_meta, value) {
      return value;
    },
    fw: {
      createStore(_name, model) {
        return model;
      }
    },
    utils: {
      userCrypto: {
        async decryptText(value) {
          return value;
        },
        async encryptText(value) {
          return value;
        }
      },
      yaml: {
        parse() {
          return {};
        },
        stringify() {
          return "";
        }
      }
    }
  };

  globalThis.document = {
    addEventListener() {},
    body: { appendChild() {} },
    createElement() {
      return { appendChild() {}, classList: { add() {}, remove() {} }, setAttribute() {}, style: {} };
    },
    documentElement: { appendChild() {} },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    removeEventListener() {}
  };
  globalThis.localStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.sessionStorage = { getItem() { return null; }, removeItem() {}, setItem() {} };
  globalThis.window = {
    addEventListener() {},
    cancelAnimationFrame() {},
    console,
    location: { href: "http://localhost/" },
    matchMedia() {
      return { addEventListener() {}, matches: false };
    },
    // The thread view schedules its post-paint scroll restore through rAF, so a
    // window stub without it throws on the render path instead of on a product bug.
    requestAnimationFrame(callback) {
      callback(0);

      return 1;
    },
    removeEventListener() {},
    space: runtime
  };
  globalThis.space = runtime;

  return { runtime, writes };
}

installRuntime();

const storeModule = await import("/modules/_core/admin/views/agent/store.js");
const { adminAgent: store, normalizeStoredMessage } = storeModule;
const shapes = await import(
  "/modules/_core/framework/js/engine-swap/history-shapes.js"
);

// A realistic legacy admin transcript as every `~/history/admin-chat.json` reads today.
const LEGACY_HISTORY = Object.freeze([
  Object.freeze({ attachments: [], content: "hello there", id: "u1", kind: "", role: "user" }),
  Object.freeze({
    attachments: [],
    content: "Hi.\n_____javascript\nreturn await space.api.userSelfInfo()",
    id: "a1",
    kind: "",
    role: "assistant"
  }),
  Object.freeze({
    attachments: [],
    content: "execution ok\nresult↓\nusername: brauk",
    id: "u2",
    kind: "execution-output",
    role: "user"
  })
]);

// One typed Tier 1 turn: the user's ask, the narration the user watched stream, the
// call, and its result. This is the shape admin could not keep.
function createTypedTurn() {
  return [
    { attachments: [], content: "delete my scratch file", id: "u1", kind: "", role: "user" },
    { attachments: [], content: "Removing it now.", id: "assistant-1", kind: "", role: "assistant" },
    shapes.createToolCallEntry({
      arguments: { path: "~/scratch.txt" },
      callId: "call_abc",
      id: "tool-call-call_abc",
      name: "file_delete"
    }),
    shapes.createToolResultEntry({
      callId: "call_abc",
      id: "tool-result-call_abc",
      name: "file_delete",
      payload: { deleted: true, path: "~/scratch.txt" }
    })
  ];
}

function withHistory(history) {
  store.history = history;

  return store;
}

// --- selector-capable DOM, for the ONE case that must observe the paint ------
//
// The render seam is asserted at the DOM rather than by stubbing `agentView.renderMessages`
// because `agentView` is an ESM namespace object: its exports are immutable, so the store's
// own call cannot be replaced. Observing the thread the real renderer builds is the
// equivalent and strictly stronger — it proves the projected bytes reached the PAINT, not
// merely that a function was called.

function camelCaseDataName(dataAttribute) {
  return String(dataAttribute || "")
    .replace(/^data-/iu, "")
    .replace(/-([a-z])/gu, (_m, letter) => letter.toUpperCase());
}

function matchesSelector(element, selector) {
  const trimmed = String(selector || "").trim();

  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith(".")) {
    return element.classList.contains(trimmed.slice(1));
  }

  const compound = trimmed.match(/^([a-z0-9]*)((?:\[[^\]]+\])*)$/iu);

  if (!compound) {
    return false;
  }

  const [, tagName, attributePart] = compound;

  if (tagName && element.tagName.toLowerCase() !== tagName.toLowerCase()) {
    return false;
  }

  return (attributePart.match(/\[[^\]]+\]/gu) || []).every((attributeSelector) => {
    const body = attributeSelector.slice(1, -1);
    const equalsIndex = body.indexOf("=");

    if (equalsIndex === -1) {
      return element.dataset[camelCaseDataName(body)] !== undefined;
    }

    const name = camelCaseDataName(body.slice(0, equalsIndex));
    const value = body.slice(equalsIndex + 1).replace(/^["']|["']$/gu, "");

    return String(element.dataset[name]) === value;
  });
}

class StubNode {
  constructor(tagName = "div") {
    this.tagName = String(tagName || "div").toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
    this.disabled = false;
    this.open = false;
    this._text = "";
    this._listeners = new Map();
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/u).filter(Boolean));
        names.forEach((name) => current.add(name));
        this.className = Array.from(current).join(" ");
      },
      contains: (name) => this.className.split(/\s+/u).filter(Boolean).includes(name),
      remove: (...names) => {
        const remove = new Set(names);
        this.className = this.className
          .split(/\s+/u)
          .filter((name) => name && !remove.has(name))
          .join(" ");
      }
    };
  }

  get childNodes() {
    return this.children;
  }

  get textContent() {
    if (this.children.length) {
      return this.children.map((child) => child.textContent).join("");
    }

    return this._text;
  }

  set textContent(value) {
    this._text = String(value === undefined || value === null ? "" : value);
    this.children = [];
  }

  set innerHTML(value) {
    this._text = String(value || "");
    this.children = [];

    if (this._text) {
      const child = new StubNode("span");
      child.textContent = this._text;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  get innerHTML() {
    return this._text;
  }

  setAttribute(name, value) {
    if (String(name).startsWith("data-")) {
      this.dataset[camelCaseDataName(name)] = String(value);
    }
  }

  getAttribute(name) {
    return this.dataset[camelCaseDataName(name)] ?? null;
  }

  addEventListener(type, handler) {
    this._listeners.set(type, handler);
  }

  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }

  appendChild(node) {
    if (node) {
      node.parentNode = this;
      this.children.push(node);
    }

    return node;
  }

  prepend(node) {
    if (node) {
      node.parentNode = this;
      this.children.unshift(node);
    }
  }

  insertBefore(node, reference) {
    const index = this.children.indexOf(reference);
    node.parentNode = this;

    if (index === -1) {
      this.children.push(node);
    } else {
      this.children.splice(index, 0, node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    nodes.forEach((node) => this.appendChild(node));
  }

  remove() {
    const parent = this.parentNode;

    if (parent) {
      parent.children = parent.children.filter((child) => child !== this);
      this.parentNode = null;
    }
  }

  replaceWith(node) {
    const parent = this.parentNode;

    if (!parent) {
      return;
    }

    const index = parent.children.indexOf(this);
    node.parentNode = parent;
    parent.children.splice(index, 1, node);
    this.parentNode = null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      node.children.forEach((child) => {
        if (matchesSelector(child, selector)) {
          results.push(child);
        }

        walk(child);
      });
    };

    walk(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let node = this;

    while (node) {
      if (matchesSelector(node, selector)) {
        return node;
      }

      node = node.parentNode;
    }

    return null;
  }
}

function createThreadStub() {
  const thread = new StubNode("div");
  thread.className = "chat-thread";

  return thread;
}

// The view module reads `document` at CALL time, so installing a selector-capable
// document here does not disturb the import-time runtime the store already captured.
function withSelectorDom(run) {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;

  globalThis.document = {
    addEventListener() {},
    createElement(tagName) {
      return new StubNode(tagName);
    },
    createTextNode(value) {
      const node = new StubNode("#text");
      node.nodeType = 3;
      node.textContent = value;

      return node;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  globalThis.Node = { TEXT_NODE: 3 };

  try {
    return run();
  } finally {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
  }
}

const adminView = await import("/modules/_core/admin/views/agent/view.js");

// --- THE BLOCKER: persist -> reload -> render ---------------------------------

test("a typed turn survives persist -> reload -> render, byte-identically", () => {
  const original = createTypedTurn();

  withHistory(original);

  // The REAL writer: what a page reload will find in admin-chat.json.
  const stored = store.serializeHistory();

  // The REAL serialization boundary. A round-trip through JSON is what a reload is.
  const reloadedWire = JSON.parse(JSON.stringify(stored));

  // The REAL reader: the very function `init()` uses to restore history.
  const restored = reloadedWire.map((message) => normalizeStoredMessage(message));

  // Both sides normalized first, because the live thread never renders a raw fixture:
  // every entry in `store.history` has been through this same reader. Comparing a
  // normalized reload against un-normalized fixtures would pin the read seam's
  // `streaming: false` default instead of the property under test.
  const originalNormalized = original.map((message) => normalizeStoredMessage(message));
  const originalRendered = originalNormalized.map((entry) => shapes.projectHistoryEntryForDisplay(entry));
  const restoredRendered = restored.map((entry) => shapes.projectHistoryEntryForDisplay(entry));

  assert.equal(
    JSON.stringify(restoredRendered),
    JSON.stringify(originalRendered),
    "every rendered row must be byte-identical before and after the reload"
  );

  // The tool call and its result are the rows that used to vanish.
  const restoredCall = restoredRendered.find((row) => row.typedTool === "call");
  const restoredResult = restoredRendered.find((row) => row.typedTool === "result");

  assert.ok(restoredCall, "the tool call must survive the reload");
  assert.ok(restoredResult, "the tool result must survive the reload");
  assert.equal(restoredCall.typedToolName, "file_delete");
  assert.equal(restoredCall.typedToolCallId, "call_abc");
  assert.match(restoredCall.content, /\{"path":"~\/scratch\.txt"\}$/u);
  assert.equal(restoredResult.typedToolOutcome, shapes.TOOL_RESULT_OUTCOME.SUCCESS);
  assert.match(restoredResult.content, /"deleted":true/u);

  // The narration stays in stored order ahead of its calls, so the reloaded thread
  // reads the way the turn was watched rather than stacking chips at the top.
  assert.deepEqual(
    restoredRendered.map((row) => row.id),
    ["u1", "assistant-1", "tool-call-call_abc", "tool-result-call_abc"]
  );
});

test("a typed entry's persisted payload is the shared mapping, not an admin-local one", () => {
  const original = createTypedTurn();

  withHistory(original);

  const stored = store.serializeHistory();
  const callRow = stored.find((row) => row.id === "tool-call-call_abc");
  const resultRow = stored.find((row) => row.id === "tool-result-call_abc");

  // Byte-equal to what the ONE shared writer produces for the same entry. Any second
  // mapping written admin-locally would show up here as a diff.
  //
  // `content` is `undefined` on a typed row — a typed entry has no prose — which is
  // exactly what onscreen's `serializeHistoryMessages` produces too. It disappears at
  // `JSON.stringify` and the reader restores `""`, so nothing is lost and admin and
  // onscreen keep writing the same shape.
  assert.deepEqual(callRow, {
    attachments: [],
    content: undefined,
    id: "tool-call-call_abc",
    kind: "tool_call",
    role: "assistant",
    ...shapes.serializeTypedHistoryFields(original[2])
  });
  assert.deepEqual(resultRow, {
    attachments: [],
    content: undefined,
    id: "tool-result-call_abc",
    kind: "tool_result",
    role: "user",
    ...shapes.serializeTypedHistoryFields(original[3])
  });
  // And the on-disk row really drops the key rather than storing `null`.
  assert.equal("content" in JSON.parse(JSON.stringify(callRow)), false);
});

// --- Legacy compatibility ------------------------------------------------------

test("a legacy transcript serializes with exactly the base key set", () => {
  withHistory(LEGACY_HISTORY);

  const stored = store.serializeHistory();

  // `0905d21`'s serializer wrote exactly these six keys. A new typed field appearing
  // on a legacy row would be a stored-format change, which this lane must not make.
  assert.deepEqual(
    stored.map((row) => Object.keys(row).sort()),
    LEGACY_HISTORY.map(() => ["attachments", "content", "id", "kind", "role"])
  );
  assert.deepEqual(stored, [
    { attachments: [], content: "hello there", id: "u1", kind: "", role: "user" },
    {
      attachments: [],
      content: "Hi.\n_____javascript\nreturn await space.api.userSelfInfo()",
      id: "a1",
      kind: "",
      role: "assistant"
    },
    {
      attachments: [],
      content: "execution ok\nresult↓\nusername: brauk",
      id: "u2",
      kind: "execution-output",
      role: "user"
    }
  ]);
});

test("a legacy transcript reads back unchanged and renders as before", () => {
  withHistory(LEGACY_HISTORY);

  const reloaded = store.serializeHistory().map((row) => normalizeStoredMessage(row));

  assert.deepEqual(
    reloaded.map((row) => ({
      content: row.content,
      id: row.id,
      kind: row.kind,
      role: row.role
    })),
    LEGACY_HISTORY.map((row) => ({
      content: row.content,
      id: row.id,
      kind: row.kind,
      role: row.role
    }))
  );

  // No typed reader sees a legacy row, so the render projection hands it back untouched.
  assert.deepEqual(
    store.getRenderHistory(reloaded),
    reloaded,
    "a legacy row must render exactly as before — the projection changes nothing"
  );
});

// --- THE RENDER SEAM: the store's paint must consume the projection ------------
//
// Audit finding (P4a-3a, non-blocker a): `getRenderHistory` and `render()`'s use of it
// were both correct, but reverting either to raw history left the whole fleet green. A
// reload test that calls `projectHistoryEntryForDisplay` itself proves the PROJECTION
// works; it proves nothing about whether the store's own paint path calls it. That is
// the wiring-not-proven class this campaign has hit repeatedly.
//
// The distinction is observable and load-bearing, not cosmetic: raw typed entries reach
// the view in their STORED shape, which the renderer does not recognize as a chip, so it
// paints empty shells; projected entries paint real chips naming the tool and outcome.

test("the store's OWN render path paints typed chips — raw history paints none", () => {
  // The fixture is built BY HAND rather than through `normalizeStoredMessage` on purpose.
  // On the base commit that reader is not exported, so a fixture that called it would die
  // on a missing export instead of on the seam this case pins — a red for the wrong
  // reason. Hand-built live-shaped entries let the case reach `store.render()` on BOTH
  // trees, so its base failure is the seam itself.
  const typed = [
    {
      attachments: [],
      content: "delete my scratch file",
      id: "u1",
      kind: "",
      role: "user",
      streaming: false
    },
    {
      attachments: [],
      content: "Removing it now.",
      id: "assistant-1",
      kind: "",
      role: "assistant",
      streaming: false
    },
    shapes.createToolCallEntry({
      arguments: { path: "~/scratch.txt" },
      callId: "call_abc",
      id: "tool-call-call_abc",
      name: "file_delete"
    }),
    shapes.createToolResultEntry({
      callId: "call_abc",
      id: "tool-result-call_abc",
      name: "file_delete",
      payload: { deleted: true, path: "~/scratch.txt" }
    })
  ];

  withSelectorDom(() => {
    // CONTROL, and the reason this case is not cosmetic: handing the view RAW typed
    // entries produces four shells and ZERO execution cards. This is what a reverted
    // `render()` would paint — the exact symptom the lane exists to prevent.
    const rawThread = createThreadStub();

    adminView.renderMessages(rawThread, typed, {});

    assert.equal(
      rawThread.querySelectorAll("[data-execution-card]").length,
      0,
      "raw typed entries must paint no chip — that is the regression being guarded"
    );
    assert.equal(rawThread.children.length, 4, "raw entries still occupy rows, as empty shells");

    // THE REAL PATH: `store.render()` dials out through `getRenderHistory`.
    const thread = createThreadStub();

    store.history = typed;
    store.refs = { scroller: null, thread };
    store.executionOutputOverrides = {};
    store.queuedSubmissions = [];
    store.rerunningMessageId = "";
    store.isSending = false;

    store.render();

    const cards = thread.querySelectorAll("[data-execution-card]");

    assert.ok(cards.length > 0, "the store's render must paint chips for a typed turn");

    const painted = thread.textContent;

    // The tool name and its outcome came from the PROJECTION. A reverted `render()`
    // passing `this.history` paints shells with an empty body instead, so both of these
    // assertions go red rather than silently passing.
    assert.match(painted, /file_delete/u, "the chip must name the tool from the typed entry");
    assert.match(painted, /Success/u, "the chip must carry the projected outcome");
    assert.match(painted, /~\/scratch\.txt/u, "the chip must carry the call's real arguments");
  });
});

// --- Prompt projection (Tier 3 must SEE a Tier 1 history) ----------------------



test("a typed history projects into the Tier 3 prompt instead of vanishing", () => {
  const typed = createTypedTurn();

  withHistory(typed);

  const projected = store.projectHistoryForPrompt(typed);

  assert.equal(projected.length, typed.length);
  assert.match(projected[2].content, /^tool call: file_delete \{/u);
  assert.match(projected[3].content, /^file_delete result: /u);
  // Legacy rows pass through by reference: the projection answers null for them.
  assert.equal(projected[0], typed[0]);
  assert.equal(projected[1], typed[1]);

  // And the legacy-only case is untouched, which is what keeps today's prompt shape.
  assert.deepEqual(store.projectHistoryForPrompt(LEGACY_HISTORY), LEGACY_HISTORY);
});

test("the prompt SEAMS consume the projection, so a helper with no caller cannot pass", () => {
  // The defect class: a projection that exists and is never called. Asserting
  // `projectHistoryForPrompt` in isolation says nothing about whether a prompt build
  // sees it, so this drives the REAL seam with a recording prompt runtime.
  const seen = [];
  const originalPromptRuntime = store.promptRuntime;

  store.promptRuntime = {
    async build(payload) {
      seen.push(payload.historyMessages);

      return { historyMessages: [], requestMessages: [] };
    },
    async updateHistory(historyMessages) {
      seen.push(historyMessages);

      return { historyMessages: [], requestMessages: [] };
    }
  };
  store.defaultSystemPrompt = "system";

  const typed = createTypedTurn();

  store.rebuildPromptInput({ history: typed });
  store.refreshPromptInputFromHistory(typed);

  store.promptRuntime = originalPromptRuntime;

  assert.equal(seen.length, 2, "both prompt seams must build");
  seen.forEach((messages, index) => {
    assert.equal(messages.length, typed.length);
    assert.match(
      messages[2].content,
      /^tool call: file_delete /u,
      `prompt seam ${index} saw the raw typed entry instead of the projection`
    );
    assert.match(messages[3].content, /^file_delete result: /u);
  });
});

test("the shared writer NORMALIZES, so a local passthrough copy diverges", () => {
  // A second admin-local mapping that merely copies the fields would look identical on
  // a well-formed entry and drift on a malformed one. The shared writer normalizes: a
  // string arguments payload becomes `{}`, and a result with no payload gains
  // `payload: null`. A passthrough keeps the junk, so this fixture is what makes the
  // lookalike visible.
  const messy = [
    {
      id: "tool-call-messy",
      kind: "tool_call",
      role: "assistant",
      toolCall: { arguments: '{"path":"~/x"}', callId: 7, name: "file_delete" }
    },
    {
      id: "tool-result-messy",
      kind: "tool_result",
      role: "user",
      toolResult: { callId: 7, name: "file_delete" }
    }
  ];

  withHistory(messy);

  const stored = store.serializeHistory();

  // The shared writer's normalization, spelled out: a string `arguments` payload becomes
  // `{}`, a non-string `callId` becomes `""`, and a result with no payload gains
  // `payload: null`. A passthrough copy keeps the raw junk on all three.
  assert.deepEqual(stored.map((row) => shapes.serializeTypedHistoryFields(row)), [
    { toolCall: { arguments: {}, callId: "", name: "file_delete" } },
    { toolResult: { callId: "", name: "file_delete", payload: null } }
  ]);
  // The stored rows really carry those normalized values, not the raw junk.
  assert.deepEqual(stored[0].toolCall, { arguments: {}, callId: "", name: "file_delete" });
  assert.deepEqual(stored[1].toolResult, { callId: "", name: "file_delete", payload: null });
  // And the round-trip keeps them: a reload cannot un-normalize a stored row.
  assert.deepEqual(
    normalizeStoredMessage(JSON.parse(JSON.stringify(stored[0]))).toolCall,
    { arguments: {}, callId: "", name: "file_delete" }
  );
});

// --- The consent affordance (UNIT LEVEL ONLY — see file header) ----------------

test("engineSwapPendingHold is a REAL data property, never a getter onto engine state", () => {
  // An accessor is an own property too, so `hasOwnProperty` would pass on the broken
  // shape. The descriptor is the assertion: behind a getter, a driver's write bypasses
  // Alpine's set trap, no trigger fires, and the bar silently stops appearing while
  // every other case in this file stays green.
  const descriptor = Object.getOwnPropertyDescriptor(store, "engineSwapPendingHold");

  assert.ok(descriptor, "the hold must be an own property of the store");
  assert.equal(typeof descriptor.get, "undefined", "a getter would bypass the set trap");
  assert.equal(typeof descriptor.set, "undefined", "a setter pair is the same defect");
  assert.equal(descriptor.value, null, "the bar starts hidden");
  assert.equal("value" in descriptor, true);

  const sessionDescriptor = Object.getOwnPropertyDescriptor(store, "engineSwapTier1Session");

  assert.ok(sessionDescriptor, "the session slot must be an own property too");
  assert.equal(typeof sessionDescriptor.get, "undefined");
});

test("the panel renders the bar and binds both handlers, with no busy gate", () => {
  const panel = readFileSync(new URL("panel.html", ADMIN_VIEW_DIR), "utf8");
  const barStart = panel.indexOf("admin-agent-confirm-bar");

  assert.ok(barStart > -1, "the confirm bar markup must exist in admin's panel");

  const bar = panel.slice(panel.lastIndexOf("<template", barStart), panel.indexOf("</template>", barStart));

  assert.match(bar, /x-if="\$store\.adminAgent\.engineSwapPendingHold"/u);
  assert.match(bar, /\$store\.adminAgent\.denyEngineSwapHold\(\)/u);
  assert.match(bar, /\$store\.adminAgent\.confirmEngineSwapHold\(\)/u);
  // A consent affordance must never depend on a busy flag: no `:disabled` at all.
  assert.doesNotMatch(bar, /:disabled/u, "neither consent control may be gated");
  // Both controls are plain buttons, so neither can submit the composer form.
  assert.equal((bar.match(/type="button"/gu) || []).length, 2);
});

test("the confirm bar's styles stay scoped to the admin surface", () => {
  const css = readFileSync(new URL("agent.css", ADMIN_VIEW_DIR), "utf8");
  // Comments are stripped first: the rule-scan below is a regex over text, and prose
  // mentioning the class name would otherwise be read as an unscoped selector.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules = withoutComments.match(/[^{}]+\{[^{}]*\}/gu) || [];
  const confirmRules = rules.filter((rule) => rule.includes("admin-agent-confirm"));

  assert.ok(confirmRules.length > 0, "the bar must be styled");

  confirmRules.forEach((rule) => {
    assert.match(
      rule.trim(),
      /^\.admin-agent-root\s/u,
      `an unscoped rule leaks into other admin surfaces: ${rule.trim().split("{")[0].trim()}`
    );
  });
});

test("confirm with NO session leaves the bar up — a control that cannot act must not clear it", () => {
  store.engineSwapPendingHold = { arguments: { path: "~/scratch.txt" }, callId: "call_abc", tool: "file_delete" };
  store.engineSwapTier1Session = null;

  store.confirmEngineSwapHold();

  // The owner's honesty rule, pinned: adoption will add the session, and a future lane
  // that reorders the guard above the clear turns this red.
  assert.notEqual(store.engineSwapPendingHold, null, "a confirm that cannot execute must not clear the bar");
  assert.deepEqual(store.engineSwapPendingHold.arguments, { path: "~/scratch.txt" });

  store.engineSwapPendingHold = null;
});

test("deny with NO session leaves the bar up", () => {
  store.engineSwapPendingHold = { arguments: { path: "~/scratch.txt" }, callId: "call_abc" };
  store.engineSwapTier1Session = null;

  store.denyEngineSwapHold();

  assert.notEqual(store.engineSwapPendingHold, null, "a deny with nothing to deny must not clear the bar");

  store.engineSwapPendingHold = null;
});

test("cancel clears the hold and the session slot", () => {
  let cancelled = 0;

  store.engineSwapPendingHold = { arguments: {}, callId: "call_abc" };
  store.engineSwapTier1Session = {
    cancelHeld() {
      cancelled += 1;
    }
  };
  // A held cancel now SETTLES the transcript and repaints it (BUG-009), so this
  // DOM-less case stubs paint for the same reason its confirm and deny siblings do.
  const previousRender = store.render;
  const previousPersist = store.persistHistory;

  store.render = () => {};
  store.persistHistory = async () => {};

  store.cancelEngineSwapHold();

  store.render = previousRender;
  store.persistHistory = previousPersist;

  assert.equal(cancelled, 1, "cancel must tell the gate the episode is over");
  assert.equal(store.engineSwapPendingHold, null);
  assert.equal(store.engineSwapTier1Session, null);
});

test("a reachable hold clears the bar BEFORE the session work, and only once", async () => {
  const calls = [];
  const session = {
    async confirmHeld() {
      // Ordering is the honesty rule's other half: by the time the gate runs, the
      // affordance must already be gone, so a second click cannot re-enter.
      calls.push({ holdAtCallTime: store.engineSwapPendingHold });

      return { status: "ok" };
    }
  };

  store.engineSwapPendingHold = { arguments: { path: "~/scratch.txt" }, callId: "call_abc" };
  store.engineSwapTier1Session = session;
  store.render = () => {};

  await store.confirmEngineSwapHold();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].holdAtCallTime, null, "the bar must be cleared before the gate runs");
  assert.equal(store.engineSwapPendingHold, null);
  assert.equal(store.status, "Confirmed and executed.");

  store.engineSwapTier1Session = null;
});

test("deny clears the bar, drops the session and reports the cancellation", async () => {
  let denied = 0;
  const session = {
    denyHeld() {
      denied += 1;

      return { description: "the file ~/scratch.txt", tool: "file_delete" };
    }
  };

  store.engineSwapPendingHold = { arguments: {}, callId: "call_abc" };
  store.engineSwapTier1Session = session;
  store.render = () => {};

  await store.denyEngineSwapHold();

  assert.equal(denied, 1);
  assert.equal(store.engineSwapPendingHold, null);
  assert.equal(store.engineSwapTier1Session, null);
  assert.match(store.status, /^Cancelled: the user denied the file ~\/scratch\.txt\.$/u);
});

// --- Both flags stay default-off, and admin stays inert ------------------------

test("admin imports no adoption machinery: no turn driver, no tool-turn transport", () => {
  const source = readFileSync(new URL("store.js", ADMIN_VIEW_DIR), "utf8");

  assert.doesNotMatch(source, /engine-swap\/turn-driver\.js/u, "adoption belongs to steps 3-5");
  assert.doesNotMatch(source, /engine-swap\/tool-turn-transport\.js/u, "adoption belongs to steps 3-5");
  assert.doesNotMatch(source, /engine-swap\/dispatch-pipeline\.js/u, "adoption belongs to steps 3-5");
  assert.doesNotMatch(source, /engine-swap\/tier1-session\.js/u, "adoption belongs to steps 3-5");
  // The one engine-swap import admin is allowed: the shared history shapes.
  assert.match(source, /engine-swap\/history-shapes\.js/u);
});
