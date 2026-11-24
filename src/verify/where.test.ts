// ADR 0027 through the orchestrator's verbs, on real git repos with stand-in agents: the skill named from the main
// checkout (never a job's folder), a repo that ignores .claude/ keeping its map on this machine, a skill that isn't
// committed yet staying local until it is, and a map commit that fails never holding back a tested change.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { loadConfig } from "../config.ts";
import * as control from "../engine/control.ts";
import { finish, start } from "../engine/jobs.ts";
import { intakeFile, qaDir, regressDir, reviewFile } from "../engine/lanes.ts";
import { ensureStaging } from "../engine/staging.ts";
import { findJob, jobDirOf } from "../engine/store.ts";
import { init } from "../init/quick.ts";
import { LOCAL_LINE, localSkillDir, settleMap } from "./where.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-where-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();
const quiet = () => {};

/** A repo with no package.json (the skill's name comes from this folder), on main. */
function repo(name: string, ignore = ".kitchen/\n.worktrees/\n"): string {
  const r = path.join(root, name);
  fs.mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "app.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(r, ".gitignore"), ignore);
  fs.writeFileSync(path.join(r, "kitchen.yaml"), "checks: []\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "base");
  return r;
}
async function initIn(r: string): Promise<string[]> {
  const lines: string[] = [];
  assert.equal(await init({ repo: r, skipPreflight: true }, (l) => lines.push(l)), 0, lines.join("\n"));
  g(r, "add", "-A");
  g(r, "commit", "-qm", "kitchen init");
  g(r, "branch", "-f", "staging", "main");
  return lines;
}

const feature = (step = "Exactly one line, two, is printed.") => `# Search

A person finds lines by their text.

## Sub-features

- \`search-match\` finds a line by part of its text.

## How to get to it (user POV)

- \`app.txt\`, read top to bottom.

## Driving it with kitchen qa

Preconditions:

- The app is up.

- **Match.** Look for \`two\`. Run \`grep two app.txt\`. ${step}

## Gotchas

- None yet.

Code: \`app.txt\`
`;

const open = async (r: string, id: string, lane: string) => {
  const s = await start(r, id, lane);
  assert.ok("brief" in s, JSON.stringify(s));
  return s;
};
const fin = async (r: string, id: string) => {
  const f = await finish(r, id);
  assert.ok("line" in f, JSON.stringify(f));
  return f.line;
};
/** intake → build → QA PASS (with map files); returns the QA brief, the QA line and the build's worktree. */
async function upToReview(r: string, text: string, map: Record<string, string>) {
  await control.ticket(r, text, quiet);
  const id = findJob(r, String(fs.readdirSync(path.join(r, ".kitchen", "jobs")).filter((x) => /^\d/.test(x)).length)).id;
  const dir = jobDirOf(r, id);
  const intake = await open(r, id, "intake");
  fs.writeFileSync(
    intakeFile(dir),
    "DECISION: ACCEPT\nTITLE: Change the app\nKIND: feature\nRISK: low\nSURFACES: none\nFILES: app.txt\n\n## Criteria\n- C1 (cmd): app.txt changed\n",
  );
  await fin(r, id);
  const b = await open(r, id, "build");
  fs.appendFileSync(path.join(b.cwd, "app.txt"), `${text}\n`);
  g(b.cwd, "add", "-A");
  g(b.cwd, "commit", "-qm", "build");
  await fin(r, id);
  const q = await open(r, id, "qa");
  const d = qaDir(dir, findJob(r, id).round);
  fs.writeFileSync(path.join(d, "c1.txt"), "ok\n");
  fs.writeFileSync(
    path.join(d, "verdict.json"),
    JSON.stringify({ verdict: "PASS", criteria: [{ id: "C1", result: "PASS", evidence: ["c1.txt"], note: "x" }] }),
  );
  fs.mkdirSync(path.join(d, "map"), { recursive: true });
  for (const [f, t] of Object.entries(map)) fs.writeFileSync(path.join(d, "map", f), t);
  return { id, intakeBrief: fs.readFileSync(intake.brief, "utf8"), qaBrief: fs.readFileSync(q.brief, "utf8"), line: await fin(r, id), wt: b.cwd };
}
/** review → (the merge check's drive, when features are touched) → done. */
async function toDone(r: string, id: string, seeded = false) {
  await open(r, id, "review");
  fs.writeFileSync(reviewFile(jobDirOf(r, id), findJob(r, id).round), JSON.stringify({ summary: "ok", findings: [] }));
  await fin(r, id);
  let drive: string | null = null;
  if (findJob(r, id).stage === "regress") {
    const s = await open(r, id, "regress");
    drive = s.cwd;
    if (seeded) assert.ok(fs.existsSync(path.join(s.cwd, ".claude/skills", `verify-${path.basename(r)}`, "features/search.md")), "the trial merge has the map");
    const d = regressDir(jobDirOf(r, id), findJob(r, id).round);
    fs.writeFileSync(path.join(d, "search.txt"), "drove it\n");
    fs.writeFileSync(path.join(d, "verdict.json"), JSON.stringify({ features: [{ id: "search", result: "PASS", evidence: ["search.txt"], note: "ok" }] }));
    await fin(r, id);
  }
  assert.equal(findJob(r, id).stage, "done");
  return drive;
}

test("(a) no package name, no skill on staging: QA's first map commit names the skill from the main checkout", async () => {
  const r = repo("plain-app");
  await ensureStaging(r, loadConfig(r), quiet);
  const { id, line, wt } = await upToReview(r, "first", { "search.md": feature() });
  assert.match(line, /map search\.md committed/);
  const files = g(r, "show", "--name-only", "--format=", findJob(r, id).branch);
  assert.match(files, /^\.claude\/skills\/verify-plain-app\/features\/search\.md$/m);
  assert.doesNotMatch(files, /verify-0/);
  assert.ok(path.basename(wt) !== "plain-app");
});

test("(b) a repo that ignores .claude/: the map lives on this machine, seeds each checkout, learns from QA, never committed", async () => {
  const r = repo("ignoring-app", ".claude/\n");
  const said = await initIn(r);
  assert.ok(
    said.some((l) => l.includes(LOCAL_LINE)),
    said.join("\n"),
  );
  assert.match(fs.readFileSync(path.join(r, "kitchen.yaml"), "utf8"), /verify:\n\s+skill: verify-ignoring-app\n\s+map: local/);
  const local = localSkillDir(r, "verify-ignoring-app");
  assert.ok(fs.existsSync(path.join(local, "SKILL.md")));
  const one = await upToReview(r, "first", { "search.md": feature() });
  assert.ok(fs.existsSync(path.join(one.wt, ".claude/skills/verify-ignoring-app/SKILL.md")), "the worktree has the skill at the usual path");
  assert.match(one.line, /QA PASS .* map search\.md saved on this machine/);
  assert.ok(fs.existsSync(path.join(local, "features/search.md")), "QA's update is written back");
  assert.equal(g(one.wt, "status", "--porcelain"), "");
  await toDone(r, one.id, true);
  const two = await upToReview(r, "second", {});
  assert.match(two.intakeBrief, /search-match/, "intake sees the map the first job taught");
  assert.match(two.qaBrief, /Exactly one line, two, is printed/, "QA follows the touched feature's recipe");
  assert.match(two.qaBrief, /saves your files to the map on this machine/);
  await toDone(r, two.id, true);
  assert.equal(g(r, "log", "staging", "--name-only", "--format=", "--", ".claude"), "", "nothing under .claude is committed");
});

test("(c) a skill that isn't committed: local until a commit has it, then the repo again", async () => {
  const r = repo("pending-app");
  fs.mkdirSync(path.join(r, ".claude/skills/verify-pending-app/features"), { recursive: true });
  fs.writeFileSync(path.join(r, ".claude/skills/verify-pending-app/SKILL.md"), "---\nname: verify-pending-app\n---\n# Verify\n");
  const lines: string[] = [];
  assert.equal(await init({ repo: r, skipPreflight: true }, (l) => lines.push(l)), 0);
  assert.ok(
    lines.some((l) => l.includes("commit .claude/skills/verify-pending-app so jobs see it")),
    lines.join("\n"),
  );
  assert.equal(loadConfig(r).verify.map, "local");
  g(r, "add", "-A", "--", "kitchen.yaml", ".gitignore");
  g(r, "commit", "-qm", "kitchen");
  g(r, "branch", "-f", "staging", "main");
  const one = await upToReview(r, "first", { "search.md": feature() });
  assert.match(one.qaBrief, new RegExp(`${localSkillDir(r, "verify-pending-app")}/SKILL.md`), "the brief points at the local copy");
  assert.match(one.line, /saved on this machine/);
  assert.equal(g(one.wt, "status", "--porcelain"), "", "nothing copied where a build could commit it");
  // The person commits the skill (with the map the job taught) and brings staging up to it.
  fs.cpSync(path.join(localSkillDir(r, "verify-pending-app"), "features"), path.join(r, ".claude/skills/verify-pending-app/features"), { recursive: true });
  g(r, "add", "-A", "--", ".claude/skills/verify-pending-app");
  g(r, "commit", "-qm", "the verify skill");
  await toDone(r, one.id);
  g(r, "merge", "-q", "--no-edit", "staging");
  g(r, "branch", "-f", "staging", "main");
  const back = await settleMap(r);
  assert.ok(
    back.some((l) => l.includes("is committed now")),
    back.join("\n"),
  );
  assert.equal(loadConfig(r).verify.map, "repo");
  const two = await upToReview(r, "second", { "search.md": feature().replace("- None yet.", "- Case matters.") });
  assert.match(two.line, /map search\.md committed \([0-9a-f]{7}\)/);
});

test("(e) a map commit that fails: the tested change moves on, and the line and the Report say why", async () => {
  const r = repo("hooked-app");
  await ensureStaging(r, loadConfig(r), quiet);
  const hook = path.join(r, ".git/hooks/pre-commit");
  fs.writeFileSync(
    hook,
    "#!/bin/sh\nif git diff --cached --name-only | grep -q '^.claude/skills/verify-'; then echo 'map files are not allowed here' >&2; exit 1; fi\n",
  );
  fs.chmodSync(hook, 0o755);
  const { id, line, wt } = await upToReview(r, "first", { "search.md": feature() });
  assert.match(line, /QA PASS .* map update skipped: git commit failed \(exit 1\): map files are not allowed here → review/);
  assert.equal(findJob(r, id).stage, "review");
  assert.equal(g(wt, "status", "--porcelain"), "", "the worktree is left clean");
  await toDone(r, id);
  const report = fs.readFileSync(path.join(jobDirOf(r, id), "report.html"), "utf8");
  assert.match(report, /map update skipped: git commit failed \(exit 1\): map files are not allowed here/);
});
