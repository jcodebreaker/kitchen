// The stage machine (PLAN §2, "Transition table"). Pure: no files, no git, no clock.
//
// One table, as data. Each row names a move `from → to`, says in words when it
// is legal, and has a guard that reads only `Facts` (what the caller gathered
// from files, git and the forge, never what an agent says) plus the job's own
// counters. `move()` returns the moved job, or the reason it refused.
//
// Every counter the table governs (round, smith attempts, drive/render/repro
// attempts, INCONCLUSIVE retries, Toolkit tickets, backoff) changes only here.
import type { ManifestHead } from "../proof/manifest.ts";

export const STAGES = [
  "intake",
  "needs-info",
  "spec",
  "repro",
  "build",
  "gate",
  "drives",
  "verify",
  "toolkit",
  "review",
  "ready",
  "report",
  "done",
  "needs-human",
  "paused",
  "rejected",
] as const;
export type Stage = (typeof STAGES)[number];

/** Stages the runner dispatches a handler for. The rest wait for a human, a condition, or nothing. */
export const ACTIVE: readonly Stage[] = ["intake", "spec", "repro", "build", "gate", "drives", "verify", "toolkit", "review", "ready", "report"];
export const isActive = (s: Stage) => ACTIVE.includes(s);
/** pausedReason of a job a person paused, or stopped (ADR 0009). Only `kitchen resume` wakes it. */
export const BY_YOU = "by-you";
export const BY_YOU_STOPPED = "by-you: stopped";
export const pausedByYou = (j: Pick<Job, "stage" | "pausedReason">) => j.stage === "paused" && !!j.pausedReason?.startsWith(BY_YOU);
/** Stages that carry a reason for whoever looks next. */
export const WAITING: readonly Stage[] = ["needs-info", "needs-human", "paused", "rejected"];

export type Risk = "low" | "medium" | "high";
export type Kind = "feature" | "bug" | "ui" | "chore";
/** no-toolkit: the ticket needs Kitchen to drive the app and the repo has no Toolkit yet (ADR 0010). */
export type WaitFor = "backoff" | "toolkit-pr" | "ci" | "toolkit-ticket" | "no-toolkit";
export type TicketRef = { source: "prompt" | "github"; id: string; url?: string };
/**
 * One skill a role run was given (ADR 0014): its SKILL.md from `source` (kitchen (vendored), repo at <sha>, user,
 * plugin <key>…), pinned by the sha256 of its bytes; `chars` of its `of` characters reached the prompt (0: left out).
 */
export type SkillUse = {
  name: string;
  source?: string;
  path: string;
  host: "claude" | "codex";
  sha256: string;
  chars: number;
  of?: number;
  truncated: boolean;
};
export type AgentRunRef = {
  key: string;
  role: string;
  stage: Stage;
  round: number;
  adapter: string;
  model: string;
  sessionId?: string;
  /** The agent's event stream, relative to the job folder (activity/…jsonl): what the dashboard shows. */
  stream?: string;
  ok: boolean;
  line: string;
  file?: string;
  usd?: number;
  secs: number;
  at: string;
  /** The skills quoted into its prompt, and the optional ones it went without (not installed). */
  skills?: SkillUse[];
  skillsSkipped?: string[];
};

export type Job = {
  id: string;
  title: string;
  ticket: TicketRef;
  stage: Stage;
  pausedReason?: string;
  /** paused only */
  pausedFrom?: Stage;
  waitFor?: WaitFor;
  until?: string;
  /** Monotonic: the round evidence is stamped with. Never goes back, so old stamps never look current. */
  round: number;
  /** The round the current budget started at. `kitchen feedback` resets the budget, not `round`. */
  roundStart: number;
  roundLimit: number;
  risk: Risk | null;
  riskFloor: Risk | null;
  surfaces: ("ui" | "security")[];
  kind: Kind | null;
  /** Base commit the job branch starts from (main's HEAD when the ticket came in). */
  base: string;
  branch: string;
  worktree: string;
  pr: number | null;
  slot: { n: number; ports: number[] } | null;
  toolkitRef: string;
  returnTo: Stage | null;
  /** The primitive a Toolkit gap named. */
  gap: string | null;
  /**
   * The person resumed a no-toolkit pause without building a Toolkit (ADR 0010): the job goes on with checks and
   * tests only, and criteria that need the running app are reported "not proven (no Toolkit)", never passed.
   */
  checksOnly?: boolean;
  /** Files the repro stage committed (the regression test or feature drive): the builder may not edit them. */
  reproFiles?: string[];
  attempts: {
    drives: number;
    render: number;
    toolkitTicket: number;
    repro: number;
    inconclusive: number;
    backoff: number;
    /** Runner bookkeeping: consecutive adapter/engine errors and refused moves in this stage. */
    errors: number;
    refused: number;
    /** The repro sent the contract back to its author (intake or spec) once: its proof can't show the bug on the base. */
    contract?: number;
  };
  smith: { attempts: number; toolkitPr: number | null };
  toolkitTicketRef: string | null;
  filed: string[];
  agentRuns: AgentRunRef[];
  /** Number of moves made; the sequence for ledger keys and per-entry role runs. */
  moves: number;
  /**
   * Set while a runner works on the job; left behind by a crash. Names the runner
   * (pid + process start time). The process groups the runner started for the job
   * (agents, checks, Toolkit calls) are recorded beside it in jobs/<id>/procs/ (src/procs.ts).
   */
  running: { pid: number; start?: string | null; stage: Stage; at: string } | null;
  /** The stage a job went to needs-human from; `kitchen feedback` returns there (ADR 0007). */
  escalatedFrom?: Stage;
  startedAt: string;
  updatedAt: string;
  /** When the job last moved to done: PR comments written before it are not feedback on this report (runner.ts). */
  doneAt?: string;
  // proof fields (src/proof/job.ts)
  uid: string;
  gitDir: string;
  toolkitBin: string;
  slotId: string;
  manifestHead: ManifestHead;
};

export type Lint = { ok: boolean; reason?: string; missingPrimitive?: string };
/** NO-TOOLKIT (overall): nothing proved the change, or a requirement, without the app (ADR 0010). */
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "TOOLKIT-GAP" | "NO-TOOLKIT";
/** review-unparseable: a lens said VERDICT: BLOCKING twice without a finding the engine could read (never a silent PASS). */
export type Escalation = "round-limit" | "smith-limit" | "adapter-error" | "engine-error" | "refused" | "review-unparseable" | "skill-missing";

