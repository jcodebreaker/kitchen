// Job worktrees and engine commits, all through engine/git.ts (explicit gitdir,
// neutral config, scrubbed env). The worktree is created the first time a
// write-tier stage needs it, at .worktrees/<id> on branch kitchen/<id> from the
// job's base; its gitdir is resolved then, engine side, and stored in job.json.
import fs from "node:fs";
import { GitError, linkedWorktree, openGit, plainCheckout } from "./git.ts";
import type { Job } from "./machine.ts";
import { updateJob, worktreeOf } from "./store.ts";

const IDENTITY = { GIT_AUTHOR_NAME: "Kitchen", GIT_AUTHOR_EMAIL: "kitchen@localhost", GIT_COMMITTER_NAME: "Kitchen", GIT_COMMITTER_EMAIL: "kitchen@localhost" };
/** Agents' one-file outbox: never committed. */
const NOT_COMMITTED = [":(exclude).kitchen-out", ":(exclude).kitchen-out/**"];

export async function mainHead(repo: string): Promise<string> {
  const git = await openGit(plainCheckout(repo));
  return (await git.run(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
}

/** Idempotent: an existing worktree is reused; a branch left by a crash is checked out again. */
export async function ensureWorktree(repo: string, job: Job): Promise<Job> {
  const wt = worktreeOf(repo, job.id);
  if (job.worktree && job.gitDir && fs.existsSync(wt)) return job;
  if (!job.base) throw new Error(`${repo} had no commit when ${job.id} was taken in; commit something first`);
  const main = await openGit(plainCheckout(repo));
  if (!fs.existsSync(wt)) {
    await main.run(["worktree", "prune"]);
    let hasBranch = true;
    try {
      await main.run(["rev-parse", "--verify", "--quiet", `refs/heads/${job.branch}`]);
    } catch {
      hasBranch = false;
    }
    await main.run(hasBranch ? ["worktree", "add", "--quiet", wt, job.branch] : ["worktree", "add", "--quiet", "-b", job.branch, wt, job.base]);
  }
  const { gitDir, workTree } = linkedWorktree(repo, job.id, wt);
  return updateJob(repo, job.id, (j) => {
    j.worktree = workTree;
    j.gitDir = gitDir;
    return j;
  });
}

const gitOf = (job: Job) => openGit({ gitDir: job.gitDir, workTree: job.worktree });

export async function headOf(job: Job): Promise<string> {
  return (await (await gitOf(job)).run(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
}

/**
 * Commit everything the role left in the worktree (except .kitchen-out/).
 * Running it again after a crash finds nothing staged and commits nothing.
 */
export async function commitAll(job: Job, message: string): Promise<{ committed: boolean; head: string; ahead: boolean; clean: boolean }> {
  const git = await gitOf(job);
  await git.run(["add", "-A", "--", ".", ...NOT_COMMITTED]);
  let staged = false;
  try {
    await git.run(["diff", "--cached", "--quiet", "--no-ext-diff"]);
  } catch (e) {
    if (!(e instanceof GitError) || e.exitCode !== 1) throw e;
    staged = true;
  }
  if (staged) await git.run(["commit", "--quiet", "--no-verify", "-m", message], { env: IDENTITY });
  const head = (await git.run(["rev-parse", "HEAD"])).stdout.trim();
  const status = (await git.run(["status", "--porcelain", "--untracked-files=all", "--", ".", ...NOT_COMMITTED])).stdout.trim();
  return { committed: staged, head, ahead: head !== job.base, clean: status === "" };
}

export async function changedFiles(job: Job, from: string, to = "HEAD"): Promise<string[]> {
  const out = (await (await gitOf(job)).run(["diff", "--name-only", "--no-ext-diff", "--no-textconv", from, to])).stdout;
  return out.split("\n").filter(Boolean);
}

/** Lines added + removed per file between the base and HEAD. */
export async function diffStat(job: Job): Promise<{ file: string; lines: number }[]> {
  const out = (await (await gitOf(job)).run(["diff", "--numstat", "--no-ext-diff", "--no-textconv", job.base, "HEAD"])).stdout;
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, d, file] = l.split("\t");
      return { file, lines: (Number(a) || 0) + (Number(d) || 0) };
    });
}
