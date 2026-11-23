import assert from "node:assert/strict";
import { test } from "vitest";
import { type Job, MOVES, MoveRefused, move, outOfRounds, refuse, STAGES } from "./machine.ts";
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

test("a wave: downstream first, capped by parallel; running lanes take room", () => {
  const jobs = [job(1, { stage: "intake" }), job(2, { stage: "build" }), job(3, { stage: "qa" }), job(4, { stage: "review" })];
  const p = planWave(jobs, { parallel: 3 });
  assert.deepEqual(
    p.start.map((s) => [s.id.slice(0, 3), s.lane]),
    [
      ["004", "review"],
      ["003", "qa"],
      ["002", "build"],
    ],
  );
  assert.deepEqual(
    p.held.map((h) => [h.id.slice(0, 3), h.why]),
    [["001", "waits for room (parallel: 3)"]],
  );
  const busy = planWave([job(1, { stage: "build", running: { lane: "build", at: "t", key: "k" } }), job(2)], { parallel: 1 });
  assert.deepEqual([busy.start.length, busy.running.length, busy.drained], [0, 1, false]);
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