/** What guards read. Gathered by the caller (stage handlers, runner, CLI) from files, git and the forge. */
export type Facts = {
  now: string;
  intake?: {
    decision: "ACCEPT" | "NEEDS-INFO" | "REJECT";
    kind?: Kind;
    risk?: Risk;
    surfaces?: ("ui" | "security")[];
    criteria?: Lint;
    /** How many requirements intake.md lists (`## Requirements`): the spec is checked against them (spec-lint rule 7). */
    requirements?: number;
  };
  /** needs-info: the source shows an answer from the author or operator. */
  replied?: boolean;
  /** A human command. */
  /** pause / stop: a person parked the job (`kitchen pause`, `kitchen stop`, the dashboard; ADR 0009). */
  operator?: "feedback" | "reject" | "resume" | "pause" | "stop";
  /** `kitchen feedback --to <stage>`: where a needs-human job goes instead of the stage it escalated from. */
  feedbackTo?: Stage;
  spec?: Lint;
  /** contractProblem: the proof ran on the base and can't show the bug as written (a step failed before the expect, or it held). */
  repro?: { failedAsExpected: boolean; onBase: boolean; committed: boolean; missingPrimitive?: string; contractProblem?: string };
  /** syncRefused: base-changed files of a sync merge the layer rules would have put back to ours (silently dropping the base's change). */
  build?: { status: "READY" | "BLOCKED"; committed: boolean; pushed: boolean; pr: number | null; localForge: boolean; syncRefused?: string[] };
  gate?: { head: string; currentHead: string; result: "PASS" | "FAIL"; riskFloor?: Risk | null };
  drives?: { gateValid: boolean; resolved: boolean; featureChecks: boolean; unreachable?: boolean; missingPrimitive?: string; writeFailed?: boolean };
  verify?: {
    verdict: Verdict;
    mechanicalFirst: boolean;
    citationsOk: boolean;
    /** Why the citations fail, when they do. */
    citationProblem?: string;
    manifestOk: boolean;
    doctorOk?: boolean;
    gapPrimitive?: string;
    /** The Toolkit ticket the engine filed for a second INCONCLUSIVE. */
    ticket?: string;
  };
  toolkit?: { checkPassed: boolean; sha: string; pr: number | null };
  /**
   * pass: no finding blocks (checks/findings.ts: only a demonstrable, confident one can). blocking: the blocking findings, one line.
   * nonDiscriminating: criteria that already held on the base (base-check.json). findings/notes: counts after merging across lenses.
   */
  review?: { pass: boolean; blocking?: string; nonDiscriminating?: string[]; findings?: number; notes?: number };
  ready?: {
    synced: boolean;
    conflict: boolean;
    ci: "none" | "pending" | "pass" | "fail";
    /** closed: the Toolkit PR was closed without merging (→ needs-human). */
    toolkitPr: "none" | "open" | "merged" | "closed";
    gatePass: boolean;
    baseMoved: boolean;
    recheckFailed: boolean;
    /** HEAD is on the remote (publish/<head>), so CI and the report are about it. Always true on the local forge. */
    pushed?: boolean;
    /** The job PR that HEAD was published to (a closed one is never reused). */
    pr?: number | null;
    /** paused(ci): don't read CI again before this (the grace window after a push, or a cancelled run's second read). */
    until?: string;
    /** The base tip the job branch was just synced with (the job's base from now on). */
    newBase?: string;
    /** toolkitRef after the sync: the new base when it has a Toolkit and no Toolkit PR is still open. */
    toolkitRef?: string;
  };
  report?: { rendered: boolean; idsResolved: boolean; evidencePushed: boolean; commented: boolean; localForge: boolean; refusal?: string };
  /** done → build: a review comment on the PR from a trusted person (the runner reads it through the forge). */
  prComment?: { id: string; author: string; trusted: boolean };
  /** paused: the waitFor condition cleared. */
  waitCleared?: boolean;
  /**
   * The repo has no Toolkit for this job (ADR 0010). needsApp: criteria whose proof drives the app; highRisk: the
   * job's path is high, which never reaches ready without a Toolkit.
   */
  noToolkit?: {
    needsApp: string[];
    highRisk: boolean;
    /** Why checks and tests alone can't prove this job (a requirement only the app shows, a bug's repro that drives it): it never goes on without a Toolkit. */
    unprovable?: string;
  };
  /**
   * Waking a no-toolkit pause (runner or `kitchen resume`): the Toolkit now on the base (base, toolkitRef), or the
   * person's choice to go on without one (checksOnly).
   */
  wake?: { base?: string; toolkitRef?: string; checksOnly?: boolean };
  adapter?: { rateLimited?: boolean; authFailure?: boolean; until?: string; error?: string };
  escalate?: Escalation;
  why?: string;
};

export type Refusal = { refused: string; code?: Escalation };
export type MoveResult = { job: Job; row: string } | Refusal;

type Guard = (j: Job, f: Facts) => string | Refusal | null;
type Row = { id: string; from: Stage | "*"; to: Stage; when: string; guard: Guard; apply?: (j: Job, f: Facts) => void };

// ---- helpers --------------------------------------------------------------

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
export const maxRisk = (a: Risk | null, b: Risk | null): Risk | null => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);
/** The path a job runs on: the stricter of intake's rating and the diff floor. */
export const effectiveRisk = (j: Pick<Job, "risk" | "riskFloor">): Risk => maxRisk(j.risk, j.riskFloor) ?? "medium";

/** Rounds used from the current budget, counting the one in progress. */
export const roundsUsed = (j: Pick<Job, "round" | "roundStart">) => j.round - j.roundStart + 1;

const need = <T>(v: T | undefined, what: string): string | null => (v === undefined ? `no ${what} facts` : null);

/** Going back to build starts a new round: refused with code round-limit when the budget is spent. */
const roundLeft: Guard = (j) =>
  roundsUsed(j) < j.roundLimit ? null : { refused: `round limit: ${roundsUsed(j)} of ${j.roundLimit} rounds used`, code: "round-limit" };
