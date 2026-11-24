// ADR 0026 on real git: a ticket's target branch (cut from it, merged into it, staging untouched), the guard on
// main, `staging.merge: pr` against a bare origin and a stand-in `gh` that records its calls (the PR opened with the
// Report, merged or closed on "GitHub", the merge check re-run when the target moves), and one merge per target.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { loadConfig, parseConfig } from "../config.ts";
import { questionOf, snapshot, stateOf } from "../dashboard/data.ts";
import * as control from "./control.ts";
import { finish, mergeHeld, next, start, syncPrs } from "./jobs.ts";
import { intakeFile, qaDir, reviewFile } from "./lanes.ts";
import type { Job } from "./machine.ts";
import { ensureStaging, mergeToTarget } from "./staging.ts";
import { findJob, jobDirOf, parseJob } from "./store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-targets-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();
const quiet = () => {};
let n = 0;

/** A repo with staging and feature/x (one commit ahead of main). `origin`: a bare remote with both pushed. */
async function repo(yaml = "", o: { origin?: boolean } = {}): Promise<{ r: string; origin: string }> {
  const r = path.join(root, `r${++n}`);
  const origin = path.join(root, `o${n}.git`);
  fs.mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "app.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(r, "kitchen.yaml"), `checks: [{ name: guard, run: "test ! -e BROKEN" }]\n${yaml}`);
  fs.writeFileSync(path.join(r, ".gitignore"), ".kitchen/\n.worktrees/\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "base");
  g(r, "branch", "staging");
  g(r, "checkout", "-q", "-b", "feature/x");
  fs.writeFileSync(path.join(r, "feature.txt"), "x\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "feature x");
  g(r, "checkout", "-q", "main");
  if (o.origin) {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    g(r, "remote", "add", "origin", origin);
    g(r, "push", "-q", "origin", "main", "staging", "feature/x");
  }
  await ensureStaging(r, loadConfig(r), quiet);
  return { r, origin };
}
const open = async (r: string, id: string, lane: string) => {
  const s = await start(r, id, lane);
  assert.ok("brief" in s, JSON.stringify(s));
  return s;
};
const fin = async (r: string, id: string) => {
  const f = await finish(r, id);
  assert.ok("line" in f, JSON.stringify(f));
  return f;
};
const INTAKE = `DECISION: ACCEPT\nTITLE: Add four\nKIND: feature\nRISK: low\nSURFACES: none\nFILES: app.txt\n\n## Criteria\n- C1 (cmd): app.txt has a fourth line\n`;
async function ticket(r: string, into?: string): Promise<{ id: string; intakeHead: string }> {
  const lines: string[] = [];
  assert.equal(await control.ticket(r, "add a fourth line", (l) => lines.push(l), { into }), 0, lines.join("\n"));
  const id = findJob(r, String(fs.readdirSync(path.join(r, ".kitchen", "jobs")).filter((x) => /^\d/.test(x)).length)).id;
  const s = await open(r, id, "intake");
  const intakeHead = g(s.cwd, "rev-parse", "HEAD");
  fs.writeFileSync(intakeFile(jobDirOf(r, id)), INTAKE);
  await fin(r, id);
  return { id, intakeHead };
}
async function build(r: string, id: string, content = "one\ntwo\nthree\nfour\n") {
  const s = await open(r, id, "build");
  fs.writeFileSync(path.join(s.cwd, "app.txt"), content);
  g(s.cwd, "commit", "-qam", "four");
  return fin(r, id);
}
async function qaAndReview(r: string, id: string) {
  await open(r, id, "qa");
  let j = findJob(r, id);
  const d = qaDir(jobDirOf(r, j.id), j.round);
  fs.writeFileSync(path.join(d, "c1.txt"), "four\n");
  fs.writeFileSync(
    path.join(d, "verdict.json"),
    JSON.stringify({ verdict: "PASS", criteria: [{ id: "C1", result: "PASS", evidence: ["c1.txt"], note: "x" }] }),
  );
  await fin(r, id);
  await open(r, id, "review");
  j = findJob(r, id);
  fs.writeFileSync(reviewFile(jobDirOf(r, j.id), j.round), JSON.stringify({ summary: "ok", findings: [] }));
  return fin(r, id);
}

test("(a) ticket --into feature/x: intake and the worktree start from feature/x, it merges into feature/x, staging untouched", async () => {
  const { r } = await repo();
  const fx = g(r, "rev-parse", "feature/x");
  const staging = g(r, "rev-parse", "staging");
  const { id, intakeHead } = await ticket(r, "feature/x");
  assert.equal(findJob(r, id).target, "feature/x");
  assert.equal(intakeHead, fx, "intake reads feature/x's tip");
  const s = await open(r, id, "build");
  assert.equal(g(s.cwd, "rev-parse", "HEAD"), fx, "the worktree is cut from feature/x");
  assert.match(fs.readFileSync(s.brief, "utf8"), /- Target: feature\/x/);
  fs.writeFileSync(path.join(s.cwd, "app.txt"), "one\ntwo\nthree\nfour\n");
  g(s.cwd, "commit", "-qam", "four");
  await fin(r, id);
  const done = await qaAndReview(r, id);
  assert.match(done.line, /merged into feature\/x/);
  const j = findJob(r, id);
  assert.equal(j.stage, "done");
  assert.equal(j.merged?.into, "feature/x");
  assert.equal(g(r, "show", "feature/x:app.txt"), "one\ntwo\nthree\nfour");
  assert.equal(g(r, "show", "feature/x:feature.txt"), "x", "feature/x's own work stays");
  assert.equal(g(r, "rev-parse", "staging"), staging, "staging untouched");
  assert.equal(g(r, "show", "main:app.txt"), "one\ntwo\nthree");
  const card = (await snapshot(r)).jobs.find((c) => c.id === id);
  assert.equal(card?.target, "feature/x", "the card carries a target that isn't staging");
});

test("(b) a job without a target (and an old job.json with pr as a number) targets staging", async () => {
  const { r } = await repo();
  const fx = g(r, "rev-parse", "feature/x");
  const { id } = await ticket(r);
  assert.equal(findJob(r, id).target, undefined);
  await build(r, id);
  assert.match((await qaAndReview(r, id)).line, /merged into staging/);
  assert.equal(g(r, "show", "staging:app.txt"), "one\ntwo\nthree\nfour");
  assert.equal(g(r, "rev-parse", "feature/x"), fx);
  const card = (await snapshot(r)).jobs.find((c) => c.id === id);
  assert.ok(card && !("target" in card), "no target on a default card");
  const old = parseJob(JSON.stringify({ ...findJob(r, id), target: undefined, pr: 5 }));
  assert.deepEqual(old.pr, { number: 5, url: "" });
});

test("(c) --into main (or the base) with merge: kitchen is refused; a branch that doesn't exist too; nothing filed", async () => {
  const { r } = await repo("staging: { base: develop }\n");
  g(r, "branch", "develop", "main");
  for (const [into, why] of [
    ["main", /--into main: Kitchen never merges into develop, main or master/],
    ["develop", /--into develop: Kitchen never merges into develop, main or master/],
    ["nope", /there is no branch nope: Kitchen never creates a target/],
  ] as const) {
    const lines: string[] = [];
    assert.equal(await control.ticket(r, "x", (l) => lines.push(l), { into }), 1);
    assert.match(lines.join("\n"), why);
  }
  assert.ok(!fs.existsSync(path.join(r, ".kitchen", "jobs")) || !fs.readdirSync(path.join(r, ".kitchen", "jobs")).some((x) => /^\d/.test(x)));
  assert.throws(() => parseConfig("staging: { merge: pr }\n"), /needs forge: \{ kind: github \}/);
});

/** The stand-in gh: records each call, answers `pr view` from view.json, `pr create` with PR #12. */
function standInGh(dir: string): { calls: () => string[][]; view: (v: unknown) => void } {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "gh");
  const log = path.join(dir, "calls.jsonl");
  const view = path.join(dir, "view.json");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
if (a[0] === "pr" && a[1] === "create") console.log("https://github.com/o/r/pull/12");
else if (a[0] === "pr" && a[1] === "view") process.stdout.write(fs.readFileSync(${JSON.stringify(view)}, "utf8"));
else if (a[0] === "pr" && a[1] === "list") process.stdout.write("");
else if (a[0] === "repo") console.log("o/r");
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(view, JSON.stringify({ state: "OPEN", mergedAt: null, mergeCommit: null }));
  process.env.KITCHEN_GH_BIN = bin;
  return {
    calls: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    view: (v) => fs.writeFileSync(view, JSON.stringify(v)),
  };
}
const PR_YAML = "forge: { kind: github, repo: o/r }\nstaging: { merge: pr }\n";
const remote = (origin: string, ref: string) => execFileSync("git", ["--git-dir", origin, "rev-parse", ref], { encoding: "utf8" }).trim();

test("(d) merge: pr: the PR opens with the Report, the job waits under Needs you; MERGED → done (github), CLOSED → rejected", async () => {
  const { r, origin } = await repo(PR_YAML, { origin: true });
  const gh = standInGh(path.join(root, "gh-d"));
  const staging = remote(origin, "staging");
  const { id } = await ticket(r);
  await build(r, id);
  const f = await qaAndReview(r, id);
  assert.match(f.line, /PR #12 into staging .*PR open · waiting for review/);
  let j = findJob(r, id);
  assert.equal(j.stage, "ready");
  assert.equal(j.pr?.state, "open");
  assert.equal(j.pr?.url, "https://github.com/o/r/pull/12");
  assert.equal(remote(origin, `refs/heads/${j.branch}`), g(r, "rev-parse", j.branch), "the job branch is pushed");
  assert.equal(remote(origin, "staging"), staging, "Kitchen never merged it");
  const create = gh.calls().find((c) => c[1] === "create") as string[];
  const body = create[create.indexOf("--body") + 1];
  assert.deepEqual([create[create.indexOf("--base") + 1], create[create.indexOf("--head") + 1]], ["staging", j.branch]);
  assert.match(body, /\*\*Merge check:\*\* merged onto `staging`/);
  assert.match(body, /<h1>.*Add four<\/h1>/, "the Report is the body");
  assert.match(body, /C1/);
  assert.ok(!gh.calls().some((c) => c[1] === "merge"), "no gh pr merge");
  assert.equal(stateOf(j), "you");
  assert.equal(questionOf(j, jobDirOf(r, id)), "PR open · waiting for review");
  const plan = await next(r);
  assert.match(plan.you.find((y) => y.id === id)?.why ?? "", /PR open · waiting for review \(PR #12/);
  const card = (await snapshot(r)).jobs.find((c) => c.id === id);
  assert.deepEqual([card?.lane, card?.pull], ["you", { number: 12, url: "https://github.com/o/r/pull/12", state: "open" }]);
  // kitchen merge refuses it: a person merges on GitHub.
  const held = await mergeHeld(r, id);
  assert.match("refused" in held ? held.refused : "", /merge it on GitHub/);
  // Within the minute nothing is asked; forced, GitHub says merged.
  gh.view({ state: "MERGED", mergedAt: "2026-11-24T10:00:00Z", mergeCommit: { oid: "a".repeat(40) } });
  assert.deepEqual(await syncPrs(r), [], "at most once per minute");
  const lines = await syncPrs(r, { force: true });
  assert.match(lines.join("\n"), /PR #12 merged on GitHub into staging/);
  j = findJob(r, id);
  assert.deepEqual([j.stage, j.mergedBy, j.merged?.via, j.merged?.into, j.pr?.state], ["done", "github", "github", "staging", "merged"]);
  assert.match(fs.readFileSync(path.join(jobDirOf(r, id), "report.html"), "utf8"), /Merged on GitHub on 2026-11-24 into staging/);

  // A second job: its PR closed without merging.
  const b = (await ticket(r)).id;
  await build(r, b, "one\ntwo\nthree\nfive\n");
  await qaAndReview(r, b);
  assert.equal(findJob(r, b).pr?.state, "open");
  gh.view({ state: "CLOSED", mergedAt: null, mergeCommit: null });
  assert.match((await syncPrs(r, { force: true })).join("\n"), /closed on GitHub without merging → rejected/);
  assert.deepEqual([findJob(r, b).stage, findJob(r, b).pr?.state], ["rejected", "closed"]);
});

test("(e) the target moves under an open PR: green re-check updates the PR; a conflict is a catch-up, then the PR is updated", async () => {
  const { r, origin } = await repo(PR_YAML, { origin: true });
  const gh = standInGh(path.join(root, "gh-e"));
  const { id } = await ticket(r);
  await build(r, id);
  await qaAndReview(r, id);
  const first = findJob(r, id).pr?.onto;
  // Someone lands an unrelated change on staging (origin).
  const other = path.join(root, "other-e");
  execFileSync("git", ["clone", "-q", "-b", "staging", origin, other]);
  fs.writeFileSync(path.join(other, "z.txt"), "z\n");
  g(other, "add", "-A");
  g(other, "commit", "-qm", "unrelated");
  g(other, "push", "-q", "origin", "staging");
  const green = await syncPrs(r, { force: true });
  assert.match(green.join("\n"), /staging moved .* while PR #12 was open: merge check re-run → PR #12/);
  let j = findJob(r, id);
  assert.equal(j.stage, "ready");
  assert.notEqual(j.pr?.onto, first);
  assert.equal(j.pr?.onto, remote(origin, "staging"));
  assert.ok(
    gh.calls().some((c) => c[1] === "edit" && c[2] === "12"),
    "the PR body is updated",
  );
  // Now a conflicting change lands on staging.
  fs.writeFileSync(path.join(other, "app.txt"), "one\ntwo\nTHREE\n");
  g(other, "commit", "-qam", "shout three");
  g(other, "push", "-q", "origin", "staging");
  const conflict = await syncPrs(r, { force: true });
  assert.match(conflict.join("\n"), /conflicts with staging in app\.txt → build \(catch-up 1 of 3, no round spent\)/);
  j = findJob(r, id);
  assert.deepEqual([j.stage, j.catchUps, j.pr?.state], ["build", 1, "open"]);
  // The catch-up round: Kitchen started the merge of staging's tip; the builder resolves it.
  const s = await open(r, id, "build");
  fs.writeFileSync(path.join(s.cwd, "app.txt"), "one\ntwo\nTHREE\nfour\n");
  g(s.cwd, "add", "app.txt");
  g(s.cwd, "commit", "-q", "--no-edit");
  await fin(r, id);
  const edits = gh.calls().filter((c) => c[1] === "edit").length;
  const f = await qaAndReview(r, id);
  assert.match(f.line, /PR #12 into staging/);
  j = findJob(r, id);
  assert.equal(j.stage, "ready");
  assert.equal(remote(origin, `refs/heads/${j.branch}`), g(r, "rev-parse", j.branch), "the updated branch is pushed");
  assert.equal(gh.calls().filter((c) => c[1] === "edit").length, edits + 1, "the same PR, updated");
  assert.equal(gh.calls().filter((c) => c[1] === "create").length, 1, "never a second PR");
});

test("(f) merges into one target wait for each other; merges into different targets run at once", async () => {
  const log = path.join(root, "f.log");
  const { r } = await repo();
  // A check slow enough to see two merges overlap (or not): each writes s when it starts and e when it ends.
  fs.writeFileSync(path.join(r, "kitchen.yaml"), `checks: [{ name: slow, run: "echo s >> ${log}; sleep 1; echo e >> ${log}" }]\n`);
  const cfg = loadConfig(r);
  const job = (id: string, from: string, target?: string): Job => {
    const branch = `kitchen/${id}`;
    g(r, "branch", branch, from);
    const wt = path.join(root, `wt-${n}-${id}`);
    g(r, "worktree", "add", "-q", wt, branch);
    fs.writeFileSync(path.join(wt, `${id}.txt`), `${id}\n`);
    g(wt, "add", "-A");
    g(wt, "commit", "-qm", id);
    g(r, "worktree", "remove", "--force", wt);
    return { id, title: id, branch, pr: null, ...(target ? { target } : {}) } as unknown as Job;
  };
  const run = (j: Job) => mergeToTarget(r, cfg, j, g(r, "rev-parse", j.branch), { log: path.join(root, `${j.id}.log`) });
  const order = async (a: Job, b: Job) => {
    fs.writeFileSync(log, "");
    const out = await Promise.all([run(a), run(b)]);
    assert.ok(
      out.every((m) => m.ok),
      JSON.stringify(out),
    );
    return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).join("");
  };
  assert.equal(await order(job("001-a", "staging"), job("002-b", "staging")), "sese", "same target: one after the other");
  assert.equal(await order(job("003-c", "staging"), job("004-d", "feature/x", "feature/x")), "ssee", "different targets: side by side");
  assert.equal(g(r, "show", "feature/x:004-d.txt"), "004-d");
  assert.equal(g(r, "show", "staging:003-c.txt"), "003-c");
});

test("(g) rejecting or removing a job whose PR is open closes the PR once, with a comment; restore leaves it closed", async () => {
  const { r } = await repo(PR_YAML, { origin: true });
  const gh = standInGh(path.join(root, "gh-g"));
  const a = (await ticket(r)).id;
  await build(r, a);
  await qaAndReview(r, a);
  assert.equal(findJob(r, a).pr?.state, "open");
  const said: string[] = [];
  assert.equal(await control.reject(r, a, (l) => said.push(l)), 0);
  assert.match(said.join("\n"), /rejected; PR #12 closed on GitHub/);
  const close = gh.calls().filter((c) => c[1] === "close");
  assert.equal(close.length, 1);
  assert.deepEqual(close[0].slice(0, 3), ["pr", "close", "12"]);
  assert.match(close[0][close[0].indexOf("--comment") + 1], new RegExp(`job ${a} was rejected by the person`));
  assert.deepEqual([findJob(r, a).stage, findJob(r, a).pr?.state, findJob(r, a).pr?.closedBy], ["rejected", "closed", "kitchen"]);
  // Removing it afterwards closes nothing again; restore says the PR stays closed.
  said.length = 0;
  await control.remove(r, a, (l) => said.push(l));
  assert.equal(gh.calls().filter((c) => c[1] === "close").length, 1, "once");
  await control.restore(r, a, (l) => said.push(l));
  assert.match(said.at(-1) ?? "", /back in view \(rejected\); its PR #12 stays closed \(reopen it on GitHub/);
  // A second job, removed while its PR is open.
  const b = (await ticket(r)).id;
  await build(r, b, "one\ntwo\nthree\nfive\n");
  await qaAndReview(r, b);
  said.length = 0;
  await control.remove(r, b, (l) => said.push(l));
  assert.match(said.join("\n"), /removed, rejected.*; PR #12 closed on GitHub; kitchen restore/);
  const last = gh
    .calls()
    .filter((c) => c[1] === "close")
    .at(-1) as string[];
  assert.match(last[last.indexOf("--comment") + 1], new RegExp(`job ${b} was removed by the person`));
});

test("(h) a PR merged on GitHub during a catch-up round: done (github), the lane closed, its finish refused, its agent stopped", async () => {
  const { r, origin } = await repo(PR_YAML, { origin: true });
  const gh = standInGh(path.join(root, "gh-h"));
  const { id } = await ticket(r);
  await build(r, id);
  await qaAndReview(r, id);
  // A conflicting change lands on staging: the open PR's job goes back for a catch-up.
  const other = path.join(root, "other-h");
  execFileSync("git", ["clone", "-q", "-b", "staging", origin, other]);
  fs.writeFileSync(path.join(other, "app.txt"), "one\ntwo\nTHREE\n");
  g(other, "commit", "-qam", "shout three");
  g(other, "push", "-q", "origin", "staging");
  await syncPrs(r, { force: true });
  assert.equal(findJob(r, id).stage, "build");
  await open(r, id, "build");
  assert.equal(findJob(r, id).running?.lane, "build");
  // Meanwhile a person resolves and merges the PR on GitHub.
  gh.view({ state: "MERGED", mergedAt: "2026-11-24T11:00:00Z", mergeCommit: { oid: "b".repeat(40) } });
  const lines = await syncPrs(r, { force: true });
  assert.match(lines.join("\n"), /PR #12 merged on GitHub into staging \(bbbbbbb\) while it was in build \(the build agent was stopped\)/);
  const j = findJob(r, id);
  assert.deepEqual([j.stage, j.mergedBy, j.merged?.via, j.pr?.state, j.running], ["done", "github", "github", "merged", null]);
  assert.equal(j.agentRuns.at(-1)?.ok, false);
  assert.match(j.agentRuns.at(-1)?.line ?? "", /merged on GitHub/);
  const f = await finish(r, id);
  assert.match("refused" in f ? f.refused : "", /was merged on GitHub: this lane's result is dropped/);
  // The guard hook stops the lane's agent the way it stops a removed job's.
  const hook = path.resolve(import.meta.dirname, "..", "..", "hooks", "guard-worktree.py");
  fs.mkdirSync(path.join(r, ".kitchen", "agents"), { recursive: true });
  fs.writeFileSync(path.join(r, ".kitchen", "agents", "agent-h"), id);
  const out = execFileSync("python3", [hook], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" }, cwd: r, agent_id: "agent-h" }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: r },
    encoding: "utf8",
  });
  assert.match(out, /ended while you worked \(merged\)/);
});
