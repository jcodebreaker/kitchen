// What the dashboard shows (dashboard/dashboard.html), read from `.kitchen/` only:
// job.json, the latest verdict and review of each job, report.html's presence, the
// ledger (cost, moves, the §0 measures), the run lock, the retro's mutes, and the live
// line of the agent working on each job. Read-only.
import fs from "node:fs";
import path from "node:path";
import { type Config, loadConfig, modelFor } from "../config.ts";
import { runningNow } from "../engine/control.ts";
import { readRunLock, staleReason } from "../engine/lock.ts";
import { BY_YOU_STOPPED, isActive, type Job, maxRisk, pausedByYou, type Risk, type Stage } from "../engine/machine.ts";
import { JOB_ID, jobDirOf, scanJobs } from "../engine/store.ts";
import { liveDiffStat } from "../engine/worktree.ts";
import { type LedgerLine, readLedger } from "../ledger/append.ts";
import { measures } from "../ledger/measures.ts";
import { readRetroState } from "../retro/state.ts";
import { noToolkitWords, type ToolkitState, toolkitLabel, toolkitState } from "../toolkit/approve.ts";
import { provenFile } from "../toolkit/check.ts";
import { activityOf, type Ev } from "./activity.ts";

export type Chip = { id: string; result: string };
/** Every stage as the page names it: the one list the timeline, the track and the composer read. */
export const STAGE_NAMES: Record<Stage, string> = {
  intake: "Intake",
  "needs-info": "Needs you",
  spec: "Spec",
  repro: "Repro",
  build: "Build",
  gate: "Gate",
  drives: "Drives",
  verify: "Verify",
  toolkit: "Toolkit",
  review: "Review",
  ready: "Ready",
  report: "Report",
  done: "Done",
  "needs-human": "Needs you",
  paused: "Paused",
  rejected: "Rejected",
};
/** The six steps of the stage track, each with the stages it folds in, the way a person reads a job. */
export const PHASES = [
  { k: "intake", nm: "Intake", stages: ["intake", "needs-info", "spec", "repro"] },
  { k: "build", nm: "Build", stages: ["build"] },
  { k: "gate", nm: "Gate", stages: ["gate"] },
  { k: "verify", nm: "Verify", stages: ["drives", "verify", "toolkit"] },
  { k: "review", nm: "Review", stages: ["review"] },
  { k: "report", nm: "Report", stages: ["ready", "report", "done"] },
] as const satisfies readonly { k: string; nm: string; stages: readonly Stage[] }[];
export type Phase = (typeof PHASES)[number]["k"];
/** Who works in a stage, as the page names it; null: Kitchen itself (an automatic step, no agent). */
const AGENT: Partial<Record<Stage, string>> = {
  intake: "Intake agent",
  spec: "Spec agent",
  repro: "Repro agent",
  build: "Build agent",
  drives: "Verify agent",
  toolkit: "Toolkit smith",
  review: "Review agents",
  report: "Report agent",
};
/**
 * The stage a job's track and agent are read from: where it paused or escalated from, else where it is.
 * `from`: the stage of the move that brought it here (the ledger), for a needs-info job (intake or repro asks).
 */
export function workStage(j: Pick<Job, "stage" | "pausedFrom" | "escalatedFrom">, from?: string): Stage {
  if (j.stage === "paused") return j.pausedFrom ?? "intake";
  if (j.stage === "needs-info") return from === "repro" ? "repro" : "intake";
  if (j.stage === "needs-human" || j.stage === "rejected") return j.escalatedFrom ?? "intake";
  return j.stage;
}
export const phaseOf = (s: Stage): Phase => PHASES.find((p) => (p.stages as readonly Stage[]).includes(s))?.k ?? "intake";
export const agentOf = (s: Stage): string | null => AGENT[s] ?? null;
export type JobState = "you" | "run" | "paused" | "done" | "rejected";
/** AUTH_FAILURE: the pause reason machine.ts gives a backoff after the agent's login failed. */
export const AUTH_FAILURE = "auth failure";
/**
 * A pause only the person can end, or null: a Toolkit to build (ADR 0010), the agent's login to fix
 * (a backoff after an auth failure), a Toolkit PR to merge. A rate-limit backoff ends by itself.
 */
