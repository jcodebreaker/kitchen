// The slice of job.json that proofs need (the full Job type lands in W1, PLAN §2).
// .kitchen/jobs/<id>/job.json is engine-owned: outside every agent's writable root.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type GitRepo, resolveGitRepo } from "../engine/git.ts";
import { engineKey, ensureHome, kitchenHome } from "../home.ts";
import { serialize, withFileLock } from "../lock.ts";
import { emptyHead, type ManifestHead, type Seal } from "./manifest.ts";

export type ProofJob = {
  id: string;
  /** Random per job; the scope of the manifest head's HMAC, so heads can't move between jobs. */
  uid: string;
  /** The job worktree: the app source the proofs run against. */
  worktree: string;
  /** Its gitdir, resolved by the engine when the job was created (src/engine/git.ts). Never read from the worktree. */
  gitDir: string;
  /** bin/dev of the engine-owned Toolkit checkout. */
  toolkitBin: string;
  /** The id `up` was given for this job's slot. */
  slotId: string;
  round: number;
  manifestHead: ManifestHead;
};

export const jobFile = (jobDir: string) => path.join(jobDir, "job.json");
export const evidenceDir = (jobDir: string) => path.join(jobDir, "evidence");
export const jobGit = (job: Pick<ProofJob, "gitDir" | "worktree">): GitRepo => {
  if (!job.gitDir) throw new Error("job.json has no gitDir: the job predates engine git; create it again");
  return { gitDir: job.gitDir, workTree: job.worktree };
};

/**
 * The per-job head counter, $KITCHEN_HOME/heads/<uid>: the highest entry count
 * the engine ever stored for the job. Only rises. A head below it is a rollback
 * (an older job.json + manifest put back together, both still validly signed).
 */
const headsFile = (uid: string, home = kitchenHome()) => {
  if (!/^[A-Za-z0-9-]+$/.test(uid)) throw new Error(`bad job uid ${JSON.stringify(uid)}`);
  return path.join(ensureHome(home), "heads", uid);
};

export function headFloor(uid: string, home = kitchenHome()): number {
  try {
    const n = Number(fs.readFileSync(headsFile(uid, home), "utf8").trim());
    if (!Number.isInteger(n) || n < 0) throw new Error(`${headsFile(uid, home)} is not a count`);
    return n;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}

export function raiseHeadFloor(uid: string, n: number, home = kitchenHome()) {
  const f = headsFile(uid, home);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  if (fs.existsSync(f) && headFloor(uid, home) >= n) return;
  fs.writeFileSync(`${f}.tmp`, `${n}\n`, { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

export const sealOf = (job: Pick<ProofJob, "uid">): Seal => ({ scope: job.uid, key: engineKey(), floor: headFloor(job.uid) });

export function readJob(jobDir: string): ProofJob {
  return JSON.parse(fs.readFileSync(jobFile(jobDir), "utf8")) as ProofJob;
}

export function writeJob(jobDir: string, job: ProofJob) {
  const f = jobFile(jobDir);
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(job, null, 2)}\n`);
  fs.renameSync(`${f}.tmp`, f);
}

/** job.json first, then the counter: a crash in between leaves the counter low (safe), never high. */
export function storeHead(jobDir: string, job: ProofJob) {
  writeJob(jobDir, job);
  raiseHeadFloor(job.uid, job.manifestHead.n);
}

/**
 * `linked` names the main repo and worktree id of a linked worktree; without it
 * the worktree must be a plain checkout. The gitdir is resolved here, once.
 */
export function createJob(jobDir: string, o: Omit<ProofJob, "uid" | "manifestHead" | "gitDir">, linked?: { mainRepo: string; id: string }): ProofJob {
  if (fs.existsSync(jobFile(jobDir))) throw new Error(`${jobFile(jobDir)} exists; a job's manifest never restarts`);
  const { gitDir } = resolveGitRepo(o.worktree, linked);
  fs.mkdirSync(evidenceDir(jobDir), { recursive: true });
  const uid = randomUUID();
  const job: ProofJob = { ...o, gitDir, uid, manifestHead: emptyHead(sealOf({ uid })) };
  storeHead(jobDir, job);
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
