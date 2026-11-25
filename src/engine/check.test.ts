// ADR 0028 on real git: a check ticket (intake → QA on staging's tip → done, never a branch), its problems proposed
// in the inbox and run from there, an exploring check, a QA that couldn't run, the schedule that files a check, and
// the amendment: KEEP: no ends verified and not merged until `kitchen promote`. No agent: each test writes what a
// lane agent would.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { loadConfig } from "../config.ts";
import { snapshot } from "../dashboard/data.ts";
import { argvOf, listKept, parseEvery, scheduleCheck, scheduleId, schedulesLines } from "../inbox/schedule.ts";
import { getProposal, listItems, listProposals, run as runProposals } from "../inbox/store.ts";
import { runDir, runWorktree } from "../verify/paths.ts";
import * as control from "./control.ts";
import { checkWords, finish, next, start } from "./jobs.ts";
import { intakeFile, parseIntake, qaDir, reviewFile } from "./lanes.ts";
import { planWave } from "./plan.ts";
import { ensureStaging } from "./staging.ts";
import { findJob, jobDirOf } from "./store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-check-"));
process.env.KITCHEN_HOME = path.join(root, "home");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();
const quiet = () => {};
let n = 0;

async function repo(yaml = "", o: { origin?: boolean } = {}): Promise<string> {
  const r = path.join(root, `r${++n}`);
  fs.mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "app.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(r, "kitchen.yaml"), `checks: [{ name: guard, run: "test ! -e BROKEN" }]\n${yaml}`);
  fs.writeFileSync(path.join(r, ".gitignore"), ".kitchen/\n.worktrees/\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "base");
  if (o.origin) {
    const origin = path.join(root, `o${n}.git`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    g(r, "remote", "add", "origin", origin);
    g(r, "branch", "staging");
    g(r, "push", "-q", "origin", "main", "staging");
  }
  await ensureStaging(r, loadConfig(r), quiet);
  return r;
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
const lastId = (r: string) =>
  fs
    .readdirSync(path.join(r, ".kitchen", "jobs"))
    .filter((x) => /^\d/.test(x))
    .sort()
    .at(-1) as string;
const branches = (r: string) => g(r, "branch", "--format=%(refname:short)").split("\n").sort();

/** File a ticket and finish its intake with `intake`. */
async function intake(r: string, text: string, md: string, o: { check?: boolean } = {}) {
  await control.ticket(r, text, quiet, { check: o.check });
  const id = lastId(r);
  const s = await open(r, id, "intake");
  fs.writeFileSync(intakeFile(jobDirOf(r, id)), md);
  return { id, brief: fs.readFileSync(s.brief, "utf8"), f: await fin(r, id) };
}
const CHECK = (crit: string[], extra = "") =>
  `DECISION: ACCEPT\nTITLE: Check the app\nKIND: check\n${extra}LEFT OUT: nothing\nREASON: asks to check\n\n## Criteria\n${crit.map((c, i) => `- C${i + 1} (cmd): ${c}`).join("\n")}\n`;

/** Open the check's QA lane, write evidence and verdict.json there, finish it. */
async function checkQa(r: string, id: string, verdict: Record<string, unknown>, files: Record<string, string> = {}) {
  const s = await open(r, id, "qa");
  const j = findJob(r, id);
  const d = qaDir(jobDirOf(r, j.id), j.round);
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), t);
  }
  fs.writeFileSync(path.join(d, "verdict.json"), JSON.stringify(verdict));
  return { s, f: await fin(r, id) };
}