export function waitYouOf(j: Pick<Job, "stage" | "waitFor" | "pausedReason">): "no-toolkit" | "auth" | "toolkit-pr" | null {
  if (j.stage !== "paused") return null;
  if (j.waitFor === "no-toolkit" || j.waitFor === "toolkit-pr") return j.waitFor;
  return j.waitFor === "backoff" && j.pausedReason === AUTH_FAILURE ? "auth" : null;
}
export function stateOf(j: Pick<Job, "stage" | "waitFor" | "pausedReason">): JobState {
  if (j.stage === "needs-info" || j.stage === "needs-human") return "you";
  // Waiting on something only the person can do: theirs to act on, not a pause of theirs.
  if (waitYouOf(j)) return "you";
  if (j.stage === "paused") return "paused";
  if (j.stage === "done") return "done";
  if (j.stage === "rejected") return "rejected";
  return "run";
}
/**
 * The Board's lanes (ADR 0013), left to right: Needs you first, then the stages a job works through,
 * Ready (ready to merge) and Done (closed: rejected or stopped; merges come later).
 */
export const LANES = [
  { k: "you", nm: "Needs you" },
  { k: "intake", nm: "Intake" },
  { k: "build", nm: "Build" },
  { k: "check", nm: "Check" },
  { k: "review", nm: "Review" },
  { k: "ready", nm: "Ready" },
  { k: "done", nm: "Done" },
] as const;
export type Lane = (typeof LANES)[number]["k"];
const LANE_OF: Partial<Record<Stage, Lane>> = {
  intake: "intake",
  spec: "intake",
  repro: "intake",
  build: "build",
  gate: "check",
  drives: "check",
  verify: "check",
  toolkit: "check",
  review: "review",
  ready: "ready",
  report: "ready",
  done: "ready",
};
/**
 * A job's lane on the Board. Pure. Needs you: whatever is the person's to act on (a question, an
 * escalation, a Toolkit to build). Done: closed, rejected or stopped by you. A job paused by you, or
 * waiting on something else, stays in the lane of the stage it paused in.
 */
export function laneOf(j: Pick<Job, "stage" | "waitFor" | "pausedFrom" | "escalatedFrom" | "pausedReason">, from?: string): Lane {
  if (stateOf(j) === "you") return "you";
  if (j.stage === "rejected" || (pausedByYou(j) && j.pausedReason === BY_YOU_STOPPED)) return "done";
  return LANE_OF[workStage(j, from)] ?? "intake";
}
/** Who works in each lane, as its header says: the models this repo's kitchen.yaml runs, `engine` for Kitchen's own steps. */
export function laneWho(cfg: Config | null): Record<Lane, string> {
  const m = (role: string, fallback: string) => (cfg ? modelFor(cfg, role) : fallback);
  return {
    you: "you",
    intake: m("intake", "intake agent"),
    build: m("builder", "build agent"),
    check: `engine + ${m("verifier", "verifier")}`,
    review: m("reviewer", "review agents"),
    ready: "engine",
    done: "closed",
  };
}
/** The job's real risk: intake's call, raised by the gate's floor. Null until intake has decided. */
export const riskOf = (j: Pick<Job, "risk" | "riskFloor">): Risk | null => maxRisk(j.risk ?? null, j.riskFloor ?? null);
/** The card's proof pill, from the latest verdict: pass, fail, or not proven yet (none, inconclusive, a gap). Rejected: none. */
export function proofOf(stage: Stage, verdict: string | null): "pass" | "fail" | "not proven" | null {
  if (stage === "rejected") return null;
  return verdict === "PASS" ? "pass" : verdict === "FAIL" ? "fail" : "not proven";
}
/**
 * What a job that needs you asks: intake's question (question.md), or why it escalated. A no-toolkit wait says
 * what to do from where the Toolkit stands now (`tk`, read from the repo when not given; ADR 0015).
 */
export function questionOf(j: Job, dir: string, tk?: ToolkitState): string | null {
  if (j.stage === "needs-info") {
    try {
      const q = fs
        .readFileSync(path.join(dir, "question.md"), "utf8")
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim();
      if (q) return q;
    } catch {}
  }
  const w = waitYouOf(j);
  if (w === "no-toolkit") return noToolkitWords(tk ?? toolkitState(path.resolve(dir, "..", "..", "..")));
  if (w === "auth") return "The agent could not log in (auth failure). Log in to its CLI again, then Resume.";
  if (w === "toolkit-pr") return "Waiting for the Toolkit PR to merge. Merge it and the job goes on by itself, or Resume to try now.";
  return j.stage === "needs-info" || j.stage === "needs-human" ? (j.pausedReason ?? "It needs your answer to go on.") : null;
}
/** The agent stream files of one stage entry, oldest first (activity/m<moves>-<role>-<t0>.jsonl). */
export function liveStreams(dir: string, moves: number): { role: string; file: string; t0: number }[] {
  const d = path.join(dir, "activity");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .flatMap((f) => {
      const m = /^m(\d+)-(.+)-(\d+)\.jsonl$/.exec(f);
      return m && Number(m[1]) === moves ? [{ role: m[2], file: path.join(d, f), t0: Number(m[3]) }] : [];
    })
    .sort((a, b) => a.t0 - b.t0);
}

