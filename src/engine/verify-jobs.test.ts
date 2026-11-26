// ADR 0017 through the orchestrator's verbs, on real git repos with stand-in agents (each test writes what a lane
// agent would): QA's map updates committed by Kitchen, builders kept out of the map, weakening refused unless
// CHANGES: names it, the touched features driven on the trial merge before it lands (red goes back to Build),
// staging moving during that drive, and the re-drive note in later rounds.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { loadConfig } from "../config.ts";
import { writeVerifySkill } from "../verify/skill.ts";
import * as control from "./control.ts";
import { failureOf } from "./diagnose.ts";
import { finish, mergeHeld, start } from "./jobs.ts";
import { intakeFile, parseIntake, qaDir, regressDir, reviewFile } from "./lanes.ts";
import { ensureStaging } from "./staging.ts";
import { findJob, jobDirOf } from "./store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-vjobs-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();
const quiet = () => {};
let n = 0;
const SK = ".claude/skills/verify-demo";

/** A repo whose base carries init's verify skill (empty map), with staging made from it. */
async function repo(): Promise<string> {
  const r = path.join(root, `r${++n}`);
  fs.mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "package.json"), JSON.stringify({ name: "demo" }));
  fs.writeFileSync(path.join(r, "app.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(r, "lib.txt"), "lib\n");
  fs.writeFileSync(path.join(r, "kitchen.yaml"), `checks: [{ name: guard, run: "test ! -e BROKEN" }]\n`);
  fs.writeFileSync(path.join(r, ".gitignore"), ".kitchen/\n.worktrees/\n");
  writeVerifySkill(r, loadConfig(r));
  g(r, "add", "-A");
  g(r, "commit", "-qm", "base");
  await ensureStaging(r, loadConfig(r), quiet);
  return r;
}

const feature = (o: { code?: string; expect?: string; clear?: boolean } = {}) => `# Search

A person finds lines by their text.

## Sub-features

- \`search-match\` finds a line by part of its text.
${o.clear === false ? "" : "- `search-clear` shows every line again.\n"}
## How to get to it (user POV)

- \`app.txt\`, read top to bottom.

## Driving it with kitchen qa

Preconditions:

- The app is up.

- **Match.** Look for \`two\`. Run \`grep two app.txt\`. ${o.expect ?? "Exactly one line, two, is printed."}
${o.clear === false ? "" : "- **Clear.** Show it all (`search-clear`). Run `cat app.txt`. Every line is printed.\n"}
## Gotchas

- None yet.

Code: \`${o.code ?? "app.txt"}\`
`;

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
const INTAKE = (extra = "") =>
  `DECISION: ACCEPT\nTITLE: Change the app\nKIND: feature\nRISK: low\nSURFACES: none\nFILES: app.txt\n${extra}\n## Criteria\n- C1 (cmd): app.txt changed\n`;
async function toBuild(r: string, text: string, intake = INTAKE()) {
  await control.ticket(r, text, quiet);
  const id = findJob(r, String(fs.readdirSync(path.join(r, ".kitchen", "jobs")).filter((x) => /^\d/.test(x)).length)).id;
  await open(r, id, "intake");
  fs.writeFileSync(intakeFile(dirOf(r, id)), intake);
  await fin(r, id);
  return id;
}
async function build(r: string, id: string, files: Record<string, string>) {
  const s = await open(r, id, "build");
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(s.cwd, f)), { recursive: true });
    fs.writeFileSync(path.join(s.cwd, f), t);
  }
  g(s.cwd, "add", "-A");
  g(s.cwd, "commit", "-qm", "build");
  return fin(r, id);
}
async function qa(r: string, id: string, map: Record<string, string> = {}, result: "PASS" | "FAIL" = "PASS", extra: object[] = []) {
  const s = await open(r, id, "qa");
  const j = findJob(r, id);
  const d = qaDir(jobDirOf(r, j.id), j.round);
  fs.writeFileSync(path.join(d, "c1.txt"), "ok\n");
  fs.writeFileSync(
    path.join(d, "verdict.json"),
    JSON.stringify({ verdict: result, criteria: [{ id: "C1", result, evidence: ["c1.txt"], note: "x" }, ...extra] }),
  );
  if (Object.keys(map).length) fs.mkdirSync(path.join(d, "map"), { recursive: true });
  for (const [f, t] of Object.entries(map)) fs.writeFileSync(path.join(d, "map", f), t);
  return { brief: fs.readFileSync(s.brief, "utf8"), f: await finish(r, id) };
}
async function review(r: string, id: string) {
  await open(r, id, "review");
  const j = findJob(r, id);
  fs.writeFileSync(reviewFile(jobDirOf(r, j.id), j.round), JSON.stringify({ summary: "ok", findings: [] }));
  return fin(r, id);
}
async function regress(r: string, id: string, rows: { id: string; result: "PASS" | "FAIL"; note?: string }[]) {
  const s = await open(r, id, "regress");
  const j = findJob(r, id);
  const d = regressDir(jobDirOf(r, j.id), j.round);
  for (const x of rows) fs.writeFileSync(path.join(d, `${x.id}.txt`), "drove it\n");
  fs.writeFileSync(
    path.join(d, "verdict.json"),
    JSON.stringify({ features: rows.map((x) => ({ id: x.id, result: x.result, evidence: [`${x.id}.txt`], note: x.note ?? "every step" })) }),
  );
  return { brief: fs.readFileSync(s.brief, "utf8"), cwd: s.cwd, f: await fin(r, id) };
}

