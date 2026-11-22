// ADR 0009: kitchen steer / pause / stop / resume as engine functions, and how a steer reaches an agent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { FakeAdapter } from "../agents/fake.ts";
import { resume, statusLine } from "../cli/commands.ts";
import { parseConfig } from "../config.ts";
import { processStart } from "../lock.ts";
import { groupAlive, procsDirOf } from "../procs.ts";
import { honorControl, pause, readControl, steer, stop } from "./control.ts";
import { MAX_MESSAGE, readMessages } from "./messages.ts";
import { runRole } from "./stages/role.ts";
import type { StageContext } from "./stages/types.ts";
import { createJob, jobDirOf, readJobAt, updateJob } from "./store.ts";

let repo = "";
const saved = process.env.KITCHEN_HOME;
const lines: string[] = [];
const out = (l: string) => lines.push(l);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-control-"));
  process.env.KITCHEN_HOME = path.join(repo, ".home");
  lines.length = 0;
});
afterEach(() => {
  process.env.KITCHEN_HOME = saved;
  fs.rmSync(repo, { recursive: true, force: true });
});

async function job(stage: "build" | "needs-info" | "done" = "build") {
  const { job } = await createJob(repo, { title: "Show the open count", ticket: { source: "prompt", id: "p1" }, body: "x", roundLimit: 3, base: "" });
  return updateJob(repo, job.id, (j) => {
    j.stage = stage;
    return j;
  });
}

test("steer: a message on the job's thread, sent until an agent reads it; refused when it can't be steered", async () => {
  const j = await job();
  assert.equal((await steer(repo, "1", "  keep the diff small  ", out)).code, 0);
  const [m] = readMessages(jobDirOf(repo, j.id));
  assert.deepEqual([m.kind, m.text, m.status, m.stage, m.who], ["steer", "keep the diff small", "sent", "build", "you"]);
  assert.equal((await steer(repo, "1", "   ", out)).code, 1, "empty");
  assert.equal((await steer(repo, "1", "x".repeat(MAX_MESSAGE + 1), out)).code, 1, "over the cap");
  await updateJob(repo, j.id, (x) => ({ ...x, stage: "needs-info" }));
  assert.equal((await steer(repo, "1", "hi", out)).code, 1, "a job that needs you takes an answer");
  await updateJob(repo, j.id, (x) => ({ ...x, stage: "done" }));
  assert.equal((await steer(repo, "1", "hi", out)).code, 1, "a done job takes a follow-up");
  assert.equal(readMessages(jobDirOf(repo, j.id)).length, 1);
});

test("pause with no runner on the job parks it at once (by-you); resume returns it to its stage", async () => {
  const j = await job();
  assert.equal(await pause(repo, j.id, out), 0);
  const p = readJobAt(jobDirOf(repo, j.id));
  assert.deepEqual([p.stage, p.pausedFrom, p.pausedReason, p.waitFor], ["paused", "build", "by-you", undefined]);
  assert.match(statusLine(p, jobDirOf(repo, j.id)), /paused\(by-you, from build\)/);
  assert.equal(await pause(repo, j.id, out), 1, "already paused");
  assert.equal(await resume(repo, j.id, out), 0);
  assert.equal(readJobAt(jobDirOf(repo, j.id)).stage, "build");
  assert.equal(await pause(repo, (await job("done")).id, out), 1, "a done job has nothing to pause");
});

test("pause while a runner works on the job: the request waits; the runner parks it after the step", async () => {
  const j = await job();
  await updateJob(repo, j.id, (x) => ({ ...x, running: { pid: process.pid, start: processStart(process.pid), stage: "build", at: new Date().toISOString() } }));
  assert.equal(await pause(repo, j.id, out), 0);
  assert.equal(readJobAt(jobDirOf(repo, j.id)).stage, "build", "the step finishes first");
  assert.ok(readControl(jobDirOf(repo, j.id)).pause);
  assert.equal(await honorControl(repo, j.id, out), true);
  assert.equal(readJobAt(jobDirOf(repo, j.id)).stage, "paused");
  assert.deepEqual(readControl(jobDirOf(repo, j.id)), {}, "the request is used up");
});

