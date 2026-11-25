// The job's stages and the moves between them (ADR 0016). Pure: no files, no git, no clock.
//
// One table, as data: each stage lists the stages it may move to. `kitchen job` verbs are the only writers of
// job state and they move a job only through `move()`, which refuses any move the table doesn't list.
// Lanes (where an agent works): intake, build, qa, review, regress (ADR 0017: the touched features driven on the
// trial merge before it lands). Ready waits for a person; done is merged into staging.

export const STAGES = ["intake", "needs-info", "build", "qa", "review", "regress", "ready", "done", "needs-human", "paused", "rejected"] as const;
export type Stage = (typeof STAGES)[number];

/** The stages an agent works in, in order. */
export const LANES = ["intake", "build", "qa", "review", "regress"] as const;
export type Lane = (typeof LANES)[number];
export const isLane = (s: string): s is Lane => (LANES as readonly string[]).includes(s);
export const isActive = (s: Stage) => isLane(s);

/** pausedReason of a job a person paused or stopped. Only `kitchen resume` wakes it. */
export const BY_YOU = "by-you";
export const BY_YOU_STOPPED = "by-you: stopped";
export const pausedByYou = (j: Pick<Job, "stage" | "pausedReason">) => j.stage === "paused" && !!j.pausedReason?.startsWith(BY_YOU);
export const WAITING: readonly Stage[] = ["needs-info", "needs-human", "paused", "rejected"];

export type Risk = "low" | "medium" | "high";
export type Kind = "feature" | "bug" | "ui" | "chore" | "check";
export const KINDS: readonly Kind[] = ["feature", "bug", "ui", "chore", "check"];
/** ADR 0028: how long an exploring check drives freely when intake's EXPLORE: names no minutes. */
export const EXPLORE_MINUTES = 20;
/** Why intake sends a ticket to be refined with its author (ADR 0020 §1). */
export const REFINE_REASONS = ["readings", "too-big", "no-repro", "terms"] as const;
export type RefineReason = (typeof REFINE_REASONS)[number];

export type TicketRef = { source: "prompt" | "github"; id: string; url?: string };

/**
 * ADR 0022: where a job filed from the outer loop came from: its proposal, the inbox items it covers, and each one's
 * source (the first is the job's own: `source`, `ref`, `url`). `label` is the chip the dashboard shows ("GitHub #17",
 * "3 reports"). A job filed with `kitchen ticket` has none.
 */
export type JobFrom = {
  source: string;
  kind: string;
  ref: string;
  url?: string;
  label: string;
  proposal: string;
  items: string[];
  refs: { source: string; kind: string; ref: string; url?: string }[];
};

/**
 * ADR 0028: a check. `forced`: filed with `kitchen ticket --check` (intake is told the kind). `explore`: minutes QA
 * drives freely (intake's EXPLORE:). `run`/`onto`: the check-<id> verify run QA drove and the tip it checked out. Once
 * done: `result` (the words a card shows), the criteria passed of the total, the problems found and the inbox
 * proposals they became, and what became of the recipes it kept (`map`).
 */
export type JobCheck = {
  forced?: boolean;
  /** ADR 0028 §5: filed by a schedule's tick (`kitchen ticket --check --from-schedule <every>`), and how often it runs. */
  filedBy?: "schedule";
  every?: string;
  explore?: number;
  run?: string;
  onto?: string;
  result?: string;
  pass?: number;
  total?: number;
  findings?: number;
  proposals?: string[];
  map?: string;
};
/** ADR 0029 §2: a job's needs-human reason after its second BLOCKED QA (`<words>: <why>`); Resume runs QA again. */
export const QA_BLOCKED_WORDS = "QA couldn't test it";
export const isCheck = (j: Pick<Job, "kind" | "check">) => j.kind === "check" || !!j.check?.forced;
/** ADR 0028 amendment: the words of a job verified and not merged (`KEEP: no`). */
export const VERIFIED_WORDS = "Verified · not merged";
/** A `KEEP: no` job QA verified, waiting for `kitchen promote` (done, not merged). */
export const promotable = (j: Pick<Job, "stage" | "keep" | "merged">) => j.stage === "done" && j.keep === false && !j.merged;

