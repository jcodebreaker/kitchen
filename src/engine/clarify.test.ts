// The clarification thread (clarify.ts): intake's question and the author's answer reach the next
// intake's prompt inside the ticket, whether the answer came from `kitchen feedback` (a prompt ticket)
// or an issue comment (the runner's needs-info check); a third NEEDS-INFO goes to a person. Fake adapter only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { FakeAdapter } from "../agents/fake.ts";
import { feedback } from "../cli/commands.ts";
import { parseConfig } from "../config.ts";
import { clarificationsSection, readRounds, recordAnswers } from "./clarify.ts";
import { checkWaits, moveJob } from "./runner.ts";
import { intake } from "./stages/intake.ts";
import type { StageContext } from "./stages/types.ts";
import { createJob, jobDirOf, readJobAt } from "./store.ts";

let root: string;
const prevHome = process.env.KITCHEN_HOME;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-clarify-"));
  process.env.KITCHEN_HOME = path.join(root, "home");
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.KITCHEN_HOME;
  else process.env.KITCHEN_HOME = prevHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8" }).trim();

async function setup(name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const { job } = await createJob(dir, {
    title: "add a minimal UI",
    ticket: { source: "prompt", id: "p" },
    body: "can you add a minimalistic UI connected to the API",
    roundLimit: 3,
    base: git(dir, "rev-parse", "HEAD"),
  });
  return { dir, id: job.id, jobDir: jobDirOf(dir, job.id) };
}

const NEEDS = (q: string) => `DECISION: NEEDS-INFO\nKIND: feature\nRISK: medium\nSURFACES: ui\nQUESTION: ${q}\nREASON: no screens named\n`;
const Q1 = "Which screens and actions should the first version have?";

/** One intake run on the job as it is on disk; the move it proposes is made like the runner makes it. */
async function runIntake(dir: string, id: string, agent: FakeAdapter, asked: string[]) {
  const jobDir = jobDirOf(dir, id);
  const job = readJobAt(jobDir);
  const ctx: StageContext = {
    repo: dir,
    job,
    jobDir,
    config: parseConfig("agent: { tool: fake }\n"),
    agent,
    forge: {} as StageContext["forge"],
    source: { kind: "prompt", ask: async (_j: unknown, o: { text: string }) => void asked.push(o.text) } as unknown as StageContext["source"],
    now: () => new Date(),
    log: () => {},
    refresh: () => readJobAt(jobDir),
    holdsLock: () => true,
  };
  const p = await intake(ctx);
  await moveJob(dir, job, p, () => {});
  return { proposal: p, job: readJobAt(jobDir) };
}

test("the author's answer reaches the next intake inside the ticket, paired with its question, and the job goes on", async () => {
  const { dir, id, jobDir } = await setup("answered");
  const asked: string[] = [];
  const agent = new FakeAdapter((req) =>
    req.prompt.includes("The author answered:") ? { file: "DECISION: REJECT\nREASON: test stop\n", line: "decided" } : { file: NEEDS(Q1), line: "asks" },
  );
  const a = await runIntake(dir, id, agent, asked);
  assert.equal(a.job.stage, "needs-info");
  assert.deepEqual(asked, [Q1]);
  assert.equal(await feedback(dir, id, "all of these", () => {}), 0);
  assert.equal(readJobAt(jobDir).stage, "intake");
  const b = await runIntake(dir, id, agent, asked);
  const prompt = agent.calls[1].prompt;
  // Inside the ticket's fence: the same trust as the ticket text.
  const fence = /<<<TICKET-(\w+)\n([\s\S]*?)\nTICKET-\1>>>/.exec(prompt);
  assert.ok(fence, "the ticket is fenced");
  assert.match(fence[2], /## Clarifications/);
  assert.match(fence[2], /> Which screens and actions should the first version have\?\n\nThe author answered:\n> all of these/);
  assert.equal(b.job.stage, "rejected", "the second intake decided instead of asking again");
  assert.deepEqual(asked, [Q1], "asked once");
});

test("after two questions a third NEEDS-INFO goes to a person (needs-human), not the author; their answer joins the thread", async () => {
  const { dir, id, jobDir } = await setup("loop");
  const asked: string[] = [];
  const agent = new FakeAdapter((_r, n) => ({ file: NEEDS(`question ${n}?`), line: "asks" }));
  for (const answer of ["yes all of these", "all of these"]) {
    assert.equal((await runIntake(dir, id, agent, asked)).job.stage, "needs-info");
    assert.equal(await feedback(dir, id, answer, () => {}), 0);
  }
  const third = await runIntake(dir, id, agent, asked);
  assert.equal(third.job.stage, "needs-human");
  assert.match(third.job.pausedReason ?? "", /^info-limit: intake asked the author 2 questions .* It asks: question 3\?/);
  assert.deepEqual(asked, ["question 1?", "question 2?"], "the third question is not posted to the author");
  assert.deepEqual(
    readRounds(jobDir).map((r) => [r.question, r.answers]),
    [
      ["question 1?", ["yes all of these"]],
      ["question 2?", ["all of these"]],
      ["question 3?", []],
    ],
  );
  // The person answers on needs-human: back to intake, with the answer under the third question.
  assert.equal(await feedback(dir, id, "browse and borrow only", () => {}), 0);
  assert.equal(readJobAt(jobDir).stage, "intake");
  assert.deepEqual(readRounds(jobDir).at(-1)?.answers, ["browse and borrow only"]);
  await runIntake(dir, id, agent, asked);
  assert.match(agent.calls[3].prompt, /> question 3\?\n\nThe author answered:\n> browse and borrow only/);
});

test("an issue comment answers through the runner's needs-info check, recorded once however often it is read", async () => {
  const { dir, id, jobDir } = await setup("github");
  const asked: string[] = [];
  const agent = new FakeAdapter(() => ({ file: NEEDS(Q1), line: "asks" }));
  await runIntake(dir, id, agent, asked);
  const d = { config: parseConfig("agent: { tool: fake }\n"), forge: {} as StageContext["forge"] };
  const source = { kind: "github", replies: async () => ["browse and borrow, please"] } as unknown as StageContext["source"];
  recordAnswers(jobDir, ["browse and borrow, please"], { replace: true }); // an earlier read whose move didn't happen
  await checkWaits(
    dir,
    { ...d, source },
    () => {},
    () => true,
  );
  assert.equal(readJobAt(jobDir).stage, "intake");
  assert.deepEqual(readRounds(jobDir)[0].answers, ["browse and borrow, please"]);
});

test("a job from before the thread file reads its question.md and replies/ as one answered round", () => {
  const jobDir = fs.mkdtempSync(path.join(root, "legacy-"));
  fs.writeFileSync(path.join(jobDir, "question.md"), `<!-- ask/m4 -->\n${Q1}\n`);
  fs.mkdirSync(path.join(jobDir, "replies"));
  fs.writeFileSync(path.join(jobDir, "replies", "2026-11-23T01-34-59-012Z.md"), "see the books with copies available\n");
  fs.writeFileSync(path.join(jobDir, "replies", "2026-11-23T01-36-05-642Z.md"), "yes all of these\n");
  const rounds = readRounds(jobDir);
  assert.deepEqual(
    rounds.map((r) => [r.key, r.question, r.answers]),
    [["ask/m4", Q1, ["see the books with copies available", "yes all of these"]]],
  );
  assert.match(
    clarificationsSection(rounds),
    /### Question 1\n> Which screens.*\n\nThe author answered:\n> see the books with copies available\n\n> yes all of these/,
  );
});
