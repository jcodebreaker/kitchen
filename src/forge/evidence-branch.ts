// The `kitchen-evidence` branch (PLAN §2 "Report: Publishing"): one orphan
// branch, one folder per job (report.html, evidence/, published.json). The engine
// builds each commit itself with git plumbing on a private index (no checkout,
// no worktree, nothing of the user's working tree touched), replacing the job's
// folder and pruning folders published more than `keepDays` ago. A forge then
// decides where the branch goes: the local and fake forges keep it in the repo;
// GitHub pushes it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitError, openGit, plainCheckout } from "../engine/git.ts";
import { withFileLock } from "../lock.ts";

export const EVIDENCE_BRANCH = "kitchen-evidence";
const IDENTITY = { GIT_AUTHOR_NAME: "Kitchen", GIT_AUTHOR_EMAIL: "kitchen@localhost", GIT_COMMITTER_NAME: "Kitchen", GIT_COMMITTER_EMAIL: "kitchen@localhost" };

/** Every file under `dir`, relative, sorted. */
function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)))
    .sort();
}

/** Folders older than `keepDays` by their published.json (a folder without one is kept). Pure. */
export function expired(published: Map<string, string>, now: Date, keepDays: number): string[] {
  const cutoff = now.getTime() - keepDays * 86_400_000;
  return [...published].filter(([, at]) => Number.isFinite(Date.parse(at)) && Date.parse(at) < cutoff).map(([dir]) => dir);
}

/**
 * Commit `bundle` (a folder) as `<job>/` on the evidence branch of `repo`. Idempotent:
 * the same bundle on top of the same branch makes no new commit. Returns the branch head
 * and the folders pruned.
 */
type EvidenceOpts = { repo: string; job: string; bundle: string; keepDays: number; now?: Date; branch?: string };

/** One evidence commit at a time per repo: two jobs reaching report together both moved the branch, and the second update-ref failed (W5). */
export function commitEvidence(o: EvidenceOpts): Promise<{ commit: string; pruned: string[]; files: number }> {
  fs.mkdirSync(path.join(o.repo, ".kitchen"), { recursive: true });
  return withFileLock(path.join(o.repo, ".kitchen", "evidence.lock"), () => commitEvidenceNow(o));
}

async function commitEvidenceNow(o: EvidenceOpts): Promise<{ commit: string; pruned: string[]; files: number }> {
  const branch = o.branch ?? EVIDENCE_BRANCH;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(o.job)) throw new Error(`bad job id ${JSON.stringify(o.job)}`);
  const git = await openGit(plainCheckout(o.repo));
  const ref = `refs/heads/${branch}`;
  let parent: string | null = null;
  try {
    parent = (await git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.trim() || null;
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-evidence-"));
  const env = { ...IDENTITY, GIT_INDEX_FILE: path.join(tmp, "index") };
  try {
    if (parent) await git.run(["read-tree", parent], { env });
    else await git.run(["read-tree", "--empty"], { env });
    // What is on the branch now: top-level folders and when each was published.
    const top = parent ? (await git.run(["ls-tree", "--full-tree", "-d", "--name-only", parent])).stdout.split("\n").filter(Boolean) : [];
    const published = new Map<string, string>();
    for (const d of top) {
      try {
        const p = JSON.parse((await git.run(["show", `${parent}:${d}/published.json`])).stdout) as { at?: string };
        if (p.at) published.set(d, p.at);
      } catch {}
    }
    const pruned = expired(published, o.now ?? new Date(), o.keepDays).filter((d) => d !== o.job);
    for (const d of [o.job, ...pruned]) await git.run(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", `:(top)${d}`], { env }); // from the top: cwd is the gitdir, inside the work tree
    const files = filesUnder(o.bundle);
    for (const f of files) {
      const sha = (await git.run(["hash-object", "-w", "--no-filters", path.join(o.bundle, f)])).stdout.trim();
      await git.run(["update-index", "--add", "--cacheinfo", `100644,${sha},${o.job}/${f.split(path.sep).join("/")}`], { env });
    }
    const tree = (await git.run(["write-tree"], { env })).stdout.trim();
    if (parent && (await git.run(["rev-parse", `${parent}^{tree}`])).stdout.trim() === tree) return { commit: parent, pruned: [], files: files.length };
    const msg = `kitchen: evidence for ${o.job}${pruned.length ? ` (pruned ${pruned.join(", ")})` : ""}`;
    const commit = (await git.run(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", msg], { env })).stdout.trim();
    await git.run(["update-ref", ref, commit, ...(parent ? [parent] : [])]);
    return { commit, pruned, files: files.length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
