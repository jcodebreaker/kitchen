// What the dashboard shows (dashboard/dashboard.html), read from `.kitchen/` only: job.json, each job's intake
// criteria and QA verdict, its review, report.html's presence, the ledger (moves, spend of `kitchen run` sessions),
// the orchestrator's liveness, and the live line of the lane agent working on each job (its activity stream,
// written by the activity hook). Read-only.
import fs from "node:fs";
import path from "node:path";
import { type Config, LANE_ROLES, loadConfig, modelFor, targetOf } from "../config.ts";
import { readControl } from "../engine/control.ts";
import { type FailKind, failureOf } from "../engine/diagnose.ts";
import { diffSize } from "../engine/git.ts";
import { heartbeatFile, syncPrs } from "../engine/jobs.ts";
import { criteriaOf, leftOutOf, readIntake, readQa, readReview } from "../engine/lanes.ts";
import { BY_YOU_STOPPED, isActive, isCheck, type Job, PR_OPEN_WORDS, pausedByYou, prOpen, promotable, type Stage } from "../engine/machine.ts";
import { type Plan, planWave } from "../engine/plan.ts";
import { JOB_ID, jobDirOf, scanJobs } from "../engine/store.ts";
import { type Kept, listKept } from "../inbox/schedule.ts";
import { type LedgerLine, readLedger } from "../ledger/append.ts";
import { liveRun } from "../run/orchestrator.ts";
import { activityOf, type Ev } from "./activity.ts";

export type Chip = { id: string; result: string };
export const STAGE_NAMES: Record<Stage, string> = {
  intake: "Intake",
  "needs-info": "Needs you",
  build: "Build",
  qa: "QA",
  review: "Review",
  regress: "Merge check",
  ready: "Ready",
  done: "Merged",
  "needs-human": "Needs you",
  paused: "Paused",
  rejected: "Rejected",
};
/** The steps of a job's track, each with the stages it folds in. */
export const PHASES = [
  { k: "intake", nm: "Intake", stages: ["intake", "needs-info"] },
  { k: "build", nm: "Build", stages: ["build"] },
  { k: "qa", nm: "QA", stages: ["qa"] },
  { k: "review", nm: "Review", stages: ["review", "regress"] },
  { k: "merge", nm: "Merge", stages: ["ready", "done"] },
] as const satisfies readonly { k: string; nm: string; stages: readonly Stage[] }[];
export type Phase = (typeof PHASES)[number]["k"];
const AGENT: Partial<Record<Stage, string>> = {
  intake: "Intake agent",
  build: "Build agent",
  qa: "QA agent",
  review: "Review agent",
  regress: "Merge-check agent",
};

/** The stage a job's track and agent are read from: where it paused or escalated from, else where it is. */
export function workStage(j: Pick<Job, "stage" | "pausedFrom" | "escalatedFrom">): Stage {
  if (j.stage === "paused") return j.pausedFrom ?? "intake";
  if (j.stage === "needs-info") return "intake";
  if (j.stage === "needs-human" || j.stage === "rejected") return j.escalatedFrom ?? "intake";
  return j.stage;
}
export const phaseOf = (s: Stage): Phase => PHASES.find((p) => (p.stages as readonly Stage[]).includes(s))?.k ?? "intake";
export const agentOf = (s: Stage): string | null => AGENT[s] ?? null;
export type JobState = "you" | "run" | "paused" | "done" | "rejected";
/**
 * A job held at Ready waits for the person's merge (or their changes): it needs you, it isn't done. So does one whose
 * PR waits for review on GitHub (ADR 0026 §4: Ready with an open PR).
 */