test("intake: KIND check (criteria or EXPLORE), KEEP: no, and the old kinds as before", () => {
  const c = parseIntake(CHECK(["app.txt has three lines"]));
  assert.ok("decision" in c && c.decision === "ACCEPT");
  assert.deepEqual([c.kind, c.risk, c.keep, c.explore], ["check", "low", true, undefined], "a check is low risk, no RISK: needed");
  const e = parseIntake("DECISION: ACCEPT\nTITLE: Explore loans\nKIND: check\nEXPLORE:\n");
  assert.ok("decision" in e && e.decision === "ACCEPT" && e.explore === 20 && e.criteria.length === 0, JSON.stringify(e));
  const e2 = parseIntake("DECISION: ACCEPT\nKIND: check\nEXPLORE: 45 minutes\n");
  assert.ok("decision" in e2 && e2.decision === "ACCEPT" && e2.explore === 45);
  assert.match(String((parseIntake("DECISION: ACCEPT\nKIND: check\n") as { refused: string }).refused), /criterion .* or an EXPLORE/);
  assert.match(String((parseIntake("DECISION: ACCEPT\nKIND: test\nRISK: low\n- C1 (cmd): x\n") as { refused: string }).refused), /chore or check/);
  const k = parseIntake("DECISION: ACCEPT\nKIND: chore\nKEEP: no\nRISK: low\n\n- C1 (cmd): the harness runs 10k rows\n");
  assert.ok("decision" in k && k.decision === "ACCEPT" && k.keep === false);
  const f = parseIntake("DECISION: ACCEPT\nKIND: feature\nRISK: low\n\n- C1 (cmd): x\n");
  assert.ok("decision" in f && f.decision === "ACCEPT" && f.keep === true && f.explore === undefined, "a feature: kept, no explore");
  assert.match(String((parseIntake("DECISION: ACCEPT\nKIND: feature\n- C1 (cmd): x\n") as { refused: string }).refused), /RISK/, "RISK still required");
  assert.equal(checkWords({ pass: 4, total: 4, findings: 0 }), "Checked on staging · 4 of 4 pass");
  assert.equal(checkWords({ pass: 2, total: 4, findings: 2 }), "Found 2 problems");
  assert.equal(checkWords({ pass: 0, total: 0, findings: 1, explore: 20 }), "Found 1 problem");
});

