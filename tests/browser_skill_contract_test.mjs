import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const browserManagerSkill = fs.readFileSync(
  "app/L0/_all/modules/_core/skillset/ext/skills/browser-manager/SKILL.md",
  "utf8"
);
const browserControlSkill = fs.readFileSync(
  "app/L0/_all/modules/_core/skillset/ext/skills/browser-control/SKILL.md",
  "utf8"
);
const browserWindowHtml = fs.readFileSync(
  "app/L0/_all/modules/_core/web_browsing/window.html",
  "utf8"
);

test("browser-manager auto-loads on onscreen surfaces", () => {
  assert.match(browserManagerSkill, /name: Browser Manager/u);
  assert.match(browserManagerSkill, /when:\n\s+tags:\n\s+- onscreen/u);
  assert.match(browserManagerSkill, /loaded:\n\s+tags:\n\s+- onscreen/u);
});

test("browser-control auto-loads only when a browser surface is open", () => {
  assert.match(browserControlSkill, /name: Browser Control/u);
  assert.match(browserControlSkill, /when:\n\s+tags:\n\s+- onscreen/u);
  assert.match(browserControlSkill, /loaded:\n\s+tags:\n\s+- onscreen\n\s+- browser:open/u);
});

test("browser overlay exports browser:open context tags when any browser is open", () => {
  assert.match(
    browserWindowHtml,
    /<x-context :data-tags="\$store\.webBrowsing\.hasOpenBrowsers \? 'browser:open' : ''"><\/x-context>/u
  );
});