const DIFFS = new Map<string, { at: number; files: FileStat[] }>();
async function changesOf(j: Job, now: number): Promise<FileStat[]> {
  if (!j.worktree || !j.gitDir || !fs.existsSync(j.worktree)) return [];
  const c = DIFFS.get(j.id);
  if (c && now - c.at < (isActive(j.stage) ? 2500 : 60_000)) return c.files;
  const files = await liveDiffStat(j).catch(() => c?.files ?? []);
  DIFFS.set(j.id, { at: now, files });
  return files;
}
export type FileStat = { p: string; a: number; d: number };
export type JobCard = {
  id: string;
  title: string;
  stage: string;
  paused: string | null;
  reason: string | null;
  /** The job's real risk (riskOf), null until intake decides. */
  risk: Risk | null;
  kind: string | null;
  /** job.json's round: the one evidence is stamped with, the timeline shows and a follow-up adds to. */
  round: number;
  roundLimit: number;
  verdict: string | null;
  criteria: Chip[];
  review: { result: string; blocking: number; notes: number } | null;
  usd: number;
  /** The job's age: from its ticket to now, or to when it ended. */
  secs: number;
  startedAt: string;
  updatedAt: string;
  /** When the job entered the stage it is in (its last `move` ledger line; startedAt before any). */
  movedAt: string;
  /** A paused job: how long it ran in the stage it paused in (its row's frozen timer). */
  pausedSecs: number | null;
  /** What it is doing now: the stage a runner is running, and its last ledger line (a proof, an agent, a move). */
  step: string | null;
  active: boolean;
  pr: number | null;
  report: string | null;
  /** The job's branch (kitchen/<id>): a done job's panel shows it, with a copy button. */
  branch: string;
  // ADR 0009: what the interactive page needs
  state: JobState;
  phase: Phase;
  /** Who works in the job's stage (null: an automatic step). */
  agent: string | null;
  /** A job that needs you: what it asks. */
  q: string | null;
  /** Paused by a person: "pause" or "stop". */
  pausedBy: "pause" | "stop" | null;
  /** Paused no-toolkit (ADR 0010): the person builds the Toolkit, or resumes it to go on with checks and tests only. */
  needsToolkit: boolean;
  /** Waiting no-toolkit while a proven Toolkit waits for approval: the Approve Toolkit button (ADR 0015). */
  tkApprove: boolean;
  /** Paused on something only the person can do (waitYouOf): a Toolkit to build, a login to fix, a Toolkit PR to merge. */
  waitYou: "no-toolkit" | "auth" | "toolkit-pr" | null;
  /** The last thing the agent working on it now did. */
  live: Ev | null;
  /** A runner is working on it right now. */
  runnerOn: boolean;
  /** Files changed from the base (worktree as it is now). */
  files: FileStat[];
  doneAt: string | null;
  /** The Board lane it sits in (laneOf). */
  lane: Lane;
  /** Its proof so far (proofOf). */
  proof: "pass" | "fail" | "not proven" | null;
};

export type Snapshot = {
  repo: string;
  at: string;
  /** Spent, from the ledger's every line with a cost (jobs, setup, retro): today (local day) and in all. */
  usdToday: number;
  usdTotal: number;
  tool: string | null;
  toolkitProven: boolean;
  /** Where the Toolkit stands (toolkit/approve.ts): the sidebar's word, and the sha waiting for approval. */
  toolkit: { state: ToolkitState["state"]; label: string; sha: string | null };
  runner: { running: boolean; text: string };
  phases: { k: Phase; nm: string }[];
  /** The Board's lanes in order, each with who works there. */
  lanes: { k: Lane; nm: string; who: string }[];
  jobs: JobCard[];
  corrupt: string[];
  summary: {
    takenIn: number;
    mergeReady: number;
    firstPass: number;
    verified: number;
    roundsMean: number;
    usd: number;
    medianUsd: number;
    medianSecs: number;
    inconclusive: number;
    proofRuns: number;
    inconclusiveVerdicts: number;
    verdicts: number;
    flaky: number;
    groups: number;
    gapsPerJob: number;
    escalations: { code: string; to: string; n: number }[];
    mutes: string[];
  };
};