test("(a) a check that passes: intake → QA on staging's tip → done; no branch, staging unchanged, the words right", async () => {
  const r = await repo();
  const before = g(r, "rev-parse", "staging");
  const before_br = branches(r);
  const { id, brief, f } = await intake(r, "check that app.txt still has three lines", CHECK(["app.txt has 3 lines", "app.txt starts with one"]), {
    check: true,
  });
  assert.match(brief, /filed this as a check \(`kitchen ticket --check`\)/, "intake is told the kind");
  assert.match(f.line, /intake ACCEPT check: 2 criteria → qa on staging/);
  assert.equal(findJob(r, id).stage, "qa");
  assert.deepEqual((await next(r)).start, [{ id, lane: "qa" }], "the plan sends it to QA, never to Build");
  assert.match(String(((await start(r, id, "build")) as { refused: string }).refused ?? ""), /is in qa, not build/);
  const { s, f: done } = await checkQa(
    r,
    id,
    {
      verdict: "PASS",
      criteria: [
        { id: "C1", result: "PASS", evidence: ["c1.txt"], note: "3 lines" },
        { id: "C2", result: "PASS", evidence: ["c2.txt"], note: "one" },
      ],
    },
    { "c1.txt": "3 app.txt\n", "c2.txt": "one\n" },
  );
  assert.equal(s.cwd, runWorktree(r, `check-${id}`), "QA drives the check-<id> verify run");
  const qaBrief = fs.readFileSync(s.brief, "utf8");
  assert.match(qaBrief, /checkout to drive \(change nothing\).*staging at [0-9a-f]{12}, detached: a check has no branch/);
  assert.match(qaBrief, /## A check: test staging as it is/);
  assert.match(qaBrief, /## A check ticket/, "the QA role's check section");
  assert.match(done.line, /check on staging [0-9a-f]{7}: Checked on staging · 2 of 2 pass → done/);
  const j = findJob(r, id);
  assert.equal(j.stage, "done");
  assert.equal(j.kind, "check");
  assert.equal(j.check?.result, "Checked on staging · 2 of 2 pass");
  assert.equal(j.check?.onto, before);
  assert.equal(j.merged, undefined);
  assert.equal(g(r, "rev-parse", "staging"), before, "staging unchanged");
  assert.deepEqual(branches(r), before_br, "no branch made");
  assert.ok(!fs.existsSync(runWorktree(r, `check-${id}`)), "the checkout is gone");
  assert.ok(fs.existsSync(path.join(runDir(r, `check-${id}`), "run.json")), "its run.json stays");
  assert.match(fs.readFileSync(path.join(jobDirOf(r, id), "report.html"), "utf8"), /Checked on staging · 2 of 2 pass/);
  const card = (await snapshot(r)).jobs.find((c) => c.id === id);
  assert.deepEqual(
    [card?.kind, card?.check?.result, card?.check?.findings, card?.check?.proposals, card?.state],
    ["check", "Checked on staging · 2 of 2 pass", 0, [], "done"],
  );
  assert.equal(listProposals(r).length, 0);
});

test("(b) a check with 2 failures: done 'Found 2 problems', 2 proposals linked to the job; Run on one files a normal bug job", async () => {
  const r = await repo();
  const before = g(r, "rev-parse", "staging");
  const { id } = await intake(r, "check renewing and the overdue badge", CHECK(["renew works", "overdue badge shows", "list loads"]));
  const crit = (id: string, result: string, f: string) => ({ id, result, evidence: [f], note: result === "PASS" ? "fine" : "broken" });
  const findings = [
    { title: "Renew returns 500", seen: "POST /loans/4/renew → 500", repro: ["reset", "renew loan 4"], evidence: ["c1.txt"], criterion: "C1" },
    { title: "Overdue badge missing", seen: "no badge on loan 2", repro: "open /loans", evidence: ["c2.png"], criterion: "C2" },
  ];
  const files = { "c1.txt": "500\n", "c2.png": "png", "c3.txt": "ok\n" };
  // Kitchen refuses a FAIL row without its finding.
  const { f: refused } = await checkQa(
    r,
    id,
    { verdict: "FAIL", criteria: [crit("C1", "FAIL", "c1.txt"), crit("C2", "FAIL", "c2.png"), crit("C3", "PASS", "c3.txt")], findings: [findings[0]] },
    files,
  );
  assert.match(refused.line, /C2 FAILED with no finding/);
  const { f } = await checkQa(
    r,
    id,
    { verdict: "FAIL", criteria: [crit("C1", "FAIL", "c1.txt"), crit("C2", "FAIL", "c2.png"), crit("C3", "PASS", "c3.txt")], findings },
    files,
  );
  assert.match(f.line, /Found 2 problems · proposed p1, p2 in the inbox → done/);
  const j = findJob(r, id);
  assert.deepEqual(
    [j.stage, j.check?.result, j.check?.findings, j.check?.pass, j.check?.total, j.check?.proposals],
    ["done", "Found 2 problems", 2, 1, 3, ["p1", "p2"]],
  );
  assert.equal(g(r, "rev-parse", "staging"), before);
  const items = listItems(r);
  assert.deepEqual(
    items.map((i) => [i.key, i.src.source, i.src.job, i.src.label]),
    [
      [`kitchen:${id}:check:1.1`, "kitchen", id, `Check ${id.slice(0, 3)}`],
      [`kitchen:${id}:check:1.2`, "kitchen", id, `Check ${id.slice(0, 3)}`],
    ],
  );
  const p1 = getProposal(r, "p1");
  assert.deepEqual(
    [p1.title, p1.kind, p1.state, p1.items, p1.ev?.steps, p1.ev?.sha],
    ["Renew returns 500", "bug", "open", [items[0].id], ["reset", "renew loan 4"], before.slice(0, 12)],
  );
  assert.ok(p1.ev?.files?.[0] && fs.existsSync(path.join(r, ".kitchen", "inbox", p1.ev.files[0])), "the evidence is kept with the item");
  assert.match(getProposal(r, "p2").ev?.shot ?? "", /c2\.png$/);
  // Finishing again adds nothing twice.
  const card = (await snapshot(r)).jobs.find((c) => c.id === id);
  assert.deepEqual([card?.check?.result, card?.check?.findings, card?.check?.proposals], ["Found 2 problems", 2, ["p1", "p2"]]);
  // Run on one: a normal job at intake, linked back to the check.
  const [made] = await runProposals(r, ["p1"]);
  const bug = findJob(r, made.job);
  assert.deepEqual([bug.stage, bug.from?.source, bug.from?.ref, bug.from?.proposal, bug.check], ["intake", "kitchen", id, "p1", undefined]);
  assert.match(fs.readFileSync(path.join(jobDirOf(r, bug.id), "ticket.md"), "utf8"), /POST \/loans\/4\/renew → 500/);
  await open(r, bug.id, "intake");
  fs.writeFileSync(intakeFile(jobDirOf(r, bug.id)), "DECISION: ACCEPT\nKIND: bug\nRISK: low\n\n- C1 (cmd): renew works\n");
  assert.match((await fin(r, bug.id)).line, /intake ACCEPT bug low: 1 criteria → build/, "the fix is a normal job");
});

const FEATURE = `# App file

What the app file shows.

## Sub-features

- \`app-lines\` the file has its three lines.

## How to get to it (user POV)

- \`app.txt\` in the checkout.

## Driving it with kitchen qa

Preconditions:

- The checkout of staging.

- **Lines.** Read app.txt. Run \`wc -l app.txt\`. 3 lines.

## Gotchas

- None.

Code: \`app.txt\`
`;

test("(c) an exploring check with findings: time-boxed brief, the finding proposed, the recipe it kept added to the map", async () => {
  const r = await repo();
  const { id, f } = await intake(r, "try the app and see what breaks", "DECISION: ACCEPT\nTITLE: Explore the app\nKIND: check\nEXPLORE: 15\nREASON: explore\n");
  assert.match(f.line, /intake ACCEPT check \(explore 15 min\): 0 criteria → qa/);
  assert.equal(findJob(r, id).check?.explore, 15);
  const { s, f: done } = await checkQa(
    r,
    id,
    {
      verdict: "FAIL",
      criteria: [],
      findings: [{ title: "Line three is lowercase", seen: "three, not Three", repro: ["cat app.txt"], evidence: ["cat.txt"] }],
    },
    { "cat.txt": "one\ntwo\nthree\n", "map/app-file.md": FEATURE },
  );
  assert.match(fs.readFileSync(s.brief, "utf8"), /for at most 15 minutes/);
  assert.match(done.line, /Found 1 problem · proposed p1 in the inbox · map app-file\.md merged into staging/);
  const j = findJob(r, id);
  assert.equal(j.check?.result, "Found 1 problem");
  assert.match(
    g(
      r,
      "show",
      "staging:.claude/skills/" +
        g(r, "ls-tree", "-r", "--name-only", "staging")
          .split("\n")
          .find((p) => p.endsWith("features/app-file.md"))
          ?.split("/")[2] +
        "/features/app-file.md",
    ),
    /# App file/,
  );
  assert.ok(!branches(r).some((b) => b.startsWith("kitchen/")), "the map's branch is gone once merged");
  // A map that can't be admitted never fails the check.
  const { id: id2 } = await intake(r, "explore again", "DECISION: ACCEPT\nKIND: check\nEXPLORE:\n");
  const { f: f2 } = await checkQa(r, id2, { verdict: "PASS", criteria: [], findings: [] }, { "map/bad.md": "# no contract\n" });
  assert.match(f2.line, /Checked on staging · explored 20 min, no problems · map update skipped: map\/bad\.md breaks the feature file contract/);
  assert.equal(findJob(r, id2).stage, "done");
});

test("(d) a check whose app won't start: BLOCKED runs QA again (ADR 0029 §2: every row NOT_RUN), still not run it goes to a person", async () => {
  const r = await repo("round_limit: 2\n");
  const before = g(r, "rev-parse", "staging");
  const { id } = await intake(r, "check the app", CHECK(["app answers"]));
  const blocked = { verdict: "BLOCKED", blocked: "the app won't start: port in use", evidence: ["app.log"] };
  const { f } = await checkQa(r, id, blocked, { "app.log": "EADDRINUSE\n" });
  assert.match(f.line, /QA couldn't test C1 \(the app won't start: port in use\) → qa again on C1 on fresh seed data \(round 2\)/);
  assert.deepEqual([findJob(r, id).stage, findJob(r, id).round], ["qa", 2]);
  const { f: f2 } = await checkQa(r, id, blocked, { "app.log": "EADDRINUSE\n" });
  assert.match(f2.line, /QA still couldn't test C1 \(the app won't start: port in use\) → needs-human/);
  const j = findJob(r, id);
  assert.deepEqual([j.stage, j.escalatedFrom], ["needs-human", "qa"]);
  assert.equal(j.pausedReason, "QA couldn't test C1: the app won't start: port in use");
  assert.equal(listProposals(r).length, 0, "not a problem found");
  assert.equal(g(r, "rev-parse", "staging"), before);
  // The person's answer runs it again in QA, never Build.
  await control.feedback(r, id, "the port is free now", quiet);
  assert.equal(findJob(r, id).stage, "qa");
});

