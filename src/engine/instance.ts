// The job's running app: the Toolkit's lifecycle commands for the job's slot,
// run by the engine (src/toolkit/run.ts, untrusted env + Docker for the control
// plane). Used by the stages (and the builder's `restart_app` bridge tool):
//   ensureUp     doctor ok → keep it; else down + up from the worktree as it is now
//   freshUp      down + up, always: the app then matches the worktree tree the next
//                stamps record (PLAN §2 "Isolation", before repro, drives and Verify)
//   resetUp      `reset`: data and browser session back to seed state
// `prepare` runs the first time a job's worktree is brought up, and again when
// `up` fails (new dependencies, a new migration that changes the seed snapshot).
// W3b: bin/dev comes from the engine-owned Toolkit checkout at toolkitRef; until
// then it is the repo's own .kitchen/toolkit/bin/dev (job.toolkitBin).
import fs from "node:fs";
import path from "node:path";
import { runToolkit, type ToolkitCall } from "../toolkit/run.ts";

export type InstanceJob = { toolkitBin: string; slotId: string; worktree: string; slot: { n: number; ports: number[] } | null };
export type UpResult = { ok: boolean; why?: string; secs: number; prepared: boolean; fresh: boolean };

const PREPARE_MS = 20 * 60_000;
const UP_MS = 5 * 60_000;
const marker = (jobDir: string) => path.join(jobDir, "prepared.json");

function preparedFor(jobDir: string, src: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(marker(jobDir), "utf8")) as { src?: string }).src === src;
  } catch {
    return false;
  }
}

const why = (c: ToolkitCall) => String(c.json?.why ?? c.json?.status ?? (c.stderr.trim().split("\n").pop() || `exit ${c.exit}`));

export async function doctorOk(job: InstanceJob, jobDir?: string): Promise<boolean> {
  if (!job.toolkitBin || !fs.existsSync(job.toolkitBin)) return false;
  const r = await runToolkit(job.toolkitBin, ["doctor", `--id=${job.slotId}`], { src: job.worktree, jobDir });
  return r.json?.status === "ok";
}

export async function down(job: InstanceJob, jobDir?: string): Promise<void> {
  if (!job.toolkitBin || !fs.existsSync(job.toolkitBin)) return;
  await runToolkit(job.toolkitBin, ["down", `--id=${job.slotId}`], { src: job.worktree || process.cwd(), jobDir, timeoutMs: UP_MS });
}

async function prepare(job: InstanceJob, jobDir: string, log: (m: string) => void): Promise<ToolkitCall> {
  log(`prepare --src ${job.worktree}`);
  const r = await runToolkit(job.toolkitBin, ["prepare", `--src=${job.worktree}`], { src: job.worktree, jobDir, timeoutMs: PREPARE_MS });
  if (r.json?.status === "ok") fs.writeFileSync(marker(jobDir), JSON.stringify({ src: job.worktree, at: new Date().toISOString() }));
  return r;
}

async function up(job: InstanceJob, jobDir: string): Promise<ToolkitCall> {
  if (!job.slot) throw new Error("the job has no slot");
  return runToolkit(job.toolkitBin, ["up", `--id=${job.slotId}`, `--src=${job.worktree}`, `--ports=${job.slot.ports.join(",")}`], {
    src: job.worktree,
    jobDir,
    timeoutMs: UP_MS,
  });
}

/** Bring the job's app up from its worktree. `fresh`: always down first. Throws when it can't. */
export async function bringUp(job: InstanceJob, jobDir: string, o: { fresh: boolean; log?: (m: string) => void }): Promise<UpResult> {
  const log = o.log ?? (() => {});
  const t0 = Date.now();
  if (!job.toolkitBin || !fs.existsSync(job.toolkitBin)) throw new Error("no Toolkit (.kitchen/toolkit/bin/dev)");
  if (!job.worktree) throw new Error("the job has no worktree yet");
  if (!o.fresh && (await doctorOk(job, jobDir))) return { ok: true, secs: (Date.now() - t0) / 1000, prepared: false, fresh: false };
  await down(job, jobDir);
  let prepared = false;
  if (!preparedFor(jobDir, job.worktree)) {
    const p = await prepare(job, jobDir, log);
    if (p.json?.status !== "ok") throw new Error(`prepare failed: ${why(p)}`);
    prepared = true;
  }
  let u = await up(job, jobDir);
  if (u.json?.status !== "ready" && !prepared) {
    log(`up failed (${why(u)}): prepare, then up again`);
    await down(job, jobDir);
    const p = await prepare(job, jobDir, log);
    if (p.json?.status !== "ok") throw new Error(`prepare failed: ${why(p)}`);
    prepared = true;
    u = await up(job, jobDir);
  }
  if (u.json?.status !== "ready") {
    await down(job, jobDir);
    throw new Error(`up failed: ${why(u)}`);
  }
  const secs = (Date.now() - t0) / 1000;
  log(`app ${o.fresh ? "fresh " : ""}up from the worktree in ${secs.toFixed(1)}s${prepared ? " (prepared)" : ""}`);
  return { ok: true, secs, prepared, fresh: true };
}

export const ensureUp = (job: InstanceJob, jobDir: string, log?: (m: string) => void) => bringUp(job, jobDir, { fresh: false, log });
export const freshUp = (job: InstanceJob, jobDir: string, log?: (m: string) => void) => bringUp(job, jobDir, { fresh: true, log });

/** Seed data and a fresh browser session, without a restart. Throws when it fails. */
export async function resetUp(job: InstanceJob, jobDir: string): Promise<void> {
  const r = await runToolkit(job.toolkitBin, ["reset", `--id=${job.slotId}`], { src: job.worktree, jobDir, timeoutMs: UP_MS });
  if (r.json?.status !== "ok") throw new Error(`reset failed: ${why(r)}`);
}
