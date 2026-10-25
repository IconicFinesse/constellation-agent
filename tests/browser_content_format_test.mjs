import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  readBrowserHarnessLogs,
  sendBrowserHarnessCommand,
  startBrowserHarness,
  startHttpServer,
  stopBrowserHarness,
  stopHttpServer
} from "./browser_harness_cli_test_utils.mjs";

test("browser CLI content uses typed ref boxes, state tags, semantic tags, and URL fallbacks", {
  timeout: 2 * 60 * 1000
}, async () => {
  const server = await startHttpServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });
    response.end(`<!doctype html>
<html>
  <head>
    <title>Browser Content Format Test</title>
  </head>
  <body>
    <img src="/img/hero.jpg" alt="Hero image">
    <img src="/img/fallback-image.jpg">
    <a href="/article">Story Link</a>
    <a href="/media/download-brochure.pdf"></a>
    <div style="display:none">
      <a href="/hidden-display-none">Hidden display none link</a>
    </div>
    <div hidden>
      <button>Hidden attribute button</button>
    </div>
    <div style="opacity:0">
      <button>Invisible opacity button</button>
      <span>Invisible opacity text</span>
    </div>
    <div style="content-visibility:hidden">
      <a href="/hidden-content-visibility">Hidden content visibility link</a>
    </div>
    <div style="display: contents">
      <a href="/visible-through-contents">Visible through contents</a>
    </div>
    <button disabled>Confirm</button>
    <input type="checkbox" aria-label="Email updates" checked>
    <input type="text" aria-label="Search" placeholder="Hledat" value="Ethereum">
    <button style="background: rgb(198, 40, 40); color: white;">Delete</button>
    <button style="background: rgb(46, 125, 50); color: white;">Save</button>
  </body>
</html>`);
  });
  const { port } = server.address();
  const harness = await startBrowserHarness();

  try {
    const openResult = await sendBrowserHarnessCommand(harness, "open", [`http://127.0.0.1:${port}/`]);
    const contentResult = await sendBrowserHarnessCommand(harness, "content");
    const flatContentResult = await sendBrowserHarnessCommand(harness, "content", [{
      includeSemanticTags: false,
      includeStateTags: false
    }]);
    const detailResult = await sendBrowserHarnessCommand(harness, "detail", [1]);

    assert.equal(openResult?.id, 1, JSON.stringify({
      openResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.match(contentResult?.document || "", /\[image 1\] Hero image/u);
    assert.match(contentResult?.document || "", /\[image 2\] \/img\/fallback\\-image\.jpg/u);
    assert.match(contentResult?.document || "", /\[link 3\] Story Link/u);
    assert.match(contentResult?.document || "", /\[link 4\] \/media\/download\\-brochure\.pdf/u);
    assert.match(contentResult?.document || "", /\[link 5\] Visible through contents/u);
    assert.match(contentResult?.document || "", /\[disabled muted button 6\] Confirm/u);
    assert.match(contentResult?.document || "", /\[checked checkbox 7\] Email updates/u);
    assert.match(contentResult?.document || "", /\[input text 8\] Search placeholder=Hledat value=Ethereum/u);
    assert.match(contentResult?.document || "", /\[error button 9\] Delete/u);
    assert.match(contentResult?.document || "", /\[success button 10\] Save/u);
    assert.doesNotMatch(contentResult?.document || "", /Hidden display none link/u);
    assert.doesNotMatch(contentResult?.document || "", /Hidden attribute button/u);
    assert.doesNotMatch(contentResult?.document || "", /Invisible opacity button/u);
    assert.doesNotMatch(contentResult?.document || "", /Invisible opacity text/u);
    assert.doesNotMatch(contentResult?.document || "", /Hidden content visibility link/u);
    assert.match(flatContentResult?.document || "", /\[button 6\] Confirm/u);
    assert.match(flatContentResult?.document || "", /\[checkbox 7\] Email updates/u);
    assert.doesNotMatch(flatContentResult?.document || "", /\[disabled muted button 6\]/u);
    assert.doesNotMatch(contentResult?.document || "", /\[ref \d+\]/u);
    assert.doesNotMatch(contentResult?.document || "", /Image "Hero image"/u);
    assert.equal(detailResult?.tagName, "IMG");
    assert.match(detailResult?.dom || "", /<img[^>]+src="\/img\/hero\.jpg"/u);
  } finally {
    await stopBrowserHarness(harness);
    await stopHttpServer(server);
  }
});

test("browser CLI content descends into actionable dialog containers", {
  timeout: 2 * 60 * 1000
}, async () => {
  const server = await startHttpServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });
    response.end(`<!doctype html>
<html>
  <head>
    <title>Consent Dialog Content Test</title>
  </head>
  <body>
    <div
      role="dialog"
      aria-label="Before you continue to Test Search"
      aria-modal="true"
      tabindex="0"
      onclick="window.__dialogClicked = true"
    >
      <h1>Before you continue to Test</h1>
      <p>We use <a href="/cookies">cookies</a> and data to</p>
      <ul>
        <li>Deliver and maintain Test services</li>
        <li>Track outages and protect against spam, fraud, and abuse</li>
      </ul>
      <p>If you choose to "Accept all," we will also use cookies and data to improve new services.</p>
      <p>Select “More options” to see additional information.</p>
      <button>Reject all</button>
      <button>Accept all</button>
      <button role="link"><a>More options</a></button>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </div>
  </body>
</html>`);
  });
  const { port } = server.address();
  const harness = await startBrowserHarness();

  try {
    await sendBrowserHarnessCommand(harness, "open", [`http://127.0.0.1:${port}/`]);
    const contentResult = await sendBrowserHarnessCommand(harness, "content");
    const documentContent = contentResult?.document || "";

    assert.match(documentContent, /# Before you continue to Test/u);
    assert.match(documentContent, /\[link \d+\] cookies/u);
    assert.match(documentContent, /Deliver and maintain Test services/u);
    assert.match(documentContent, /Track outages and protect against spam, fraud, and abuse/u);
    assert.match(documentContent, /Accept all/u);
    assert.match(documentContent, /Reject all/u);
    assert.match(documentContent, /More options/u);
    assert.match(documentContent, /Privacy/u);
    assert.match(documentContent, /Terms/u);
    assert.notEqual(
      documentContent.trim(),
      "[button 1] Before you continue to Test Search"
    );
  } finally {
    await stopBrowserHarness(harness);
    await stopHttpServer(server);
  }
});

