// The `kitchen` commands of PLAN §4 that W1 brings. One line of output per action.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { readRunLock, staleReason } from "../engine/lock.ts";
import { type Job, roundsUsed, type Stage } from "../engine/machine.ts";
import { moveJob, runKitchen } from "../engine/runner.ts";
import { createJob, findJob, jobDirOf, kitchenDir, listJobs, writeAtomic } from "../engine/store.ts";
import { mainHead } from "../engine/worktree.ts";
import { readLedger } from "../ledger/append.ts";
import { formatCounts, summarize } from "../ledger/report.ts";
import { PromptSource } from "../sources/prompt.ts";

export type Out = (line: string) => void;

const toolkitBinOf = (repo: string) => {
  const b = path.join(repo, ".kitchen", "toolkit", "bin", "dev");
  return fs.existsSync(b) ? b : "";
};

export async function ticket(repo: string, text: string, out: Out): Promise<number> {
  const cfg = loadConfig(repo);
  const t = PromptSource.ticket(text);
  let base = "";
  try {
    base = await mainHead(repo);
  } catch {
    out(`warning: ${repo} has no commit yet; the job can't get a worktree until it has one`);
  }
  const { job } = await createJob(repo, { title: t.title, ticket: t.ref, body: t.body, roundLimit: cfg.round_limit, base, toolkitBin: toolkitBinOf(repo) });
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
  const jobs = listJobs(repo);
  if (!jobs.length) out("no jobs");
  for (const j of jobs) out(statusLine(j, jobDirOf(repo, j.id)));
  return 0;
}

async function human(repo: string, ref: string, to: Stage, facts: Parameters<typeof moveJob>[2]["facts"], note: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  const r = await moveJob(repo, job, { to, facts, note }, out);
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

export async function feedback(repo: string, ref: string, text: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  if (job.stage === "needs-info") {
    if (!text.trim()) throw new Error("kitchen feedback on a needs-info job needs the answer text");
    new PromptSource(repo).reply(job, text);
    return human(repo, ref, "intake", { replied: true }, "the operator replied", out);
  }
  if (text.trim() && (job.stage === "needs-human" || job.stage === "done")) {
    writeAtomic(path.join(jobDirOf(repo, job.id), "feedback", `${new Date().toISOString().replace(/[:.]/g, "-")}.md`), `${text.trim()}\n`);
  }
  return human(repo, ref, "build", { operator: "feedback" }, "kitchen feedback", out);
}

export async function reject(repo: string, ref: string, out: Out): Promise<number> {
  return human(repo, ref, "rejected", { operator: "reject" }, "kitchen reject", out);
}

export function report(repo: string, out: Out): number {
  out(formatCounts(summarize(readLedger(repo))));
  return 0;
}
