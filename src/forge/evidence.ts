// The evidence branch (PLAN §2 "Report: Publishing"): one orphan branch,
// `kitchen-evidence`, with one folder per job (report.html + evidence/), so the
// person who merges sees the proof on GitHub. Folders older than
// `evidence_keep_days` are pruned at each publish. Text files pass through
// proof/redact.ts on the way out (screenshots can't be scanned: Toolkits seed
// only fake data); the job folder keeps the unredacted, hash-chained originals.
//
// Built with engine git only (src/engine/git.ts): a temporary index
// (GIT_INDEX_FILE), hash-object/update-index/write-tree/commit-tree on the main
// repo's gitdir. No worktree is touched, nothing in a worktree runs. Pushed to the
// explicit URL with --receive-pack, never forced: a concurrent publish that won
// makes this one fail (it is retried by the stage).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchFrom, GitError, IDENTITY, openGit, plainCheckout, pushTo } from "../engine/git.ts";
import { redact } from "../proof/redact.ts";

export const EVIDENCE_BRANCH = "kitchen-evidence";
const LOCAL_REF = "refs/kitchen/evidence";
const TEXT = /\.(html?|json|jsonl|md|txt|log|csv|ya?ml|xml|svg)$/i;

/** Whether a file is text to redact: a known text extension, or no NUL byte in its first 8 KB. Pure. */
export function isText(name: string, buf: Buffer): boolean {
  if (TEXT.test(name)) return true;
  if (/\.(png|jpe?g|gif|webp|pdf|zip|gz)$/i.test(name)) return false;
  return !buf.subarray(0, 8192).includes(0);
}

/** The job folders to prune: `at` older than keepDays, never the one being published. Pure. */
export function stale(folders: { name: string; at: string | null }[], keepDays: number, now: Date, publishing: string): string[] {
  const cut = now.getTime() - keepDays * 86_400_000;
  return folders.filter((f) => f.name !== publishing && f.at !== null && Date.parse(f.at) < cut).map((f) => f.name);
}

/** Files to publish from a job folder: report.html (+ its source) and everything under evidence/. Relative paths. */
export function publishable(jobDir: string): string[] {
  const out: string[] = [];
  for (const f of ["report.html", "report.src.html"]) if (fs.existsSync(path.join(jobDir, f))) out.push(f);
  const walk = (rel: string) => {
    const abs = path.join(jobDir, rel);
    if (!fs.existsSync(abs)) return;
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = path.join(rel, d.name);
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) out.push(r);
    }
  };
  walk("evidence");
  return out;
}

export type Published = { commit: string; files: number; redacted: number; pruned: string[] };

export async function publishEvidence(o: {
  repo: string;
  url: string;
  helper?: string;
  job: string;
  jobDir: string;
  keepDays: number;
  now?: Date;
}): Promise<Published> {
  const now = o.now ?? new Date();
  const git = await openGit(plainCheckout(o.repo));
  try {
    await fetchFrom(git, { url: o.url, refspecs: [`+refs/heads/${EVIDENCE_BRANCH}:${LOCAL_REF}`], helper: o.helper });
  } catch (e) {
    if (!(e instanceof GitError) || !/couldn't find remote ref|not our ref|no such ref/i.test(e.stderr)) throw e;
    await git.run(["update-ref", "-d", LOCAL_REF]).catch(() => {}); // the branch doesn't exist yet: an orphan
  }
  let parent = "";
  try {
    parent = (await git.run(["rev-parse", "--verify", "--quiet", `${LOCAL_REF}^{commit}`])).stdout.trim();
  } catch {}
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-evidence-"));
  const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
  try {
    await git.run(parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
    const pruned: string[] = [];
    if (parent) {
      const folders: { name: string; at: string | null }[] = [];
      for (const name of (await git.run(["ls-tree", "--name-only", parent])).stdout.split("\n").filter(Boolean)) {
        let at: string | null = null;
        try {
          at = (JSON.parse((await git.run(["show", `${parent}:${name}/meta.json`])).stdout) as { at?: string }).at ?? null;
        } catch {}
        folders.push({ name, at });
      }
      for (const name of stale(folders, o.keepDays, now, o.job)) {
        await git.run(["rm", "-r", "-f", "--cached", "--quiet", "--", name], { env });
        pruned.push(name);
      }
    }
    await git.run(["rm", "-r", "-f", "--cached", "--quiet", "--ignore-unmatch", "--", o.job], { env });
    let redacted = 0;
    const files = publishable(o.jobDir);
    for (const rel of files) {
      let buf: Buffer = fs.readFileSync(path.join(o.jobDir, rel));
      if (isText(rel, buf)) {
        const before = buf.toString("utf8");
        const after = redact(before);
        if (after !== before) redacted++;
        buf = Buffer.from(after, "utf8");
      }
      const blob = (await git.run(["hash-object", "-w", "--no-filters", "--stdin"], { input: buf })).stdout.trim();
      await git.run(["update-index", "--add", "--cacheinfo", `100644,${blob},${o.job}/${rel.split(path.sep).join("/")}`], { env });
    }
    const meta = JSON.stringify({ job: o.job, at: now.toISOString(), files: files.length, redacted }, null, 2);
    const metaBlob = (await git.run(["hash-object", "-w", "--no-filters", "--stdin"], { input: `${meta}\n` })).stdout.trim();
    await git.run(["update-index", "--add", "--cacheinfo", `100644,${metaBlob},${o.job}/meta.json`], { env });
    const tree = (await git.run(["write-tree"], { env })).stdout.trim();
    const commit = (
      await git.run(
        ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `kitchen evidence: ${o.job}${pruned.length ? ` (pruned ${pruned.length})` : ""}`],
        {
          env: IDENTITY,
        },
      )
    ).stdout.trim();
    await git.run(["update-ref", LOCAL_REF, commit]);
    await pushTo(git, { url: o.url, refspecs: [`${commit}:refs/heads/${EVIDENCE_BRANCH}`], helper: o.helper });
    return { commit, files: files.length + 1, redacted, pruned };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
