// What the dashboard shows (dashboard/dashboard.html), read from `.kitchen/` only:
// job.json, the latest verdict and review of each job, report.html's presence, the
// ledger (cost, the §0 measures), the run lock and the retro's mutes. Read-only.
import fs from "node:fs";
import path from "node:path";
import { readRunLock, staleReason } from "../engine/lock.ts";
import { isActive, type Job, roundsUsed } from "../engine/machine.ts";
import { jobDirOf, scanJobs } from "../engine/store.ts";
import { type LedgerLine, readLedger } from "../ledger/append.ts";
import { measures } from "../ledger/measures.ts";
import { readRetroState } from "../retro/state.ts";

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
};

export type Snapshot = {
  repo: string;
  at: string;
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

export function snapshot(repo: string, now = Date.now()): Snapshot {
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
    });
  }
  const lock = readRunLock(repo);
  const stale = lock ? staleReason(lock.info, now) : null;
  const done = m.jobs.filter((j) => j.done);
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  return {
    repo: path.basename(repo),
    at: new Date(now).toISOString(),
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
