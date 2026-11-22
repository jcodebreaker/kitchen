// The Board's data shape (ADR 0013): which lane a job sits in, where needs-you jobs go, and the risk its pill shows.
import assert from "node:assert/strict";
import { test } from "vitest";
import { parseConfig } from "../config.ts";
import { BY_YOU, BY_YOU_STOPPED, type Job } from "../engine/machine.ts";
import { LANES, laneOf, laneWho, proofOf, riskOf } from "./data.ts";

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