test("browser CLI actions report visible reaction and no-op retries", {
  timeout: 2 * 60 * 1000
}, async () => {
  const server = await startHttpServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });
    response.end(`<!doctype html>
<html>
  <head>
    <title>Browser Action Effect Test</title>
  </head>
  <body>
    <form id="donation-form">
      <button type="button">Continue</button>
      <label><input type="radio" name="optin" value="yes">Yes</label>
      <label><input type="radio" name="optin" value="no">No</label>
      <div id="message"></div>
    </form>
    <script>
      document.querySelector("button").addEventListener("click", () => {
        const checked = document.querySelector('input[name="optin"]:checked');
        const message = document.getElementById("message");
        if (!checked && !message.textContent) {
          message.textContent = "Select yes or no";
          message.style.color = "rgb(198, 40, 40)";
        }
      });
    </script>
  </body>
</html>`);
  });
  const { port } = server.address();
  const harness = await startBrowserHarness();

  try {
    await sendBrowserHarnessCommand(harness, "open", [`http://127.0.0.1:${port}/`]);
    const contentResult = await sendBrowserHarnessCommand(harness, "content");
    const continueRef = Number((contentResult?.document || "").match(/\[[^\]]*button (\d+)\] Continue/u)?.[1] || 0);
    assert.equal(Number.isInteger(continueRef) && continueRef > 0, true, JSON.stringify({
      contentResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    const documentContent = contentResult?.document || "";
    assert.match(documentContent, /\[radio \d+\] Yes/u, JSON.stringify({
      contentResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.match(documentContent, /\[radio \d+\] No/u, JSON.stringify(contentResult, null, 2));
    assert.doesNotMatch(documentContent, /Yes Yes/u, JSON.stringify(contentResult, null, 2));
    assert.doesNotMatch(documentContent, /No No/u, JSON.stringify(contentResult, null, 2));
    const firstClickResult = await sendBrowserHarnessCommand(harness, "click", [continueRef]);
    const secondClickResult = await sendBrowserHarnessCommand(harness, "click", [continueRef]);

    assert.equal(firstClickResult?.state?.currentUrl, `http://127.0.0.1:${port}/`, JSON.stringify({
      firstClickResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.equal(firstClickResult?.action?.status?.reacted, true, JSON.stringify(firstClickResult, null, 2));
    assert.equal(firstClickResult?.action?.status?.validationTextAdded, true, JSON.stringify(firstClickResult, null, 2));
    assert.equal(firstClickResult?.action?.status?.nearbyTextChanged, true, JSON.stringify(firstClickResult, null, 2));
    assert.deepEqual(firstClickResult?.action?.effect?.validationText || [], ["Select yes or no"], JSON.stringify(firstClickResult, null, 2));
    assert.deepEqual(firstClickResult?.action?.effect?.semanticHints || [], ["error"], JSON.stringify(firstClickResult, null, 2));

    assert.equal(secondClickResult?.action?.status?.reacted, false, JSON.stringify(secondClickResult, null, 2));
    assert.equal(secondClickResult?.action?.status?.noObservedEffect, true, JSON.stringify(secondClickResult, null, 2));
    assert.deepEqual(secondClickResult?.action?.effect?.validationText || [], [], JSON.stringify(secondClickResult, null, 2));
  } finally {
    await stopBrowserHarness(harness);
    await stopHttpServer(server);
  }
});

test("browser CLI content exposes label-wrapped form controls as addressable refs", {
  timeout: 2 * 60 * 1000
}, async () => {
  const server = await startHttpServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });
    response.end(`<!doctype html>
<html>
  <head>
    <title>Label Wrapped Controls Test</title>
  </head>
  <body>
    <form id="login-form">
      <label><span>Username</span><input id="username" name="username" type="text"></label>
      <label for="password">Password</label>
      <input id="password" name="password" type="password">
      <label><input type="radio" name="optin" value="yes">Yes</label>
      <label><input type="radio" name="optin" value="no">No</label>
      <label><input id="agree" type="checkbox">I agree</label>
      <label>Notes<textarea id="notes" name="notes"></textarea></label>
      <label>Country<select id="country" name="country"><option>Czechia</option><option>Germany</option></select></label>
      <button type="submit">Log in</button>
    </form>
  </body>
</html>`);
  });
  const { port } = server.address();
  const harness = await startBrowserHarness();

  try {
    await sendBrowserHarnessCommand(harness, "open", [`http://127.0.0.1:${port}/`]);
    const contentResult = await sendBrowserHarnessCommand(harness, "content");
    const documentContent = contentResult?.document || "";
    const contentContext = JSON.stringify({
      contentResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2);

    assert.match(documentContent, /\[input text \d+\] Username/u, contentContext);
    assert.match(documentContent, /\[input password \d+\] Password/u, contentContext);
    assert.match(documentContent, /\[radio \d+\] Yes/u, contentContext);
    assert.match(documentContent, /\[radio \d+\] No/u, contentContext);
    assert.match(documentContent, /\[checkbox \d+\] I agree/u, contentContext);
    assert.match(documentContent, /\[textarea \d+\] Notes/u, contentContext);
    assert.match(documentContent, /\[select \d+\] Country selected=Czechia/u, contentContext);
    assert.match(documentContent, /\[button \d+\] Log in/u, contentContext);

    assert.doesNotMatch(documentContent, /Username Username/u, contentContext);
    assert.doesNotMatch(documentContent, /CountryCzechiaGermany/u, contentContext);
    assert.doesNotMatch(documentContent, /Notes\s*$/mu, contentContext);

    const usernameRef = Number(documentContent.match(/\[[^\]]*input[^\]]* (\d+)\] Username/u)?.[1] || 0);
    assert.equal(usernameRef > 0, true, contentContext);

    const typeResult = await sendBrowserHarnessCommand(harness, "type", [usernameRef, "alice"]);
    assert.equal(typeResult?.action?.status?.reacted, true, JSON.stringify({
      typeResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.equal(typeResult?.action?.status?.valueChanged, true, JSON.stringify(typeResult, null, 2));

    const typedContentResult = await sendBrowserHarnessCommand(harness, "content");
    assert.match(typedContentResult?.document || "", /\[input text \d+\] Username value=alice/u, JSON.stringify({
      typedContentResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));

    const radioRef = Number(documentContent.match(/\[radio (\d+)\] Yes/u)?.[1] || 0);
    assert.equal(radioRef > 0, true, contentContext);
    const radioClickResult = await sendBrowserHarnessCommand(harness, "click", [radioRef]);
    assert.equal(radioClickResult?.action?.status?.reacted, true, JSON.stringify({
      radioClickResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.equal(radioClickResult?.action?.status?.checkedChanged, true, JSON.stringify(radioClickResult, null, 2));
  } finally {
    await stopBrowserHarness(harness);
    await stopHttpServer(server);
  }
});

test("browser CLI content falls back to live DOM capture on Trusted Types pages", {
  timeout: 2 * 60 * 1000
}, async () => {
  const server = await startHttpServer((request, response) => {
    response.writeHead(200, {
      "content-security-policy": "require-trusted-types-for 'script'; trusted-types default",
      "content-type": "text/html; charset=utf-8"
    });
    response.end(`<!doctype html>
<html>
  <head>
    <title>Trusted Types Content Test</title>
  </head>
  <body>
    <main>
      <a href="/trusted">Trusted Story</a>
      <label><span>Trusted Email</span><input id="trusted-email" type="email"></label>
      <button>Continue</button>
    </main>
  </body>
</html>`);
  });
  const { port } = server.address();
  const harness = await startBrowserHarness();

  try {
    const openResult = await sendBrowserHarnessCommand(harness, "open", [`http://127.0.0.1:${port}/`]);
    const contentResult = await sendBrowserHarnessCommand(harness, "content");

    assert.equal(openResult?.id, 1, JSON.stringify({
      openResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.match(contentResult?.document || "", /\[link 1\] Trusted Story/u);
    assert.match(contentResult?.document || "", /\[input email 2\] Trusted Email/u, JSON.stringify({
      contentResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.match(contentResult?.document || "", /\[button 3\] Continue/u);
    assert.doesNotMatch(contentResult?.document || "", /Browser frame bridge could not collect semantic page content\./u);
  } finally {
    await stopBrowserHarness(harness);
    await stopHttpServer(server);
  }
});

test("browser CLI content stays available after late same-document navigation", {
  timeout: 2 * 60 * 1000
}, async () => {
  const server = await startHttpServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });
    response.end(`<!doctype html>
<html>
  <head>
    <title>Late Same-Document Navigation Test</title>
    <script>
      window.addEventListener("load", () => {
        window.setTimeout(() => {
          window.location.hash = "late";
        }, 1000);
      });
    </script>
  </head>
  <body>
    <main>
      <a href="/story">Story</a>
      <button>Continue</button>
    </main>
  </body>
</html>`);
  });
  const { port } = server.address();
  const harness = await startBrowserHarness();

  try {
    const openResult = await sendBrowserHarnessCommand(harness, "open", [`http://127.0.0.1:${port}/`]);
    await delay(2000);
    const stateResult = await sendBrowserHarnessCommand(harness, "state");
    const contentResult = await sendBrowserHarnessCommand(harness, "content");

    assert.equal(openResult?.id, 1, JSON.stringify({
      openResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.match(String(stateResult?.currentUrl || ""), /#late$/u, JSON.stringify({
      stateResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.equal(stateResult?.bridgeReady, true, JSON.stringify({
      stateResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.equal(stateResult?.coreReady, true, JSON.stringify({
      stateResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.equal(stateResult?.preloadReady, true, JSON.stringify({
      stateResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.match(contentResult?.document || "", /\[link 1\] Story/u);
    assert.match(contentResult?.document || "", /\[button 2\] Continue/u);
  } finally {
    await stopBrowserHarness(harness);
    await stopHttpServer(server);
  }
});
