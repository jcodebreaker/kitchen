import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { BROWSER_FILES, handRolledBrowser, hasTemplateBrowser, isBrowserGap, PLAYWRIGHT, restoreBrowserModule, TEMPLATE_DIR } from "./template-modules.ts";

const apiOnly = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-tk-mod-"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.copyFileSync(path.join(TEMPLATE_DIR, "lib", "common.mjs"), path.join(dir, "lib", "common.mjs"));
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "kitchen-toolkit", private: true, type: "module" }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "app.mjs"), 'import { sameOrigin } from "./lib/common.mjs";\nexport default {};\n');
  return dir;
};

test("a browser gap restores Kitchen's own browser module byte for byte, with playwright pinned; idempotent", () => {
  assert.ok(isBrowserGap("open") && isBrowserGap("press") && isBrowserGap("screenshot"));
  assert.ok(!isBrowserGap("sql") && !isBrowserGap("http"));
  const dir = apiOnly();
  assert.equal(hasTemplateBrowser(dir), false);
  assert.deepEqual(restoreBrowserModule(dir), [...BROWSER_FILES, "package.json"]);
  assert.ok(hasTemplateBrowser(dir));
  for (const f of BROWSER_FILES) assert.deepEqual(fs.readFileSync(path.join(dir, f)), fs.readFileSync(path.join(TEMPLATE_DIR, f)));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.dependencies.playwright, PLAYWRIGHT);
  assert.equal(pkg.name, "kitchen-toolkit", "the rest of package.json is kept");
  assert.deepEqual(restoreBrowserModule(dir), [], "nothing to do the second time");
  assert.deepEqual(handRolledBrowser(dir), [], "Kitchen's own module is not a hand-rolled driver");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hand-rolled browser driver is refused: a raw CDP lib, an edited daemon, playwright straight from app.mjs", () => {
  const dir = apiOnly();
  fs.writeFileSync(
    path.join(dir, "lib", "browser.mjs"),
    "// raw CDP\nconst ws = new WebSocket(info.webSocketDebuggerUrl);\nsend('Runtime.evaluate', { expression });\n",
  );
  assert.match(handRolledBrowser(dir).join("\n"), /lib\/browser\.mjs drives a browser itself: use Kitchen's browser module/);
  restoreBrowserModule(dir);
  assert.deepEqual(handRolledBrowser(dir), []);
  fs.appendFileSync(path.join(dir, "lib", "browser-daemon.mjs"), "\n// tweaked\n");
  assert.match(handRolledBrowser(dir).join("\n"), /lib\/browser-daemon\.mjs drives a browser itself/);
  restoreBrowserModule(dir);
  fs.writeFileSync(path.join(dir, "app.mjs"), 'import { chromium } from "playwright";\nawait chromium.launch();\n');
  assert.match(handRolledBrowser(dir).join("\n"), /app\.mjs drives a browser itself/);
  fs.writeFileSync(path.join(dir, "app.mjs"), 'import { browserPrimitives, startBrowser } from "./lib/browser.mjs";\nexport default {};\n');
  assert.deepEqual(handRolledBrowser(dir), [], "importing Kitchen's module is the way");
  fs.rmSync(dir, { recursive: true, force: true });
});
