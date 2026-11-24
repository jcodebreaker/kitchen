// The orchestrator's verbs on a real git repo: every lane's files in, Kitchen's moves out, and every illegal move
// refused. No agent: each test writes what a lane agent would.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { report, stageLabel } from "../cli/commands.ts";
import { loadConfig } from "../config.ts";
import { readLedger } from "../ledger/append.ts";
import * as control from "./control.ts";
import { finish, next, start } from "./jobs.ts";
import { intakeFile, qaDir, reviewFile } from "./lanes.ts";
import { refine } from "./refine.ts";
import { ensureStaging } from "./staging.ts";
import { findJob, jobDirOf } from "./store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-jobs-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();
const quiet = () => {};
let n = 0;

async function repo(yaml = ""): Promise<string> {
  const r = path.join(root, `r${++n}`);
  fs.mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "app.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(r, "kitchen.yaml"), `checks: [{ name: guard, run: "test ! -e BROKEN" }]\n${yaml}`);
  fs.writeFileSync(path.join(r, ".gitignore"), ".kitchen/\n.worktrees/\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "base");
  await ensureStaging(r, loadConfig(r), quiet);
  return r;
}
const dirOf = (r: string, id: string) => jobDirOf(r, findJob(r, id).id);
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
const INTAKE = (risk = "low", files = "app.txt") =>
  `DECISION: ACCEPT\nTITLE: Add four\nKIND: feature\nRISK: ${risk}\nSURFACES: none\nFILES: ${files}\n\n## Criteria\n- C1 (cmd): app.txt has a fourth line\n`;
async function toBuild(r: string, text = "add a fourth line", intake = INTAKE()) {
  await control.ticket(r, text, quiet);
  const id = findJob(r, String(findJobsCount(r))).id;
  await open(r, id, "intake");
  fs.writeFileSync(intakeFile(dirOf(r, id)), intake);
  await fin(r, id);
  return id;
}
const findJobsCount = (r: string) => fs.readdirSync(path.join(r, ".kitchen", "jobs")).filter((x) => /^\d/.test(x)).length;
async function build(r: string, id: string, content = "one\ntwo\nthree\nfour\n") {
  const s = await open(r, id, "build");
  fs.writeFileSync(path.join(s.cwd, "app.txt"), content);
  g(s.cwd, "commit", "-qam", "four");
  return fin(r, id);
}
async function qa(r: string, id: string, result: "PASS" | "FAIL") {
  await open(r, id, "qa");
  const j = findJob(r, id);
  const d = qaDir(jobDirOf(r, j.id), j.round);
  fs.writeFileSync(path.join(d, "c1.txt"), "four\n");
  fs.writeFileSync(path.join(d, "verdict.json"), JSON.stringify({ verdict: result, criteria: [{ id: "C1", result, evidence: ["c1.txt"], note: "x" }] }));
  return fin(r, id);
}
async function review(r: string, id: string, findings: unknown[] = []) {
  await open(r, id, "review");
  const j = findJob(r, id);
  fs.writeFileSync(reviewFile(jobDirOf(r, j.id), j.round), JSON.stringify({ summary: "ok", findings }));
  return fin(r, id);
}

test("a ticket through every lane merges into staging: main untouched, the Report written, every move in the ledger", async () => {
  const r = await repo();
  const id = await toBuild(r);
  assert.equal(findJob(r, id).stage, "build");
  assert.equal(findJob(r, id).title, "Add four", "intake's title");
  assert.match((await build(r, id)).line, /built \(1 commit\), checks pass → qa/);
  assert.match((await qa(r, id, "PASS")).line, /QA PASS/);
  const done = await review(r, id, [{ id: "F1", blocks: false, why: "fine" }]);
  assert.match(done.line, /merged into staging/);
  const j = findJob(r, id);
  assert.equal(j.stage, "done");
  assert.equal(g(r, "show", "staging:app.txt"), "one\ntwo\nthree\nfour");
  assert.equal(g(r, "show", "main:app.txt"), "one\ntwo\nthree");
  assert.equal(j.merged?.sha, g(r, "rev-parse", "staging"));
  assert.ok(fs.existsSync(path.join(dirOf(r, id), "report.html")));
  assert.match(fs.readFileSync(path.join(dirOf(r, id), "report.html"), "utf8"), /Merged into staging/);
  assert.deepEqual(
    readLedger(r)
      .filter((l) => l.event === "move")
      .map((l) => `${l.stage}→${l.result}`),
    ["intake→build", "build→qa", "qa→review", "review→done"],
  );
  assert.ok(fs.existsSync(path.join(r, ".kitchen", "orchestrator.json")) || next(r).drained);
});

test("refusals: no lane open, the wrong lane, uncommitted work, red checks; three refusals go to a person", async () => {
  const r = await repo();
  const id = await toBuild(r);
  assert.match(String(((await finish(r, id)) as { refused: string }).refused), /no lane open/);
  assert.match(String(((await start(r, id, "qa")) as { refused: string }).refused), /is in build, not qa/);
  const s = await open(r, id, "build");
  assert.match(String(((await start(r, id, "build")) as { refused: string }).refused), /works since/, "one agent per lane");
  fs.writeFileSync(path.join(s.cwd, "app.txt"), "changed\n");
  const f1 = await fin(r, id);
  assert.match(f1.line, /uncommitted changes/);
  assert.equal(findJob(r, id).stage, "build");
  g(s.cwd, "commit", "-qam", "x");
  fs.writeFileSync(path.join(s.cwd, "BROKEN"), "");
  g(s.cwd, "add", "-A");
  g(s.cwd, "commit", "-qm", "broken");
  await open(r, id, "build");
  assert.match((await fin(r, id)).line, /the checks failed: guard/);
  assert.match(fs.readFileSync((await open(r, id, "build")).brief, "utf8"), /This round's checks FAILED \(guard\)/, "the next builder reads why");
  const f3 = await fin(r, id);
  assert.equal(f3.to, "needs-human");
  assert.match(String(findJob(r, id).pausedReason), /build lane failed 3 times/);
});

test("QA FAIL sends the job back for another round with QA's notes in the brief; out of rounds it goes to a person", async () => {
  const r = await repo("round_limit: 2\n");
  const id = await toBuild(r);
  await build(r, id);
  assert.match((await qa(r, id, "FAIL")).line, /→ build \(round 2\)/);
  const b = await open(r, id, "build");
  assert.match(fs.readFileSync(b.brief, "utf8"), /Round 1: QA FAILED[\s\S]*C1: x/);
  fs.writeFileSync(path.join(b.cwd, "app.txt"), "one\ntwo\nthree\nfour!\n");
  g(b.cwd, "commit", "-qam", "again");
  await fin(r, id);
  assert.equal((await qa(r, id, "FAIL")).to, "needs-human");
  await control.feedback(r, id, "try with a capital F", quiet, { to: "build" });
  assert.deepEqual([findJob(r, id).stage, findJob(r, id).roundStart], ["build", 2]);
});

test("high risk, high-risk paths or a big diff stop at Ready for a person: nothing merges", async () => {
  const r = await repo("staging: { max_lines: 3 }\n");
  const hi = await toBuild(r, "auth change", INTAKE("high"));
  await build(r, hi);
  await qa(r, hi, "PASS");
  const f = await review(r, hi);
  assert.equal(f.to, "ready");
  assert.match(String(findJob(r, hi).held), /high risk/);
  const big = await toBuild(r, "big", INTAKE("low"));
  await build(r, big, `${"x\n".repeat(10)}`);
  await qa(r, big, "PASS");
  await review(r, big);
  assert.match(String(findJob(r, big).held), /changed lines, over 3/);
  assert.equal(g(r, "rev-parse", "staging"), g(r, "rev-parse", "main"), "staging never moved");
});

test("a review whose branch moved is refused; a conflict with staging sends the job back to build", async () => {
  const r = await repo();
  const a = await toBuild(r);
  await build(r, a);
  await qa(r, a, "PASS");
  const s = await open(r, a, "review");
  fs.writeFileSync(path.join(s.cwd, "app.txt"), "sneaky\n");
  g(s.cwd, "commit", "-qam", "sneak");
  fs.writeFileSync(reviewFile(dirOf(r, a), 1), JSON.stringify({ findings: [] }));
  assert.match((await fin(r, a)).line, /moved during review/);
  // Staging moves under it (another job merged), touching the same line.
  const wt = path.join(root, `side${n}`);
  g(r, "worktree", "add", "-q", wt, "staging");
  fs.writeFileSync(path.join(wt, "app.txt"), "other\n");
  g(wt, "commit", "-qam", "other");
  g(r, "worktree", "remove", "--force", wt);
  const f = await review(r, a);
  assert.match(f.line, /conflicts with staging in app\.txt → build \(catch-up 1 of 3, no round spent\)/);
  assert.match(fs.readFileSync((await open(r, a, "build")).brief, "utf8"), /the merge into staging failed: it conflicts/);
});

test("two jobs on one file run at once; the one that conflicts is rebuilt on staging as it is now, then merges", async () => {
  const r = await repo();
  const a = await toBuild(r, "add a fourth line");
  const b = await toBuild(r, "shout the third line");
  assert.deepEqual(
    next(r).start.map((s) => [s.id, s.lane]),
    [
      [a, "build"],
      [b, "build"],
    ],
    "both touch app.txt; neither waits",
  );
  await build(r, a);
  await build(r, b, "one\ntwo\nTHREE\n");
  await qa(r, a, "PASS");
  await qa(r, b, "PASS");
  assert.match((await review(r, a)).line, /merged into staging/);
  assert.match((await review(r, b)).line, /conflicts with staging in app\.txt → build \(catch-up 1 of 3, no round spent\)/);
  const reviewed = findJob(r, b).reviewed?.head as string;
  assert.deepEqual([findJob(r, b).round, findJob(r, b).roundStart, findJob(r, b).catchUps], [2, 2, 1], "a catch-up spends no round");
  const tip = g(r, "rev-parse", "staging");
  const s = await open(r, b, "build");
  assert.match(
    fs.readFileSync(s.brief, "utf8"),
    /resolve the merge first[\s\S]*conflicts in app\.txt[\s\S]*A catch-up, not a new round[\s\S]*Change nothing else/,
  );
  assert.equal(findJob(r, b).base, tip, "the round starts from staging's tip");
  assert.match(fs.readFileSync(path.join(s.cwd, "app.txt"), "utf8"), /<<<<<<<[\s\S]*four[\s\S]*>>>>>>>/);
  // A builder that aborts Kitchen's merge is refused: the branch must contain staging.
  g(s.cwd, "merge", "--abort");
  assert.match((await fin(r, b)).line, /doesn't contain staging's/);
  const again = await open(r, b, "build");
  assert.match(fs.readFileSync(again.brief, "utf8"), /conflicts in app\.txt/);
  fs.writeFileSync(path.join(s.cwd, "app.txt"), "one\ntwo\nTHREE\nfour\n");
  g(s.cwd, "add", "app.txt");
  g(s.cwd, "commit", "-q", "--no-edit");
  assert.match((await fin(r, b)).line, /checks pass → qa/);
  assert.match(fs.readFileSync((await open(r, b, "qa")).brief, "utf8"), /Re-drive, don't re-explore/);
  const qd = qaDir(dirOf(r, b), 2);
  fs.writeFileSync(path.join(qd, "c1.txt"), "four\n");
  fs.writeFileSync(
    path.join(qd, "verdict.json"),
    JSON.stringify({ verdict: "PASS", criteria: [{ id: "C1", result: "PASS", evidence: ["c1.txt"], note: "x" }] }),
  );
  await fin(r, b);
  const rb = fs.readFileSync((await open(r, b, "review")).brief, "utf8");
  assert.match(rb, new RegExp(`A catch-up: review what changed since the last review[\\s\\S]*git diff ${reviewed} `));
  fs.writeFileSync(reviewFile(dirOf(r, b), 2), JSON.stringify({ summary: "ok", findings: [] }));
  assert.match((await fin(r, b)).line, /merged into staging/);
  assert.equal(g(r, "show", "staging:app.txt"), "one\ntwo\nTHREE\nfour");
  assert.equal(findJob(r, b).catchUps, undefined, "landing clears the catch-ups");
  const lines: string[] = [];
  report(r, (l) => lines.push(l), { json: true });
  const rep = JSON.parse(lines.join("\n"));
  assert.deepEqual([rep.firstPass, rep.caughtUp, rep.reviewBlocks], [2, 1, 0], "both landed on their first real round; one catch-up");
});

test("a later round with staging moved but no conflict: Kitchen merges staging in and the builder builds on it", async () => {
  const r = await repo();
  const id = await toBuild(r);
  await build(r, id, "one\ntwo\nthree\nfour\n");
  await qa(r, id, "FAIL");
  const wt = path.join(root, `side${n}`);
  g(r, "worktree", "add", "-q", wt, "staging");
  fs.writeFileSync(path.join(wt, "other.txt"), "x\n");
  g(wt, "add", "other.txt");
  g(wt, "commit", "-qm", "other job");
  g(r, "worktree", "remove", "--force", wt);
  const s = await open(r, id, "build");
  assert.match(fs.readFileSync(s.brief, "utf8"), /## staging moved\n\nKitchen merged staging/);
  assert.ok(fs.existsSync(path.join(s.cwd, "other.txt")));
  assert.equal(findJob(r, id).base, g(r, "rev-parse", "staging"));
});

test("staging checked out somewhere: Kitchen won't move it, the job waits at Ready", async () => {
  const r = await repo();
  const id = await toBuild(r);
  await build(r, id);
  await qa(r, id, "PASS");
  g(r, "checkout", "-q", "staging");
  const f = await review(r, id);
  assert.equal(f.to, "ready");
  assert.match(String(findJob(r, id).held), /staging is checked out/);
});

test("steering reaches the next lane; pause parks after the lane; stop drops the lane's result; needs-info and its answer", async () => {
  const r = await repo();
  const id = await toBuild(r);
  await control.steer(r, id, "keep it to one line", quiet);
  const s = await open(r, id, "build");
  assert.match(fs.readFileSync(s.brief, "utf8"), /## Operator notes[\s\S]*> keep it to one line/);
  const m = fs.readFileSync(path.join(dirOf(r, id), "messages.jsonl"), "utf8");
  assert.match(m, /"status":"read","stage":"build","by":"build agent"/);
  assert.equal(await control.pause(r, id, quiet), 0);
  fs.writeFileSync(path.join(s.cwd, "app.txt"), "one\ntwo\nthree\nfour\n");
  g(s.cwd, "commit", "-qam", "four");
  assert.match((await fin(r, id)).line, /then paused, as you asked/);
  assert.deepEqual([findJob(r, id).stage, findJob(r, id).pausedFrom], ["paused", "qa"]);
  await control.resume(r, id, quiet);
  await open(r, id, "qa");
  await control.stop(r, id, quiet);
  assert.match(String(((await finish(r, id)) as { refused: string }).refused), /stopped by the person: this lane's result is dropped/);

  await control.ticket(r, "make it better", quiet);
  const q = findJob(r, "2").id;
  await open(r, q, "intake");
  fs.writeFileSync(intakeFile(dirOf(r, q)), "DECISION: NEEDS-INFO\nQUESTION: Better how?\n");
  assert.equal((await fin(r, q)).to, "needs-info");
  await control.feedback(r, q, "faster", quiet);
  const again = await open(r, q, "intake");
  assert.match(fs.readFileSync(again.brief, "utf8"), /Better how\?[\s\S]*> faster/);
});

test("intake sees the other jobs: accepted ones by criteria and FILES, ones still in intake by their ticket; AFTER from it holds the job, and the builder sees what it builds on", async () => {
  const r = await repo();
  const a = await toBuild(r, "add a fourth line");
  await control.ticket(r, "let people search books by title or author", quiet);
  await control.ticket(r, "on the page show my overdue loans in red and add a search box above the book list", quiet);
  const [b, c] = [findJob(r, "2").id, findJob(r, "3").id];
  await open(r, b, "intake");
  const s = await open(r, c, "intake");
  const text = fs.readFileSync(s.brief, "utf8");
  const section = text.slice(text.indexOf("## Other jobs in the queue"));
  assert.ok(text.includes("## Other jobs in the queue"), text);
  assert.match(section, /- 001 "Add four" · build\n {2}- C1 \(cmd\): app\.txt has a fourth line\n {2}- FILES: app\.txt/);
  assert.match(section, /- 002 "[^"]*" · intake\n {2}- ticket \(intake not accepted yet\): "let people search books by title or author"/);
  assert.doesNotMatch(section.slice(0, section.indexOf("# Role: intake")), /- 003 /, "not itself");
  fs.writeFileSync(intakeFile(dirOf(r, c)), INTAKE("low", "app.txt").replace("FILES: app.txt", "FILES: app.txt\nAFTER: 001"));
  await fin(r, c);
  assert.deepEqual(findJob(r, c).after, ["001"]);
  assert.match(next(r).held.find((h) => h.id === c)?.why ?? "", /waits for 001-.* \(build\): named on its AFTER: line/);
  await build(r, a);
  await qa(r, a, "PASS");
  await review(r, a);
  const bc = fs.readFileSync((await open(r, c, "build")).brief, "utf8");
  assert.match(
    bc,
    /## Jobs this one builds on[\s\S]*- 001 "Add four" · done \(merged into staging, [0-9a-f]{7}\)[\s\S]*its change is in your branch: reuse its code/,
  );
});

const REFINE = (reason = "readings") =>
  `DECISION: REFINE\nTITLE: Overdue loans\nREASON: ${reason}\n\n## Refine\n- A: a red flag on each loan\n- B: a page of overdue loans\n`;

test("ADR 0020: REFINE waits for you marked refine; your refined ticket goes back to intake as your words; the same reason isn't sent back twice", async () => {
  const r = await repo();
  await control.ticket(r, "show overdue loans", quiet);
  const id = findJob(r, "1").id;
  await open(r, id, "intake");
  fs.writeFileSync(intakeFile(dirOf(r, id)), REFINE());
  assert.match((await fin(r, id)).line, /needs-info: refine with you \(readings\)/);
  const j = findJob(r, id);
  assert.equal(j.stage, "needs-info");
  assert.equal(j.waits?.for === "refine" && j.waits.reason, "readings");
  assert.equal(stageLabel(j), "needs-info(refine: readings)");
  assert.equal(await control.approve(r, id, quiet), 1, "approve is only for a confirm job");
  const lines: string[] = [];
  assert.equal(await refine(r, id, (l) => lines.push(l)), 0);
  const brief = fs.readFileSync(path.join(dirOf(r, id), "refine", "brief.md"), "utf8");
  assert.match(brief, /show overdue loans[\s\S]*- A: a red flag on each loan[\s\S]*grill-with-docs[\s\S]*kitchen feedback 001 "<the refined ticket>"/);
  assert.match(lines.join("\n"), /refine brief: .*refine\/brief\.md/);

  await control.feedback(r, id, "Problem: … In: the red flag (A). Out: the page.", quiet);
  const back = findJob(r, id);
  assert.equal(back.stage, "intake");
  assert.equal(back.waits, undefined, "the marker is cleared");
  assert.deepEqual(
    back.refined?.map((x) => x.reason),
    ["readings"],
  );
  assert.equal(await refine(r, id, quiet), 1, "nothing to refine in intake");
  const again = await open(r, id, "intake");
  assert.match(fs.readFileSync(again.brief, "utf8"), /Refine with you \(readings\)[\s\S]*> Problem: … In: the red flag \(A\)/);
  fs.writeFileSync(intakeFile(dirOf(r, id)), REFINE());
  assert.match((await fin(r, id)).line, /already refined this ticket for "readings"/);
  assert.equal(findJob(r, id).stage, "intake");
  await open(r, id, "intake");
  fs.writeFileSync(intakeFile(dirOf(r, id)), INTAKE());
  assert.equal((await fin(r, id)).to, "build");
});

test("ADR 0020 §3: intake.confirm holds an accepted job for your approval; feedback sends it back to intake, approve to build", async () => {
  const r = await repo("intake: { confirm: true }\n");
  await control.ticket(r, "add a fourth line", quiet);
  const id = findJob(r, "1").id;
  await open(r, id, "intake");
  fs.writeFileSync(intakeFile(dirOf(r, id)), INTAKE().replace("\n\n## Criteria", "\nLEFT OUT: a fifth line\n\n## Criteria"));
  assert.match((await fin(r, id)).line, /waits for your approval/);
  assert.equal(findJob(r, id).waits?.for, "confirm");
  assert.match(fs.readFileSync(path.join(dirOf(r, id), "question.md"), "utf8"), /C1 \(cmd\): app\.txt has a fourth line[\s\S]*Left out: a fifth line/);
  assert.equal(await refine(r, id, quiet), 1, "refine is only for a refine job");
  await control.feedback(r, id, "also a fifth line", quiet);
  assert.equal(findJob(r, id).stage, "intake");
  await open(r, id, "intake");
  fs.writeFileSync(intakeFile(dirOf(r, id)), INTAKE());
  await fin(r, id);
  assert.equal(findJob(r, id).stage, "needs-info");
  assert.equal(await control.approve(r, id, quiet), 0);
  const j = findJob(r, id);
  assert.deepEqual([j.stage, j.kind, typeof j.approved], ["build", "feature", "string"]);
  assert.equal(await control.approve(r, id, quiet), 1, "only while it waits");
  assert.match((await build(r, id)).line, /→ qa/);
});
