// What the dashboard shows (dashboard/dashboard.html), read from `.kitchen/` only:
// job.json, the latest verdict and review of each job, report.html's presence, the
// ledger (cost, the §0 measures), the run lock, the retro's mutes, each job's
// steering thread and the live line of the agent working on it. Read-only.
import fs from "node:fs";
import path from "node:path";
import { runningNow } from "../engine/control.ts";
import { readRunLock, staleReason } from "../engine/lock.ts";
import { BY_YOU_STOPPED, isActive, type Job, pausedByYou, roundsUsed, type Stage } from "../engine/machine.ts";
import { readMessages } from "../engine/messages.ts";
import { jobDirOf, scanJobs } from "../engine/store.ts";
import { liveDiffStat } from "../engine/worktree.ts";
import { type LedgerLine, readLedger } from "../ledger/append.ts";
import { measures } from "../ledger/measures.ts";
import { readRetroState } from "../retro/state.ts";
import { activityOf, type Ev } from "./activity.ts";

/** The board's columns, left to right; a paused job sits in the column it paused from. */
export const COLUMNS = [
  { id: "intake", title: "Intake", stages: ["intake"] },
  { id: "spec", title: "Spec", stages: ["spec", "repro"] },
  { id: "build", title: "Build", stages: ["build", "gate"] },
  { id: "verify", title: "Verify", stages: ["drives", "verify", "toolkit"] },
  { id: "review", title: "Review", stages: ["review"] },
  { id: "ship", title: "Ready", stages: ["ready", "report"] },
  { id: "done", title: "Done", stages: ["done"] },
  { id: "human", title: "Needs you", stages: ["needs-human", "needs-info"] },
  { id: "closed", title: "Rejected", stages: ["rejected"] },
] as const;

export type Chip = { id: string; result: string };
/** The six steps of the stage track: a job's stages folded the way a person reads them. */
export type Phase = "intake" | "build" | "gate" | "verify" | "review" | "report";
const PHASE: Record<Stage, Phase | null> = {
  intake: "intake",
  "needs-info": "intake",
  spec: "intake",
  repro: "intake",
  build: "build",
  gate: "gate",
  drives: "verify",
  verify: "verify",
  toolkit: "verify",
  review: "review",
  ready: "report",
  report: "report",
  done: "report",
  "needs-human": null,
  paused: null,
  rejected: null,
};
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
/** The stage a job's track and agent are read from: where it paused or escalated from, else where it is. */
export function workStage(j: Pick<Job, "stage" | "pausedFrom" | "escalatedFrom">): Stage {
  if (j.stage === "paused") return j.pausedFrom ?? "intake";
  if (j.stage === "needs-info") return "intake";
  if (j.stage === "needs-human" || j.stage === "rejected") return j.escalatedFrom ?? "intake";
  return j.stage;
}
export const phaseOf = (j: Pick<Job, "stage" | "pausedFrom" | "escalatedFrom">): Phase => PHASE[workStage(j)] ?? "intake";
export const agentOf = (s: Stage): string | null => AGENT[s] ?? null;
export type JobState = "you" | "run" | "paused" | "done" | "rejected";
export function stateOf(j: Pick<Job, "stage">): JobState {
  if (j.stage === "needs-info" || j.stage === "needs-human") return "you";
  if (j.stage === "paused") return "paused";
  if (j.stage === "done") return "done";
  if (j.stage === "rejected") return "rejected";
  return "run";
}
/** What a job that needs you asks: intake's question (question.md), or why it escalated. */
export function questionOf(j: Job, dir: string): string | null {
  if (j.stage === "needs-info") {
    try {
      const q = fs
        .readFileSync(path.join(dir, "question.md"), "utf8")
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim();
      if (q) return q;
    } catch {}
  }
  return j.stage === "needs-info" || j.stage === "needs-human" ? (j.pausedReason ?? "It needs your answer to go on.") : null;
}
/** The agent stream files of the stage entry the job is in now, oldest first (activity/m<moves>-<role>-<t0>.jsonl). */
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
  column: string;
  paused: string | null;
  reason: string | null;
  risk: string | null;
  kind: string | null;
  round: number;
  roundLimit: number;
  verdict: string | null;
  criteria: Chip[];
  review: { result: string; blocking: number; notes: number } | null;
  usd: number;
  secs: number;
  startedAt: string;
  updatedAt: string;
  /** When the job last changed stage (its last `move` ledger line; job.json's updatedAt before any). */
  movedAt: string;
  /** What it is doing now: the stage a runner is running, and its last ledger line (a proof, an agent, a move). */
  step: string | null;
  active: boolean;
  pr: number | null;
  report: string | null;
  // ADR 0009: what the interactive page needs
  state: JobState;
  phase: Phase;
  /** Who works in the job's stage (null: an automatic step). */
  agent: string | null;
  /** A job that needs you: what it asks. */
  q: string | null;
  /** Paused by a person: "pause" or "stop". */
  pausedBy: "pause" | "stop" | null;
  /** The last thing the agent working on it now did, and which role that is. */
  live: Ev | null;
  liveRole: string | null;
  /** A runner is working on it right now. */
  runnerOn: boolean;
  /** Files changed from the base (worktree as it is now). */
  files: FileStat[];
  /** Steering messages no agent has read yet. */
  unread: number;
  doneAt: string | null;
};