const newRound = (j: Job) => {
  j.round += 1;
  j.attempts.drives = 0;
  j.attempts.inconclusive = 0;
};
const smithLeft: Guard = (j) => (j.smith.attempts < 2 ? null : { refused: `smith limit: ${j.smith.attempts} Toolkit attempts already`, code: "smith-limit" });
const toToolkit = (returnTo: Stage, gap: string | undefined) => (j: Job) => {
  j.smith.attempts += 1;
  j.returnTo = returnTo;
  j.gap = gap ?? null;
};
const all =
  (...gs: Guard[]): Guard =>
  (j, f) => {
    for (const g of gs) {
      const r = g(j, f);
      if (r) return r;
    }
    return null;
  };
const check = (ok: (j: Job, f: Facts) => boolean, why: string | ((j: Job, f: Facts) => string)): Guard => {
  return (j, f) => (ok(j, f) ? null : typeof why === "string" ? why : why(j, f));
};

const intakeIs =
  (d: "ACCEPT" | "NEEDS-INFO" | "REJECT"): Guard =>
  (_j, f) =>
    need(f.intake, "intake") ?? (f.intake?.decision === d ? null : `intake.md says ${f.intake?.decision}, not ${d}`);
const hasRequirements: Guard = (_j, f) =>
  (f.intake?.requirements ?? 0) > 0 ? null : "intake.md lists no requirements (`## Requirements`, R1…): the spec has nothing to cover";
const criteriaLint: Guard = (_j, f) => (f.intake?.criteria?.ok ? null : `inline criteria fail spec-lint: ${f.intake?.criteria?.reason ?? "no criteria"}`);
const setIntake = (j: Job, f: Facts) => {
  j.kind = f.intake?.kind ?? j.kind;
  j.risk = f.intake?.risk ?? j.risk;
  if (f.intake?.surfaces) j.surfaces = f.intake.surfaces;
};
const kindOf = (j: Job, f: Facts) => f.intake?.kind ?? j.kind;
const riskOf = (j: Job, f: Facts) => f.intake?.risk ?? j.risk;
const operatorIs = (o: "feedback" | "reject"): Guard => check((_j, f) => f.operator === o, `needs \`kitchen ${o}\``);
const specLint: Guard = (_j, f) => need(f.spec, "spec-lint") ?? (f.spec?.ok ? null : `spec-lint fails: ${f.spec?.reason ?? "?"}`);
const isBug = check(
  (j) => j.kind === "bug",
  (j) => `kind is ${j.kind}, not bug`,
);
const notBug = check((j) => j.kind !== "bug", "kind is bug: bugs go through repro");
/** Where `kitchen feedback` sends a needs-human job: `--to`, else the stage it escalated from, else build. */
export const feedbackTarget = (j: Pick<Job, "escalatedFrom">, f: Pick<Facts, "feedbackTo">): Stage => f.feedbackTo ?? j.escalatedFrom ?? "build";
/** Stages `kitchen feedback --to` may name (ADR 0007): none past verify, so gate, drives and verify always run again before ready. */
export const FEEDBACK_TO: readonly Stage[] = ["intake", "spec", "repro", "build", "drives", "verify"];
/** Why `--to <to>` is refused for a needs-human job, or null: it must be in FEEDBACK_TO and at or before the stage it escalated from. Pure. */
export function feedbackToRefusal(j: Pick<Job, "escalatedFrom">, to: Stage): string | null {
  const from = j.escalatedFrom ?? "build";
  if (!FEEDBACK_TO.includes(to)) return `--to ${to}: feedback goes to one of ${FEEDBACK_TO.join(", ")}, so the job is gated, driven and verified again`;
  if (STAGES.indexOf(to) > STAGES.indexOf(from)) return `--to ${to}: it is past ${from}, where the job escalated from; that would skip ${from}`;
  return null;
}
const resetBudget = (j: Job) => {
  j.round += 1;
  j.roundStart = j.round;
  j.attempts.drives = 0;
  j.attempts.inconclusive = 0;
  j.attempts.render = 0;
};
const verdictIs =
  (v: Verdict): Guard =>
  (_j, f) =>
    need(f.verify, "verify") ?? (f.verify?.verdict === v ? null : `verdict is ${f.verify?.verdict}, not ${v}`);
/** Ready synced the branch with a moved base: the job's base, and its toolkitRef when it moves with it (PLAN §2 lifecycle). */
const synced = (j: Job, f: Facts) => {
  if (f.ready?.newBase) j.base = f.ready.newBase;
  if (f.ready?.toolkitRef) j.toolkitRef = f.ready.toolkitRef;
  readyPr(j, f);
};
/** The job PR Ready published HEAD to. */
const readyPr = (j: Job, f: Facts) => {
  if (f.ready?.pr !== undefined && f.ready.pr !== null) j.pr = f.ready.pr;
};
/** The pause a job takes when it needs the running app and there is no Toolkit (ADR 0010). */
export const noToolkitReason = (id: string) =>
  `This ticket needs Kitchen to drive the app; run \`kitchen toolkit build\` (about 3–15 min), then \`kitchen resume ${id}\`.`;
const needsToolkit: Guard = (j, f) =>
  !f.noToolkit
    ? "the job has a Toolkit"
    : f.noToolkit.highRisk || f.noToolkit.unprovable || (!j.checksOnly && f.noToolkit.needsApp.length)
      ? null
      : j.checksOnly
        ? "the person chose to go on with checks and tests only"
        : "no criterion needs the running app";
/** Without a Toolkit, a criterion that drives the app stops the job here unless the person chose checks only (review L3). */
const notWaitingForToolkit: Guard = (j, f) =>
  f.noToolkit && (f.noToolkit.highRisk || f.noToolkit.unprovable || (f.noToolkit.needsApp.length && !j.checksOnly))
    ? `no Toolkit, and ${f.noToolkit.unprovable ?? (f.noToolkit.highRisk ? "the job is high risk" : `${f.noToolkit.needsApp.join(", ")} drive the app`)}: it waits for one`
    : null;
const pauseNoToolkit = (j: Job, f: Facts) => {
  pause("no-toolkit", noToolkitReason(j.id))(j, f);
};
const pause = (waitFor: WaitFor, why: string) => (j: Job, f: Facts) => {
  j.pausedFrom = j.stage;
  j.waitFor = waitFor;
  j.until = f.adapter?.until ?? f.ready?.until;
  j.pausedReason = why;
};