test("(e) a normal feature job is unchanged: intake → build → qa → review → merged", async () => {
  const r = await repo();
  await control.ticket(r, "add a fourth line", quiet);
  const id = lastId(r);
  await open(r, id, "intake");
  fs.writeFileSync(
    intakeFile(jobDirOf(r, id)),
    "DECISION: ACCEPT\nTITLE: Add four\nKIND: feature\nRISK: low\nFILES: app.txt\n\n## Criteria\n- C1 (cmd): app.txt has a fourth line\n",
  );
  assert.match((await fin(r, id)).line, /intake ACCEPT feature low: 1 criteria → build/);
  const b = await open(r, id, "build");
  fs.writeFileSync(path.join(b.cwd, "app.txt"), "one\ntwo\nthree\nfour\n");
  g(b.cwd, "commit", "-qam", "four");
  assert.match((await fin(r, id)).line, /→ qa/);
  await open(r, id, "qa");
  const d = qaDir(jobDirOf(r, id), 1);
  fs.writeFileSync(path.join(d, "c1.txt"), "four\n");
  fs.writeFileSync(
    path.join(d, "verdict.json"),
    JSON.stringify({ verdict: "PASS", criteria: [{ id: "C1", result: "PASS", evidence: ["c1.txt"], note: "x" }] }),
  );
  assert.match((await fin(r, id)).line, /QA PASS \(1 criteria\) → review/);
  await open(r, id, "review");
  fs.writeFileSync(reviewFile(jobDirOf(r, id), 1), JSON.stringify({ summary: "ok", findings: [] }));
  assert.match((await fin(r, id)).line, /merged into staging/);
  const j = findJob(r, id);
  assert.deepEqual([j.stage, j.kind, j.check, j.keep, j.verified], ["done", "feature", undefined, undefined, undefined]);
  const card = (await snapshot(r)).jobs.find((c) => c.id === id);
  assert.deepEqual([card?.kind, card?.check, card?.keep, card?.promotable], ["feature", null, undefined, false]);
});

