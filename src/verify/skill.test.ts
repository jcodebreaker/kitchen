// `kitchen init`'s verify skill (ADR 0017 §1): both tools' copies, filled from what init detected, idempotent, and
// never over a file someone changed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { parseConfig } from "../config.ts";
import { detectHandles, untouched, writeVerifySkill } from "./skill.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-skill-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function app(name: string): string {
  const r = path.join(root, name);
  fs.mkdirSync(path.join(r, "public"), { recursive: true });
  fs.writeFileSync(path.join(r, "package.json"), JSON.stringify({ name: "@acme/library-demo", scripts: { start: "node server.js" } }));
  fs.writeFileSync(
    path.join(r, "public", "app.js"),
    `h("select", { id: "member" }); h("input", { id: "book-search", type: "search" }); h("input", { name: "title" }); h("button", { "aria-label": "Add book" });`,
  );
  return r;
}
const cfg = parseConfig('app: { start: "npm start", health: "/healthz", reset: "rm -f data/library.json" }\n');

test("init writes SKILL.md and features/README.md for Claude Code and Codex, filled from what it found", () => {
  const r = app("a");
  const w = writeVerifySkill(r, cfg);
  assert.equal(w.name, "verify-library-demo", "package.json's name, without its scope");
  assert.deepEqual(
    w.files.map((f) => [f.path, f.did]),
    [
      [".claude/skills/verify-library-demo/SKILL.md", "wrote"],
      [".agents/skills/verify-library-demo/SKILL.md", "wrote"],
      [".claude/skills/verify-library-demo/features/README.md", "wrote"],
      [".agents/skills/verify-library-demo/features/README.md", "wrote"],
    ],
  );
  const skill = fs.readFileSync(path.join(r, ".claude/skills/verify-library-demo/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: verify-library-demo\ndescription: /);
  for (const h of ["## Launch", "## Doctor", "## Drive", "## Evidence", "## Cleanup"]) assert.ok(skill.includes(h), h);
  assert.match(skill, /`npm start`/);
  assert.match(skill, /`rm -f data\/library.json`/);
  assert.match(skill, /GET \/healthz/);
  assert.match(skill, /`#book-search`/);
  assert.match(skill, /`\[aria-label="Add book"\]`/);
  const readme = fs.readFileSync(path.join(r, ".claude/skills/verify-library-demo/features/README.md"), "utf8");
  for (const h of ["## Baseline preconditions", "## Driving conventions", "## Feature entry contract", "## Sweep order", "## Features"])
    assert.ok(readme.includes(h), h);
  assert.equal(fs.readdirSync(path.join(r, ".claude/skills/verify-library-demo/features")).length, 1, "no feature files are seeded");
  assert.equal(fs.readFileSync(path.join(r, ".agents/skills/verify-library-demo/SKILL.md"), "utf8"), skill, "the Codex copy is the same file");
  assert.ok(untouched(skill));
});

test("idempotent; a Kitchen file is refreshed when what init detects changes; an edited one is never overwritten", () => {
  const r = app("b");
  writeVerifySkill(r, cfg);
  assert.ok(writeVerifySkill(r, cfg).files.every((f) => f.did === "same"));
  const noReset = parseConfig('app: { start: "npm start", health: "/healthz" }\n');
  const again = writeVerifySkill(r, noReset);
  assert.equal(again.files.find((f) => f.path.endsWith(".claude/skills/verify-library-demo/SKILL.md"))?.did, "refreshed");
  const readme = path.join(r, ".claude/skills/verify-library-demo/features/README.md");
  const edited = `${fs.readFileSync(readme, "utf8").replace("## Features", "## Features\n\n- [Search](./search.md): search books")}`;
  fs.writeFileSync(readme, edited);
  const third = writeVerifySkill(r, cfg);
  assert.equal(third.files.find((f) => f.path === ".claude/skills/verify-library-demo/features/README.md")?.did, "kept");
  assert.equal(fs.readFileSync(readme, "utf8"), edited);
  assert.equal(
    fs.readFileSync(path.join(r, ".agents/skills/verify-library-demo/features/README.md"), "utf8"),
    edited,
    "the Codex copy, still Kitchen's, follows the edited one",
  );
});

test("an existing verify skill keeps its name; handles skip tests and dependencies", () => {
  const r = app("c");
  fs.mkdirSync(path.join(r, ".claude/skills/verify-mine"), { recursive: true });
  fs.writeFileSync(path.join(r, ".claude/skills/verify-mine/SKILL.md"), "mine\n");
  const w = writeVerifySkill(r, cfg);
  assert.equal(w.name, "verify-mine");
  assert.equal(fs.readFileSync(path.join(r, ".claude/skills/verify-mine/SKILL.md"), "utf8"), "mine\n", "a skill without Kitchen's marker is the person's");
  fs.mkdirSync(path.join(r, "public", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(r, "public", "node_modules", "x.js"), `id: "dep-thing"`);
  fs.writeFileSync(path.join(r, "public", "app.test.js"), `id: "test-thing"`);
  const h = detectHandles(r);
  assert.ok(h.includes("#member") && !h.includes("#dep-thing") && !h.includes("#test-thing"), h.join());
});

test("ADR 0021 §2: SKILL.md's Your tests: the suite, its page objects, fixtures and helpers, login and seed helpers, one spec's command", () => {
  const r = app("suite");
  const put = (f: string, t: string) => {
    fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true });
    fs.writeFileSync(path.join(r, f), t);
  };
  put("playwright.config.ts", 'export default { testDir: "./e2e", use: { baseURL: process.env.BASE_URL } };\n');
  put("e2e/cart.spec.ts", "");
  put("e2e/checkout.spec.ts", "");
  put("e2e/pages/cart.page.ts", "export class CartPage {}\n");
  put("e2e/fixtures.ts", "export async function loginAs(page, who) {}\nexport const seedCart = async () => {};\nexport const money = 1;\n");
  const c = parseConfig('app: { start: "npm start" }\nchecks: [{ name: e2e, run: "npm run test:e2e", when: merge, needs_app: true }]\n');
  writeVerifySkill(r, c);
  const md = fs.readFileSync(path.join(r, ".claude/skills/verify-library-demo/SKILL.md"), "utf8");
  const sec = /## Your tests\n([\s\S]*?)\n## Drive/.exec(md)?.[1] ?? "";
  assert.match(sec, /Playwright suite[\s\S]*Kitchen runs the whole suite \(`npm run test:e2e`\) on every merge into staging/);
  assert.match(
    sec,
    /Where: `e2e\/` \(2 specs, e\.g\. `e2e\/cart\.spec\.ts`, `e2e\/checkout\.spec\.ts`\)\. Config: `playwright\.config\.ts` \(reads `BASE_URL`/,
  );
  assert.match(sec, /Page objects, fixtures, helpers: `e2e\/pages\/`, `e2e\/fixtures\.ts`, `e2e\/pages\/cart\.page\.ts`/);
  assert.match(sec, /Logging in and seeding: `loginAs \(e2e\/fixtures\.ts\)`, `seedCart \(e2e\/fixtures\.ts\)`\./);
  assert.ok(!sec.includes("money"));
  assert.match(sec, /`BASE_URL=<url> PLAYWRIGHT_BASE_URL=<url> npx playwright test <spec> --reporter=line --output <evidence folder>\/pw > /);
  assert.match(sec, /Never edit the suite/);
  assert.ok(untouched(md), "still Kitchen's: a later init refreshes it");
  // Cypress: its own one-spec command and env.
  const cy = app("cy");
  fs.writeFileSync(path.join(cy, "cypress.config.js"), "module.exports = {}\n");
  fs.mkdirSync(path.join(cy, "cypress/e2e"), { recursive: true });
  fs.mkdirSync(path.join(cy, "cypress/support"), { recursive: true });
  fs.writeFileSync(path.join(cy, "cypress/e2e/cart.cy.js"), "");
  fs.writeFileSync(path.join(cy, "cypress/support/commands.js"), 'Cypress.Commands.add("login", () => {})\n');
  writeVerifySkill(cy, cfg);
  const cmd = fs.readFileSync(path.join(cy, ".claude/skills/verify-library-demo/SKILL.md"), "utf8");
  assert.match(cmd, /`CYPRESS_BASE_URL=<url> npx cypress run --spec <spec> --config video=false/);
  assert.match(cmd, /`cypress\/support\/`[\s\S]*`cy\.login \(cypress\/support\/commands\.js\)`/);
  // No suite: says so.
  assert.match(fs.readFileSync(path.join(root, "a", ".claude/skills/verify-library-demo/SKILL.md"), "utf8"), /## Your tests\n\nNo end-to-end suite was found/);
});
