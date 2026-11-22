// The `kitchen` commands of PLAN §4 that W1 brings. One line of output per action.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { takeTicket } from "../engine/base.ts";
import { contractOf, specArgsOf } from "../engine/contract.ts";
import { ensureUp, freshUp } from "../engine/instance.ts";
import { ensureJobToolkit } from "../engine/job-toolkit.ts";
import { readRunLock, staleReason } from "../engine/lock.ts";
import { feedbackTarget, type Job, roundsUsed, STAGES, type Stage } from "../engine/machine.ts";
import { moveJob, runKitchen } from "../engine/runner.ts";
import { findingsOf } from "../engine/stages/review.ts";
import { findJob, jobDirOf, kitchenDir, scanJobs, writeAtomic } from "../engine/store.ts";
import { runView } from "../engine/views.ts";
import { changedFiles, headOf } from "../engine/worktree.ts";
import { appendLedger, readLedger } from "../ledger/append.ts";
import { formatMeasures, measures } from "../ledger/measures.ts";
import { formatCounts, summarize } from "../ledger/report.ts";
import { prove } from "../proof/prove.ts";
import { PromptSource } from "../sources/prompt.ts";
import { queueLine } from "../toolkit/reproof.ts";
import { acquireSlot, downSlot, listSlots, releaseSlot } from "../toolkit/slots.ts";

export type Out = (line: string) => void;

export async function ticket(repo: string, text: string, out: Out): Promise<number> {
  const cfg = loadConfig(repo);
  const t = PromptSource.ticket(text);
  const { job, warning } = await takeTicket(repo, cfg, t);
  if (warning) out(`warning: ${warning}`);
  out(`ticket ${job.id}  "${job.title}"  → intake`);
  return 0;
}

export async function run(repo: string, o: { once: boolean; detach: boolean; job?: string; cli: string; argv: string[] }, out: Out): Promise<number> {
  const id = o.job ? findJob(repo, o.job).id : undefined;
  if (o.detach) {
    const log = path.join(kitchenDir(repo), "run.log");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const fd = fs.openSync(log, "a");
    const args = [o.cli, ...o.argv.filter((a) => a !== "--detach")];
    const child = spawn(process.execPath, args, { cwd: repo, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, KITCHEN_LOG_FILE: log } });
    child.unref();
    fs.closeSync(fd);
    out(`run detached: pid ${child.pid}, log ${log}`);
    return 0;
  }
  await runKitchen({ repo, once: o.once, job: id, print: out, logFile: process.env.KITCHEN_LOG_FILE });
  return 0;
}

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export function statusLine(j: Job, jobDir: string): string {
  const stage =
    j.stage === "paused"
      ? `paused(${j.waitFor}${j.until && j.waitFor === "backoff" ? ` until ${j.until.slice(11, 19)}` : ""}, from ${j.pausedFrom})`
      : j.pausedReason && ["needs-info", "needs-human", "rejected"].includes(j.stage)
        ? `${j.stage}(${j.pausedReason})`
        : j.stage;
  const report = fs.existsSync(path.join(jobDir, "report.html")) ? `  ${path.join(jobDir, "report.html")}` : "";
  return `${j.id.padEnd(28)} ${j.title.slice(0, 34).padEnd(34)} ${stage.padEnd(16)} round ${roundsUsed(j)}/${j.roundLimit}  moved ${ago(j.updatedAt)}  ${j.pr ? `PR #${j.pr}` : "no PR"}${report}`;
}

export function status(repo: string, out: Out): number {
  const l = readRunLock(repo);
  if (!l) out("runner: not running");
  else {
    const why = staleReason(l.info, Date.now());
    out(
      why
        ? `runner: not running (stale lock: ${why})`
        : `runner: pid ${l.info?.pid}, heartbeat ${ago(l.info?.heartbeat ?? "")}${l.info?.log ? `, log ${l.info.log}` : ""}`,
    );
  }
  const q = queueLine(repo);
  if (q) out(q);
  const jobs = scanJobs(repo);
  if (!jobs.length) out("no jobs");
  for (const e of jobs) out(e.job ? statusLine(e.job, jobDirOf(repo, e.id)) : `${e.id.padEnd(28)} corrupt(${e.corrupt})`);
  return 0;
}

async function human(repo: string, ref: string, to: Stage, facts: Parameters<typeof moveJob>[2]["facts"], note: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  const r = await moveJob(repo, job, { to, facts, note }, out, "human");
  if (r === "stale") out(`${job.id}  changed while you asked; run it again`);
  return r === "moved" ? 0 : 1;
}

