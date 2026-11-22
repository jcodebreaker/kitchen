// Job worktrees and engine commits, all through engine/git.ts (explicit gitdir,
// neutral config, scrubbed env). The worktree is created the first time a
// write-tier stage needs it, at .worktrees/<id> on branch kitchen/<id> from the
// job's base; its gitdir is resolved then, engine side, and stored in job.json.
import fs from "node:fs";
import path from "node:path";
import { GitError, linkedWorktree, openGit, plainCheckout } from "./git.ts";
import type { Job } from "./machine.ts";
import { updateJob, worktreeOf } from "./store.ts";

const IDENTITY = { GIT_AUTHOR_NAME: "Kitchen", GIT_AUTHOR_EMAIL: "kitchen@localhost", GIT_COMMITTER_NAME: "Kitchen", GIT_COMMITTER_EMAIL: "kitchen@localhost" };
/** Agents' one-file outbox: never committed. */
const OUTBOX = ".kitchen-out";
type Git = Awaited<ReturnType<typeof openGit>>;
/**
 * Stage everything but the outbox. Not an `:(exclude)` pathspec: when the repo's
 * .gitignore names .kitchen-out (fixture A does), `git add` refuses an exclude
 * pathspec that matches an ignored path, so it is unstaged afterwards instead.
 */
