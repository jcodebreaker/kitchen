// The slice of job.json that proofs need (the full Job type lands in W1, PLAN §2).
// .kitchen/jobs/<id>/job.json is engine-owned: outside every agent's writable root.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { engineKey } from "../home.ts";
import { serialize, withFileLock } from "../lock.ts";
import { emptyHead, type ManifestHead, type Seal } from "./manifest.ts";

export type ProofJob = {
  id: string;
  /** Random per job; the scope of the manifest head's HMAC, so heads can't move between jobs. */
  uid: string;
  /** The job worktree: the app source the proofs run against. */
  worktree: string;
  /** bin/dev of the engine-owned Toolkit checkout. */
  toolkitBin: string;
  /** The id `up` was given for this job's slot. */
  slotId: string;
  round: number;
  manifestHead: ManifestHead;
};

export const jobFile = (jobDir: string) => path.join(jobDir, "job.json");
export const evidenceDir = (jobDir: string) => path.join(jobDir, "evidence");
export const sealOf = (job: Pick<ProofJob, "uid">): Seal => ({ scope: job.uid, key: engineKey() });

export function readJob(jobDir: string): ProofJob {
  return JSON.parse(fs.readFileSync(jobFile(jobDir), "utf8")) as ProofJob;
}

export function writeJob(jobDir: string, job: ProofJob) {
  const f = jobFile(jobDir);
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(job, null, 2)}\n`);
  fs.renameSync(`${f}.tmp`, f);
}

export function createJob(jobDir: string, o: Omit<ProofJob, "uid" | "manifestHead">): ProofJob {
  if (fs.existsSync(jobFile(jobDir))) throw new Error(`${jobFile(jobDir)} exists; a job's manifest never restarts`);
  fs.mkdirSync(evidenceDir(jobDir), { recursive: true });
  const uid = randomUUID();
  const job: ProofJob = { ...o, uid, manifestHead: emptyHead(sealOf({ uid })) };
  writeJob(jobDir, job);
  return job;
}

/**
 * One drive at a time per job, across processes (the CLI and the MCP bridge) and
 * within one: the next evidence id is read from the head under this lock, so
 * two drives can never predict the same e<N>.
 */
export function withJobLock<T>(jobDir: string, fn: () => Promise<T>): Promise<T> {
  const abs = path.resolve(jobDir);
  return serialize(abs, () => withFileLock(path.join(abs, "drive.lock"), fn, { timeoutMs: 15 * 60_000 }));
}