export async function resume(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (job.stage === "paused" && job.pausedFrom) return human(repo, ref, job.pausedFrom, { operator: "resume" }, "resumed by kitchen resume", out);
  out(
    `${job.id}  is ${job.stage}: nothing to resume${job.stage === "needs-info" || job.stage === "needs-human" ? " (answer with kitchen feedback)" : " (kitchen run picks it up)"}`,
  );
  return 1;
}

/**
 * needs-info: the answer goes to the source and the job back to intake.
 * needs-human: back to the stage it escalated from (ADR 0007), or `--to <stage>` at or before it
 * and never past verify (intake, spec, repro, build, drives, verify).
 * done: back to build. The text is kept for the builder only if the move is made.
 */
export async function feedback(repo: string, ref: string, text: string, out: Out, o: { to?: string } = {}): Promise<number> {
  if (o.to !== undefined && !(STAGES as readonly string[]).includes(o.to)) throw new Error(`kitchen feedback --to: no stage ${o.to}`);
  const feedbackTo = o.to as Stage | undefined;
  const job = findJob(repo, ref);
  if (job.stage === "needs-info") {
    if (!text.trim()) throw new Error("kitchen feedback on a needs-info job needs the answer text");
    new PromptSource(repo).reply(job, text);
    return human(repo, ref, "intake", { replied: true }, "the operator replied", out);
  }
  const to = job.stage === "needs-human" ? feedbackTarget(job, { feedbackTo }) : (feedbackTo ?? "build");
  const file = path.join(jobDirOf(repo, job.id), "feedback", `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  if (text.trim()) writeAtomic(file, `${text.trim()}\n`);
  const code = await human(repo, ref, to, { operator: "feedback", feedbackTo }, `kitchen feedback${feedbackTo ? ` --to ${feedbackTo}` : ""}`, out);
  if (code !== 0) fs.rmSync(file, { force: true }); // refused: no side effect
  return code;
}

export async function reject(repo: string, ref: string, out: Out): Promise<number> {
  return human(repo, ref, "rejected", { operator: "reject" }, "kitchen reject", out);
}

/** `kitchen report`: every §0 measure from the ledger (measures.ts), then the raw counts per stage and event. */
export function report(repo: string, out: Out, o: { json?: boolean } = {}): number {
  const lines = readLedger(repo);
  const m = measures(lines);
  if (o.json) {
    out(JSON.stringify(m, null, 2));
    return 0;
  }
  for (const l of formatMeasures(m)) out(l);
  out("");
  out(formatCounts(summarize(lines)));
  return 0;
}

/**
 * `kitchen drive <job> <C> [--repro] [--arg k=v]… [--role r]`: run one criterion's proof
 * the way the stages do (prove.ts), stamped with `role` (default operator, which no
 * Verdict may cite). `--arg` gives concrete feature drive args over the spec's; the
 * difference is logged against the spec. `--repro`: only on a branch whose diff from
 * the base is the repro's own files, on a fresh app, and it reports whether the proof
 * failed as expected. Uses the job's slot, or takes one for the call.
 * Prints one JSON line; exit 0 when the expect holds (with --repro: when it failed as expected).
 */
export async function drive(
  repo: string,
  ref: string,
  criterion: string,
  o: { repro: boolean; args: Record<string, string>; role: string },
  out: Out,
): Promise<number> {
  const cfg = loadConfig(repo);
  const job = await ensureJobToolkit(repo, findJob(repo, ref));
  const jobDir = jobDirOf(repo, job.id);
  const c = contractOf(jobDir)?.criteria.find((x) => x.id === criterion);
  if (!c) throw new Error(`${job.id} has no criterion ${criterion}`);
  if (!job.worktree) throw new Error(`${job.id} has no worktree yet`);
  if (o.repro) {
    const diff = await changedFiles(job, job.base, await headOf(job));
    const extra = diff.filter((f) => !(job.reproFiles ?? []).includes(f));
    if (extra.length) throw new Error(`--repro runs on the base: the branch also changes ${extra.join(", ")}`);
  }
  let took = false;
  let slot = listSlots().find((x) => x.id === job.slotId);
  if (!slot) {
    slot = (await acquireSlot({ id: job.slotId, toolkitBin: job.toolkitBin, src: job.worktree, pid: process.pid })).slot;
    took = true;
  }
  const inst = { ...job, slot: { n: slot.n, ports: slot.ports } };
  try {
    await (o.repro || took ? freshUp : ensureUp)(inst, jobDir, (m) => console.error(`[kitchen drive] ${m}`));
    const p = await prove({
      jobDir,
      criterion: c,
      role: o.role,
      testCmd: cfg.test_cmd,
      argsOverride: o.args,
      ...(o.repro ? { tag: { phase: "repro" } } : {}),
      log: (m) => console.error(`[kitchen drive] ${m}`),
    });
    for (const d of p.driveArgs) {
      if (JSON.stringify(Object.entries(d.used).sort()) === JSON.stringify(Object.entries(specArgsOf(c, d.drive) ?? {}).sort())) continue;
      const f = path.join(jobDir, "rounds", String(job.round), "args-deltas.jsonl");
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, `${JSON.stringify({ criterion, drive: d.drive, spec: d.spec, used: d.used, by: o.role, at: new Date().toISOString() })}\n`);
    }
    const holds = p.status === "pass";
    const failedAsExpected = p.status === "assert-fail";
    out(
      JSON.stringify({
        job: job.id,
        criterion,
        status: p.status,
        ...(o.repro ? { failedAsExpected } : { holds }),
        ...(p.why ? { why: p.why } : {}),
        vars: p.outcome.vars,
        evidence: p.evidence,
      }),
    );
    return (o.repro ? failedAsExpected : holds) ? 0 : 1;
  } finally {
    if (took) {
      await downSlot(slot);
      await releaseSlot(job.slotId);
    }
  }
}

/**
 * `kitchen dismiss <job> <finding-id> [--reason "<why>"]`: a person says a review finding was not
 * useful. Recorded in the job folder (dismissed.jsonl, shown in the Report) and in the ledger with
 * its lens, so the dismissals per lens can be counted (W5 retro). An id that no review of the job
 * has is refused.
 */
export function dismiss(repo: string, ref: string, finding: string, reason: string | undefined, out: Out): number {
  const job = findJob(repo, ref);
  const jobDir = jobDirOf(repo, job.id);
  const all = findingsOf(jobDir).flatMap((r) => r.findings.map((f) => ({ ...f, round: r.round })));
  const f = all.find((x) => x.id === finding || x.also?.includes(finding));
  if (!f) throw new Error(`${job.id} has no review finding ${finding}${all.length ? ` (it has ${all.map((x) => x.id).join(", ")})` : ""}`);
  const lens = finding === f.id ? f.lens : (finding.split("-")[0] ?? f.lens);
  const file = path.join(jobDir, "dismissed.jsonl");
  const had =
    fs.existsSync(file) &&
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .some((l) => l && (JSON.parse(l) as { finding: string }).finding === finding);
  if (had) {
    out(`${job.id}  ${finding} was already dismissed`);
    return 0;
  }
  const at = new Date().toISOString();
  fs.appendFileSync(file, `${JSON.stringify({ finding, lens, round: f.round, blocked: f.blocks, reason: reason ?? null, at })}\n`);
  appendLedger(repo, {
    job: job.id,
    stage: job.stage,
    round: f.round,
    event: "finding-dismissed",
    key: `${job.id}/dismiss/${finding}`,
    role: `reviewer-${lens}`,
    detail: { finding, lens, blocked: f.blocks, reason: reason ?? null, title: f.title },
  });
  out(`${job.id}  dismissed ${finding} (${lens}${f.blocks ? ", it had blocked" : ""})${reason ? `: ${reason}` : ""}`);
  return 0;
}

/**
 * `kitchen drive <job> --view "<view>" [--role r]`: one extra view (views.ts) in the job's slot, the way
 * a UX/UI lens's `VIEW:` line runs: a page, a feature drive or toolkit segments, then a screenshot.
 * Stamped `criterion: view:<lens>`. Prints one JSON line.
 */
export async function view(repo: string, ref: string, v: string, role: string, out: Out): Promise<number> {
  const cfg = loadConfig(repo);
  const job = findJob(repo, ref);
  const jobDir = jobDirOf(repo, job.id);
  if (!job.worktree) throw new Error(`${job.id} has no worktree yet`);
  let took = false;
  let slot = listSlots().find((x) => x.id === job.slotId);
  if (!slot) {
    slot = (await acquireSlot({ id: job.slotId, toolkitBin: job.toolkitBin, src: job.worktree, pid: process.pid })).slot;
    took = true;
  }
  const lens = role.startsWith("reviewer-") ? role.slice("reviewer-".length) : role;
  try {
    const r = await runView({
      job: { ...job, slot: { n: slot.n, ports: slot.ports } },
      jobDir,
      view: v,
      lens,
      n: Date.now() % 100000,
      testCmd: cfg.test_cmd,
      log: (m) => console.error(`[kitchen drive --view] ${m}`),
    });
    out(JSON.stringify({ job: job.id, ...r }));
    return r.ok ? 0 : 1;
  } finally {
    if (took) {
      await downSlot(slot);
      await releaseSlot(job.slotId);
    }
  }
}