/** `closedBy: "kitchen"`: Kitchen closed it because the person rejected or removed the job. */
export type JobPr = { number: number; url: string; state?: "open" | "merged" | "closed"; onto?: string; head?: string; closedBy?: "kitchen" };
/** ADR 0026 §4: Ready because its PR waits for a person on GitHub (staging.merge: pr). */
export const prOpen = (j: Pick<Job, "stage" | "pr">) => j.stage === "ready" && j.pr?.state === "open";
export const PR_OPEN_WORDS = "PR open · waiting for review";

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
  /**
   * ADR 0018: catch-ups in a row (the merge into staging failed only because staging moved). A catch-up moves
   * `round` and `roundStart` together, so it costs no round. Set while the current round is one; cleared by a real
   * round, by landing, and when a person takes the job back from needs-human.
   */
  catchUps?: number;
  /** The head the last passing review read, and its round: a catch-up's review reads only what changed since. */
  reviewed?: { head: string; round: number };
  risk: Risk | null;
  surfaces: ("ui" | "security")[];
  kind: Kind | null;
  /** The commit the job branch started from (staging's tip when Build first ran), "" before. */
  base: string;
  branch: string;
  worktree: string;
  /** ADR 0026 §1: the branch it merges into, as its ticket named it (`kitchen ticket --into`); absent: staging.branch. */
  target?: string;
  /**
   * Its pull request into the target, once Kitchen opened one. ADR 0026 §4 (`staging.merge: pr`): `state` open while
   * it waits at Ready for a person to merge it on GitHub; `onto` and `head` are the target's tip the last merge check
   * ran on and the head it pushed (a moved target re-runs the check).
   */
  pr: JobPr | null;
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
  /**
   * ADR 0029 §2: why the last QA couldn't test this job (its first BLOCKED): Kitchen reset the app and runs QA again;
   * a second BLOCKED goes to a person. Cleared by any other move.
   */
  qaBlocked?: string;
  /**
   * ADR 0025 §4: the check command running now (Build's checks, the trial merge's) and its log; absent between them.
   * ADR 0029 §4: `setup`: the step `kitchen qa up` is on instead ("Resetting data"), `of`: the health wait's limit (s).
   */
  checking?: { cmd: string; at: string; log: string; setup?: true; of?: number };
  /** Why a job that passed stopped at Ready (high risk, a large diff, auto-merge off). */
  held?: string;
  /**
   * The trial merge waiting for its features to be driven (ADR 0017 §3): staging's tip it merged onto, the merged
   * commit (kept under refs/kitchen/drive/<id>), its worktree, and the features Kitchen chose from `Code:` lines.
   */
  drive?: { onto: string; sha: string; head: string; wt: string; features: string[]; by?: "person" };
  /** Kitchen's own commits on the job branch (QA's map updates): a builder's edit to verify-*\/ is anything else. */
  mapCommits?: string[];
  /** ADR 0027 §3: why QA's last map update couldn't be written or committed; the change moved on without it. */
  mapSkipped?: string;
  /** Where it was merged: staging's new tip, how (local or the PR). */
  merged?: { into: string; sha: string; at: string; via: "local" | "github" };
  /**
   * A person merged it from Ready (`kitchen merge`, the dashboard's Merge into staging), or on GitHub (its PR, ADR
   * 0026 §4); absent: Kitchen auto-merged it.
   */
  mergedBy?: "person" | "github";
  /**
   * ADR 0020: what a needs-info job waits for beyond an answer. `refine`: intake sent the ticket to be refined with
   * its author (`kitchen refine`); `confirm`: intake accepted it and `intake.confirm` holds it for `kitchen approve`.
   * Cleared when the job leaves needs-info.
   */
  waits?: { for: "refine"; reason: RefineReason; at: string } | { for: "confirm"; at: string };
  /** ADR 0020: each refinement the author answered (the reason intake gave), oldest first. */
  refined?: { reason: RefineReason; at: string }[];
  /** ADR 0020 §3: when the author approved intake's criteria (`kitchen approve`). */
  approved?: string;
  /** ADR 0020: the later slices intake listed (`## Later slices`), each filed once as its own ticket: its text and job id. */
  slices?: { text: string; id: string }[];
  /**
   * Removed by the person (`kitchen remove`): hidden from the dashboard, `kitchen status` and the wave plan; the job
   * folder and branch stay, and `kitchen restore` shows it again. `kitchen report` still counts it.
   */
  archived?: { at: string; by: "person" };
  /** ADR 0022: the outer loop's proposal it was filed from, or none (`kitchen ticket`). */
  from?: JobFrom;
  /** ADR 0028: a check ticket (KIND: check): QA on its target's tip, never built. */
  check?: JobCheck;
  /**
   * ADR 0028 amendment: intake's `KEEP: no`: code built only to verify something now. QA passing ends it at Done,
   * verified and not merged; its branch stays. `kitchen promote` sets it back (absent: kept, the normal flow).
   */
  keep?: false;
  /** When it was verified and not merged (`KEEP: no` and QA passed): the words, the head QA drove. */
  verified?: { words: string; head: string; at: string };
  /** When the person promoted it (`kitchen promote`): Review → merge check → merge into its target. */
  promoted?: string;
  /** Side effects done once (a PR opened): keys. */
  filed: string[];
  startedAt: string;
  updatedAt: string;
  doneAt?: string;
};

