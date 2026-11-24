import assert from "node:assert/strict";
import { test } from "vitest";
import { isCatchUp, type Job, MOVES, MoveRefused, move, outOfCatchUps, outOfRounds, refuse, roundsUsed, STAGES } from "./machine.ts";
import { planWave, waitsFor } from "./plan.ts";

const job = (n: number, o: Partial<Job> = {}): Job => ({
  id: `${String(n).padStart(3, "0")}-t${n}`,
  title: `t${n}`,
  ticket: { source: "prompt", id: `x${n}` },
  stage: "intake",
  round: 1,
  roundStart: 1,
  roundLimit: 3,
  risk: null,
  surfaces: [],
  kind: null,
  base: "",
  branch: `kitchen/${n}`,
  worktree: "",
  pr: null,
  running: null,
  agentRuns: [],
  moves: 0,
  filed: [],
  startedAt: "2026-11-22T00:00:00Z",
  updatedAt: "2026-11-22T00:00:00Z",
  ...o,
});

test("the table: only listed moves; done and rejected are terminal except a follow-up; a paused job resumes where it paused", () => {
  assert.throws(() => move(job(1), "qa"), MoveRefused);
  assert.throws(() => move(job(1, { stage: "build" }), "done"), /build → done is not a move/);
  assert.deepEqual(MOVES.rejected, []);
  assert.deepEqual(MOVES.done, ["build"]);
  const p = move(job(1, { stage: "qa" }), "paused", { reason: "by-you" });
  assert.equal(p.pausedFrom, "qa");
  assert.match(String(refuse(p, "build")), /resumes in qa/);
  assert.equal(move(p, "qa").stage, "qa");
  for (const s of STAGES) for (const t of MOVES[s]) assert.ok(STAGES.includes(t), `${s} → ${t}`);
});

test("rounds: QA or review sending a job back starts the next round; a follow-up on a merged job gets a fresh budget", () => {
  const b = move(job(1, { stage: "qa" }), "build");
  assert.equal(b.round, 2);
  assert.equal(b.roundStart, 1);
  assert.equal(outOfRounds({ ...b, round: 3 }), true);
  const merged = move(job(1, { stage: "review", round: 3 }), "done");
  assert.ok(merged.doneAt);
  const again = move(merged, "build");
  assert.deepEqual([again.round, again.roundStart, again.doneAt], [4, 4, undefined]);
  assert.equal(move(job(1, { stage: "build", running: { lane: "build", at: "x", key: "k" } }), "qa").running, null, "a move closes the lane");
});

test("ADR 0018: a catch-up opens a round folder but spends no round; three in a row are the limit; a real round or landing clears them", () => {
  const c1 = move(job(1, { stage: "review" }), "build", { catchUp: true });
  assert.deepEqual([c1.round, roundsUsed(c1), c1.catchUps], [2, 1, 1]);
  const c3 = move(move({ ...c1, stage: "regress" }, "build", { catchUp: true }), "qa");
  const c4 = move({ ...c3, stage: "review" }, "build", { catchUp: true });
  assert.deepEqual([c4.round, roundsUsed(c4), c4.catchUps, outOfCatchUps(c4)], [4, 1, 3, true]);
  const real = move({ ...c4, stage: "qa" }, "build");
  assert.deepEqual([real.round, roundsUsed(real), real.catchUps], [5, 2, undefined]);
  assert.equal(move({ ...c4, stage: "review" }, "done").catchUps, undefined, "landing clears them");
  assert.equal(move(move({ ...c4, stage: "review" }, "needs-human"), "build").catchUps, undefined, "a person taking it back clears them");
  // Who decides: a conflict always; red checks only when green on the branch alone and staging has new commits.
  assert.equal(isCatchUp({ cause: "conflict", greenAlone: false, stagingAhead: true }), true);
  assert.equal(isCatchUp({ cause: "checks", greenAlone: true, stagingAhead: true }), true);
  assert.equal(isCatchUp({ cause: "checks", greenAlone: false, stagingAhead: true }), false);
  assert.equal(isCatchUp({ cause: "checks", greenAlone: true, stagingAhead: false }), false);
  assert.equal(isCatchUp({ greenAlone: true, stagingAhead: true }), false, "a weakened map is a round");
  assert.equal(isCatchUp({ cause: "checks", greenAlone: true, stagingAhead: true, mergeOnly: true }), false, "a red when: merge check is a round");
});

