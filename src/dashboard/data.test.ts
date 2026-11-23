// The Board's data shape (ADR 0013): which lane a job sits in, where needs-you jobs go, and the risk its pill shows.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parseConfig } from "../config.ts";
import { BY_YOU, BY_YOU_STOPPED, type Job } from "../engine/machine.ts";
import { createJob, jobDirOf, updateJob } from "../engine/store.ts";
import { AUTH_FAILURE, LANES, laneOf, laneWho, proofOf, riskOf, snapshot, stateOf, waitYouOf } from "./data.ts";

const job = (o: Partial<Job>) => ({ stage: "build", ...o }) as Job;

test("lanes run Needs you first, then the stages, Ready and Done", () => {
  assert.deepEqual(
    LANES.map((l) => l.k),
    ["you", "intake", "build", "check", "review", "ready", "done"],
  );
});

test("each stage a job works in has its lane", () => {
  const want: [Job["stage"], string][] = [
    ["intake", "intake"],
    ["spec", "intake"],
    ["repro", "intake"],
    ["build", "build"],
    ["gate", "check"],
    ["drives", "check"],
    ["verify", "check"],
    ["toolkit", "check"],
    ["review", "review"],
    ["ready", "ready"],
    ["report", "ready"],
    ["done", "ready"],
    ["rejected", "done"],
  ];
  for (const [stage, lane] of want) assert.equal(laneOf(job({ stage })), lane, stage);
});

test("needs you: a question, an escalation, and a job waiting for a Toolkit all sit in Needs you", () => {
  assert.equal(laneOf(job({ stage: "needs-info" })), "you");
  assert.equal(laneOf(job({ stage: "needs-human", escalatedFrom: "verify" })), "you");
  assert.equal(laneOf(job({ stage: "paused", waitFor: "no-toolkit", pausedFrom: "verify", pausedReason: "needs a Toolkit" })), "you");
});

test("paused by you stays in its stage's lane; stopped by you is closed, in Done", () => {
  assert.equal(laneOf(job({ stage: "paused", pausedFrom: "review", pausedReason: BY_YOU })), "review");
  assert.equal(laneOf(job({ stage: "paused", pausedFrom: "build", pausedReason: BY_YOU_STOPPED })), "done");
  assert.equal(laneOf(job({ stage: "paused", waitFor: "backoff", pausedFrom: "gate" })), "check");
});

test("risk is the job's real risk: intake's call raised by the gate's floor, never lowered, null before intake", () => {
  assert.equal(riskOf({ risk: "low", riskFloor: null }), "low");
  assert.equal(riskOf({ risk: "low", riskFloor: "high" }), "high");
  assert.equal(riskOf({ risk: "high", riskFloor: "low" }), "high");
  assert.equal(riskOf({ risk: null, riskFloor: null }), null);
});

test("the proof pill: pass, fail, or not proven; none on a rejected job", () => {
  assert.equal(proofOf("ready", "PASS"), "pass");
  assert.equal(proofOf("build", "FAIL"), "fail");
  assert.equal(proofOf("intake", null), "not proven");
  assert.equal(proofOf("verify", "INCONCLUSIVE"), "not proven");
  assert.equal(proofOf("rejected", "PASS"), null);
});

test("each lane's header names who works there, from kitchen.yaml's models", () => {
  const who = laneWho(parseConfig("agent:\n  tool: claude\n"));
  assert.equal(who.you, "you");
  assert.equal(who.build, "opus");
  assert.equal(who.check, "engine + sonnet");
  assert.equal(laneWho(null).review, "review agents");
});

test("needs you: a login to fix and a Toolkit PR to merge; a rate-limit backoff stays in its stage's lane", () => {
  const auth = job({ stage: "paused", waitFor: "backoff", pausedFrom: "build", pausedReason: AUTH_FAILURE });
  assert.equal(stateOf(auth), "you");
  assert.equal(laneOf(auth), "you");
  assert.equal(waitYouOf(auth), "auth");
  const pr = job({ stage: "paused", waitFor: "toolkit-pr", pausedFrom: "ready", pausedReason: "waiting for the Toolkit PR to merge" });
  assert.equal(laneOf(pr), "you");
  assert.equal(waitYouOf(pr), "toolkit-pr");
  const rate = job({ stage: "paused", waitFor: "backoff", pausedFrom: "build", pausedReason: "rate limited" });
  assert.equal(stateOf(rate), "paused");
  assert.equal(laneOf(rate), "build");
  assert.equal(waitYouOf(rate), null);
});

test("the proof pill reads this round's verdict only: a PASS in round 1 is not proven once the job is back in build in round 2", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-data-"));
  const saved = process.env.KITCHEN_HOME;
  process.env.KITCHEN_HOME = path.join(repo, ".home");
  try {
    const { job: j } = await createJob(repo, { title: "Show the open count", ticket: { source: "prompt", id: "p1" }, body: "x", roundLimit: 3, base: "" });
    const r1 = path.join(jobDirOf(repo, j.id), "rounds", "1");
    fs.mkdirSync(r1, { recursive: true });
    fs.writeFileSync(path.join(r1, "verdict-m4.md"), "VERDICT: PASS\n");
    await updateJob(repo, j.id, (x) => ({ ...x, stage: "review", round: 1 }));
    assert.equal((await snapshot(repo)).jobs[0].proof, "pass");
    await updateJob(repo, j.id, (x) => ({ ...x, stage: "build", round: 2 }));
    assert.equal((await snapshot(repo)).jobs[0].proof, "not proven");
  } finally {
    process.env.KITCHEN_HOME = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
