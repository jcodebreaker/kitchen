// Which repo a command works in: inside a job's worktree, the main checkout that owns the jobs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import * as control from "../engine/control.ts";
import { kitchenRepo } from "./here.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-here-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();
const CLI = path.resolve(import.meta.dirname, "..", "cli.ts");

test("inside .worktrees/<job> (any depth) the main checkout; elsewhere the folder itself; kitchen qa/job verbs find the job", async () => {
  const repo = path.join(root, "app");
  fs.mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "kitchen.yaml"), "checks: []\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".kitchen/\n.worktrees/\n");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.js"), "1\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "base");
  await control.ticket(repo, "add a thing", () => {});
  const wt = path.join(repo, ".worktrees", "001-add-a-thing");
  g(repo, "worktree", "add", "-q", "-b", "kitchen/001", wt);
  assert.equal(kitchenRepo(wt), repo);
  assert.equal(kitchenRepo(path.join(wt, "src")), repo);
  assert.equal(kitchenRepo(repo), repo);
  assert.equal(kitchenRepo(path.join(repo, "src")), path.join(repo, "src"), "outside a job worktree nothing changes");
  const own = path.join(root, "my-own-worktree");
  g(repo, "worktree", "add", "-q", "-b", "mine", own);
  assert.equal(kitchenRepo(own), own, "a worktree of your own is its own repo");
  for (const d of [".kitchen/merge/001-add-a-thing", ".kitchen/verify/sweep-20261123-100000/wt"]) {
    const t = path.join(repo, d);
    g(repo, "worktree", "add", "-q", "--detach", t);
    assert.equal(kitchenRepo(t), repo, `${d}: a regress lane's trial merge and a verify run's checkout are Kitchen's too`);
  }
  assert.equal(kitchenRepo(root), root, "not a git repo");
  const shown = JSON.parse(execFileSync(process.execPath, [CLI, "job", "show", "1", "--json"], { cwd: path.join(wt, "src"), encoding: "utf8" }));
  assert.equal(shown.id, "001-add-a-thing");
  const down = execFileSync(process.execPath, [CLI, "qa", "down", "1"], { cwd: wt, encoding: "utf8" });
  assert.match(down, /app: not running/);
});
