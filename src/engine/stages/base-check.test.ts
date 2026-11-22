// The base check never fails open (final fixes H3): once HEAD has moved past the base
// (`kitchen feedback --to spec` after a build), it used to return null, and the
// negatives and guards it was to back passed unchecked. Now it runs on a checkout of
// the base (`.worktrees/<id>.base`). A real git repo; the app and the proof runner
// are stand-ins that record where they ran.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import type { Criterion } from "../../checks/spec-lint.ts";
import type { Job } from "../machine.ts";
import type { StageContext } from "./types.ts";

const ran: { criterion: string; worktree: string | null; baseHere: boolean }[] = [];
vi.mock("../../proof/prove.ts", () => ({
  prove: async (o: { criterion: Criterion; source?: { worktree: string } }) => {
    const wt = o.source?.worktree ?? null;
    // On the base the old heading shows: the negative is FALSE there.
    const baseHere = !!wt && fs.readFileSync(path.join(wt, "page.txt"), "utf8").includes("Appearance");
    ran.push({ criterion: o.criterion.id, worktree: wt, baseHere });
    const pass = !baseHere;
    return {
      criterion: o.criterion.id,
      status: pass ? "pass" : "assert-fail",
      evidence: ["e1"],
      assert: { pass, results: [{ clause: 'text "Appearance" not visible', pass, got: baseHere ? "present" : "absent" }] },
    };
  },
}));
vi.mock("../instance.ts", () => ({ freshUp: async () => {}, resetUp: async () => {} }));
vi.mock("../worktree.ts", () => ({ headOf: async () => "moved-past-the-base", changedFiles: async () => [] }));

const { runBaseCheck, baseNegativeProblems, guardBaseProblems } = await import("./base-check.ts");

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8" }).trim();

test("H3: HEAD moved past the base: the base check runs on a checkout of the base, never returns null", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-basecheck-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "page.txt"), "Settings\nAppearance\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  const worktree = path.join(repo, ".worktrees", "001-rename");
  git(repo, "worktree", "add", "-q", "-b", "kitchen/001", worktree);
  fs.writeFileSync(path.join(worktree, "page.txt"), "Settings\nDisplay\n");
  git(worktree, "commit", "-q", "-am", "built");
  const jobDir = path.join(root, "job");
  fs.mkdirSync(jobDir);
  const bin = path.join(root, "dev");
  fs.writeFileSync(bin, "");
  const job = { id: "001-rename", worktree, base, toolkitBin: bin, slotId: "s1", kind: "feature", surfaces: [] } as unknown as Job;
  const ctx = { repo, job, jobDir, config: { test_cmd: "true" }, log: () => {} } as unknown as StageContext;
  const criteria: Criterion[] = [
    {
      id: "C1",
      text: "the old heading is gone",
      proof: "toolkit open --path /settings",
      expect: 'text "Appearance" not visible',
      repro: false,
      covers: ["R1"],
    },
  ];
  const b = await runBaseCheck(ctx, job, criteria);
  assert.ok(b, "a moved HEAD no longer skips the base check");
  assert.equal(b.head, base);
  assert.deepEqual(
    ran.map((r) => [r.criterion, r.worktree, r.baseHere]),
    [["C1", `${worktree}.base`, true]],
    "proved on the base checkout, not on the built worktree",
  );
  assert.equal(fs.existsSync(`${worktree}.base`), false, "the base checkout is removed");
  const pending = [{ criterion: "C1", clause: 'text "Appearance" not visible' }];
  assert.deepEqual(baseNegativeProblems(pending, b), [], "the old heading shows on the base: the negative is backed");
  // Reused for the same contract and base.
  await runBaseCheck(ctx, job, criteria);
  assert.equal(ran.length, 1);
  // And when nothing could run, what it was to back is refused, not waved through.
  assert.match(baseNegativeProblems(pending, null)[0], /could not run/);
  assert.match(guardBaseProblems(["C2"], null)[0], /could not run/);
  fs.rmSync(root, { recursive: true, force: true });
});