export function stateOf(j: Pick<Job, "stage">): JobState {
  if (j.stage === "needs-info" || j.stage === "needs-human" || j.stage === "ready") return "you";
  if (j.stage === "paused") return "paused";
  if (j.stage === "done") return "done";
  if (j.stage === "rejected") return "rejected";
  return "run";
}
/** The Board's lanes (ADR 0013), left to right. */
export const LANES = [
  { k: "you", nm: "Needs you" },
  { k: "intake", nm: "Intake" },
  { k: "build", nm: "Build" },
  { k: "qa", nm: "QA" },
  { k: "review", nm: "Review" },
  { k: "done", nm: "Done" },
] as const;
export type Lane = (typeof LANES)[number]["k"];
/** A job's lane on the Board. Pure. */
export function laneOf(j: Pick<Job, "stage" | "pausedFrom" | "escalatedFrom" | "pausedReason">): Lane {
  if (stateOf(j) === "you") return "you";
  if (j.stage === "rejected" || j.stage === "done" || (pausedByYou(j) && j.pausedReason === BY_YOU_STOPPED)) return "done";
  const s = workStage(j);
  return s === "build" || s === "qa" || s === "review" ? s : s === "regress" ? "review" : "intake";
}
const LANE_SHORT = { intake: "intake", builder: "build", qa: "QA", reviewer: "review" } as const;
/** Who works in each lane, as its header says. */
export function laneWho(cfg: Config | null): Record<Lane, string> {
  const m = (role: "intake" | "builder" | "qa" | "reviewer", fallback: string) => (cfg ? modelFor(cfg, role) : fallback);
  return {
    you: "you",
    intake: m("intake", "intake agent"),
    build: m("builder", "build agent"),
    qa: m("qa", "QA agent"),
    review: m("reviewer", "review agent"),
    done: "merged or rejected",
  };
}
/** What a job that needs you asks: intake's question (question.md), why it stopped, or why Kitchen held it at Ready. */
export function questionOf(j: Job, dir: string): string | null {
  if (prOpen(j)) return PR_OPEN_WORDS;
  if (j.stage === "ready") return `Ready for you: ${j.held ?? "a person merges it"}`;
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
/** The activity streams of one stage entry, oldest first (activity/m<moves>-<lane>-<t0>.jsonl). */
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

/**
 * ADR 0020: what a Needs-you job waits for beyond an answer. refine: intake's reason and its readings (or slices,
 * or gaps); confirm: intake's criteria and what it left out.
 */
export type Waits = { for: "refine"; reason: string; items: string[] } | { for: "confirm"; items: string[]; leftOut: string };
export function waitsOf(j: Job, dir: string): Waits | null {
  if (j.stage !== "needs-info" || !j.waits) return null;
  if (j.waits.for === "confirm") return { for: "confirm", items: criteriaOf(dir).map((c) => `${c.id} (${c.check}): ${c.text}`), leftOut: leftOutOf(dir) };
  const i = readIntake(dir);
  return { for: "refine", reason: j.waits.reason, items: i?.decision === "REFINE" ? i.items : [] };
}

/** `skip`: ADR 0029 §2, QA couldn't test it ("not tested", with why): muted, never a fail. */
export type Crit = { id: string; text: string; st: "ok" | "bad" | "wait" | "skip"; e: string };
/** The job's criteria (intake's) with QA's latest results. */
export function critOf(dir: string, round: number, o: { check?: boolean } = {}): Crit[] {
  const crit = criteriaOf(dir);
  let rows: { id: string; result: string; note: string; evidence: string[]; why?: string }[] = [];
  for (let r = round; r >= 1 && !rows.length; r--) {
    const qa = readQa(dir, r, crit, o);
    if ("criteria" in qa) rows = qa.criteria;
  }
  return crit.map((c) => {
    const r = rows.find((x) => x.id === c.id);
    return {
      id: c.id,
      text: `${c.text} (${c.check})`,
      st: !r ? "wait" : r.result === "PASS" ? "ok" : r.result === "NOT_RUN" ? "skip" : "bad",
      e: !r
        ? ""
        : r.result === "NOT_RUN"
          ? `not tested · ${r.why ?? ""}${r.evidence.length ? ` · ${r.evidence.join(", ")}` : ""}`
          : `${r.result}${r.note ? ` · ${r.note}` : ""}${r.evidence.length ? ` · ${r.evidence.join(", ")}` : ""}`,
    };
  });
}

/** ADR 0025 §4: the check running now and the last line its log has so far (the log is written as it arrives). */
export type Checking = { cmd: string; at: string; log: string; last: string; setup?: true; of?: number };
/** ADR 0025 §4 (ADR 0029 §4: `setup` is `kitchen qa up`'s step, `of` the health wait's limit). */
export function checkingOf(j: Pick<Job, "checking">, dir: string): Checking | null {
  if (!j.checking) return null;
  let last = "";
  try {
    const fd = fs.openSync(path.join(dir, j.checking.log), "r");
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, 4096));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      last =
        buf
          .toString("utf8")
          // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes in a check's output
          .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
          .split(/[\r\n]+/)
          .map((l) => l.trim())
          .filter(Boolean)
          .at(-1) ?? "";
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  // The header alone: nothing printed yet.
  const c = j.checking;
  return {
    cmd: c.cmd,
    at: c.at,
    log: c.log,
    last: last === `$ ${c.cmd}` ? "" : last.slice(0, 300),
    ...(c.setup ? { setup: true as const } : {}),
    ...(c.of ? { of: c.of } : {}),
  };
}