// ---- the table ------------------------------------------------------------

export const TABLE: readonly Row[] = [
  // intake
  {
    id: "intake>spec",
    from: "intake",
    to: "spec",
    when: "ACCEPT, risk medium or high, intake.md lists the requirements (a bug at medium/high goes spec → repro)",
    guard: all(
      intakeIs("ACCEPT"),
      check(
        (j, f) => riskOf(j, f) === "medium" || riskOf(j, f) === "high",
        (j, f) => `risk is ${riskOf(j, f)}: low skips spec`,
      ),
      hasRequirements,
    ),
    apply: setIntake,
  },
  {
    id: "intake>build",
    from: "intake",
    to: "build",
    when: "ACCEPT, kind≠bug, risk low, inline criteria pass spec-lint",
    guard: all(
      intakeIs("ACCEPT"),
      check((j, f) => kindOf(j, f) !== "bug", "kind is bug: bugs go to repro"),
      check(
        (j, f) => riskOf(j, f) === "low",
        (j, f) => `risk is ${riskOf(j, f)}: only low skips spec`,
      ),
      criteriaLint,
      notWaitingForToolkit,
    ),
    apply: setIntake,
  },
  {
    id: "intake>repro",
    from: "intake",
    to: "repro",
    when: "ACCEPT, kind=bug, risk low, inline criteria pass spec-lint",
    guard: all(
      intakeIs("ACCEPT"),
      check(
        (j, f) => kindOf(j, f) === "bug",
        (j, f) => `kind is ${kindOf(j, f)}, not bug`,
      ),
      check(
        (j, f) => riskOf(j, f) === "low",
        (j, f) => `risk is ${riskOf(j, f)}: a medium/high bug goes through spec first`,
      ),
      criteriaLint,
      notWaitingForToolkit,
    ),
    apply: setIntake,
  },
  {
    id: "intake>needs-info",
    from: "intake",
    to: "needs-info",
    when: "DECISION: NEEDS-INFO",
    guard: intakeIs("NEEDS-INFO"),
    apply: (j, f) => {
      j.pausedReason = f.why ?? "question for the author";
    },
  },
  {
    id: "intake>rejected",
    from: "intake",
    to: "rejected",
    when: "DECISION: REJECT",
    guard: intakeIs("REJECT"),
    apply: (j, f) => {
      j.pausedReason = f.why;
    },
  },
  {
    id: "intake>paused",
    from: "intake",
    to: "paused",
    when: "ACCEPT, no Toolkit, and an inline criterion's proof drives the app (unless the person chose checks only): waits for `kitchen toolkit build` (no-toolkit)",
    guard: all(intakeIs("ACCEPT"), needsToolkit),
    apply: (j, f) => {
      setIntake(j, f);
      pauseNoToolkit(j, f);
    },
  },
  // needs-info
  {
    id: "needs-info>intake",
    from: "needs-info",
    to: "intake",
    when: "the author or operator replied (the source says so)",
    guard: check((_j, f) => !!f.replied, "no reply from the author or operator yet"),
  },
  { id: "needs-info>rejected", from: "needs-info", to: "rejected", when: "`kitchen reject`", guard: operatorIs("reject") },
  // spec
  { id: "spec>repro", from: "spec", to: "repro", when: "kind=bug, spec-lint passes", guard: all(isBug, specLint, notWaitingForToolkit) },
  { id: "spec>build", from: "spec", to: "build", when: "kind≠bug, spec-lint passes", guard: all(notBug, specLint, notWaitingForToolkit) },
  {
    id: "spec>toolkit",
    from: "spec",
    to: "toolkit",
    when: "spec-lint finds a missing primitive, smith.attempts < 2",
    guard: all(
      check((_j, f) => !!f.spec?.missingPrimitive, "spec-lint names no missing primitive"),
      smithLeft,
    ),
    apply: (j, f) => toToolkit("spec", f.spec?.missingPrimitive)(j),
  },
  {
    id: "spec>paused",
    from: "spec",
    to: "paused",
    when: "no Toolkit, and the job is high risk or a criterion's proof drives the app (unless the person chose checks only): waits for `kitchen toolkit build` (no-toolkit)",
    guard: needsToolkit,
    apply: pauseNoToolkit,
  },
  // repro
  {
    id: "repro>build",
    from: "repro",
    to: "build",
    when: "the repro proof ran through `kitchen drive` on the base sha, failed as expected, and is committed",
    guard: (_j, f) =>
      need(f.repro, "repro") ??
      (!f.repro?.failedAsExpected
        ? "the repro did not fail as expected"
        : !f.repro.onBase
          ? "the repro did not run on the base sha"
          : !f.repro.committed
            ? "the repro is not committed"
            : null),
  },
  {
    id: "repro>toolkit",
    from: "repro",
    to: "toolkit",
    when: "the reproduction needs a primitive that doesn't exist (returnTo = repro)",
    guard: all(
      check((_j, f) => !!f.repro?.missingPrimitive, "repro names no missing primitive"),
      smithLeft,
    ),
    apply: (j, f) => toToolkit("repro", f.repro?.missingPrimitive)(j),
  },
  ...(["intake", "spec"] as const).map(
    (to): Row => ({
      id: `repro>${to}`,
      from: "repro",
      to,
      when: `the repro proof can't show the bug as written (a step failed before the expect, or it held on the base): the contract goes back once to ${to === "intake" ? "intake (risk low: inline criteria)" : "spec (risk medium/high)"} with the evidence`,
      guard: all(
        check((_j, f) => !!f.repro?.contractProblem && !f.repro.failedAsExpected && !f.repro.missingPrimitive, "the repro names no contract problem"),
        check((j) => (j.attempts.contract ?? 0) === 0, "the contract was already sent back once"),
        check(
          (j) => (j.risk === "low") === (to === "intake"),
          (j) => `risk ${j.risk}: the contract is ${j.risk === "low" ? "intake's" : "the spec's"}`,
        ),
      ),
      apply: (j) => {
        j.attempts.contract = (j.attempts.contract ?? 0) + 1;
        j.attempts.repro = 0;
      },
    }),
  ),
  {
    id: "repro>repro",
    from: "repro",
    to: "repro",
    when: "no reproduction on the first try: one more try",
    guard: all(
      check((_j, f) => !!f.repro && !f.repro.failedAsExpected && !f.repro.missingPrimitive, "the repro reproduced (or names a gap)"),
      check((j) => j.attempts.repro + 1 < 2, "second try failed: goes to needs-info"),
    ),
    apply: (j) => {
      j.attempts.repro += 1;
    },
  },
  {
    id: "repro>needs-info",
    from: "repro",
    to: "needs-info",
    when: "no reproduction after 2 tries; the author gets a question with the evidence",
    guard: all(
      check((_j, f) => !!f.repro && !f.repro.failedAsExpected && !f.repro.missingPrimitive, "the repro reproduced (or names a gap)"),
      check(
        (j) => j.attempts.repro + 1 >= 2,
        (j) => `only ${j.attempts.repro + 1} try so far`,
      ),
    ),
    apply: (j) => {
      j.attempts.repro += 1;
      j.pausedReason = "could not reproduce after 2 tries";
    },
  },
  // build
  {
    id: "build>gate",
    from: "build",
    to: "gate",
    when: "build.md STATUS: READY, the engine committed (and pushed, and the draft PR exists, unless the forge is local)",
    guard: (_j, f) =>
      need(f.build, "build") ??
      (f.build?.status !== "READY"
        ? `build.md says ${f.build?.status}`
        : !f.build.committed
          ? "nothing committed on the job branch"
          : !f.build.localForge && !f.build.pushed
            ? "not pushed"
            : !f.build.localForge && f.build.pr === null
              ? "no draft PR"
              : null),
    apply: (j, f) => {
      j.pr = f.build?.pr ?? j.pr;
    },
  },
  {
    id: "build>needs-human",
    from: "build",
    to: "needs-human",
    when: "build.md STATUS: BLOCKED, or a sync merge whose resolution the layer rules would cut a base change from (the merge is aborted)",
    guard: check((_j, f) => f.build?.status === "BLOCKED" || !!f.build?.syncRefused?.length, "build.md is not BLOCKED and the sync kept every base change"),
    apply: (j, f) => {
      j.pausedReason = f.why ?? (f.build?.syncRefused?.length ? `sync merge aborted: ${f.build.syncRefused.join(", ")}` : "builder blocked");
    },
  },
  // gate
  {
    id: "gate>drives",
    from: "gate",
    to: "drives",
    when: "gate.md for this HEAD: PASS. Risk floor raised from the diff",
    guard: (_j, f) =>
      need(f.gate, "gate") ??
      (f.gate?.head !== f.gate?.currentHead
        ? `gate.md is for ${f.gate?.head.slice(0, 8)}, HEAD is ${f.gate?.currentHead.slice(0, 8)}`
        : f.gate?.result !== "PASS"
          ? "gate FAIL"
          : null),
    apply: (j, f) => {
      j.riskFloor = maxRisk(j.riskFloor, f.gate?.riskFloor ?? null);
    },
  },
  {
    id: "gate>build",
    from: "gate",
    to: "build",
    when: "gate.md for this HEAD: FAIL (costs a round)",
    guard: all(
      (_j, f) =>
        need(f.gate, "gate") ?? (f.gate?.head !== f.gate?.currentHead ? "gate.md is not for this HEAD" : f.gate?.result !== "FAIL" ? "gate PASS" : null),
      roundLeft,
    ),
    apply: (j, f) => {
      newRound(j);
      j.riskFloor = maxRisk(j.riskFloor, f.gate?.riskFloor ?? null);
    },
  },
  // drives
  {
    id: "drives>verify",
    from: "drives",
    to: "verify",
    when: "gate still valid (only features/*.md since), every spec drive resolves on HEAD, toolkit check --feature passes",
    guard: (_j, f) =>
      need(f.drives, "drives") ??
      (!f.drives?.gateValid
        ? "commits since gate touch more than features/*.md: gate again"
        : !f.drives.resolved
          ? "a drive named in the spec does not resolve on HEAD"
          : !f.drives.featureChecks
            ? "toolkit check --feature fails"
            : null),
    apply: (j) => {
      j.attempts.drives = 0;
    },
  },
  {
    id: "drives>gate",
    from: "drives",
    to: "gate",
    when: "commits since gate.md touch more than features/*.md: Gate runs again",
    guard: check((_j, f) => f.drives?.gateValid === false, "gate is still valid"),
  },
  {
    id: "drives>toolkit",
    from: "drives",
    to: "toolkit",
    when: "a feature drive needs a primitive that doesn't exist (returnTo = drives)",
    guard: all(
      check((_j, f) => !!f.drives?.missingPrimitive, "no missing primitive named"),
      smithLeft,
    ),
    apply: (j, f) => toToolkit("drives", f.drives?.missingPrimitive)(j),
  },
  {
    id: "drives>build",
    from: "drives",
    to: "build",
    when: "the verifier reports the feature unreachable, with stamped evidence (costs a round)",
    guard: all(
      check((_j, f) => !!f.drives?.unreachable, "feature not reported unreachable"),
      roundLeft,
    ),
    apply: newRound,
  },
  {
    id: "drives>drives",
    from: "drives",
    to: "drives",
    when: "writing a drive failed on a reachable feature: one more attempt",
    guard: all(
      check((_j, f) => !!f.drives?.writeFailed && !f.drives.unreachable, "no failed drive attempt"),
      check((j) => j.attempts.drives + 1 < 2, "second drive attempt failed: needs-human"),
    ),
    apply: (j) => {
      j.attempts.drives += 1;
    },
  },
  {
    id: "drives>needs-human",
    from: "drives",
    to: "needs-human",
    when: "two attempts at writing a drive fail on a reachable feature",
    guard: all(
      check((_j, f) => !!f.drives?.writeFailed && !f.drives.unreachable, "no failed drive attempt"),
      check(
        (j) => j.attempts.drives + 1 >= 2,
        (j) => `only ${j.attempts.drives + 1} failed attempt so far`,
      ),
    ),
    apply: (j) => {
      j.attempts.drives += 1;
      j.pausedReason = "two drive attempts failed on a reachable feature";
    },
  },
  // verify
  {
    id: "verify>review",
    from: "verify",
    to: "review",
    when: "mechanical proofs ran first, everything PASS, every citation stamped for this HEAD/round/criterion, manifest matches job.json",
    guard: all(verdictIs("PASS"), (_j, f) =>
      !f.verify?.mechanicalFirst
        ? "mechanical proofs did not run first"
        : !f.verify.citationsOk
          ? `a cited id is not stamped for this HEAD, round and criterion${f.verify.citationProblem ? ` (${f.verify.citationProblem})` : ""}`
          : !f.verify.manifestOk
            ? "manifest does not match job.json"
            : null,
    ),
    apply: (j) => {
      j.attempts.inconclusive = 0;
    },
  },
  { id: "verify>build", from: "verify", to: "build", when: "any FAIL (costs a round)", guard: all(verdictIs("FAIL"), roundLeft), apply: newRound },
  {
    id: "verify>verify",
    from: "verify",
    to: "verify",
    when: "INCONCLUSIVE: one free retry on a fresh instance (no round)",
    guard: all(
      verdictIs("INCONCLUSIVE"),
      check((j) => j.attempts.inconclusive === 0, "the free retry is used"),
    ),
    apply: (j) => {
      j.attempts.inconclusive = 1;
    },
  },
  {
    id: "verify>paused",
    from: "verify",
    to: "paused",
    when: "INCONCLUSIVE twice: a Toolkit ticket is filed and the job waits (no round)",
    guard: all(
      verdictIs("INCONCLUSIVE"),
      check((j) => j.attempts.inconclusive >= 1, "first INCONCLUSIVE gets the free retry"),
      check((j) => j.attempts.toolkitTicket === 0, "a Toolkit ticket was already filed: needs-human"),
      check((_j, f) => !!f.verify?.ticket, "no Toolkit ticket filed"),
    ),
    apply: (j, f) => {
      pause("toolkit-ticket", "INCONCLUSIVE twice: waiting on a Toolkit ticket")(j, f);
      j.toolkitTicketRef = f.verify?.ticket ?? null;
      j.attempts.toolkitTicket += 1;
      j.attempts.inconclusive = 0;
    },
  },
  {
    id: "verify>paused(no-toolkit)",
    from: "verify",
    to: "paused",
    when: "NO-TOOLKIT: without a Toolkit nothing proved the change (or a requirement): waits for `kitchen toolkit build`, never a pass",
    guard: all(
      verdictIs("NO-TOOLKIT"),
      check((_j, f) => !!f.noToolkit, "no noToolkit facts"),
    ),
    apply: (j, f) => {
      pauseNoToolkit(j, f);
      // Woken with a Toolkit, the job writes its feature drives first: they were never written without one (review R5).
      j.pausedFrom = "drives";
    },
  },
  {
    id: "verify>needs-human",
    from: "verify",
    to: "needs-human",
    when: "INCONCLUSIVE twice more after the Toolkit ticket closed",
    guard: all(
      verdictIs("INCONCLUSIVE"),
      check((j) => j.attempts.inconclusive >= 1, "first INCONCLUSIVE gets the free retry"),
      check((j) => j.attempts.toolkitTicket >= 1, "no Toolkit ticket yet: pause first"),
    ),
    apply: (j) => {
      j.pausedReason = "INCONCLUSIVE after the Toolkit ticket closed";
    },
  },
  {
    id: "verify>toolkit",
    from: "verify",
    to: "toolkit",
    when: "TOOLKIT-GAP with doctor=ok and the missing primitive named, smith.attempts < 2",
    guard: all(
      verdictIs("TOOLKIT-GAP"),
      check((_j, f) => !!f.verify?.doctorOk, "doctor is not ok: not a gap"),
      check((_j, f) => !!f.verify?.gapPrimitive, "the gap names no primitive"),
      smithLeft,
    ),
    apply: (j, f) => toToolkit("drives", f.verify?.gapPrimitive)(j),
  },
  {
    id: "toolkit>toolkit",
    from: "toolkit",
    to: "toolkit",
    when: "the engine's check of the smith's commit fails (or the smith gave up), smith.attempts < 2: the second try reads toolkit-check-<n>.json",
    guard: all((_j, f) => need(f.toolkit, "toolkit") ?? (f.toolkit?.checkPassed ? "the toolkit check passed" : null), smithLeft),
    apply: (j) => {
      j.smith.attempts += 1;
    },
  },
  // toolkit → returnTo
  ...(["spec", "repro", "drives"] as const).map(
    (to): Row => ({
      id: `toolkit>${to}`,
      from: "toolkit",
      to,
      when: `the smith's Toolkit PR passes toolkit check on main + that PR; back to returnTo (${to})`,
      guard: all(
        check(
          (j) => j.returnTo === to,
          (j) => `returnTo is ${j.returnTo}`,
        ),
        (_j, f) => need(f.toolkit, "toolkit") ?? (f.toolkit?.checkPassed ? null : "toolkit check fails on main + the Toolkit PR"),
      ),
      apply: (j, f) => {
        j.toolkitRef = f.toolkit?.sha ?? j.toolkitRef;
        j.smith.toolkitPr = f.toolkit?.pr ?? j.smith.toolkitPr;
        j.returnTo = null;
        j.gap = null;
      },
    }),
  ),
  // review
  {
    id: "review>ready",
    from: "review",
    to: "ready",
    when: "all lenses PASS, and a high-risk job has a Toolkit",
    guard: all(
      check((_j, f) => !!f.review?.pass, "a lens did not PASS"),
      check((_j, f) => !f.noToolkit?.highRisk, "a high-risk job needs a Toolkit before ready"),
    ),
  },
  {
    id: "review>paused",
    from: "review",
    to: "paused",
    when: "all lenses PASS but the job is high risk (the diff can raise it) and has no Toolkit: waits for `kitchen toolkit build` (no-toolkit)",
    guard: all(
      check((_j, f) => !!f.review?.pass, "a lens did not PASS"),
      check((_j, f) => !!f.noToolkit?.highRisk, "not a high-risk job without a Toolkit"),
    ),
    apply: pauseNoToolkit,
  },
  {
    id: "review>build",
    from: "review",
    to: "build",
    when: "a blocking finding the reviewer can show (costs a round)",
    guard: all(
      check((_j, f) => !!f.review?.blocking, "no blocking finding"),
      roundLeft,
    ),
    apply: newRound,
  },
  // ready
  {
    id: "ready>report",
    from: "ready",
    to: "report",
    when: "synced with base, HEAD pushed, CI green on it, Toolkit PR (if any) merged, gate PASS, base unmoved since verify",
    guard: (_j, f) => {
      const r = f.ready;
      if (!r) return "no ready facts";
      if (!r.synced || r.conflict) return "not synced with base";
      if (r.baseMoved) return "base moved since verify: re-verify";
      if (!r.pushed) return "HEAD is not pushed: CI and the report would be about an older commit";
      if (r.ci !== "pass" && r.ci !== "none") return `CI is ${r.ci}`;
      if (r.toolkitPr === "open" || r.toolkitPr === "closed") return `Toolkit PR ${r.toolkitPr}, not merged`;
      if (!r.gatePass) return "gate is not PASS on this HEAD";
      return null;
    },
    apply: readyPr,
  },
  {
    id: "ready>needs-human",
    from: "ready",
    to: "needs-human",
    when: "the job's Toolkit PR was closed without merging: its primitive will not reach the base",
    guard: check((_j, f) => f.ready?.toolkitPr === "closed", "the Toolkit PR is not closed"),
    apply: (j, f) => {
      j.pausedReason = f.why ?? `Toolkit PR ${j.smith.toolkitPr} was closed without merging`;
    },
  },
  {
    id: "ready>gate",
    from: "ready",
    to: "gate",
    when: "gate is not PASS on this HEAD (commits since gate.md touch more than features/*.md, e.g. a sync with a moved base): Gate runs again",
    guard: check((_j, f) => !!f.ready && !f.ready.gatePass && !f.ready.conflict, "gate is PASS on this HEAD"),
    apply: (j, f) => synced(j, f),
  },
  {
    id: "ready>drives",
    from: "ready",
    to: "drives",
    when: "base (or toolkitRef) moved since verify: drives (a check) and Verify re-run on the synced HEAD",
    guard: check((_j, f) => !!f.ready?.baseMoved && !f.ready.conflict, "base did not move"),
    apply: (j, f) => synced(j, f),
  },
  {
    id: "ready>paused",
    from: "ready",
    to: "paused",
    when: "CI still running, or the Toolkit PR not merged yet",
    guard: check((_j, f) => f.ready?.ci === "pending" || f.ready?.toolkitPr === "open", "neither CI pending nor a Toolkit PR open"),
    apply: (j, f) => {
      readyPr(j, f);
      if (f.ready?.toolkitPr === "open") pause("toolkit-pr", "waiting for the Toolkit PR to merge")(j, f);
      else pause("ci", "waiting for CI")(j, f);
    },
  },
  {
    id: "ready>build",
    from: "ready",
    to: "build",
    when: "sync conflict, red CI, or a re-check that fails (costs a round)",
    guard: all(
      check((_j, f) => !!f.ready && (f.ready.conflict || f.ready.ci === "fail" || f.ready.recheckFailed), "no conflict, red CI or failed re-check"),
      roundLeft,
    ),
    apply: (j, f) => {
      readyPr(j, f);
      newRound(j);
    },
  },
  // paused
  ...(["intake", "spec", "repro", "build", "gate", "drives", "verify", "toolkit", "review", "ready", "report"] as const).map(
    (to): Row => ({
      id: `paused>${to}`,
      from: "paused",
      to,
      when: "the waitFor condition clears (or `kitchen resume`): back to pausedFrom",
      guard: all(
        check(
          (j) => j.pausedFrom === to,
          (j) => `paused from ${j.pausedFrom}, not ${to}`,
        ),
        check(
          (_j, f) => !!f.waitCleared || f.operator === "resume",
          (j) => `still waiting for ${j.waitFor}`,
        ),
        (j, f) =>
          !f.wake?.checksOnly
            ? null
            : effectiveRisk(j) === "high"
              ? "a high-risk job can't go on without a Toolkit"
              : !f.noToolkit
                ? "going on without a Toolkit needs the noToolkit facts (what checks can't prove: no-toolkit.ts needsToolkitToGoOn)"
                : f.noToolkit.unprovable
                  ? `it can't go on without a Toolkit: ${f.noToolkit.unprovable}`
                  : null,
      ),
      apply: (j, f) => {
        j.pausedFrom = undefined;
        j.waitFor = undefined;
        j.until = undefined;
        j.pausedReason = undefined;
        if (f.wake?.base) j.base = f.wake.base;
        if (f.wake?.toolkitRef) {
          j.toolkitRef = f.wake.toolkitRef;
          j.checksOnly = undefined;
        } else if (f.wake?.checksOnly) j.checksOnly = true;
      },
    }),
  ),
  // report
  {
    id: "report>done",
    from: "report",
    to: "done",
    when: "report.html rendered with every id resolved; evidence branch pushed, PR comment posted",
    guard: (_j, f) => {
      const r = f.report;
      if (!r) return "no report facts";
      if (!r.rendered || !r.idsResolved) return `report not rendered: ${r.refusal ?? "unresolved ids"}`;
      if (!r.localForge && (!r.evidencePushed || !r.commented)) return "evidence branch not pushed or PR comment not posted";
      return null;
    },
  },
  {
    id: "report>report",
    from: "report",
    to: "report",
    when: "rendering refused once: the report role writes it again",
    guard: all(
      check((_j, f) => !!f.report?.refusal, "rendering was not refused"),
      check((j) => j.attempts.render + 1 < 2, "refused twice: needs-human"),
    ),
    apply: (j) => {
      j.attempts.render += 1;
    },
  },
  {
    id: "report>needs-human",
    from: "report",
    to: "needs-human",
    when: "rendering refused twice",
    guard: all(
      check((_j, f) => !!f.report?.refusal, "rendering was not refused"),
      check((j) => j.attempts.render + 1 >= 2, "first refusal gets another try"),
    ),
    apply: (j, f) => {
      j.attempts.render += 1;
      j.pausedReason = `report refused twice: ${f.report?.refusal}`;
    },
  },
  // done
  {
    id: "done>build",
    from: "done",
    to: "build",
    when: "`kitchen feedback` or a trusted review comment on the PR; the round budget resets",
    guard: check(
      (_j, f) => f.operator === "feedback" || !!f.prComment?.trusted,
      (_j, f) =>
        f.prComment ? `PR comment ${f.prComment.id} by ${f.prComment.author} is not from a trusted person` : "needs `kitchen feedback` or a trusted PR comment",
    ),
    apply: resetBudget,
  },
  // any active stage
  {
    id: "*>paused",
    from: "*",
    to: "paused",
    when: "adapter rate limit or auth failure: retried with backoff, never needs-human",
    guard: all(
      check(
        (j) => isActive(j.stage),
        (j) => `${j.stage} runs no agent`,
      ),
      check((_j, f) => !!f.adapter?.rateLimited || !!f.adapter?.authFailure, "no rate limit or auth failure"),
      check((_j, f) => !!f.adapter?.until, "no backoff time"),
    ),
    apply: (j, f) => {
      pause("backoff", f.adapter?.rateLimited ? "rate limited" : "auth failure")(j, f);
      j.attempts.backoff += 1;
    },
  },
  {
    id: "*>paused(by-you)",
    from: "*",
    to: "paused",
    when: "`kitchen pause` (after the current step) or `kitchen stop` (its agent killed): parked until `kitchen resume`",
    guard: all(
      check(
        (j) => isActive(j.stage),
        (j) => `${j.stage} is not running: nothing to pause`,
      ),
      check((_j, f) => f.operator === "pause" || f.operator === "stop", "needs `kitchen pause` or `kitchen stop`"),
    ),
    apply: (j, f) => {
      j.pausedFrom = j.stage;
      j.waitFor = undefined;
      j.until = undefined;
      j.pausedReason = f.operator === "stop" ? BY_YOU_STOPPED : BY_YOU;
    },
  },
  {
    id: "*>needs-human",
    from: "*",
    to: "needs-human",
    when: "round limit, smith limit, an adapter error that repeats (not a rate limit), a stage whose result was refused twice, a review lens that said BLOCKING twice without a readable finding, or a required skill that is not installed (before any agent runs)",
    guard: all(
      check(
        (j) => isActive(j.stage),
        (j) => `${j.stage} is not an active stage`,
      ),
      (j, f) => {
        switch (f.escalate) {
          case "round-limit":
            return roundsUsed(j) >= j.roundLimit ? null : `round budget left: ${roundsUsed(j)} of ${j.roundLimit}`;
          case "smith-limit":
            return j.smith.attempts >= 2 ? null : `smith attempts left: ${j.smith.attempts} of 2`;
          case "adapter-error":
          case "engine-error":
            return j.attempts.errors + 1 >= 2 ? null : `first ${f.escalate} is retried`;
          case "refused":
            return j.attempts.refused + 1 >= 2 ? null : "first refused move is retried";
          case "review-unparseable":
            return j.stage === "review" ? null : "review-unparseable comes from review";
          case "skill-missing":
            return null;
          default:
            return "no escalation reason";
        }
      },
    ),
    apply: (j, f) => {
      j.pausedReason = `${f.escalate}${f.why ? `: ${f.why}` : ""}`;
    },
  },
  // needs-human: feedback goes back to the stage the job escalated from (ADR 0007), or where `--to` says
  ...ACTIVE.map(
    (to): Row => ({
      id: `needs-human>${to}`,
      from: "needs-human",
      to,
      when: `\`kitchen feedback\` on a job that escalated from ${to}${FEEDBACK_TO.includes(to) ? ` (or \`--to ${to}\` on one that escalated later)` : ""}; the round budget resets (not after a missing skill: no round was spent)`,
      guard: all(
        operatorIs("feedback"),
        (j, f) => (f.feedbackTo ? feedbackToRefusal(j, f.feedbackTo) : null),
        check(
          (j, f) => feedbackTarget(j, f) === to,
          (j, f) => `feedback goes to ${feedbackTarget(j, f)}${f.feedbackTo ? " (--to)" : j.escalatedFrom ? " (where it escalated from)" : ""}, not ${to}`,
        ),
      ),
      // A job that stopped for a missing skill spent no round on it: its budget stays as it was.
      apply: (j) => (j.pausedReason?.startsWith("skill-missing") ? undefined : resetBudget(j)),
    }),
  ),
  { id: "needs-human>rejected", from: "needs-human", to: "rejected", when: "`kitchen reject`", guard: operatorIs("reject") },
];

/**
 * Move `job` to `to` if a row allows it. Pure: returns a new job.
 * A refusal names the reason; `code` marks an escalation the caller should take (→ needs-human).
 */
export function move(job: Job, to: Stage, facts: Facts): MoveResult {
  // Rows for this exact `from` first, then the any-stage rows.
  const rows = [...TABLE.filter((r) => r.to === to && r.from === job.stage), ...TABLE.filter((r) => r.to === to && r.from === "*")];
  if (!rows.length) return { refused: `no move ${job.stage} → ${to}` };
  const reasons: Refusal[] = [];
  for (const row of rows) {
    const r = row.guard(job, facts);
    if (r) {
      reasons.push(typeof r === "string" ? { refused: r } : r);
      continue;
    }
    const next: Job = structuredClone(job);
    // The backoff counter survives a pause and its resume, so repeated rate limits back off longer;
    // the first move that is neither resets it.
    if (to !== "paused" && job.stage !== "paused") next.attempts.backoff = 0;
    next.escalatedFrom = to === "needs-human" ? job.stage : job.stage === "needs-human" ? undefined : job.escalatedFrom;
    next.attempts.errors = 0;
    next.attempts.refused = 0;
    row.apply?.(next, facts); // sees the stage being left, and the reason it waited
    if (!WAITING.includes(to)) next.pausedReason = undefined;
    next.stage = to;
    next.moves += 1;
    next.updatedAt = facts.now;
    if (to === "done") next.doneAt = facts.now;
    next.running = null;
    return { job: next, row: row.id };
  }
  const coded = reasons.find((r) => r.code);
  return { refused: `${job.stage} → ${to}: ${reasons.map((r) => r.refused).join("; ")}`, ...(coded ? { code: coded.code } : {}) };
}

/** Rows as plain data, for docs and `kitchen status --table`. */
export const tableRows = () => TABLE.map(({ id, from, to, when }) => ({ id, from, to, when }));