/** The moves the table allows: from → to. */
export const MOVES: Record<Stage, readonly Stage[]> = {
  // ADR 0028: a check goes from intake (or the approval) straight to QA, and from QA to done; a QA that couldn't run
  // (the app won't start) runs again in a new round (qa → qa; ADR 0029 §2: a job's too), and a done check can be run again.
  intake: ["build", "qa", "needs-info", "needs-human", "rejected", "paused"],
  "needs-info": ["intake", "build", "qa", "rejected"],
  build: ["qa", "needs-human", "rejected", "paused"],
  qa: ["review", "build", "qa", "done", "needs-human", "rejected", "paused"],
  review: ["build", "regress", "ready", "done", "needs-human", "rejected", "paused"],
  regress: ["build", "ready", "done", "needs-human", "rejected", "paused"],
  // kitchen merge: the person's yes runs the merge gate, which may need the merge check lane or another round.
  ready: ["build", "regress", "done", "needs-human", "rejected"],
  // ADR 0028 amendment: a job verified and not merged (KEEP: no) is promoted to Review.
  done: ["build", "qa", "review"],
  "needs-human": ["intake", "build", "qa", "review", "regress", "rejected"],
  paused: ["intake", "build", "qa", "review", "regress", "rejected"],
  rejected: [],
};

/** Moves that start another round (the work goes back to Build). */
const BACK_TO_BUILD: readonly Stage[] = ["qa", "review", "regress", "ready", "done"];

/** Catch-ups in a row before the job goes to a person (ADR 0018 §1). */
export const CATCH_UP_LIMIT = 3;
export const outOfCatchUps = (j: Pick<Job, "catchUps">) => (j.catchUps ?? 0) >= CATCH_UP_LIMIT;

/**
 * Pure, ADR 0018 §3: a failed merge into staging is a catch-up (not a round) when it conflicted, or when the checks
 * went red on the merged result while the same checks were green on the job branch alone and staging has commits
 * the branch doesn't. Anything else (a weakened map, red checks staging didn't cause) is a round.
 */
export function isCatchUp(f: { cause?: "conflict" | "checks"; greenAlone: boolean; stagingAhead: boolean; mergeOnly?: boolean }): boolean {
  // ADR 0021: a red `when: merge` check never ran on the branch alone, so "green alone" isn't known: always a round.
  return f.cause === "conflict" || (f.cause === "checks" && !f.mergeOnly && f.greenAlone && f.stagingAhead);
}

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
 * the round (back to Build), catch-ups, moves, the pause bookkeeping, doneAt.
 */
export function move(j: Job, to: Stage, o: { reason?: string; now?: Date; catchUp?: boolean; mergedOnGitHub?: boolean } = {}): Job {
  // ADR 0026 §4: a PR merged on GitHub ends the job wherever it is (a catch-up round, paused): the table's one
  // exception, made only by syncPrs. A finished job stays finished.
  const why = o.mergedOnGitHub && to === "done" && j.stage !== "done" && j.stage !== "rejected" ? null : refuse(j, to);
  if (why) throw new MoveRefused(why);
  const now = (o.now ?? new Date()).toISOString();
  const n: Job = { ...j, stage: to, moves: j.moves + 1, updatedAt: now, running: null };
  delete n.pausedReason;
  delete n.tries;
  delete n.waits;
  delete n.qaBlocked;
  // ADR 0028: a check's QA again (it couldn't run, or the person runs a done check again): a new round folder. Again
  // after done is new work, a fresh budget; after a QA that couldn't run, the same budget.
  if (to === "qa" && (j.stage === "qa" || j.stage === "done")) {
    n.round = j.round + 1;
    if (j.stage === "done") {
      n.roundStart = n.round;
      delete n.doneAt;
    }
    // ADR 0029 §2: a job's QA again after a BLOCKED (the environment, not the change): no Build round counted.
    else if (!isCheck(j)) n.roundStart = j.roundStart + 1;
  }
  if (to === "review" && j.stage === "done") {
    n.roundStart = j.round;
    delete n.doneAt;
    delete n.verified;
  }
  if (to === "build" && BACK_TO_BUILD.includes(j.stage)) {
    n.round = j.round + 1;
    // A catch-up (ADR 0018): a new round folder, the same budget. Anything else back to Build is a real round.
    if (o.catchUp) {
      n.roundStart = j.roundStart + 1;
      n.catchUps = (j.catchUps ?? 0) + 1;
    } else delete n.catchUps;
    // A follow-up on a finished job is new work: a fresh budget.
    if (j.stage === "done" || j.stage === "ready") n.roundStart = n.round;
    delete n.held;
    delete n.verified;
    delete n.merged;
    delete n.mergedBy;
    delete n.doneAt;
  }
  if (j.stage === "needs-human") {
    delete n.escalatedFrom;
    delete n.catchUps;
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
  if (to === "done") delete n.catchUps;
  return n;
}

export const RISKS: readonly Risk[] = ["low", "medium", "high"];
export const maxRisk = (a: Risk | null, b: Risk | null): Risk | null => (!a ? b : !b ? a : RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b);