async function addAll(git: Git) {
  await git.run(["add", "-A", "--", "."]);
  await git.run(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", OUTBOX]);
}
/** `git status --porcelain` lines outside the outbox: empty means clean. */
async function dirtyLines(git: Git): Promise<string> {
  const out = (await git.run(["status", "--porcelain", "--untracked-files=all", "--", "."])).stdout;
  return out
    .split("\n")
    .filter((l) => l.trim() && l.slice(3) !== OUTBOX && !l.slice(3).startsWith(`${OUTBOX}/`))
    .join("\n");
}

export async function mainHead(repo: string): Promise<string> {
  const git = await openGit(plainCheckout(repo));
  return (await git.run(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
}

/**
 * Idempotent: a worktree recorded in job.json is reused; a branch left by a
 * crash is checked out again. A folder at the worktree path that job.json does
 * not record is not trusted (a `worktree add` cut short by a crash, or anything
 * else): it is moved aside to `<id>.stray-<time>` and the worktree is created
 * again. No agent has run in it, since agents run only after this returns.
 */
export async function ensureWorktree(repo: string, job: Job, now = new Date()): Promise<Job> {
  const wt = worktreeOf(repo, job.id);
  if (job.worktree && job.gitDir && fs.existsSync(wt)) return job;
  if (!job.base) throw new Error(`${repo} had no commit when ${job.id} was taken in; commit something first`);
  const main = await openGit(plainCheckout(repo));
  if (fs.existsSync(wt) && !job.worktree) {
    fs.renameSync(wt, `${wt}.stray-${now.toISOString().replace(/[:.]/g, "-")}`);
  }
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

/** A file's text at a commit (default HEAD), or null when it has no such file. */
export async function fileAtHead(job: Job, rel: string, ref = "HEAD"): Promise<string | null> {
  try {
    return (await (await gitOf(job)).run(["show", `${ref}:${rel}`])).stdout;
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

/** Paths a role left changed in the worktree (tracked or new), outside the outbox. */
export async function pendingFiles(job: Job): Promise<string[]> {
  const lines = (await dirtyLines(await gitOf(job))).split("\n").filter(Boolean);
  return lines.map((l) => l.slice(3).replace(/^"|"$/g, "")).map((p) => (p.includes(" -> ") ? (p.split(" -> ").at(-1) ?? p) : p));
}

export async function headOf(job: Job): Promise<string> {
  return (await (await gitOf(job)).run(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
}

/** When the job branch's HEAD was committed (ISO). */
export async function headTime(job: Job): Promise<string> {
  return (await (await gitOf(job)).run(["log", "-1", "--format=%cI", "HEAD"])).stdout.trim();
}

const TOOLKIT = ".kitchen/toolkit";
/** Toolkit files a job branch may change: feature drives only. Primitives belong on a Toolkit PR. */
const TOOLKIT_PRIMITIVES = [TOOLKIT, `:(exclude)${TOOLKIT}/features`];

/**
 * Put every Toolkit file outside features/ back as it is at HEAD, in the index
 * and the worktree: a job commit never carries a Toolkit primitive change (a
 * smith's edit, or a builder's). Returns the paths put back.
 * W3b: the smith works on its own Toolkit PR branch in an engine-owned checkout,
 * so there is nothing of its work here to lose; in W1 its edits in the job
 * worktree are dropped by this.
 */
export async function stripToolkitEdits(job: Job): Promise<string[]> {
  const git = await gitOf(job);
  const z = (s: string) => s.split("\0").filter(Boolean);
  const inHead = new Set(z((await git.run(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", TOOLKIT])).stdout));
  if (!inHead.size && !fs.existsSync(path.join(job.worktree, TOOLKIT))) return []; // no Toolkit either side
  await git.run(["add", "-A", "--", ...TOOLKIT_PRIMITIVES]);
  const changed = z((await git.run(["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--", ...TOOLKIT_PRIMITIVES])).stdout);
  if (!changed.length) return [];
  const tracked = changed.filter((p) => inHead.has(p));
  const added = changed.filter((p) => !inHead.has(p));
  if (tracked.length) await git.run(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
  if (added.length) {
    await git.run(["rm", "--cached", "--quiet", "-f", "--", ...added]);
    for (const p of added) fs.rmSync(path.join(job.worktree, p), { force: true });
  }
  return changed;
}

/**
 * Commit everything the role left in the worktree (except .kitchen-out/, and
 * Toolkit primitive edits, which are put back first: `stripped`).
 * Running it again after a crash finds nothing staged and commits nothing.
 */
export async function commitAll(job: Job, message: string): Promise<{ committed: boolean; head: string; ahead: boolean; clean: boolean; stripped: string[] }> {
  const git = await gitOf(job);
  const stripped = await stripToolkitEdits(job);
  await addAll(git);
  let staged = false;
  try {
    await git.run(["diff", "--cached", "--quiet", "--no-ext-diff"]);
  } catch (e) {
    if (!(e instanceof GitError) || e.exitCode !== 1) throw e;
    staged = true;
  }
  if (staged) await git.run(["commit", "--quiet", "--no-verify", "-m", message], { env: IDENTITY });
  const head = (await git.run(["rev-parse", "HEAD"])).stdout.trim();
  const status = await dirtyLines(git);
  return { committed: staged, head, ahead: head !== job.base, clean: status === "", stripped };
}

/** What a role may leave in the worktree for the engine to commit (PLAN §2 layer rules). */
export type CommitPolicy = (file: string, status: "A" | "M" | "D" | string) => string | null;

/**
 * Commit what a role left, after putting back every change `policy` refuses (it
 * returns the reason): a tracked file goes back to HEAD, an added one is removed.
 * `refused` lists `path: reason` for the log and the facts. .kitchen-out/ is never committed.
 */
export async function commitWith(
  job: Job,
  message: string,
  policy: CommitPolicy,
): Promise<{ committed: boolean; head: string; ahead: boolean; clean: boolean; refused: string[]; files: string[] }> {
  const git = await gitOf(job);
  await addAll(git);
  const rows = (await git.run(["diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"])).stdout.split("\0").filter(Boolean);
  const changes: { status: string; file: string }[] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) changes.push({ status: rows[i], file: rows[i + 1] });
  const refused: string[] = [];
  const restore: string[] = [];
  const drop: string[] = [];
  for (const c of changes) {
    const why = policy(c.file, c.status);
    if (!why) continue;
    refused.push(`${c.file}: ${why}`);
    (c.status === "A" ? drop : restore).push(c.file);
  }
  if (restore.length) await git.run(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...restore]);
  if (drop.length) {
    await git.run(["rm", "--cached", "--quiet", "-f", "--", ...drop]);
    for (const p of drop) fs.rmSync(path.join(job.worktree, p), { force: true });
  }
  let staged = false;
  try {
    await git.run(["diff", "--cached", "--quiet", "--no-ext-diff"]);
  } catch (e) {
    if (!(e instanceof GitError) || e.exitCode !== 1) throw e;
    staged = true;
  }
  if (staged) await git.run(["commit", "--quiet", "--no-verify", "-m", message], { env: IDENTITY });
  const head = (await git.run(["rev-parse", "HEAD"])).stdout.trim();
  const status = await dirtyLines(git);
  const files = changes.filter((c) => !refused.some((r) => r.startsWith(`${c.file}: `))).map((c) => c.file);
  return { committed: staged, head, ahead: head !== job.base, clean: status === "", refused, files };
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

/** The job's whole diff from the base to HEAD, as a patch (for reviewers and the report). */
export async function diffPatch(job: Job): Promise<string> {
  return (await (await gitOf(job)).run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", job.base, "HEAD"])).stdout;
}

/** The job branch's commits since the base, one line each. */
export async function commitLog(job: Job): Promise<string> {
  return (await (await gitOf(job)).run(["log", "--no-color", "--format=%h %s", `${job.base}..HEAD`])).stdout.trim();
}
