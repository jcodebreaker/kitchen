import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { refreshSkill } from "./files.ts";

test("kitchen run brings an older Kitchen's skill copy up to date, and leaves a current one alone", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-skill-"));
  const claude = path.join(repo, ".claude/skills/kitchen/SKILL.md");
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, "| start, run | `kitchen run --detach` |\n"); // the pre-ADR-0016 skill sent the session to start another
  assert.deepEqual(refreshSkill(repo).sort(), [".agents/skills/kitchen/SKILL.md", ".claude/skills/kitchen/SKILL.md"]);
  assert.match(fs.readFileSync(claude, "utf8"), /Running the queue/);
  assert.deepEqual(refreshSkill(repo), []);
  fs.rmSync(repo, { recursive: true, force: true });
});
