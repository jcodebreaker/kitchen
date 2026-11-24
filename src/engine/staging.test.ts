// The GitHub side of the merge into staging, against a bare "origin" and a stand-in `gh` that records its calls:
// staging created on the remote from the base, the job branch pushed by Kitchen, its PR into staging opened and
// merged with --match-head-commit pinned to the reviewed head. Never a push to the base or main.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { parseConfig } from "../config.ts";
import type { Job } from "./machine.ts";
import { assertNotProtected, ensureStaging, type Gh, mergeToTarget } from "./staging.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-staging-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();

test("GitHub: staging made on origin from the base; a passing job's PR merged pinned to the reviewed head; main untouched", async () => {
  const origin = path.join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const r = path.join(root, "clone");
  fs.mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "a.txt"), "a\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "a");
  g(r, "remote", "add", "origin", origin);
  g(r, "push", "-q", "origin", "main");
  const calls: string[][] = [];
  // The stand-in gh: `api …/git/refs` creates the remote branch; `pr merge` merges the PR head into staging on origin.
  const gh: Gh = async (args) => {
    calls.push(args);
    if (args[0] === "api") {
      const sha = args.find((a) => a.startsWith("sha="))?.slice(4) as string;
      execFileSync("git", ["--git-dir", origin, "update-ref", "refs/heads/staging", sha]);
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: "https://github.com/o/r/pull/7\n", stderr: "" };
    if (args[0] === "pr" && args[1] === "merge") {
      const head = args[args.indexOf("--match-head-commit") + 1];
      const tip = execFileSync("git", ["--git-dir", origin, "rev-parse", "refs/heads/kitchen/001-x"], { encoding: "utf8" }).trim();
      if (tip !== head) return { code: 1, stdout: "", stderr: "head moved" };
      const wt = path.join(root, "merger");
      execFileSync("git", ["clone", "-q", "-b", "staging", origin, wt]);
      g(wt, "merge", "-q", "--no-ff", "-m", "Merge PR #7", `origin/kitchen/001-x`);
      g(wt, "push", "-q", "origin", "staging");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  const cfg = parseConfig('forge: { kind: github, repo: o/r }\nchecks: [{ name: t, run: "test -f a.txt" }]\n');
  const lines: string[] = [];
  await ensureStaging(r, cfg, (l) => lines.push(l), gh);
  assert.match(lines[0], /created staging on GitHub from main/);
  g(r, "branch", "kitchen/001-x", "staging");
  const wt = path.join(root, "job");
  g(r, "worktree", "add", "-q", wt, "kitchen/001-x");
  fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "b");
  const head = g(r, "rev-parse", "kitchen/001-x");
  const job = { id: "001-x", title: "add b", branch: "kitchen/001-x", pr: null } as unknown as Job;
  const m = await mergeToTarget(r, cfg, job, head, { log: path.join(root, "merge.log"), gh });
  assert.deepEqual(m.ok && [m.via, m.pr], ["github", 7], JSON.stringify(m));
  const merge = calls.find((c) => c[1] === "merge") as string[];
  assert.deepEqual(merge, ["pr", "merge", "7", "--merge", "--match-head-commit", head]);
  assert.equal(execFileSync("git", ["--git-dir", origin, "show", "staging:b.txt"], { encoding: "utf8" }), "b\n");
  assert.throws(() => execFileSync("git", ["--git-dir", origin, "show", "main:b.txt"], { stdio: "ignore" }), "main never gets it");
  // A head that moved after review is refused before anything is pushed.
  const stale = await mergeToTarget(r, cfg, job, "0".repeat(40), { log: path.join(root, "merge.log"), gh });
  assert.match(!stale.ok ? stale.why : "", /moved since review/);
});

test("Kitchen refuses to merge into the base, main or master", () => {
  const cfg = parseConfig("staging: { base: develop }\n");
  for (const b of ["develop", "main", "master"]) assert.throws(() => assertNotProtected(cfg, b), /never merges/);
  assert.doesNotThrow(() => assertNotProtected(cfg, "staging"));
});
