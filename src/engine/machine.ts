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
/** Stages that carry a reason for whoever looks next. */
export const WAITING: readonly Stage[] = ["needs-info", "needs-human", "paused", "rejected"];

export type Risk = "low" | "medium" | "high";
export type Kind = "feature" | "bug" | "chore";
export type WaitFor = "backoff" | "toolkit-pr" | "ci" | "toolkit-ticket";
export type TicketRef = { source: "prompt" | "github"; id: string; url?: string };
export type AgentRunRef = {
  key: string;
  role: string;
  stage: Stage;
  round: number;
  adapter: string;
  model: string;
  sessionId?: string;
  ok: boolean;
  line: string;
  file?: string;
  usd?: number;
  secs: number;
  at: string;
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
  // proof fields (src/proof/job.ts)
  uid: string;
  gitDir: string;
  toolkitBin: string;
  slotId: string;
  manifestHead: ManifestHead;
};

export type Lint = { ok: boolean; reason?: string; missingPrimitive?: string };
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "TOOLKIT-GAP";
export type Escalation = "round-limit" | "smith-limit" | "adapter-error" | "engine-error" | "refused";

/** What guards read. Gathered by the caller (stage handlers, runner, CLI) from files, git and the forge. */
export type Facts = {
  now: string;
  intake?: { decision: "ACCEPT" | "NEEDS-INFO" | "REJECT"; kind?: Kind; risk?: Risk; surfaces?: ("ui" | "security")[]; criteria?: Lint };
  /** needs-info: the source shows an answer from the author or operator. */
  replied?: boolean;
  /** A human command. */
  operator?: "feedback" | "reject" | "resume";
  /** `kitchen feedback --to <stage>`: where a needs-human job goes instead of the stage it escalated from. */
  feedbackTo?: Stage;
  spec?: Lint;
  repro?: { failedAsExpected: boolean; onBase: boolean; committed: boolean; missingPrimitive?: string };
  build?: { status: "READY" | "BLOCKED"; committed: boolean; pushed: boolean; pr: number | null; localForge: boolean };
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
  review?: { pass: boolean; blocking?: string };
  ready?: {
    synced: boolean;
    conflict: boolean;
    ci: "none" | "pending" | "pass" | "fail";
    toolkitPr: "none" | "open" | "merged";
    gatePass: boolean;
    baseMoved: boolean;
    recheckFailed: boolean;
    /** The base tip the job branch was just synced with (the job's base from now on). */
    newBase?: string;
    /** toolkitRef after the sync: the new base when it has a Toolkit and no Toolkit PR is still open. */
    toolkitRef?: string;
  };
  report?: { rendered: boolean; idsResolved: boolean; evidencePushed: boolean; commented: boolean; localForge: boolean; refusal?: string };
  /** paused: the waitFor condition cleared. */
  waitCleared?: boolean;
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
};
const pause = (waitFor: WaitFor, why: string) => (j: Job, f: Facts) => {
  j.pausedFrom = j.stage;
  j.waitFor = waitFor;
  j.until = f.adapter?.until;
  j.pausedReason = why;
};

// ---- the table ------------------------------------------------------------

export const TABLE: readonly Row[] = [
  // intake
  {
    id: "intake>spec",
    from: "intake",
    to: "spec",
    when: "ACCEPT, risk medium or high (a bug at medium/high goes spec → repro)",
    guard: all(
      intakeIs("ACCEPT"),
      check(
        (j, f) => riskOf(j, f) === "medium" || riskOf(j, f) === "high",
        (j, f) => `risk is ${riskOf(j, f)}: low skips spec`,
      ),
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
  { id: "spec>repro", from: "spec", to: "repro", when: "kind=bug, spec-lint passes", guard: all(isBug, specLint) },
  { id: "spec>build", from: "spec", to: "build", when: "kind≠bug, spec-lint passes", guard: all(notBug, specLint) },
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
    when: "build.md STATUS: BLOCKED",
    guard: check((_j, f) => f.build?.status === "BLOCKED", "build.md is not BLOCKED"),
    apply: (j, f) => {
      j.pausedReason = f.why ?? "builder blocked";
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
  { id: "review>ready", from: "review", to: "ready", when: "all lenses PASS", guard: check((_j, f) => !!f.review?.pass, "a lens did not PASS") },
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
    when: "synced with base, CI green, Toolkit PR (if any) merged, gate PASS, base unmoved since verify",
    guard: (_j, f) => {
      const r = f.ready;
      if (!r) return "no ready facts";
      if (!r.synced || r.conflict) return "not synced with base";
      if (r.baseMoved) return "base moved since verify: re-verify";
      if (r.ci !== "pass" && r.ci !== "none") return `CI is ${r.ci}`;
      if (r.toolkitPr === "open") return "Toolkit PR not merged";
      if (!r.gatePass) return "gate is not PASS on this HEAD";
      return null;
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
    apply: (j, f) => (f.ready?.toolkitPr === "open" ? pause("toolkit-pr", "waiting for the Toolkit PR to merge")(j, f) : pause("ci", "waiting for CI")(j, f)),
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
    apply: newRound,
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
      ),
      apply: (j) => {
        j.pausedFrom = undefined;
        j.waitFor = undefined;
        j.until = undefined;
        j.pausedReason = undefined;
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
    guard: operatorIs("feedback"),
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
    id: "*>needs-human",
    from: "*",
    to: "needs-human",
    when: "round limit, smith limit, an adapter error that repeats (not a rate limit), or a stage whose result was refused twice",
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
      when: `\`kitchen feedback\` on a job that escalated from ${to}${FEEDBACK_TO.includes(to) ? ` (or \`--to ${to}\` on one that escalated later)` : ""}; the round budget resets`,
      guard: all(
        operatorIs("feedback"),
        (j, f) => (f.feedbackTo ? feedbackToRefusal(j, f.feedbackTo) : null),
        check(
          (j, f) => feedbackTarget(j, f) === to,
          (j, f) => `feedback goes to ${feedbackTarget(j, f)}${f.feedbackTo ? " (--to)" : j.escalatedFrom ? " (where it escalated from)" : ""}, not ${to}`,
        ),
      ),
      apply: resetBudget,
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
    if (!WAITING.includes(to)) next.pausedReason = undefined;
    // The backoff counter survives a pause and its resume, so repeated rate limits back off longer;
    // the first move that is neither resets it.
    if (to !== "paused" && job.stage !== "paused") next.attempts.backoff = 0;
    next.escalatedFrom = to === "needs-human" ? job.stage : job.stage === "needs-human" ? undefined : job.escalatedFrom;
    next.attempts.errors = 0;
    next.attempts.refused = 0;
    row.apply?.(next, facts); // sees the stage being left
    next.stage = to;
    next.moves += 1;
    next.updatedAt = facts.now;
    next.running = null;
    return { job: next, row: row.id };
  }
  const coded = reasons.find((r) => r.code);
  return { refused: `${job.stage} → ${to}: ${reasons.map((r) => r.refused).join("; ")}`, ...(coded ? { code: coded.code } : {}) };
}

/** Rows as plain data, for docs and `kitchen status --table`. */
export const tableRows = () => TABLE.map(({ id, from, to, when }) => ({ id, from, to, when }));
