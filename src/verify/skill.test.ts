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
