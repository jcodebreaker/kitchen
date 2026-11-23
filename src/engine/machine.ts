// The job's stages and the moves between them (ADR 0016). Pure: no files, no git, no clock.
//
// One table, as data: each stage lists the stages it may move to. `kitchen job` verbs are the only writers of
// job state and they move a job only through `move()`, which refuses any move the table doesn't list.
// Lanes (where an agent works): intake, build, qa, review. Ready waits for a person; done is merged into staging.

export const STAGES = ["intake", "needs-info", "build", "qa", "review", "ready", "done", "needs-human", "paused", "rejected"] as const;
export type Stage = (typeof STAGES)[number];

/** The stages an agent works in, in order. */
export const LANES = ["intake", "build", "qa", "review"] as const;
export type Lane = (typeof LANES)[number];
export const isLane = (s: string): s is Lane => (LANES as readonly string[]).includes(s);
export const isActive = (s: Stage) => isLane(s);

/** pausedReason of a job a person paused or stopped. Only `kitchen resume` wakes it. */
export const BY_YOU = "by-you";
export const BY_YOU_STOPPED = "by-you: stopped";
export const pausedByYou = (j: Pick<Job, "stage" | "pausedReason">) => j.stage === "paused" && !!j.pausedReason?.startsWith(BY_YOU);
export const WAITING: readonly Stage[] = ["needs-info", "needs-human", "paused", "rejected"];

export type Risk = "low" | "medium" | "high";
export type Kind = "feature" | "bug" | "ui" | "chore";
export type TicketRef = { source: "prompt" | "github"; id: string; url?: string };

/** One lane agent's run, as `kitchen job start` opened it and `kitchen job finish` closed it. */
export type AgentRunRef = {
  key: string;
  role: string;
  stage: Stage;
  round: number;
  at: string;
  end?: string;
  ok?: boolean;
  line?: string;
  secs?: number;
  /** Its activity stream, relative to the job folder (activity/m<moves>-<lane>-<t0>.jsonl). */
  stream?: string;
  model?: string;
};

export type Job = {
  id: string;
  title: string;
  ticket: TicketRef;
  stage: Stage;
  pausedReason?: string;
  pausedFrom?: Stage;
  escalatedFrom?: Stage;
  /** Monotonic: the round QA evidence and reviews are filed under. */
  round: number;
  /** The round the current budget started at: `kitchen feedback` resets the budget, never `round`. */
  roundStart: number;
  roundLimit: number;
  risk: Risk | null;
  surfaces: ("ui" | "security")[];
  kind: Kind | null;
  /** The commit the job branch started from (staging's tip when Build first ran), "" before. */
  base: string;
  branch: string;
  worktree: string;
  pr: number | null;
  /** Files intake expects the change to touch (a hint for the brief; jobs sharing files still run side by side). */
  files?: string[];
  /** Jobs this one waits for (intake's AFTER: line). */
  after?: string[];
  /** The lane an agent works in now, opened by `kitchen job start`. `head`: the commit a review lane reviews. */
  running: { lane: Lane; at: string; key: string; stream?: string; head?: string } | null;
  /** Lane runs in this stage whose files Kitchen refused (a missing verdict, red checks). Three go to a person. */
  tries?: number;
  agentRuns: AgentRunRef[];
  /** Every move so far. Activity streams and the ledger are keyed by it. */
  moves: number;
  /** Why a job that passed stopped at Ready (high risk, a large diff, auto-merge off). */
  held?: string;
  /** Where it was merged: staging's new tip, how (local or the PR). */
  merged?: { into: string; sha: string; at: string; via: "local" | "github" };
  /** Side effects done once (a PR opened): keys. */
  filed: string[];
  startedAt: string;
  updatedAt: string;
  doneAt?: string;
};

/** The moves the table allows: from → to. */
export const MOVES: Record<Stage, readonly Stage[]> = {
  intake: ["build", "needs-info", "needs-human", "rejected", "paused"],
  "needs-info": ["intake", "rejected"],
  build: ["qa", "needs-human", "rejected", "paused"],
  qa: ["review", "build", "needs-human", "rejected", "paused"],
  review: ["build", "ready", "done", "needs-human", "rejected", "paused"],
  ready: ["build", "done", "rejected"],
  done: ["build"],
  "needs-human": ["intake", "build", "qa", "review", "rejected"],
  paused: ["intake", "build", "qa", "review", "rejected"],
  rejected: [],
};

/** Moves that start another round (the work goes back to Build). */
const BACK_TO_BUILD: readonly Stage[] = ["qa", "review", "ready", "done"];

/** Rounds used in the current budget. */
export const roundsUsed = (j: Pick<Job, "round" | "roundStart">) => j.round - j.roundStart + 1;
/** Pure: the budget is spent, so a failed QA or review goes to a person instead of another round. */
export const outOfRounds = (j: Pick<Job, "round" | "roundStart" | "roundLimit">) => roundsUsed(j) >= j.roundLimit;

export class MoveRefused extends Error {}

/** Pure: why `from → to` is refused, or null when the table allows it. */
export function refuse(j: Pick<Job, "stage" | "pausedFrom">, to: Stage): string | null {
  if (!(STAGES as readonly string[]).includes(to)) return `no stage ${to}`;
  if (!MOVES[j.stage].includes(to)) return `${j.stage} → ${to} is not a move Kitchen makes (from ${j.stage}: ${MOVES[j.stage].join(", ") || "none"})`;
  if (j.stage === "paused" && to !== "rejected" && j.pausedFrom && to !== j.pausedFrom) return `a paused job resumes in ${j.pausedFrom}, not ${to}`;
  return null;
}

/**
 * Pure: the job moved to `to`. Throws MoveRefused for a move the table doesn't list. Counters change only here:
 * the round (back to Build), moves, the pause bookkeeping, doneAt.
 */
export function move(j: Job, to: Stage, o: { reason?: string; now?: Date } = {}): Job {
  const why = refuse(j, to);
  if (why) throw new MoveRefused(why);
  const now = (o.now ?? new Date()).toISOString();
  const n: Job = { ...j, stage: to, moves: j.moves + 1, updatedAt: now, running: null };
  delete n.pausedReason;
  delete n.tries;
  if (to === "build" && BACK_TO_BUILD.includes(j.stage)) {
    n.round = j.round + 1;
    // A follow-up on a finished job is new work: a fresh budget.
    if (j.stage === "done" || j.stage === "ready") n.roundStart = n.round;
    delete n.held;
    delete n.merged;
    delete n.doneAt;
  }
  if (j.stage === "needs-human") {
    delete n.escalatedFrom;
    n.roundStart = n.round;
  }
  if (to === "paused") {
    n.pausedFrom = j.stage;
    n.pausedReason = o.reason ?? BY_YOU;
  } else delete n.pausedFrom;
  if (to === "needs-info" || to === "needs-human" || to === "rejected") {
    if (o.reason) n.pausedReason = o.reason;
    if (to !== "needs-info" && isLane(j.stage)) n.escalatedFrom = j.stage;
  }
  if (to === "done" || to === "rejected") n.doneAt = now;
  return n;
}

export const RISKS: readonly Risk[] = ["low", "medium", "high"];
export const maxRisk = (a: Risk | null, b: Risk | null): Risk | null => (!a ? b : !b ? a : RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b);