/** The newest verdict-m<N>.md of the job's latest round with one: the verdict and one chip per criterion. Pure over the text. */
export function parseVerdict(text: string): { verdict: string | null; criteria: Chip[] } {
  const verdict = /^VERDICT:\s*([A-Z-]+)/m.exec(text)?.[1] ?? null;
  const criteria: Chip[] = [];
  for (const m of text.matchAll(/^\|\s*(C\d+)\s*\|[^|]*\|\s*([A-Z-]+)/gm)) criteria.push({ id: m[1], result: m[2] });
  return { verdict, criteria };
}

function latest(dir: string, re: RegExp, round?: number): string | null {
  const rounds = path.join(dir, "rounds");
  if (!fs.existsSync(rounds)) return null;
  for (const r of fs
    .readdirSync(rounds)
    .filter((x) => /^\d+$/.test(x) && (round === undefined || Number(x) === round))
    .sort((a, b) => Number(b) - Number(a))) {
    const files = fs
      .readdirSync(path.join(rounds, r))
      .filter((f) => re.test(f))
      .sort((a, b) => Number(/\d+/.exec(b)?.[0] ?? 0) - Number(/\d+/.exec(a)?.[0] ?? 0));
    if (files.length) return path.join(rounds, r, files[0]);
  }
  return null;
}

/** One ledger line, as a card's "now" line: `proof C2 PASS (login → settings.open)`, `builder ok`, `moved verify → review`. Pure. */
export function stepOf(l: LedgerLine): string {
  const d = l.detail ?? {};
  if (l.event === "proof") {
    const drives = Array.isArray(d.drives) ? (d.drives as string[]).join(" → ") : "";
    return `proof ${String(d.criterion ?? "?")} ${String(l.result ?? "")}${drives ? ` (${drives})` : ""}`.trim();
  }
  if (l.event === "agent") return `${l.role ?? "agent"} ${String(l.result ?? "")}`.trim();
  if (l.event === "move") return `moved ${l.stage} → ${String(l.result ?? "?")}`;
  return `${l.event}${l.result ? ` ${String(l.result)}` : ""}`;
}