test("a wave: intake first and never held for room, then downstream first in the room parallel leaves; running lanes take room", () => {
  const jobs = [job(1, { stage: "intake" }), job(2, { stage: "build" }), job(3, { stage: "qa" }), job(4, { stage: "review" })];
  const p = planWave(jobs, { parallel: 3 });
  assert.deepEqual(
    p.start.map((s) => [s.id.slice(0, 3), s.lane]),
    [
      ["001", "intake"],
      ["004", "review"],
      ["003", "qa"],
    ],
  );
  assert.deepEqual(
    p.held.map((h) => [h.id.slice(0, 3), h.why]),
    [["002", "waits for room (parallel: 3)"]],
  );
  const busy = planWave([job(1, { stage: "build", running: { lane: "build", at: "t", key: "k" } }), job(2, { stage: "build" })], { parallel: 1 });
  assert.deepEqual([busy.start.length, busy.running.length, busy.drained], [0, 1, false]);
});

test("slots: a job still in intake always gets an agent, even past parallel, while three others hold every slot", () => {
  const running = (n: number, lane: "intake" | "build" | "qa" | "review") => job(n, { stage: lane, running: { lane, at: "t", key: "k" } });
  // The real run: 001–003 took every slot with parallel 3, and 004 waited minutes for an intake agent.
  const p = planWave([running(1, "build"), running(2, "qa"), running(3, "review"), job(4, { stage: "intake" })], { parallel: 3 });
  assert.deepEqual(p.start, [{ id: job(4).id, lane: "intake" }]);
  assert.deepEqual(p.held, []);
  // Four new tickets with parallel 2: all four intakes start; the build waits for the room they leave.
  const burst = planWave([job(1), job(2), job(3), job(4), job(5, { stage: "build" })], { parallel: 2 });
  assert.deepEqual(
    burst.start.map((s) => s.lane),
    ["intake", "intake", "intake", "intake"],
  );
  assert.deepEqual(
    burst.held.map((h) => [h.id.slice(0, 3), h.why]),
    [["005", "waits for room (parallel: 2)"]],
  );
  // A running intake takes room like any lane; a pause still holds an intake.
  assert.deepEqual(planWave([running(1, "intake"), job(2, { stage: "build" })], { parallel: 1 }).held[0].why, "waits for room (parallel: 1)");
  assert.deepEqual(planWave([job(3)], { parallel: 2, paused: new Set([job(3).id]) }).held[0].why, "a pause is requested");
});

test("dependencies: jobs touching one file run side by side; only AFTER: holds; a finished job holds nothing", () => {
  const a = job(1, { stage: "build", files: ["server.js", "README.md"] });
  const b = job(2, { stage: "build", files: ["server.js", "README.md", "lib/x.js"] });
  assert.equal(waitsFor(b, a), false, "sharing files is no wait: git merges both into staging");
  assert.equal(waitsFor(a, b), false);
  const p = planWave([a, b], { parallel: 4 });
  assert.deepEqual(
    p.start.map((s) => s.id.slice(0, 3)),
    ["001", "002"],
  );
  assert.deepEqual(p.held, []);
  const after = job(5, { stage: "build", after: ["003"] });
  assert.equal(waitsFor(after, job(3, { stage: "review" })), true);
  assert.match(
    planWave([job(3, { stage: "review", running: { lane: "review", at: "t", key: "k" } }), after], { parallel: 4 }).held[0].why,
    /waits for 003-t3 \(review\): named on its AFTER: line/,
  );
  assert.equal(waitsFor(after, job(3, { stage: "done" })), false);
  const heldByReady = planWave([job(1, { stage: "ready" }), job(2, { stage: "build", after: ["1"] })], { parallel: 4 });
  assert.match(heldByReady.held[0].why, /a person merges it first/);
  assert.equal(heldByReady.drained, true, "nothing can move: drained, waiting on the person");
});

test("waiting on the person is listed, never started; stranded lanes restart only when asked", () => {
  const stranded = job(3, { stage: "qa", running: { lane: "qa", at: "t", key: "k" } });
  const jobs = [job(1, { stage: "needs-info", pausedReason: "which page?" }), job(2, { stage: "paused", pausedFrom: "build" }), stranded];
  const p = planWave(jobs, { parallel: 2 });
  assert.deepEqual(
    p.you.map((y) => y.stage),
    ["needs-info", "paused"],
  );
  assert.deepEqual(p.start, []);
  assert.deepEqual(planWave(jobs, { parallel: 2, restartStranded: true }).start, [{ id: stranded.id, lane: "qa", restart: true }]);
  assert.deepEqual(planWave([job(4, { stage: "build" })], { parallel: 2, paused: new Set([job(4).id]) }).held[0].why, "a pause is requested");
});
