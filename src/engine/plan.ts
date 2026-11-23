// The next wave (`kitchen job next`), adapted from super-board's wave planner (MIT, see NOTICE). Pure: the jobs
// go in, the lanes to start now come out, each with the reason anything else waits.
//
// - Width follows the dependency graph, capped by `parallel` (lane agents at once, the running ones included).
// - Intake is never held for room: every job in intake starts in the first wave it can, even past `parallel`. It is a
//   short, read-only lane, and a run where three builders took every slot left the fourth ticket without an intake
//   for minutes. Intake lanes do take room, so the rest of the wave gets what `parallel` leaves after them.
// - Then downstream first: regress, review, then QA, then build, so finished work lands before new work starts.
// - Dependencies: a job does not start its first Build while a job named on its AFTER: line is unfinished. Finished
//   is done or rejected: a job held at Ready still blocks, since staging doesn't have its change yet.
// - Jobs that touch the same files run side by side: git merges each into staging, and a conflict sends the later one
//   back to Build, where it starts from staging as it is then (`kitchen job start`). Holding them in a queue instead
//   doubled the wall time of two tickets that only shared a route file and the README.
// - Paused, waiting-for-you and finished jobs are listed, never started.
import { isLane, type Job, type Lane } from "./machine.ts";

export type Plan = {
  /** Lanes to start now, in order. `restart`: the job was left running by an orchestrator that is gone. */
  start: { id: string; lane: Lane; restart?: boolean }[];
  /** Lane agents working now. */
  running: { id: string; lane: Lane; since: string }[];
  /** Jobs in a lane that wait: for a dependency, or for room (parallel). */
  held: { id: string; lane: Lane; why: string }[];
  /** Jobs waiting on the person (needs-info, needs-human, ready, paused). */
  you: { id: string; stage: string; why: string }[];
  /** Nothing to start and nothing running: the queue is drained (what is left waits on you). */
  drained: boolean;
};

const ORDER: Lane[] = ["intake", "regress", "review", "qa", "build"];
const num = (id: string) => Number(id.split("-")[0]);
const finished = (j: Job) => j.stage === "done" || j.stage === "rejected";

/** Pure: does `b` wait for `a`? (a is unfinished, and b names it on its AFTER: line.) Sharing files is no wait. */
export function waitsFor(b: Job, a: Job): boolean {
  if (a.id === b.id || finished(a)) return false;
  return (b.after ?? []).some((x) => num(x) === num(a.id));
}

export function planWave(jobs: Job[], o: { parallel: number; restartStranded?: boolean; paused?: Set<string> }): Plan {
  const plan: Plan = { start: [], running: [], held: [], you: [], drained: false };
  const cands: { j: Job; restart?: boolean }[] = [];
  for (const j of jobs) {
    if (j.stage === "needs-info") plan.you.push({ id: j.id, stage: j.stage, why: j.pausedReason ?? "intake asked a question" });
    else if (j.stage === "needs-human") plan.you.push({ id: j.id, stage: j.stage, why: j.pausedReason ?? "it needs a person" });
    else if (j.stage === "ready") plan.you.push({ id: j.id, stage: j.stage, why: j.held ?? "ready for a person to merge" });
    else if (j.stage === "paused") plan.you.push({ id: j.id, stage: j.stage, why: j.pausedReason ?? "paused" });
    else if (isLane(j.stage)) {
      if (j.running && !o.restartStranded) plan.running.push({ id: j.id, lane: j.running.lane, since: j.running.at });
      else cands.push({ j, restart: j.running ? true : undefined });
    }
  }
  cands.sort((a, b) => ORDER.indexOf(a.j.stage as Lane) - ORDER.indexOf(b.j.stage as Lane) || num(a.j.id) - num(b.j.id));
  let room = Math.max(0, o.parallel - plan.running.length);
  for (const { j, restart } of cands) {
    const lane = j.stage as Lane;
    if (o.paused?.has(j.id)) {
      plan.held.push({ id: j.id, lane, why: "a pause is requested" });
      continue;
    }
    if (lane === "build" && !j.base) {
      const dep = jobs.find((a) => waitsFor(j, a));
      if (dep) {
        plan.held.push({
          id: j.id,
          lane,
          why: `waits for ${dep.id} (${dep.stage}${dep.stage === "ready" ? ": a person merges it first" : ""}): named on its AFTER: line`,
        });
        continue;
      }
    }
    if (room <= 0 && lane !== "intake") {
      plan.held.push({ id: j.id, lane, why: `waits for room (parallel: ${o.parallel})` });
      continue;
    }
    room--;
    plan.start.push({ id: j.id, lane, ...(restart ? { restart } : {}) });
  }
  plan.drained = !plan.start.length && !plan.running.length;
  return plan;
}