export async function snapshot(repo: string, now = Date.now()): Promise<Snapshot> {
  const lines = readLedger(repo);
  const m = measures(lines);
  const lastLine = new Map<string, LedgerLine>();
  /** Each job's last two moves: the one into its stage, and the one before (a paused job's frozen timer). */
  const moves = new Map<string, LedgerLine[]>();
  for (const l of lines) {
    lastLine.set(l.job, l);
    if (l.event === "move") moves.set(l.job, [...(moves.get(l.job) ?? []), l].slice(-2));
  }
  const usdOf = new Map(m.jobs.map((j) => [j.job, j.usd]));
  const tk = toolkitState(repo);
  const jobs: JobCard[] = [];
  const corrupt: string[] = [];
  for (const e of scanJobs(repo)) {
    // The id goes into the page's markup and URLs: only ever the engine's own shape.
    if (!e.job || !JOB_ID.test(e.job.id)) {
      corrupt.push(e.id);
      continue;
    }
    const j = e.job;
    const dir = jobDirOf(repo, j.id);
    const vf = latest(dir, /^verdict-m\d+\.md$/);
    const v = vf ? parseVerdict(fs.readFileSync(vf, "utf8")) : { verdict: null, criteria: [] };
    // The proof pill reads this round only: a PASS from an earlier round proves nothing about the code now.
    const vNow = latest(dir, /^verdict-m\d+\.md$/, j.round);
    const rf = latest(dir, /^review\.json$/);
    let review: JobCard["review"] = null;
    if (rf)
      try {
        const r = JSON.parse(fs.readFileSync(rf, "utf8")) as { findings: { blocks: boolean }[] };
        const blocking = r.findings.filter((f) => f.blocks).length;
        review = { result: blocking ? "BLOCKING" : "PASS", blocking, notes: r.findings.length - blocking };
      } catch {}
    const active = isActive(j.stage) || j.stage === "paused";
    const end = active ? now : Date.parse(j.updatedAt);
    const cur = isActive(j.stage) ? liveStreams(dir, j.moves).at(-1) : undefined;
    const [prev, last] = (moves.get(j.id) ?? []).length === 2 ? (moves.get(j.id) as LedgerLine[]) : [undefined, moves.get(j.id)?.[0]];
    const movedAt = last?.t ?? j.startedAt;
    const stage = workStage(j, last?.stage);
    jobs.push({
      id: j.id,
      title: j.title,
      stage: j.stage,
      paused: j.stage === "paused" ? `${j.waitFor ?? "paused"}${j.pausedFrom ? ` (from ${j.pausedFrom})` : ""}` : null,
      reason: j.pausedReason ?? null,
      risk: riskOf(j),
      kind: j.kind ?? null,
      round: j.round,
      roundLimit: j.roundLimit,
      verdict: v.verdict,
      criteria: v.criteria,
      review,
      usd: usdOf.get(j.id) ?? 0,
      secs: Math.max(0, Math.round((end - Date.parse(j.startedAt)) / 1000)),
      startedAt: j.startedAt,
      updatedAt: j.updatedAt,
      movedAt,
      pausedSecs: j.stage === "paused" ? Math.max(0, Math.round((Date.parse(movedAt) - Date.parse(prev?.t ?? j.startedAt)) / 1000)) : null,
      step:
        [j.running ? `running ${j.running.stage}` : null, lastLine.has(j.id) ? stepOf(lastLine.get(j.id) as LedgerLine) : null].filter(Boolean).join(" · ") ||
        null,
      active,
      pr: j.pr,
      report: fs.existsSync(path.join(dir, "report.html")) ? `jobs/${encodeURIComponent(j.id)}/report.html` : null,
      branch: j.branch,
      state: stateOf(j),
      phase: phaseOf(stage),
      agent: agentOf(stage),
      q: questionOf(j, dir, tk),
      // A proven Toolkit waits for the person: the row, card and panel offer Approve Toolkit (ADR 0015).
      tkApprove: j.stage === "paused" && j.waitFor === "no-toolkit" && tk.state === "waiting",
      pausedBy: pausedByYou(j) ? (j.pausedReason === BY_YOU_STOPPED ? "stop" : "pause") : null,
      needsToolkit: j.stage === "paused" && j.waitFor === "no-toolkit",
      waitYou: waitYouOf(j),
      live: (cur ? activityOf(cur.file, [j.worktree, repo]) : []).at(-1) ?? null,
      runnerOn: runningNow(j),
      files: await changesOf(j, now),
      doneAt: j.doneAt ?? null,
      lane: laneOf(j, last?.stage),
      proof: proofOf(j.stage, vNow ? parseVerdict(fs.readFileSync(vNow, "utf8")).verdict : null),
    });
  }
  const lock = readRunLock(repo);
  const stale = lock ? staleReason(lock.info, now) : null;
  const done = m.jobs.filter((j) => j.done);
  const today = new Date(now).toDateString();
  const priced = lines.filter((l) => typeof l.usd === "number");
  let cfg: Config | null = null;
  try {
    cfg = loadConfig(repo);
  } catch {}
  const tool = cfg?.agent.tool ?? null;
  const who = laneWho(cfg);
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  return {
    repo: path.basename(repo),
    at: new Date(now).toISOString(),
    usdToday: priced.filter((l) => new Date(l.t).toDateString() === today).reduce((a, l) => a + (l.usd as number), 0),
    usdTotal: priced.reduce((a, l) => a + (l.usd as number), 0),
    tool,
    toolkitProven: fs.existsSync(provenFile(repo)),
    toolkit: { state: tk.state, label: toolkitLabel(tk), sha: tk.sha ?? null },
    runner:
      lock && !stale ? { running: true, text: `running, pid ${lock.info?.pid}` } : { running: false, text: stale ? `not running (${stale})` : "not running" },
    phases: PHASES.map((p) => ({ k: p.k, nm: p.nm })),
    lanes: LANES.map((l) => ({ k: l.k, nm: l.nm, who: who[l.k] })),
    jobs: jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    corrupt,
    summary: {
      takenIn: m.takenIn,
      mergeReady: m.mergeReady,
      firstPass: m.firstPass,
      verified: m.verified,
      roundsMean: m.rounds.mean,
      usd: m.usd,
      medianUsd: med(done.map((j) => j.usd)),
      medianSecs: med(done.map((j) => j.secs)),
      inconclusive: m.proofs.inconclusive,
      proofRuns: m.proofs.runs,
      inconclusiveVerdicts: m.verdicts.inconclusive,
      verdicts: m.verdicts.total,
      flaky: m.proofs.flakyGroups,
      groups: m.proofs.groups,
      gapsPerJob: m.gaps.perJob,
      escalations: m.escalations.map((e) => ({ code: e.code, to: e.to, n: e.n })),
      mutes: readRetroState(repo).mutes.map((x) => `${x.lens}/${x.category}`),
    },
  };
}