export const NO_ORCHESTRATOR = "Waiting for the orchestrator (kitchen run)";
const numOf = (id: string) => JOB_ID.exec(id)?.[1] ?? id;
const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

/**
 * ADR 0029 §3: why a job in a lane with no agent on it waits, from the same wave plan `kitchen job next` makes: for
 * room (the jobs using it), for a job on its AFTER: line, or for an orchestrator. The card and the panel both show it.
 * Null while an agent works on it. Pure.
 */
export function waitingOf(id: string, plan: Plan | null, o: { parallel: number; orchestrator: boolean }): string | null {
  if (!o.orchestrator) return NO_ORCHESTRATOR;
  if (!plan || plan.running.some((r) => r.id === id)) return null;
  const h = plan.held.find((x) => x.id === id);
  if (!h) return plan.start.some((x) => x.id === id) ? "Starting its lane" : null;
  const dep = /^waits for (\S+) .*named on its AFTER: line$/.exec(h.why);
  if (dep) return `Waiting for ${numOf(dep[1])} to merge first (named on its AFTER: line)`;
  if (!h.why.startsWith("waits for room")) return `Waiting: ${h.why}`;
  // The lanes that take room: build, QA, review, merge check first (intake may start past parallel), at most parallel.
  const using = [...plan.running, ...plan.start]
    .sort((a, b) => Number(a.lane === "intake") - Number(b.lane === "intake"))
    .slice(0, o.parallel)
    .map((x) => numOf(x.id));
  const all = using.length === 1 ? "is using it" : using.length === 2 ? "are using both" : `are using all ${using.length}`;
  if (!using.length) return `Waiting for a free lane (parallel: ${o.parallel})`;
  if (using.length > 3) return `Waiting for a free lane · ${using.length} jobs are using all ${using.length}`;
  return `Waiting for a free lane · ${and(using)} ${all} (parallel: ${o.parallel})`;
}

/** ADR 0032 §3: the card's three lines for a failed step (the raw output stays in detail.json). */
function diagOf(dir: string, j: Job, cfg: Config | null): JobCard["diag"] {
  const f = failureOf(dir, j, cfg ?? undefined);
  return f ? { kind: f.kind, what: f.what, line: f.line, next: f.next, log: f.log } : null;
}

/** One ledger line, as a card's "now" line. Pure. */
export function stepOf(l: LedgerLine): string {
  if (l.event === "agent") return `${l.role ?? "agent"} ${String(l.result ?? "started")}`.trim();
  if (l.event === "move") return `moved ${l.stage} → ${String(l.result ?? "?")}`;
  return `${l.event}${l.result ? ` ${String(l.result)}` : ""}`;
}