test("resume on a job still running cancels a pause not made yet", async () => {
  const j = await job();
  await updateJob(repo, j.id, (x) => ({ ...x, running: { pid: process.pid, start: processStart(process.pid), stage: "build", at: new Date().toISOString() } }));
  await pause(repo, j.id, out);
  assert.equal(await resume(repo, j.id, out), 0);
  assert.deepEqual(readControl(jobDirOf(repo, j.id)), {});
  assert.equal(await honorControl(repo, j.id, out), false);
});

test("stop kills the job's agent process group now and parks the job", async () => {
  const j = await job();
  const dir = jobDirOf(repo, j.id);
  const agent = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const pgid = agent.pid as number;
  fs.mkdirSync(procsDirOf(dir), { recursive: true });
  fs.writeFileSync(
    path.join(procsDirOf(dir), `${pgid}.json`),
    JSON.stringify({ pgid, start: processStart(pgid), what: "agent builder", by: process.pid, at: new Date().toISOString() }),
  );
  assert.equal(await stop(repo, j.id, out), 0);
  assert.equal(groupAlive(pgid), false, "the agent is gone");
  const p = readJobAt(dir);
  assert.deepEqual([p.stage, p.pausedFrom, p.pausedReason], ["paused", "build", "by-you: stopped"]);
  assert.ok(lines.some((l) => l.includes("killed agent builder")));
});

function ctxOf(j: Awaited<ReturnType<typeof job>>, agent: FakeAdapter): StageContext {
  const jobDir = jobDirOf(repo, j.id);
  return {
    repo,
    job: j,
    jobDir,
    config: parseConfig("version: 1"),
    agent,
    forge: {} as StageContext["forge"],
    source: {} as StageContext["source"],
    now: () => new Date(),
    log: () => {},
    refresh: () => readJobAt(jobDir),
    holdsLock: () => true,
  };
}

test("a steer sent before a role starts opens its prompt as operator notes, read by that role (next-role)", async () => {
  const j = await job();
  await steer(repo, j.id, "use the existing formatter", out);
  const agent = new FakeAdapter(() => ({ file: "out", line: "ok" }));
  await runRole(ctxOf(j, agent), { role: "builder", file: "build.md", tier: "read", prompt: "Build it.", dest: path.join(jobDirOf(repo, j.id), "build.md") });
  const prompt = agent.calls[0].prompt;
  assert.match(prompt, /^## Operator notes/);
  assert.match(prompt, /> use the existing formatter/);
  assert.ok(prompt.endsWith("Build it."), "the role's own prompt follows");
  const [m] = readMessages(jobDirOf(repo, j.id));
  assert.deepEqual([m.status, m.by, m.via], ["read", "builder", "next-role"]);
});

test("a steer sent while the role runs reaches it through the inbox and is marked read mid-run", async () => {
  const j = await job();
  const dir = jobDirOf(repo, j.id);
  let got: { id: string; text: string }[] = [];
  const agent = new FakeAdapter(async (req) => {
    assert.deepEqual(req.steer?.take(), [], "nothing queued at the start");
    await steer(repo, j.id, "add a test for the empty case", out);
    got = req.steer?.take() ?? [];
    req.steer?.read(got.map((m) => m.id));
    return { file: "out", line: "ok" };
  });
  await runRole(ctxOf(j, agent), { role: "builder", file: "build.md", tier: "read", prompt: "Build it.", dest: path.join(dir, "build.md") });
  assert.equal(got.length, 1);
  assert.match(got[0].text, /Operator note/);
  assert.match(got[0].text, /> add a test for the empty case/);
  assert.doesNotMatch(agent.calls[0].prompt, /Operator notes/, "not in the starting prompt");
  for (let i = 0; i < 50 && readMessages(dir)[0].status !== "read"; i++) await new Promise((r) => setTimeout(r, 10));
  const [m] = readMessages(dir);
  assert.deepEqual([m.status, m.by, m.via], ["read", "builder", "mid-run"]);
});