/** Job 1 adds the search feature to the map and merges (with its own drive on the trial merge). */
async function withSearch(r: string) {
  const id = await toBuild(r, "let people search");
  await build(r, id, { "app.txt": "one\ntwo\nthree\nfour\n" });
  await qa(r, id, { "search.md": feature(), "README.md": "# demo feature map\n\n## Features\n\n- [Search](./search.md): find lines\n" });
  await review(r, id);
  await regress(r, id, [{ id: "search", result: "PASS" }]);
  assert.equal(findJob(r, id).stage, "done");
  return id;
}

test("QA's map update becomes a Kitchen commit on the job branch, in both tools' copies; the merge drives the feature it touches first", async () => {
  const r = await repo();
  const id = await toBuild(r, "let people search");
  await build(r, id, { "app.txt": "one\ntwo\nthree\nfour\n" });
  const q = await qa(r, id, { "search.md": feature(), "README.md": "# demo feature map\n\n## Features\n\n- [Search](./search.md): find lines\n" });
  assert.match(q.brief, /## The verify map \(how to check this app; you keep it current\)/);
  assert.match(q.brief, /### The index \(features\/README\.md\)[\s\S]*# demo feature map/);
  assert.match(q.brief, /\*\*Map updates go in `[^`]*rounds\/1\/qa\/map\/`\*\*/);
  assert.ok("line" in q.f);
  assert.match(q.f.line, /QA PASS \(1 criteria\) · map README\.md, search\.md committed \([0-9a-f]{7}\) → review/);
  const j = findJob(r, id);
  const head = g(r, "rev-parse", j.branch);
  assert.deepEqual(j.mapCommits, [head]);
  assert.equal(g(r, "log", "-1", "--format=%an", j.branch), "Kitchen");
  assert.equal(g(r, "show", `${j.branch}:${SK}/features/search.md`), feature().trim());
  assert.equal(g(r, "show", `${j.branch}:.agents/skills/verify-demo/features/search.md`), feature().trim(), "the Codex copy too");
  // Review passes: the merged result changes app.txt, which search's Code: covers, so Kitchen opens a regress lane.
  const rv = await review(r, id);
  assert.equal(rv.to, "regress");
  assert.match(rv.line, /review PASS → regress: drive search on staging with this job merged/);
  assert.equal(g(r, "rev-parse", "staging"), g(r, "rev-parse", "main"), "nothing landed yet");
  const drive = findJob(r, id).drive;
  assert.deepEqual(drive?.features, ["search"]);
  const rg = await regress(r, id, [{ id: "search", result: "PASS" }]);
  assert.match(rg.brief, /# Kitchen regress lane[\s\S]*The merged result \(drive it, change nothing\)/);
  assert.match(rg.brief, /## The features to drive \(search\)[\s\S]*\*\*Match\.\*\*/);
  assert.match(rg.brief, /# Role: merge check \(regress\)/);
  assert.equal(rg.cwd, drive?.wt);
  assert.match(rg.f.line, /regress PASS \(search\) → merged into staging/);
  assert.equal(g(r, "rev-parse", "staging"), drive?.sha, "the exact merge that was driven lands");
  assert.equal(g(r, "show", `staging:${SK}/features/search.md`), feature().trim());
  assert.ok(!fs.existsSync(drive?.wt as string), "the trial worktree is gone");
  assert.equal(g(r, "for-each-ref", "refs/kitchen/"), "", "and its ref");
  assert.match(fs.readFileSync(path.join(dirOf(r, id), "report.html"), "utf8"), /Features driven before the merge \(round 1\)[\s\S]*search/);
});

test("a builder that edits the verify skill is refused; a feature file that breaks the contract is refused", async () => {
  const r = await repo();
  const id = await toBuild(r, "change it");
  const f = await build(r, id, { "app.txt": "x\n", [`${SK}/features/sneaky.md`]: "# x\n" });
  assert.match(f.line, /the build changed the verify skill \(\.claude\/skills\/verify-demo\/features\/sneaky\.md\): builders never edit verify-\*\//);
  // Putting it back (a new commit) is enough.
  const s = await open(r, id, "build");
  g(s.cwd, "rm", "-q", `${SK}/features/sneaky.md`);
  g(s.cwd, "commit", "-qm", "put it back");
  assert.match((await fin(r, id)).line, /checks pass → qa/);
  const q = await qa(r, id, { "search.md": feature().replace("## Gotchas", "## Notes") });
  assert.ok("line" in q.f);
  assert.match(q.f.line, /qa again \(try 2 of 3\): QA's map update: map\/search\.md breaks the feature file contract: it needs exactly four H2s/);
  assert.equal(findJob(r, id).stage, "qa");
});

test("a map update that weakens an earlier check is refused unless intake's CHANGES: names it; the Report shows the change", async () => {
  const r = await repo();
  await withSearch(r);
  // Job 2 touches lib.txt only: no feature is touched, so it merges without a drive.
  const plain = await toBuild(r, "tidy lib");
  await build(r, plain, { "lib.txt": "lib!\n" });
  await qa(r, plain);
  assert.match((await review(r, plain)).line, /review PASS → merged into staging/);

  const weak = await toBuild(r, "only exact matches");
  await build(r, weak, { "app.txt": "one\ntwo\nthree\nfour\nfive\n" });
  const q1 = await qa(r, weak, { "search.md": feature({ expect: "Some lines are printed.", clear: false }) });
  assert.ok("line" in q1.f);
  assert.match(
    q1.f.line,
    /weakens an earlier check that intake's CHANGES: line doesn't name: sub-feature search\/search-clear removed; expected result of search: Match \(was "Exactly one line, two, is printed", now "Some lines are printed"\); recipe step search: Clear removed/,
  );
  // The next QA reads why.
  const q2 = await qa(r, weak, { "search.md": feature() });
  assert.match(q2.brief, /## Kitchen refused the last try[\s\S]*weakens an earlier check/);
  assert.match(q2.brief, /Intake named no CHANGES/);

  const meant = await toBuild(
    r,
    "drop the show-all view; search shows one line",
    INTAKE("CHANGES: search/search-clear, search/search-match\nLEFT OUT: nothing\n"),
  );
  assert.deepEqual((parseIntake(fs.readFileSync(intakeFile(dirOf(r, meant)), "utf8")) as { changes: string[] }).changes, [
    "search/search-clear",
    "search/search-match",
  ]);
  await build(r, meant, { "app.txt": "two\n" });
  const q3 = await qa(r, meant, { "search.md": feature({ expect: "The one line, two, is printed.", clear: false }) });
  assert.match(q3.brief, /Intake's CHANGES: search\/search-clear, search\/search-match/);
  assert.ok("line" in q3.f);
  assert.match(q3.f.line, /QA PASS .* map search\.md committed/);
  await review(r, meant);
  await regress(r, meant, [{ id: "search", result: "PASS" }]);
  const rep = fs.readFileSync(path.join(dirOf(r, meant), "report.html"), "utf8");
  assert.match(rep, /Changed earlier check \(search\/search-clear\): search\/search-clear: was “`search-clear` shows every line again\.”, now removed/);
  assert.match(
    rep,
    /Changed earlier check \(search\/search-clear\): search: Match: was “Exactly one line, two, is printed”, now “The one line, two, is printed”/,
  );
});

test("ADR 0035: a recipe that fails in QA, with every criterion passing, goes on to Review; the Report lists it; a criterion's FAIL is Build", async () => {
  const r = await repo();
  await withSearch(r);
  const id = await toBuild(r, "sort the lines");
  await build(r, id, { "app.txt": "four\none\nthree\ntwo\n" });
  const d = qaDir(dirOf(r, id), 1);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "search.txt"), "grep two printed nothing\n");
  const q = await qa(r, id, {}, "PASS", [{ id: "R-search/search-match", result: "FAIL", evidence: ["search.txt"], note: "Match: grep two printed nothing" }]);
  assert.ok("line" in q.f);
  assert.match(q.f.line, /QA PASS .*→ review/);
  await review(r, id);
  await regress(r, id, [{ id: "search", result: "PASS" }]);
  assert.equal(findJob(r, id).stage, "done");
  const rep = fs.readFileSync(path.join(dirOf(r, id), "report.html"), "utf8");
  assert.match(rep, /Recipes that didn't hold \(not this ticket's\)[\s\S]*R-SEARCH\/SEARCH-MATCH[\s\S]*Match: grep two printed nothing[\s\S]*search\.txt/);

  const red = await toBuild(r, "add six");
  await build(r, red, { "app.txt": "one\ntwo\nthree\nfour\nsix\n" });
  const f = await qa(r, red, {}, "FAIL");
  assert.ok("line" in f.f);
  assert.match(f.f.line, /QA FAIL C1 → build \(round 2\)/);
});

test("ADR 0035: a red drive on the merged result holds the job at Ready; Ask for changes sends it to Build, Merge merges it", async () => {
  const r = await repo();
  await withSearch(r);
  const id = await toBuild(r, "sort the lines");
  const intakeBrief = fs.readFileSync(path.join(dirOf(r, id), "rounds", "1", `brief-intake-m0.md`), "utf8");
  assert.match(intakeBrief, /## The verify map's features[\s\S]*- search: Search · sub-features search-match, search-clear · Code: app\.txt/);
  await build(r, id, { "app.txt": "four\none\nthree\ntwo\n" });
  const q = await qa(r, id);
  assert.match(q.brief, /### Features this job touches \(their `Code:` covers its files\): follow these recipes[\s\S]*### search/);
  assert.equal((await review(r, id)).to, "regress");
  const red = await regress(r, id, [{ id: "search", result: "FAIL", note: "Match: grep two printed nothing" }]);
  assert.ok("line" in red.f);
  assert.match(red.f.line, /regress FAIL: the merge check saw search fail: Match: grep two printed nothing → ready/);
  const held = findJob(r, id);
  assert.deepEqual([held.stage, held.held], ["ready", "the merge check saw search fail: Match: grep two printed nothing"]);
  assert.equal(failureOf(dirOf(r, id), held)?.next, "Merge it, or Ask for changes");
  assert.equal(held.drive, undefined);
  assert.equal(g(r, "for-each-ref", "refs/kitchen/"), "");
  assert.equal(await control.feedback(r, id, "make search find two again", quiet), 0);
  assert.equal(findJob(r, id).stage, "build");
  const b = await open(r, id, "build");
  assert.match(
    fs.readFileSync(b.brief, "utf8"),
    /Round 1: before the merge, Kitchen drove the features your change touches[\s\S]*- search: Match: grep two printed nothing \(search\.txt\)/,
  );
  fs.writeFileSync(path.join(b.cwd, "app.txt"), "four\none\nthree\ntwo\nfixed\n");
  g(b.cwd, "commit", "-qam", "fix");
  await fin(r, id);
  const q2 = await qa(r, id);
  assert.match(q2.brief, /## Re-drive, don't re-explore\n\nRound 1's QA passed these same criteria/);
  await review(r, id);
  await regress(r, id, [{ id: "search", result: "FAIL", note: "Match: still nothing" }]);
  assert.equal(findJob(r, id).stage, "ready");
  const m = await mergeHeld(r, id);
  assert.ok("line" in m, JSON.stringify(m));
  assert.match(m.line, /you said merge → merged into staging/);
  assert.deepEqual([findJob(r, id).stage, findJob(r, id).mergedBy], ["done", "person"]);
});

test("staging moves while the features are driven: Kitchen merges again and the lane drives the new merge", async () => {
  const r = await repo();
  await withSearch(r);
  const id = await toBuild(r, "add five");
  await build(r, id, { "app.txt": "one\ntwo\nthree\nfour\nfive\n" });
  await qa(r, id);
  await review(r, id);
  const first = findJob(r, id).drive;
  // Another job lands on staging meanwhile.
  const wt = path.join(root, `side${n}`);
  g(r, "worktree", "add", "-q", wt, "staging");
  fs.writeFileSync(path.join(wt, "lib.txt"), "other\n");
  g(wt, "commit", "-qam", "other job");
  g(r, "worktree", "remove", "--force", wt);
  const moved = await regress(r, id, [{ id: "search", result: "PASS" }]);
  assert.ok("line" in moved.f);
  assert.equal(moved.f.to, null);
  assert.match(moved.f.line, /regress PASS, but staging moved meanwhile: drive search again on the new merge/);
  const second = findJob(r, id).drive;
  assert.equal(findJob(r, id).stage, "regress");
  assert.notEqual(second?.onto, first?.onto);
  const again = await regress(r, id, [{ id: "search", result: "PASS" }]);
  assert.ok("line" in again.f);
  assert.match(again.f.line, /merged into staging/);
  assert.equal(g(r, "show", "staging:lib.txt"), "other");
  assert.equal(g(r, "show", "staging:app.txt"), "one\ntwo\nthree\nfour\nfive");
});