const DIFFS = new Map<string, { at: number; files: FileStat[] }>();
async function changesOf(j: Job, now: number): Promise<FileStat[]> {
  if (!j.base || !j.worktree || !fs.existsSync(j.worktree)) return [];
  const c = DIFFS.get(j.id);
  if (c && now - c.at < (isActive(j.stage) ? 2500 : 60_000)) return c.files;
  const files = await diffSize(j.worktree, j.base, "HEAD")
    .then((d) => d.files)
    .catch(() => c?.files ?? []);
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
  movedAt: string;
  pausedSecs: number | null;
  step: string | null;
  active: boolean;
  /** Its PR's number (GitHub), as the page shows it today. */
  pr: number | null;
  /** ADR 0026 §4: its PR in full: open while it waits for review on GitHub (staging.merge: pr), merged or closed after. */
  pull: { number: number; url: string; state: "open" | "merged" | "closed" | null } | null;
  /** ADR 0026: the branch it merges into, only when it isn't staging.branch. */
  target?: string;
  report: string | null;
  branch: string;
  state: JobState;
  phase: Phase;
  checks: { ok: number; total: number };
  phases: { k: Phase; nm: string }[];
  agent: string | null;
  q: string | null;
  pausedBy: "pause" | "stop" | null;
  live: Ev | null;
  /** A lane agent works on it now (a lane is open and an orchestrator is alive). */
  runnerOn: boolean;
  /** ADR 0029 §3: what it waits for while no agent works on it (a free lane, a job on its AFTER: line, an orchestrator); else null. */
  waiting: string | null;
  files: FileStat[];
  doneAt: string | null;
  lane: Lane;
  proof: "pass" | "fail" | null;
  held: string | null;
  /** Where it merged, and who: a person (here), GitHub (its PR merged there, ADR 0026 §4), or Kitchen (null). */
  merged: { into: string; sha: string; by: "person" | "github" | null } | null;
  waits: Waits | null;
  /** ADR 0022: where it came from in the outer loop ("GitHub #17", "3 reports"), or null (New ticket). */
  from: string | null;
  /** ADR 0025 §4: the check command running now, since when, its log (in the job folder) and its last line; null between checks. */
  checking: Checking | null;
  /**
   * ADR 0028: a check ticket (`kind: "check"`): tested on its target's tip, never built. `result`: the words once done
   * ("Checked on staging · 4 of 4 pass", "Found 2 problems"); `findings`: the problems found, and the inbox proposals
   * they became; `explore`: minutes when it explores; `every`: how often a schedule files this same check ("day",
   * "hour"; ADR 0028 §5, matched on the ticket's text), or null. Null for any other job.
   */
  check: {
    result: string | null;
    findings: number;
    proposals: string[];
    explore: number | null;
    forced: boolean;
    every: string | null;
    /** ADR 0029 §6: why proposing its findings failed (retried on the next wave), or null. */
    proposalsFailed: string | null;
  } | null;
  /** ADR 0028 amendment: false for intake's `KEEP: no` (built to verify, not merged unless promoted); absent otherwise. */
  keep?: false;
  /**
   * ADR 0032 §3: a step that failed (checks, the app, a lane refused, a merge): what, its useful line and what to do,
   * with its log (in the job folder); the card shows these in place of the raw reason. Null otherwise.
   */
  diag: { kind: FailKind; what: string; line: string; next: string; log: string | null } | null;
  /** Verified and not merged: the words ("Verified · not merged"), or null. */
  verified: string | null;
  /** It can be promoted now (`kitchen promote`, the `promote` action): done, KEEP: no, not merged. */
  promotable: boolean;
};

/** ADR 0028: a check's track is Intake → QA; a KEEP: no job's ends at QA (until it is promoted). */
function phasesOf(j: Job, chk: boolean): { k: Phase; nm: string }[] {
  const ks: Phase[] | null = chk ? ["intake", "qa"] : j.keep === false ? ["intake", "build", "qa"] : null;
  return PHASES.filter((p) => !ks || ks.includes(p.k)).map((p) => ({ k: p.k, nm: p.nm }));
}

