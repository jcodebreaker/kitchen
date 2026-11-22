// `kitchen steer`, `kitchen pause`, `kitchen stop` (ADR 0009): one engine function each, shared by
// the CLI and the dashboard. Only these and the runner write what they touch.
//
// - steer: a message on the job's thread (messages.ts). A running Claude agent gets it at its next
//   step; otherwise the next agent role reads it as operator notes.
// - pause: lets the current step finish, then parks the job (paused, reason by-you).
// - stop: kills the job's agent and every other process group it runs now (src/procs.ts), then parks it.
// When no runner is working on the job, the move is made here at once. When one is, the request is
// left in jobs/<id>/control.json and the runner makes it (runner.ts: honorControl).
import fs from "node:fs";
import path from "node:path";
import { appendLedger } from "../ledger/append.ts";
import { ownerAlive, withFileLock } from "../lock.ts";
import { procsDirOf, reapGroups } from "../procs.ts";
import { BY_YOU_STOPPED, isActive, type Job, pausedByYou } from "./machine.ts";
import { addMessage, checkText, type Message } from "./messages.ts";
import { moveJob } from "./runner.ts";
import { findJob, jobDirOf, readJobAt, writeAtomic } from "./store.ts";

export type Out = (line: string) => void;
type Control = { pause?: string; stop?: string };

const controlFile = (jobDir: string) => path.join(jobDir, "control.json");
const controlLock = (jobDir: string) => path.join(jobDir, "control.lock");

export function readControl(jobDir: string): Control {
  try {
    return JSON.parse(fs.readFileSync(controlFile(jobDir), "utf8")) as Control;
  } catch {
    return {};
  }
}
/** Read-merge-write under a file lock: the CLI, a dashboard and the runner may all write it. */
const writeControl = (jobDir: string, fn: (c: Control) => Control | null) =>
  withFileLock(controlLock(jobDir), async () => {
    const next = fn(readControl(jobDir));
    if (next) writeAtomic(controlFile(jobDir), JSON.stringify(next));
    else fs.rmSync(controlFile(jobDir), { force: true });
  });
const clearControl = (jobDir: string) => writeControl(jobDir, () => null);

/** A runner is working on the job right now (its step's owner is alive). */
export const runningNow = (j: Job) => !!j.running && ownerAlive({ pid: j.running.pid, start: j.running.start ?? null });

/**
 * Make a pending pause or stop: the job goes to paused (by-you) from the stage it is in. A job that
 * is no longer in an active stage (done, needs you) drops the request. While another live runner is in
 * a step on the job, moveJob leaves it running ("busy") and the request waits for that runner.
 */
export async function honorControl(repo: string, id: string, print: Out): Promise<"parked" | "waits" | "none"> {
  const jobDir = jobDirOf(repo, id);
  const c = readControl(jobDir);
  if (!c.pause && !c.stop) return "none";
  const job = readJobAt(jobDir);
  if (!isActive(job.stage)) {
    await clearControl(jobDir);
    return "none";
  }
  const how = c.stop ? "stop" : "pause";
  const r = await moveJob(repo, job, { to: "paused", facts: { operator: how }, note: `kitchen ${how}` }, print, "human");
  if (r === "busy" || r === "stale") return "waits";
  await clearControl(jobDir);
  return r === "moved" ? "parked" : "none";
}

export const stopRequested = (jobDir: string) => !!readControl(jobDir).stop;

async function request(repo: string, job: Job, how: "pause" | "stop", out: Out): Promise<number> {
  const jobDir = jobDirOf(repo, job.id);
  await writeControl(jobDir, (c) => ({ ...c, [how]: new Date().toISOString() }));
  if (how === "stop") {
    const killed = await reapGroups(procsDirOf(jobDir));
    for (const g of killed) out(`${job.id}  killed ${g.what} (process group ${g.pgid})`);
    appendLedger(repo, {
      job: job.id,
      stage: job.stage,
      round: job.round,
      event: "stopped",
      key: `${job.id}/m${job.moves}/stop/${Date.now()}`,
      detail: { killed: killed.map((g) => g.what) },
    });
  }
  // Decided under the job lock (moveJob): a runner that took the job a moment ago keeps it, and parks it itself.
  const r = await honorControl(repo, job.id, out);
  if (r === "waits") out(how === "pause" ? `${job.id}  pausing after the current step (${job.stage})` : `${job.id}  stopping: the runner parks it`);
  // The runner may have parked it first (a killed agent ends its step): already paused by you, as asked, is done.
  if (r === "none") {
    const now = readJobAt(jobDir);
    if (!pausedByYou(now) || (now.pausedReason === BY_YOU_STOPPED) !== (how === "stop")) return 1;
    out(`${job.id}  ${how === "stop" ? "stopped" : "paused"}`);
  }
  return 0;
}

function parkable(job: Job, how: string, out: Out): boolean {
  if (isActive(job.stage)) return true;
  out(
    job.stage === "paused"
      ? `${job.id}  is already paused (${job.pausedReason ?? job.waitFor}); kitchen resume wakes it`
      : `${job.id}  is ${job.stage}: nothing running to ${how}`,
  );
  return false;
}

export async function pause(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  return parkable(job, "pause", out) ? request(repo, job, "pause", out) : 1;
}

export async function stop(repo: string, ref: string, out: Out): Promise<number> {
  const job = findJob(repo, ref);
  return parkable(job, "stop", out) ? request(repo, job, "stop", out) : 1;
}

/** Drop a pause or stop that was not made yet (`kitchen resume` on a job still running). */
export const cancelControl = (repo: string, id: string) => clearControl(jobDirOf(repo, id));

/** `kitchen steer <id> "<text>"`: a message for whatever works on the job, now or next. */
export async function steer(repo: string, ref: string, text: string, out: Out): Promise<{ code: number; message?: Message }> {
  const job = findJob(repo, ref);
  const t = checkText(text);
  if ("refused" in t) {
    out(`${job.id}  not sent: ${t.refused}`);
    return { code: 1 };
  }
  if (job.stage === "needs-info" || job.stage === "needs-human") {
    out(`${job.id}  needs you: answer with kitchen feedback ${job.id} "…"`);
    return { code: 1 };
  }
  if (!isActive(job.stage) && job.stage !== "paused") {
    out(`${job.id}  is ${job.stage}: ${job.stage === "done" ? `follow up with kitchen feedback ${job.id} "…"` : "nothing to steer"}`);
    return { code: 1 };
  }
  const jobDir = jobDirOf(repo, job.id);
  const message = await addMessage(jobDir, { kind: "steer", text: t.text, stage: job.stage });
  appendLedger(repo, {
    job: job.id,
    stage: job.stage,
    round: job.round,
    event: "steer",
    key: `${job.id}/steer/${message.id}`,
    detail: { message: message.id, chars: t.text.length },
  });
  out(
    `${job.id}  ${message.id} sent: ${
      job.stage === "paused"
        ? "it is read when you resume"
        : runningNow(job)
          ? "a running agent reads it at its next step, otherwise the next agent role does"
          : "the next agent role reads it"
    }`,
  );
  return { code: 0, message };
}
