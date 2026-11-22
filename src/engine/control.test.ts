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
import { MAX_MESSAGE, markRead, readMessages, unread } from "./messages.ts";
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

/** Another process stands in for a `kitchen run` that is in a step on the job. */
async function takenByRunner(id: string) {
  const runner = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = runner.pid as number;
  await updateJob(repo, id, (x) => ({ ...x, running: { pid, start: processStart(pid), stage: "build", at: new Date().toISOString() } }));
  return runner;
}

test("pause while a runner is in a step on the job: decided under the job lock, it waits; the runner parks it after the step", async () => {
  const j = await job();
  const runner = await takenByRunner(j.id);
  try {
    assert.equal(await pause(repo, j.id, out), 0);
    assert.equal(readJobAt(jobDirOf(repo, j.id)).stage, "build", "the step finishes first");
    assert.ok(readControl(jobDirOf(repo, j.id)).pause, "control.json is left for the runner");
    assert.equal(await honorControl(repo, j.id, out), "waits", "asked again, it still waits while the runner is in");
    // The step ends: its move clears `running`; the runner parks the job.
    await updateJob(repo, j.id, (x) => ({ ...x, running: null }));
    assert.equal(await honorControl(repo, j.id, out), "parked");
    assert.equal(readJobAt(jobDirOf(repo, j.id)).stage, "paused");
    assert.deepEqual(readControl(jobDirOf(repo, j.id)), {}, "the request is used up");
  } finally {
    runner.kill();
  }
});

test("a runner that died mid-step does not hold a pause back", async () => {
  const j = await job();
  const runner = await takenByRunner(j.id);
  runner.kill("SIGKILL");
  await new Promise((r) => runner.once("exit", r));
  assert.equal(await pause(repo, j.id, out), 0);
  assert.equal(readJobAt(jobDirOf(repo, j.id)).stage, "paused");
});

test("resume on a job still running cancels a pause not made yet", async () => {
  const j = await job();
  const runner = await takenByRunner(j.id);
  try {
    await pause(repo, j.id, out);
    assert.equal(await resume(repo, j.id, out), 0);
    assert.deepEqual(readControl(jobDirOf(repo, j.id)), {});
    assert.equal(await honorControl(repo, j.id, out), "none");
  } finally {
    runner.kill();
  }
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

test("stop that races the runner's park: the killed agent's runner parks it first, and the stop still succeeds", async () => {
  const j = await job();
  const dir = jobDirOf(repo, j.id);
  // Another process stands in for the agent and its runner: on SIGTERM its step ends and the runner parks
  // the job (paused, by-you: stopped) before the stop's own move gets the job.
  const park = `process.on("SIGTERM",()=>{const fs=require("fs"),f=${JSON.stringify(path.join(dir, "job.json"))};const j=JSON.parse(fs.readFileSync(f,"utf8"));Object.assign(j,{stage:"paused",pausedFrom:j.stage,pausedReason:"by-you: stopped",running:null});fs.writeFileSync(f,JSON.stringify(j,null,2));process.exit(0)});console.log("ready");setInterval(()=>{},1000)`;
  const agent = spawn(process.execPath, ["-e", park], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => agent.stdout?.once("data", r));
  const pgid = agent.pid as number;
  fs.mkdirSync(procsDirOf(dir), { recursive: true });
  fs.writeFileSync(
    path.join(procsDirOf(dir), `${pgid}.json`),
    JSON.stringify({ pgid, start: processStart(pgid), what: "agent builder", by: process.pid, at: new Date().toISOString() }),
  );
  assert.equal(await stop(repo, j.id, out), 0, lines.join("\n"));
  const p = readJobAt(dir);
  assert.deepEqual([p.stage, p.pausedReason], ["paused", "by-you: stopped"]);
  assert.ok(lines.includes(`${j.id}  stopped`), lines.join("\n"));
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
  const [m] = readMessages(dir);
  assert.deepEqual([m.status, m.by, m.via], ["read", "builder", "mid-run"], "marked before runRole returns");
});

test("steer → stop → resume: the steers the stopped role read go back to sent, and the next role's prompt has them", async () => {
  const j = await job();
  const dir = jobDirOf(repo, j.id);
  await steer(repo, j.id, "use the existing formatter", out); // read next-role by the first run
  const first = new FakeAdapter(async (req) => {
    await steer(repo, j.id, "and keep the diff small", out);
    const got = req.steer?.take() ?? [];
    req.steer?.read(got.map((m) => m.id)); // read mid-run
    return { line: "", ok: false }; // then `kitchen stop` kills it: no file
  });
  const dest = path.join(dir, "build.md");
  await assert.rejects(runRole(ctxOf(j, first), { role: "builder", file: "build.md", tier: "read", prompt: "Build it.", dest }), /builder/);
  assert.deepEqual(
    readMessages(dir).map((m) => [m.status, m.by ?? null]),
    [
      ["sent", null],
      ["sent", null],
    ],
  );
  const second = new FakeAdapter(() => ({ file: "out", line: "ok" }));
  await runRole(ctxOf(j, second), { role: "builder", file: "build.md", tier: "read", prompt: "Build it.", dest });
  assert.match(second.calls[0].prompt, /> use the existing formatter/);
  assert.match(second.calls[0].prompt, /> and keep the diff small/);
  assert.ok(readMessages(dir).every((m) => m.status === "read" && m.via === "next-role"));
});

test("a failing role gives back only what it read: a parallel lens that read the same message keeps its mark", async () => {
  const j = await job();
  const dir = jobDirOf(repo, j.id);
  await steer(repo, j.id, "check the auth path", out);
  await markRead(dir, ["m1"], "reviewer-security", "mid-run");
  await unread(dir, ["m1"], "reviewer-ux"); // the ux lens was handed m1 too, then failed
  assert.deepEqual([readMessages(dir)[0].status, readMessages(dir)[0].by], ["read", "reviewer-security"]);
  await unread(dir, ["m1"], "reviewer-security");
  assert.equal(readMessages(dir)[0].status, "sent");
});

test("a role that never starts (run lock lost) gives its notes back", async () => {
  const j = await job();
  const dir = jobDirOf(repo, j.id);
  await steer(repo, j.id, "note", out);
  const ctx = { ...ctxOf(j, new FakeAdapter(() => ({ file: "x", line: "ok" }))), holdsLock: () => false };
  await assert.rejects(runRole(ctx, { role: "builder", file: "build.md", tier: "read", prompt: "x", dest: path.join(dir, "b.md") }), /lock lost/);
  assert.equal(readMessages(dir)[0].status, "sent");
});