/** ADR 0028 §5: for a check filed before jobs recorded their schedule, how often a schedule files the same text and target, or null. */
function everyOf(kept: Kept[], dir: string, j: Job): string | null {
  const ks = kept.filter((k) => k.task.name === "check");
  if (!ks.length) return null;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  let text: string;
  try {
    text = norm(fs.readFileSync(path.join(dir, "ticket.md"), "utf8").replace(/^# [^\n]*\n+/, ""));
  } catch {
    return null;
  }
  const k = ks.find((x) => x.task.name === "check" && norm(x.task.text) === text && (x.task.into ?? null) === (j.target ?? null));
  return k?.every ?? null;
}

export type Snapshot = {
  repo: string;
  /** ADR 0026: the default target (staging.branch); a card names its own only when it differs. */
  target: string;
  /** ADR 0026 §4: who merges a passing job (staging.merge): Kitchen, or a person through a PR. */
  merge: "kitchen" | "pr";
  at: string;
  usdToday: number;
  usdTotal: number;
  tool: string | null;
  /** ADR 0023: each lane's model for the active tool (the orchestrator line says it; a click changes it). */
  models: { role: string; lane: string; model: string }[];
  runner: { running: boolean; text: string };
  phases: { k: Phase; nm: string }[];
  lanes: { k: Lane; nm: string; who: string }[];
  jobs: JobCard[];
  /** Jobs the person removed in the last day (kitchen remove): hidden, named so the outer loop can say "Removed". */
  removed: { id: string; at: string }[];
  corrupt: string[];
};

/** The orchestrator: `kitchen run`'s session, or an in-session one seen in the last 15 minutes. */
export function orchestrator(repo: string, now = Date.now()): { running: boolean; text: string } {
  const r = liveRun(repo);
  if (r) return { running: true, text: `kitchen run, pid ${r.pid}` };
  try {
    const h = JSON.parse(fs.readFileSync(heartbeatFile(repo), "utf8")) as { at: string; drained?: boolean };
    const ago = (now - Date.parse(h.at)) / 1000;
    const when = ago < 90 ? `${Math.round(ago)}s` : `${Math.round(ago / 60)} min`;
    if (h.drained) return { running: false, text: `idle: the last orchestrator drained the queue ${when} ago` };
    if (ago < 900) return { running: true, text: `an orchestrator session (/kitchen run), last wave ${when} ago` };
    return { running: false, text: `not running (last seen ${when} ago)` };
  } catch {
    return { running: false, text: "not running" };
  }
}

export async function snapshot(repo: string, now = Date.now()): Promise<Snapshot> {
  // ADR 0026 §4: what became of the open PRs, at most once a minute; in the background (a moved target re-runs the
  // merge check), so this snapshot never waits for it: the next poll shows the result.
  void syncPrs(repo).catch(() => {});
  let cfg: Config | null = null;
  try {
    cfg = loadConfig(repo);
  } catch {}
  const lines = readLedger(repo);
  const lastLine = new Map<string, LedgerLine>();
  const moves = new Map<string, LedgerLine[]>();
  /** ADR 0018: catch-ups per job; a card counts only real rounds. */
  const catchUps = new Map<string, number>();
  /** ADR 0029 §2: a job's QA again on what it couldn't test is no round either (a check's is: ADR 0028). */
  const qaAgain = new Map<string, number>();
  for (const l of lines) {
    lastLine.set(l.job, l);
    if (l.event === "move") moves.set(l.job, [...(moves.get(l.job) ?? []), l].slice(-2));
    if (l.event === "move" && l.detail?.catchUp) catchUps.set(l.job, (catchUps.get(l.job) ?? 0) + 1);
    if (l.event === "move" && l.stage === "qa" && l.result === "qa") qaAgain.set(l.job, (qaAgain.get(l.job) ?? 0) + 1);
  }
  const orch = orchestrator(repo, now);
  // ADR 0029 §3: the wave plan `kitchen job next` would make, for why a job waits.
  const all = scanJobs(repo);
  const open = all.flatMap((e) => (e.job && JOB_ID.test(e.job.id) && !e.job.archived ? [e.job] : []));
  const paused = new Set(open.filter((j) => !j.running && readControl(jobDirOf(repo, j.id)).pause).map((j) => j.id));
  const plan = cfg ? planWave(open, { parallel: cfg.parallel, paused, target: (j) => targetOf(cfg as Config, j) }) : null;
  const jobs: JobCard[] = [];
  const corrupt: string[] = [];
  const removed: { id: string; at: string }[] = [];
  const kept = listKept(repo);
  for (const e of all) {
    if (!e.job || !JOB_ID.test(e.job.id)) {
      corrupt.push(e.id);
      continue;
    }
    const j = e.job;
    if (j.archived) {
      if (now - Date.parse(j.archived.at) < 86_400_000) removed.push({ id: j.id, at: j.archived.at });
      continue;
    }
    const dir = jobDirOf(repo, j.id);
    const chk = isCheck(j);
    const crit = critOf(dir, j.round, { check: chk });
    const qaNow = readQa(dir, j.round, criteriaOf(dir), { check: chk });
    const rv = readReview(dir, j.round);
    const review =
      "findings" in rv
        ? { result: rv.verdict, blocking: rv.findings.filter((f) => f.blocks).length, notes: rv.findings.filter((f) => !f.blocks).length }
        : null;
    const active = isActive(j.stage) || j.stage === "paused";
    const end = active ? now : Date.parse(j.updatedAt);
    const cur = j.running?.stream ? path.join(dir, j.running.stream) : undefined;
    const ms = moves.get(j.id) ?? [];
    const last = ms.at(-1);
    const prev = ms.length === 2 ? ms[0] : undefined;
    const movedAt = last?.t ?? j.startedAt;
    const stage = workStage(j);
    jobs.push({
      id: j.id,
      title: j.title,
      stage: j.stage,
      paused: j.stage === "paused" ? `paused${j.pausedFrom ? ` (from ${j.pausedFrom})` : ""}` : null,
      reason: j.pausedReason ?? null,
      risk: j.risk,
      round: j.round - (catchUps.get(j.id) ?? 0) - (chk ? 0 : (qaAgain.get(j.id) ?? 0)),
      roundLimit: j.roundLimit,
      kind: chk ? "check" : j.kind,
      verdict: "criteria" in qaNow ? qaNow.verdict : null,
      criteria: crit.filter((c) => c.st !== "wait").map((c) => ({ id: c.id, result: c.st === "ok" ? "PASS" : c.st === "skip" ? "NOT_RUN" : "FAIL" })),
      review,
      usd: 0,
      secs: Math.max(0, Math.round((end - Date.parse(j.startedAt)) / 1000)),
      startedAt: j.startedAt,
      updatedAt: j.updatedAt,
      movedAt,
      pausedSecs: j.stage === "paused" ? Math.max(0, Math.round((Date.parse(movedAt) - Date.parse(prev?.t ?? j.startedAt)) / 1000)) : null,
      step:
        [j.running ? `${j.running.lane} agent working` : null, lastLine.has(j.id) ? stepOf(lastLine.get(j.id) as LedgerLine) : null]
          .filter(Boolean)
          .join(" · ") || null,
      active,
      pr: j.pr?.number ?? null,
      pull: j.pr ? { number: j.pr.number, url: j.pr.url, state: j.pr.state ?? null } : null,
      ...(cfg && targetOf(cfg, j) !== cfg.staging.branch ? { target: targetOf(cfg, j) } : {}),
      report: fs.existsSync(path.join(dir, "report.html")) ? `jobs/${encodeURIComponent(j.id)}/report.html` : null,
      branch: j.branch,
      state: stateOf(j),
      phase: phaseOf(stage),
      phases: phasesOf(j, chk),
      checks: { ok: crit.filter((x) => x.st === "ok").length, total: crit.length },
      agent: agentOf(stage),
      q: questionOf(j, dir),
      pausedBy: pausedByYou(j) ? (j.pausedReason === BY_YOU_STOPPED ? "stop" : "pause") : null,
      live: (cur && fs.existsSync(cur) ? activityOf(cur, [j.worktree, repo]) : []).at(-1) ?? null,
      runnerOn: !!j.running && orch.running,
      waiting: isActive(j.stage) && !(j.running && orch.running) ? waitingOf(j.id, plan, { parallel: cfg?.parallel ?? 1, orchestrator: orch.running }) : null,
      files: await changesOf(j, now),
      doneAt: j.doneAt ?? null,
      lane: laneOf(j),
      proof:
        j.stage === "rejected" || ("criteria" in qaNow && qaNow.verdict === "INCOMPLETE")
          ? null
          : "criteria" in qaNow
            ? qaNow.verdict === "PASS"
              ? "pass"
              : "fail"
            : null, // no QA verdict yet: no pill (the Toolkit's "proven" is gone)
      held: j.held ?? null,
      merged: j.merged ? { into: j.merged.into, sha: j.merged.sha, by: j.mergedBy ?? null } : null,
      waits: waitsOf(j, dir),
      from: j.from?.label ?? null,
      checking: checkingOf(j, dir),
      check: chk
        ? {
            result: j.check?.result ?? null,
            findings: j.check?.findings ?? 0,
            proposals: j.check?.proposals ?? [],
            explore: j.check?.explore ?? null,
            forced: !!j.check?.forced,
            every: j.check?.every ?? everyOf(kept, dir, j),
            proposalsFailed: j.check?.proposalsFailed?.error ?? null,
          }
        : null,
      ...(j.keep === false ? { keep: false as const } : {}),
      diag: diagOf(dir, j, cfg),
      verified: j.stage === "done" ? (j.verified?.words ?? null) : null,
      promotable: promotable(j),
    });
  }
  const who = laneWho(cfg);
  const today = new Date(now).toDateString();
  const priced = lines.filter((l) => typeof l.usd === "number");
  return {
    repo: path.basename(repo),
    target: cfg?.staging.branch ?? "staging",
    merge: cfg?.staging.merge ?? "kitchen",
    at: new Date(now).toISOString(),
    usdToday: priced.filter((l) => new Date(l.t).toDateString() === today).reduce((a, l) => a + (l.usd as number), 0),
    usdTotal: priced.reduce((a, l) => a + (l.usd as number), 0),
    tool: cfg?.agent.tool ?? null,
    models: cfg ? LANE_ROLES.map((role) => ({ role, lane: LANE_SHORT[role], model: modelFor(cfg as Config, role) })) : [],
    runner: orch,
    phases: PHASES.map((p) => ({ k: p.k, nm: p.nm })),
    lanes: LANES.map((l) => ({ k: l.k, nm: l.nm, who: who[l.k] })),
    jobs: jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    removed,
    corrupt,
  };
}
