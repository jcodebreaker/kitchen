// How init finds the app's start and reset commands in the repo's own files.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { parseConfig } from "../config.ts";
import { detectApp } from "./detect-app.ts";
import { appYaml } from "./files.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-detect-app-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
function fixture(files: Record<string, string>): string {
  const d = path.join(root, `f${++n}`);
  fs.mkdirSync(d);
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t);
  return d;
}

test("package.json: start plus a reset or seed script (db:reset first); none leaves reset unset", () => {
  const both = detectApp(fixture({ "package.json": JSON.stringify({ scripts: { start: "node server.js", seed: "node seed.js", "db:reset": "x" } }) }));
  assert.deepEqual([both?.start, both?.reset], ["npm start", "npm run db:reset"]);
  const seed = detectApp(fixture({ "package.json": JSON.stringify({ scripts: { dev: "vite", seed: "node seed.js" } }), "pnpm-lock.yaml": "" }));
  assert.deepEqual([seed?.start, seed?.reset], ["pnpm dev", "pnpm seed"]);
  const none = detectApp(fixture({ "package.json": JSON.stringify({ scripts: { start: "node server.js" } }), "server.js": 'app.get("/healthz")' }));
  assert.deepEqual([none?.start, none?.health, none?.reset], ["npm start", "/healthz", undefined]);
});

test("Makefile: a reset or seed target next to the run target", () => {
  const mk = detectApp(fixture({ Makefile: "run:\n\tgo run .\nseed:\n\tgo run ./seed\n" }));
  assert.deepEqual([mk?.start, mk?.reset], ["make run", "make seed"]);
  assert.equal(detectApp(fixture({ Makefile: "serve:\n\tx\n" }))?.reset, undefined);
});

test("kitchen.yaml's app block: the reset when found; else a comment saying how to add one", () => {
  assert.match(appYaml({ start: "npm start", health: "/", reset: "npm run seed", from: "package.json scripts.start" }), /reset: "npm run seed"/);
  const y = appYaml({ start: "npm start", health: "/", from: "package.json scripts.start" });
  assert.match(y, /# No reset found\. So QA can restart on fresh data \(kitchen qa reset\)/);
  assert.doesNotMatch(y, /^ {2}reset:/m);
});

test("ADR 0033: the optional keys sit inside app: as comments; uncommenting them (or the whole none-found block) is valid kitchen.yaml", () => {
  const y = appYaml({ start: "npm start", health: "/", reset: "npm run seed", from: "package.json scripts.start" });
  assert.deepEqual(parseConfig(y).app.scenarios, {}, "as written: nothing optional is on");
  const on = y.replace(/^( {2})# (scenarios|whoami)/gm, "$1$2").replace(/^# (requires)/m, "$1");
  const c = parseConfig(on);
  assert.deepEqual(
    [c.app.start, c.app.reset, Object.keys(c.app.scenarios), c.app.whoami, c.requires.map((r) => r.name)],
    ["npm start", "npm run seed", ["offer-pending"], "/api/me", ["venv"]],
  );
  const none = appYaml(null);
  assert.equal(parseConfig(none).app.start, "", "all commented");
  const all = parseConfig(none.replace(/^# (app:| {2}\S)/gm, "$1").replace(/^# (requires)/m, "$1"));
  assert.deepEqual([all.app.start, all.app.whoami, Object.keys(all.app.scenarios), all.requires.length], ["npm start", "/api/me", ["offer-pending"], 1]);
});
