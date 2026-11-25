// `kitchen status` and `kitchen report`: read-only views of the job folders and the ledger.
import fs from "node:fs";
import path from "node:path";
import { heartbeatFile } from "../engine/jobs.ts";
import { isLane, type Job, prOpen, roundsUsed } from "../engine/machine.ts";
import { jobDirOf, scanJobs } from "../engine/store.ts";
import { readLedger } from "../ledger/append.ts";
import { liveRun } from "../run/orchestrator.ts";

export type Out = (line: string) => void;

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

/** The stage column: why a waiting job waits, beside its stage. Pure. */
export function stageLabel(j: Job): string {
  if (j.stage === "paused") return `paused(${j.pausedReason ?? "?"}, from ${j.pausedFrom})`;
  if (j.running) return `${j.stage}*`;
  if (prOpen(j)) return "ready(PR open)";
  if (j.stage === "ready" && j.held) return "ready(held)";
  if (j.pausedReason && ["needs-info", "needs-human", "rejected"].includes(j.stage)) return `${j.stage}(${j.pausedReason.slice(0, 60)})`;
  return j.stage;
}

export function statusLine(j: Job, jobDir: string): string {
  const report = fs.existsSync(path.join(jobDir, "report.html")) ? `  ${path.join(jobDir, "report.html")}` : "";
  const into = j.target ? ` into ${j.target}` : "";
  // ADR 0028: a check says what it found, never a merge.
  const merged = j.check?.result
    ? j.check.result
    : j.stage === "done" && j.verified
      ? `${j.verified.words} (kitchen promote ${j.id})`
      : j.merged
        ? `merged${into} ${j.merged.sha.slice(0, 7)}`
        : j.pr
          ? `PR #${j.pr.number}${prOpen(j) ? ` open${into}` : ""}`
          : into
            ? `→ ${j.target}`
            : "";
  return `${j.id.padEnd(28)} ${j.title.slice(0, 34).padEnd(34)} ${stageLabel(j).padEnd(16)} round ${roundsUsed(j)}/${j.roundLimit}  moved ${ago(j.updatedAt)}${merged ? `  ${merged}` : ""}${report}`;
}

/** The orchestrator in one line: `kitchen run`'s session, or the last `kitchen job next` of an in-session one. */
export function orchestratorLine(repo: string): string {
  const r = liveRun(repo);
  if (r) return `orchestrator: running (kitchen run, pid ${r.pid}, log ${r.log})`;
  try {
    const h = JSON.parse(fs.readFileSync(heartbeatFile(repo), "utf8")) as { at: string };
    return `orchestrator: last seen ${ago(h.at)} (kitchen run, or /kitchen run in Claude Code, works the queue)`;
  } catch {
    return "orchestrator: not running (kitchen run, or /kitchen run in Claude Code)";
  }
}

export function status(repo: string, out: Out, opts: { json?: boolean; all?: boolean } = {}): number {
  // A job the person removed shows only with --all, marked (removed).
  const jobs = scanJobs(repo).filter((e) => opts.all || !e.job?.archived);
  if (opts.json) {
    out(
      JSON.stringify(
        jobs.flatMap((e) =>
          e.job
            ? [
                {
                  id: e.job.id,
                  title: e.job.title,
                  stage: e.job.stage,
                  running: e.job.running?.lane ?? null,
                  round: roundsUsed(e.job),
                  roundLimit: e.job.roundLimit,
                  held: e.job.held ?? null,
                  merged: e.job.merged ?? null,
                  report: fs.existsSync(path.join(jobDirOf(repo, e.id), "report.html")) ? path.join(jobDirOf(repo, e.id), "report.html") : null,
                  updatedAt: e.job.updatedAt,
                  ...(e.job.archived ? { removed: e.job.archived.at } : {}),
                },
              ]
            : [],
        ),
        null,
        2,
      ),
    );
    return 0;
  }
  out(orchestratorLine(repo));
  if (!jobs.length) out("Nothing cooking.");
  for (const e of jobs)
    out(e.job ? `${statusLine(e.job, jobDirOf(repo, e.id))}${e.job.archived ? "  (removed)" : ""}` : `${e.id.padEnd(28)} corrupt(${e.corrupt})`);
  return 0;
}

/** `kitchen report`: what the queue did, from the job folders and the ledger. */
export function report(repo: string, out: Out, opts: { json?: boolean } = {}): number {
  const jobs = scanJobs(repo).flatMap((e) => (e.job ? [e.job] : []));
  const lines = readLedger(repo);
  const by = (s: string) => jobs.filter((j) => j.stage === s).length;
  const ended = jobs.filter((j) => j.stage === "done" || j.stage === "ready");
  // ADR 0018: a catch-up (staging moved under the job) opens a round folder but is no round of work. The ledger marks them.
  const catchUps = lines.filter((l) => l.event === "move" && l.detail?.catchUp);
  const real = (j: Job) => j.round - catchUps.filter((l) => l.job === j.id).length;
  const firstPass = ended.filter((j) => real(j) === 1).length;
  const secs = ended.map((j) => (Date.parse(j.doneAt ?? j.updatedAt) - Date.parse(j.startedAt)) / 1000).sort((a, b) => a - b);
  const r = {
    jobs: jobs.length,
    merged: by("done"),
    ready: by("ready"),
    needsYou: by("needs-info") + by("needs-human"),
    rejected: by("rejected"),
    inFlight: jobs.filter((j) => isLane(j.stage)).length,
    firstPass,
    roundsMean: ended.length ? ended.reduce((a, j) => a + real(j), 0) / ended.length : 0,
    caughtUp: catchUps.length,
    medianMinutes: secs.length ? Math.round(secs[Math.floor(secs.length / 2)] / 60) : 0,
    escalations: lines.filter((l) => l.event === "move" && l.result === "needs-human").length,
    qaFails: lines.filter((l) => l.event === "move" && l.stage === "qa" && l.result === "build").length,
    reviewBlocks: lines.filter((l) => l.event === "move" && l.stage === "review" && l.result === "build" && !l.detail?.catchUp).length,
  };
  if (opts.json) {
    out(JSON.stringify(r, null, 2));
    return 0;
  }
  out(
    `jobs ${r.jobs}: merged into staging ${r.merged} · ready for you ${r.ready} · needs you ${r.needsYou} · rejected ${r.rejected} · in flight ${r.inFlight}`,
  );
  out(`first pass ${r.firstPass}/${ended.length} · mean rounds ${r.roundsMean.toFixed(1)} · median ${r.medianMinutes} min from ticket to ready or merged`);
  out(`sent back: QA ${r.qaFails} · review ${r.reviewBlocks} · to a person ${r.escalations} · caught up with staging ${r.caughtUp} times`);
  return 0;
}
