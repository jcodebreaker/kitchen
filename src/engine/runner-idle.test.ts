// A detached runner (`stay`) doesn't exit when every job waits on a person: it idles and wakes when an
// answer makes a job runnable. A foreground run still exits then. Fake adapter only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { feedback } from "../cli/commands.ts";
import { readRunLock } from "./lock.ts";
import { runKitchen } from "./runner.ts";
import { createJob, jobDirOf, readJobAt, updateJob } from "./store.ts";

let root: string;
const prevHome = process.env.KITCHEN_HOME;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-idle-"));
  process.env.KITCHEN_HOME = path.join(root, "home");
  fs.writeFileSync(path.join(root, "reject.mjs"), "export default () => ({ file: 'DECISION: REJECT\\nREASON: stand-in\\n', line: 'rejected' });\n");
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.KITCHEN_HOME;
  else process.env.KITCHEN_HOME = prevHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8" }).trim();

async function waitingRepo(name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "kitchen.yaml"), `agent: { tool: fake, script: ${path.join(root, "reject.mjs")} }\n`);
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const { job } = await createJob(dir, {
    title: "asks",
    ticket: { source: "prompt", id: name },
    body: "asks",
    roundLimit: 3,
    base: git(dir, "rev-parse", "HEAD"),
  });
  await updateJob(dir, job.id, (j) => Object.assign(j, { stage: "needs-info", pausedReason: "which page?" }));
  return { dir, id: job.id };
}

const until = async (what: string, fn: () => boolean, lines: string[], ms = 15_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}:\n${lines.join("\n")}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("a staying runner idles while every job waits on a person, and runs the job when the answer comes", async () => {
  const { dir, id } = await waitingRepo("stay");
  const lines: string[] = [];
  const stop = new AbortController();
  const run = runKitchen({ repo: dir, stay: true, tickMs: 50, signal: stop.signal, print: (l) => lines.push(l) });
  await until("idle", () => lines.some((l) => l.startsWith("run: idle")), lines);
  await new Promise((r) => setTimeout(r, 300)); // several idle ticks: still alive, still holding the queue
  assert.equal(readRunLock(dir)?.info?.pid, process.pid, "it keeps the run lock while idle");
  assert.equal(readJobAt(jobDirOf(dir, id)).stage, "needs-info");
  assert.equal(await feedback(dir, id, "the books page", () => {}), 0);
  await until("the job to run", () => readJobAt(jobDirOf(dir, id)).stage === "rejected", lines);
  assert.ok(lines.includes("run: work arrived"), lines.join("\n"));
  stop.abort();
  await run;
  assert.equal(readRunLock(dir), null, "the lock is given back when it ends");
});

test("a foreground runner still exits when every job waits on a person", async () => {
  const { dir, id } = await waitingRepo("foreground");
  const lines: string[] = [];
  await runKitchen({ repo: dir, tickMs: 50, print: (l) => lines.push(l) });
  assert.ok(!lines.some((l) => l.startsWith("run: idle")), lines.join("\n"));
  assert.equal(readJobAt(jobDirOf(dir, id)).stage, "needs-info");
});