export type Snapshot = {
  repo: string;
  at: string;
  /** Spent today (local day), from the ledger. */
  usdToday: number;
  tool: string | null;
  toolkitProven: boolean;
  runner: { running: boolean; text: string };
  columns: { id: string; title: string }[];
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

export function columnOf(j: Pick<Job, "stage" | "pausedFrom">): string {
  const s = j.stage === "paused" ? (j.pausedFrom ?? "intake") : j.stage;
  return COLUMNS.find((c) => (c.stages as readonly string[]).includes(s))?.id ?? "intake";
}

/** The newest verdict-m<N>.md of the job's latest round with one: the verdict and one chip per criterion. Pure over the text. */
export function parseVerdict(text: string): { verdict: string | null; criteria: Chip[] } {
  const verdict = /^VERDICT:\s*([A-Z-]+)/m.exec(text)?.[1] ?? null;
  const criteria: Chip[] = [];
  for (const m of text.matchAll(/^\|\s*(C\d+)\s*\|[^|]*\|\s*([A-Z-]+)/gm)) criteria.push({ id: m[1], result: m[2] });
  return { verdict, criteria };
}

function latest(dir: string, re: RegExp): string | null {
  const rounds = path.join(dir, "rounds");
  if (!fs.existsSync(rounds)) return null;
  for (const r of fs
    .readdirSync(rounds)
    .filter((x) => /^\d+$/.test(x))
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
  const lastMove = new Map<string, string>();
  for (const l of lines) {
    lastLine.set(l.job, l);
    if (l.event === "move") lastMove.set(l.job, l.t);
  }
  const usdOf = new Map(m.jobs.map((j) => [j.job, j.usd]));
  const jobs: JobCard[] = [];
  const corrupt: string[] = [];
  for (const e of scanJobs(repo)) {
    if (!e.job) {
      corrupt.push(e.id);
      continue;
    }
    const j = e.job;
    const dir = jobDirOf(repo, j.id);
    const vf = latest(dir, /^verdict-m\d+\.md$/);
    const v = vf ? parseVerdict(fs.readFileSync(vf, "utf8")) : { verdict: null, criteria: [] };
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
    const streams = isActive(j.stage) ? liveStreams(dir, j.moves) : [];
    const cur = streams.at(-1);
    const evs = cur ? activityOf(cur.file, [j.worktree, repo]) : [];
    jobs.push({
      id: j.id,
      title: j.title,
      stage: j.stage,
      column: columnOf(j),
      paused: j.stage === "paused" ? `${j.waitFor ?? "paused"}${j.pausedFrom ? ` (from ${j.pausedFrom})` : ""}` : null,
      reason: j.pausedReason ?? null,
      risk: j.riskFloor && j.risk && j.riskFloor !== j.risk ? j.riskFloor : (j.risk ?? null),
      kind: j.kind ?? null,
      round: roundsUsed(j),
      roundLimit: j.roundLimit,
      verdict: v.verdict,
      criteria: v.criteria,
      review,
      usd: usdOf.get(j.id) ?? 0,
      secs: Math.max(0, Math.round((end - Date.parse(j.startedAt)) / 1000)),
      startedAt: j.startedAt,
      updatedAt: j.updatedAt,
      movedAt: lastMove.get(j.id) ?? j.updatedAt,
      step:
        [j.running ? `running ${j.running.stage}` : null, lastLine.has(j.id) ? stepOf(lastLine.get(j.id) as LedgerLine) : null].filter(Boolean).join(" · ") ||
        null,
      active,
      pr: j.pr,
      report: fs.existsSync(path.join(dir, "report.html")) ? `jobs/${encodeURIComponent(j.id)}/report.html` : null,
      state: stateOf(j),
      phase: phaseOf(j),
      agent: agentOf(workStage(j)),
      q: questionOf(j, dir),
      pausedBy: pausedByYou(j) ? (j.pausedReason === BY_YOU_STOPPED ? "stop" : "pause") : null,
      live: evs.at(-1) ?? null,
      liveRole: cur?.role ?? null,
      runnerOn: runningNow(j),
      files: await changesOf(j, now),
      unread: readMessages(dir).filter((x) => x.kind === "steer" && x.status === "sent").length,
      doneAt: j.doneAt ?? null,
    });
  }
  const lock = readRunLock(repo);
  const stale = lock ? staleReason(lock.info, now) : null;
  const done = m.jobs.filter((j) => j.done);
  const today = new Date(now).toDateString();
  const usdToday = lines.reduce((a, l) => a + (typeof l.usd === "number" && new Date(l.t).toDateString() === today ? l.usd : 0), 0);
  let tool: string | null = null;
  try {
    tool = /^\s*agent:\s*\{[^}]*tool:\s*(\w+)/m.exec(fs.readFileSync(path.join(repo, "kitchen.yaml"), "utf8"))?.[1] ?? "claude";
  } catch {}
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  return {
    repo: path.basename(repo),
    at: new Date(now).toISOString(),
    usdToday,
    tool,
    toolkitProven: fs.existsSync(path.join(repo, ".kitchen", "toolkit.proven")),
    runner:
      lock && !stale ? { running: true, text: `running, pid ${lock.info?.pid}` } : { running: false, text: stale ? `not running (${stale})` : "not running" },
    columns: COLUMNS.map((c) => ({ id: c.id, title: c.title })),
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
