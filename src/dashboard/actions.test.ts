// The dashboard's actions: one that makes work runnable starts a runner when none works the queue (never a
// second one), and a follow-up reopens a done job only when the page says so ({ reopen: true }).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { acquireRunLock } from "../engine/lock.ts";
import type { Stage } from "../engine/machine.ts";
import { createJob, jobDirOf, readJobAt, updateJob } from "../engine/store.ts";
import { act, BadRequest, setRunnerStarter } from "./actions.ts";

let root = "";
const saved = process.env.KITCHEN_HOME;
const started: string[] = [];
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-actions-"));
  process.env.KITCHEN_HOME = path.join(root, ".home");
  setRunnerStarter((repo, out) => {
    started.push(repo);
    out("run detached: pid 0 (test)");
    return 0;
  });
});
afterEach(() => {
  started.length = 0;
});
afterAll(() => {
  setRunnerStarter(null);
  process.env.KITCHEN_HOME = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function jobIn(stage: Stage, over: Record<string, unknown> = {}) {
  const repo = path.join(root, `r${++n}`);
  fs.mkdirSync(repo, { recursive: true });
  const { job } = await createJob(repo, { title: "t", ticket: { source: "prompt", id: `p${n}` }, body: "x", roundLimit: 3, base: "" });
  await updateJob(repo, job.id, (j) => Object.assign(j, { stage, ...over }));
  return { repo, id: job.id };
}

test("an answer that makes a job runnable starts a runner when none works the queue", async () => {
  const { repo, id } = await jobIn("needs-info", { pausedReason: "which page?" });
  const r = await act(repo, "answer", { id, text: "the books page" });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(readJobAt(jobDirOf(repo, id)).stage, "intake");
  assert.deepEqual(started, [repo]);
  assert.match(r.lines.at(-1) ?? "", /run detached/);
});

test("with a live runner, nothing is started; a refused action starts nothing either", async () => {
  const { repo, id } = await jobIn("needs-info", { pausedReason: "which page?" });
  const lock = acquireRunLock(repo);
  try {
    assert.equal((await act(repo, "answer", { id, text: "the books page" })).ok, true);
  } finally {
    lock.release();
  }
  assert.deepEqual(started, []);
  const other = await jobIn("build");
  assert.equal((await act(other.repo, "answer", { id: other.id, text: "x" })).ok, false, "build is not waiting for an answer");
  assert.deepEqual(started, []);
});

test("a new ticket starts a runner; Start runner is an action of its own", async () => {
  const { repo } = await jobIn("rejected");
  assert.equal((await act(repo, "ticket", { text: "add a renew endpoint" })).ok, true);
  assert.deepEqual(started, [repo]);
  assert.equal((await act(repo, "start-runner", {})).ok, true);
  assert.deepEqual(started, [repo, repo]);
});

test("a follow-up reopens a done job only with { reopen: true }: a plain message to a done job is refused", async () => {
  const { repo, id } = await jobIn("done");
  await assert.rejects(act(repo, "follow-up", { id, text: "where is the report?" }), (e) => e instanceof BadRequest && /reopen: true/.test(e.message));
  await assert.rejects(act(repo, "follow-up", { id, text: "where is the report?", reopen: "yes" }), BadRequest);
  assert.equal(readJobAt(jobDirOf(repo, id)).stage, "done", "still done");
  assert.deepEqual(started, []);
  const r = await act(repo, "follow-up", { id, text: "also show the due date", reopen: true });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(readJobAt(jobDirOf(repo, id)).stage, "build");
  assert.deepEqual(started, [repo]);
});
