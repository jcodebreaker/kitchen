// ADR 0032 §4: what a Report's "What was checked" says of each kitchen.yaml check and each language the job's tree has.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import type { CheckSpec } from "../config.ts";
import { checkLines, retested, testedLine, versionsLine } from "./checked.ts";
import type { Job } from "./machine.ts";
import { renderReport } from "./report.ts";
import { jobDirOf, roundDir } from "./store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-checked-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const g = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...a]);
const check = (name: string, run: string, when: "build" | "merge" = "build"): CheckSpec => ({ name, run, when, timeoutSec: 60, needsApp: false });

/** A repo whose job branch has a node and a python project; the person's checkout has since lost pyproject.toml. */
function repo() {
  const r = path.join(root, "r");
  fs.mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  fs.writeFileSync(path.join(r, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts = '-q'\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "base");
  g(r, "branch", "kitchen/001-x");
  fs.rmSync(path.join(r, "pyproject.toml"));
  const job = { id: "001-x", round: 1, branch: "kitchen/001-x", agentRuns: [] } as unknown as Job;
  const dir = jobDirOf(r, job.id);
  fs.mkdirSync(roundDir(dir, 1), { recursive: true });
  return { r, job, dir };
}

test("each check says what became of it: added since, the trial merge's real outcome, languages from the branch", () => {
  const { r, job, dir } = repo();
  fs.writeFileSync(path.join(roundDir(dir, 1), "checks.json"), JSON.stringify([{ name: "test", ok: true, exit: 0 }]));
  const cfg = {
    checkList: [
      check("test", "npm test"),
      check("lint", "npm run lint"),
      check("e2e", "npx playwright test", "merge"),
      check("smoke", "npm run smoke", "merge"),
    ],
    checksOff: [],
  };
  const by = (j: Job) => Object.fromEntries(checkLines(cfg, dir, j, r).map((c) => [c.name, `${c.st} ${c.note}`]));
  let l = by(job);
  assert.equal(l.lint, "wait not in this run (added since)");
  assert.equal(l.e2e, "wait when: merge: runs on the trial merge");
  // Read from the branch's tree, not the checkout (which has no pyproject.toml now).
  assert.match(l["python checks"], /^none none in kitchen.yaml \(pyproject.toml has .*pytest/);
  fs.writeFileSync(path.join(roundDir(dir, 1), "merge.txt"), "the checks fail on staging with this change merged (e2e: exit 1)\n");
  l = by(job);
  assert.equal(l.e2e, "bad failed on the trial merge");
  assert.equal(l.smoke, "wait not run: e2e failed on the trial merge first");
  l = by({ ...job, merged: { into: "staging", sha: "x", at: "", via: "local" } } as Job);
  assert.equal(l.e2e, "ok passed on the trial merge");
  // A check Kitchen can't read may run the python tests: muted, not red.
  const wrapped = { checkList: [check("ci", "./scripts/ci.sh")], checksOff: [] };
  const w = Object.fromEntries(checkLines(wrapped, dir, job, r).map((c) => [c.name, c]));
  assert.equal(w["python checks"].st, "unknown");
  assert.match(w["python checks"].note, /^can't tell: \.\/scripts\/ci\.sh may run them/);
  // A failure among the checks that ran: the ones after it didn't run.
  fs.writeFileSync(path.join(roundDir(dir, 1), "checks.json"), JSON.stringify([{ name: "test", ok: false, exit: 1 }]));
  assert.equal(by(job).lint, "wait not run: an earlier check failed");
  // Round 2 has no results of its own: after a QA retry (no Build) they are current; after a Build since, they are round 1's.
  fs.writeFileSync(path.join(roundDir(dir, 1), "checks.json"), JSON.stringify([{ name: "test", ok: true, exit: 0 }]));
  fs.mkdirSync(roundDir(dir, 2), { recursive: true });
  const two = { ...job, round: 2 } as Job;
  assert.equal(by(two).test, "ok passed");
  fs.writeFileSync(path.join(roundDir(dir, 2), "brief-build-m5.md"), "# Kitchen build lane\n");
  assert.equal(by(two).test, "ok passed on round 1");
});

test("kitchen.yaml that doesn't load: the Report says so instead of guessing", () => {
  const r = path.join(root, "bad-yaml");
  fs.mkdirSync(r);
  fs.writeFileSync(path.join(r, "kitchen.yaml"), "checks: [unclosed\n");
  const job = { id: "001-x", title: "x", stage: "build", round: 1, branch: "kitchen/001-x", kind: "feature", risk: "low", agentRuns: [] } as unknown as Job;
  fs.mkdirSync(jobDirOf(r, job.id), { recursive: true });
  assert.match(renderReport(r, job), /<h2>What was checked<\/h2><p class="bad">kitchen.yaml couldn't be read/);
});

test("no `tested` (a job from before ADR 0032): no versions line", () => {
  assert.equal(versionsLine({ agentRuns: [{ role: "builder", model: "opus" }] } as unknown as Job), null);
});

test("ADR 0034 §3: the tested line names the browser QA drove pages in; a lane with no page capture names none", () => {
  const tested = { at: "2026-11-25T13:27:11.154Z", head: "a".repeat(40), target: "staging", onto: "b".repeat(40), dirty: 0, kitchen: "0.1.0" };
  assert.equal(
    testedLine({ branch: "kitchen/001-x", tested: { ...tested, browser: "Chrome 158" } }),
    "QA tested kitchen/001-x at aaaaaaa, on staging at bbbbbbb (2026-11-25 13:27) in Chrome 158 · committed code only",
  );
  assert.doesNotMatch(String(testedLine({ branch: "kitchen/001-x", tested })), / in /);
});

test("ADR 0034 §3: QA again keeps the browser only on a true retry (the same head and round)", () => {
  const prev = { at: "t0", head: "h1", round: 2, target: "staging", onto: "o", dirty: 0, kitchen: "0.1.0", browser: "Chrome 158" };
  const now = { ...prev, at: "t1", browser: undefined };
  delete now.browser;
  assert.equal(retested(prev, now).browser, "Chrome 158");
  assert.equal(retested(prev, { ...now, head: "h2" }).browser, undefined, "a new head: tested something new");
  assert.equal(retested(prev, { ...now, round: 3 }).browser, undefined, "a new round");
  assert.equal(retested({ ...prev, round: undefined }, now).browser, undefined, "a record without its round");
  assert.equal(retested(undefined, now).browser, undefined);
});