test("(g) the schedule that files a check: launchd and systemd files written to a temp home, listed, removed", () => {
  const home = path.join(root, "sched-home");
  const repo = path.join(root, "sched-repo");
  fs.mkdirSync(repo);
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
  };
  assert.deepEqual(parseEvery("day"), { minutes: 1440 });
  assert.deepEqual(parseEvery("hour"), { minutes: 60 });
  const text = "check checkout still works";
  const task = { name: "check" as const, text };
  const id = scheduleId(repo, task);
  assert.match(id, /^dev\.kitchen\.check\.[0-9a-f]{10}\.[0-9a-f]{8}$/);
  assert.notEqual(id, scheduleId(repo, { name: "check", text: "another check" }));
  assert.notEqual(id, scheduleId(repo));
  const lines = scheduleCheck(repo, "/k/cli.js", text, "day", { platform: "darwin", home, run, uid: 501 });
  const plist = fs.readFileSync(path.join(home, "Library", "LaunchAgents", `${id}.plist`), "utf8");
  for (const a of argvOf(process.execPath, "/k/cli.js", repo, task)) assert.ok(plist.includes(`<string>${a}</string>`), a);
  assert.deepEqual(argvOf("node", "/k/cli.js", repo, task), ["node", "/k/cli.js", "ticket", "--check", "--repo", path.resolve(repo), text]);
  assert.deepEqual(argvOf("node", "/k/cli.js", repo, task, parseEvery("day")), [
    "node",
    "/k/cli.js",
    "ticket",
    "--check",
    "--repo",
    path.resolve(repo),
    "--from-schedule",
    "day",
    text,
  ]);
  assert.ok(plist.includes("<string>--from-schedule</string>"), "the tick says it came from the schedule");
  assert.match(
    plist,
    /<key>StartCalendarInterval<\/key>\n {2}<array>\n {6}<dict><key>Hour<\/key><integer>0<\/integer><key>Minute<\/key><integer>0<\/integer><\/dict>\n {2}<\/array>/,
  );
  assert.match(plist, /checks\.log/);
  assert.deepEqual(calls.at(-1), ["launchctl", "bootstrap", "gui/501", path.join(home, "Library", "LaunchAgents", `${id}.plist`)]);
  assert.match(lines.join("\n"), /the check "check checkout still works" is filed every day/);
  assert.match(lines.join("\n"), /remove it with: kitchen ticket --check --every off "check checkout still works"/);
  assert.deepEqual(
    listKept(repo).map((k) => [k.id, k.every]),
    [[id, "day"]],
  );
  assert.match(schedulesLines(repo)[0], /^every day {2}check "check checkout still works" {3}remove: kitchen ticket --check --every off/);
  // systemd: the service runs the same command, the timer fires each hour.
  scheduleCheck(repo, "/k/cli.js", text, "hour", { platform: "linux", home, run }, "release");
  const d = path.join(home, ".config", "systemd", "user");
  const service = fs.readFileSync(path.join(d, `${id}.service`), "utf8");
  assert.match(service, /Description=Kitchen check/);
  assert.match(
    service,
    new RegExp(
      `ExecStart=\\S+ /k/cli\\.js ticket --check --repo ${path.resolve(repo).replace(/[.]/g, "\\.")} --into release --from-schedule hour "check checkout still works"`,
    ),
  );
  assert.match(fs.readFileSync(path.join(d, `${id}.timer`), "utf8"), /OnCalendar=\*-\*-\* \*:00:00\nPersistent=true/);
  assert.equal(listKept(repo).length, 1, "the same text replaces its schedule");
  assert.match(scheduleCheck(repo, "/k/cli.js", text, "off", { platform: "linux", home, run })[0], /^removed .*\.timer$/);
  assert.ok(!fs.existsSync(path.join(d, `${id}.timer`)));
  assert.deepEqual(listKept(repo), []);
  assert.match(scheduleCheck(repo, "/k/cli.js", text, "off", { platform: "linux", home, run })[0], /no schedule for the check/);
});

test("(h) KEEP: no ends Done, verified and not merged, its branch kept; promote → review → merged into staging", async () => {
  const r = await repo();
  const before = g(r, "rev-parse", "staging");
  const { id, f } = await intake(
    r,
    "write a harness that proves app.txt has four lines, just to verify",
    "DECISION: ACCEPT\nTITLE: Verify four\nKIND: chore\nKEEP: no\nRISK: low\n\n- C1 (cmd): the harness says 4\n",
  );
  assert.match(f.line, /intake ACCEPT chore low \(KEEP: no\): 1 criteria → build/);
  const b = await open(r, id, "build");
  assert.match(fs.readFileSync(b.brief, "utf8"), /## Built to verify, not kept/);
  fs.writeFileSync(path.join(b.cwd, "harness.sh"), "echo 4\n");
  g(b.cwd, "add", "-A");
  g(b.cwd, "commit", "-qm", "harness");
  await fin(r, id);
  await open(r, id, "qa");
  const d = qaDir(jobDirOf(r, id), 1);
  fs.writeFileSync(path.join(d, "c1.txt"), "4\n");
  fs.writeFileSync(
    path.join(d, "verdict.json"),
    JSON.stringify({ verdict: "PASS", criteria: [{ id: "C1", result: "PASS", evidence: ["c1.txt"], note: "4" }] }),
  );
  assert.match((await fin(r, id)).line, /QA PASS \(1 criteria\) → done: Verified · not merged/);
  let j = findJob(r, id);
  assert.deepEqual([j.stage, j.keep, j.verified?.words, j.merged], ["done", false, "Verified · not merged", undefined]);
  assert.equal(j.verified?.head, g(r, "rev-parse", j.branch), "the branch stays");
  assert.equal(g(r, "rev-parse", "staging"), before, "staging unchanged");
  assert.match(fs.readFileSync(path.join(jobDirOf(r, id), "report.html"), "utf8"), /Verified · not merged/);
  let card = (await snapshot(r)).jobs.find((c) => c.id === id);
  assert.deepEqual([card?.keep, card?.promotable, card?.verified, card?.state], [false, true, "Verified · not merged", "done"]);
  // The worktree may go; the branch is what promote needs.
  g(r, "worktree", "remove", "--force", j.worktree);
  const said: string[] = [];
  assert.equal(await control.promote(r, id, (l) => said.push(l)), 0);
  assert.match(said[0], /promoted → review/);
  j = findJob(r, id);
  assert.deepEqual([j.stage, j.keep, j.verified, typeof j.promoted], ["review", undefined, undefined, "string"]);
  assert.deepEqual((await next(r)).start, [{ id, lane: "review" }]);
  await open(r, id, "review");
  fs.writeFileSync(reviewFile(jobDirOf(r, id), j.round), JSON.stringify({ summary: "ok", findings: [] }));
  assert.match((await fin(r, id)).line, /review PASS → merged into staging/);
  assert.equal(g(r, "show", "staging:harness.sh"), "echo 4");
  card = (await snapshot(r)).jobs.find((c) => c.id === id);
  assert.deepEqual([card?.promotable, card?.merged?.into], [false, "staging"]);
  assert.equal(await control.promote(r, id, quiet), 1, "promote only once");
});

test("(i) promote with staging.merge: pr opens a PR (stand-in gh), Kitchen never merges", async () => {
  const r = await repo("forge: { kind: github, repo: o/r }\nstaging: { merge: pr }\n", { origin: true });
  const dir = path.join(root, "gh-i");
  fs.mkdirSync(dir);
  const log = path.join(dir, "calls.jsonl");
  const bin = path.join(dir, "gh");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
if (a[0] === "pr" && a[1] === "create") console.log("https://github.com/o/r/pull/12");
else if (a[0] === "pr" && a[1] === "view") console.log(JSON.stringify({ state: "OPEN", mergedAt: null, mergeCommit: null }));
`,
    { mode: 0o755 },
  );
  process.env.KITCHEN_GH_BIN = bin;
  try {
    const before = g(r, "rev-parse", "staging");
    const { id } = await intake(r, "a one-off harness", "DECISION: ACCEPT\nKIND: chore\nKEEP: no\nRISK: low\n\n- C1 (cmd): it runs\n");
    const b = await open(r, id, "build");
    fs.writeFileSync(path.join(b.cwd, "harness.sh"), "echo ok\n");
    g(b.cwd, "add", "-A");
    g(b.cwd, "commit", "-qm", "harness");
    await fin(r, id);
    await open(r, id, "qa");
    const d = qaDir(jobDirOf(r, id), 1);
    fs.writeFileSync(path.join(d, "c1.txt"), "ok\n");
    fs.writeFileSync(
      path.join(d, "verdict.json"),
      JSON.stringify({ verdict: "PASS", criteria: [{ id: "C1", result: "PASS", evidence: ["c1.txt"], note: "ok" }] }),
    );
    assert.match((await fin(r, id)).line, /Verified · not merged/);
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8").includes('"create"') : false, false, "no PR before promote");
    await control.promote(r, id, quiet);
    await open(r, id, "review");
    fs.writeFileSync(reviewFile(jobDirOf(r, id), findJob(r, id).round), JSON.stringify({ summary: "ok", findings: [] }));
    assert.match((await fin(r, id)).line, /PR #12 into staging .*PR open · waiting for review/);
    const j = findJob(r, id);
    assert.deepEqual([j.stage, j.pr?.state, j.merged], ["ready", "open", undefined]);
    const calls = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    assert.ok(calls.some((c) => c[1] === "create"));
    assert.ok(!calls.some((c) => c[1] === "merge"), "no gh pr merge");
    assert.equal(g(r, "rev-parse", "staging"), before);
  } finally {
    delete process.env.KITCHEN_GH_BIN;
  }
});

test("the plan never sends a check to Build", () => {
  const job = { id: "001-x", stage: "build", kind: "check", check: {}, running: null, base: "", after: [] } as unknown as Parameters<typeof planWave>[0][0];
  const p = planWave([job], { parallel: 2 });
  assert.deepEqual(p.start, []);
  assert.match(p.you[0]?.why ?? "", /a check never builds/);
});

test("ADR 0029 §2 and §6: a NOT_RUN on a check is no proposal; proposals that fail to save are recorded, shown and proposed again once", async () => {
  const r = await repo();
  const { id } = await intake(r, "check two things", CHECK(["app.txt has three lines", "the export works"]));
  // The inbox can't take proposals now.
  const pdir = path.join(r, ".kitchen", "inbox", "proposals");
  fs.mkdirSync(path.dirname(pdir), { recursive: true });
  fs.writeFileSync(pdir, "not a folder");
  const { f } = await checkQa(
    r,
    id,
    {
      verdict: "FAIL",
      criteria: [
        { id: "C1", result: "FAIL", evidence: ["c1.txt"], note: "2 lines" },
        { id: "C2", result: "NOT_RUN", why: "the export service is down", evidence: ["c2.txt"] },
      ],
      findings: [{ title: "app.txt lost a line", seen: "2 lines", repro: ["wc -l app.txt"], evidence: ["c1.txt"], criterion: "C1" }],
    },
    { "c1.txt": "2 app.txt\n", "c2.txt": "503\n" },
  );
  assert.match(f.line, /Found 1 problem · proposals failed: .*ENOTDIR.* \(retried on the next wave\)/);
  const j = findJob(r, id);
  assert.deepEqual([j.stage, j.check?.findings, j.check?.proposals, j.check?.proposalsFailed?.round], ["done", 1, [], 1]);
  const html = fs.readFileSync(path.join(jobDirOf(r, id), "report.html"), "utf8");
  assert.match(html, /<b>Proposals failed<\/b>: <code>ENOTDIR/);
  assert.match(html, /class="st">not tested<\/td><td>the export service is down/);
  assert.match(String((await snapshot(r)).jobs.find((x) => x.id === id)?.check?.proposalsFailed), /ENOTDIR/);
  // Still failing: recorded again, nothing lost.
  await next(r);
  assert.ok(findJob(r, id).check?.proposalsFailed);
  fs.rmSync(pdir);
  await next(r);
  const k = findJob(r, id);
  assert.equal(k.check?.proposalsFailed, undefined);
  assert.equal(k.check?.proposals?.length, 1, "one proposal: the FAIL's, never the NOT_RUN's");
  assert.equal(listProposals(r).length, 1);
  // Idempotent: proposing the same round again finds the same proposal.
  await updateCheck(r, id);
  // A finish and a wave at once: one at a time, and each line said.
  const [a, b] = await Promise.all([next(r), next(r)]);
  assert.deepEqual([...a.proposals, ...b.proposals].filter((l) => /proposed .* \(retried\)/.test(l)).length, 1);
  assert.equal(listProposals(r).length, 1, "never proposed twice");
});

/** Mark the check's proposals failed again, as if the save had been lost after it was made. */
async function updateCheck(r: string, id: string) {
  const f = path.join(jobDirOf(r, id), "job.json");
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.check.proposalsFailed = { error: "lost", round: 1 };
  fs.writeFileSync(f, JSON.stringify(j));
}

test("ADR 0029 §2: an exploring check (no criteria) that says BLOCKED runs again on everything, then says QA couldn't run", async () => {
  const r = await repo("round_limit: 3\n");
  const { id } = await intake(r, "explore the app", "DECISION: ACCEPT\nKIND: check\nEXPLORE: 10\n");
  const blocked = { verdict: "BLOCKED", blocked: "the app won't start", evidence: ["app.log"] };
  const { f } = await checkQa(r, id, blocked, { "app.log": "EADDRINUSE\n" });
  assert.match(f.line, /QA couldn't run \(the app won't start\) → qa again on fresh seed data \(round 2\)$/);
  const { s, f: f2 } = await checkQa(r, id, blocked, { "app.log": "EADDRINUSE\n" });
  assert.match(fs.readFileSync(s.brief, "utf8"), /## QA again\n\nRound 1's QA couldn't run: the app won't start\. [\s\S]*Drive everything/);
  assert.match(f2.line, /QA still couldn't run \(the app won't start\) → needs-human/);
  assert.equal(findJob(r, id).pausedReason, "QA couldn't run: the app won't start");
  assert.equal(await control.resume(r, id, quiet), 0, "Resume runs QA again");
  assert.equal(findJob(r, id).stage, "qa");
});
