// ADR 0022 §5: when a job filed from a GitHub issue merges into staging, Kitchen comments on the issue with the merge
// (the sha and where the Report is) and nothing else: it never closes the issue, never labels it. Best effort, once
// per merge (the job's `filed` keys), through the person's own `gh` login.
import path from "node:path";
import type { Job } from "../engine/machine.ts";
import { type Gh, realGh } from "../engine/staging.ts";
import { jobDirOf, updateJob } from "../engine/store.ts";

/** Pure: the issues a job came from: `github:<owner/repo>#<n>` refs of its items. */
export function issuesOf(job: Pick<Job, "from">): { repo: string; number: number }[] {
  const out: { repo: string; number: number }[] = [];
  for (const r of job.from?.refs ?? []) {
    if (r.kind !== "github") continue;
    const n = /^#(\d+)$/.exec(r.ref);
    const repo = /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(r.url ?? "")?.[1];
    if (n && repo) out.push({ repo, number: Number(n[1]) });
  }
  return out;
}

/** Pure: the comment. */
export function mergeComment(job: Pick<Job, "id" | "title">, m: { into: string; sha: string }, report: string): string {
  return `Kitchen merged a fix for this into \`${m.into}\` as ${m.sha.slice(0, 7)} (job ${job.id}, “${job.title}”).\n\nReport: \`${report}\``;
}

export async function commentOnMerge(repo: string, job: Job, o: { gh?: Gh } = {}): Promise<string[]> {
  const issues = issuesOf(job);
  if (!job.merged || !issues.length) return [];
  const key = `github-comment:${job.merged.sha}`;
  if (job.filed.includes(key)) return [];
  const gh = o.gh ?? realGh;
  const report = path.relative(repo, path.join(jobDirOf(repo, job.id), "report.html"));
  const body = mergeComment(job, job.merged, report);
  const lines: string[] = [];
  for (const i of issues) {
    const r = await gh(["issue", "comment", String(i.number), "--repo", i.repo, "--body", body], repo).catch((e) => ({
      code: 1,
      stdout: "",
      stderr: (e as Error).message,
    }));
    lines.push(r.code ? `couldn't comment on ${i.repo}#${i.number}: ${r.stderr.trim().split("\n").pop()}` : `commented on ${i.repo}#${i.number}`);
  }
  await updateJob(repo, job.id, (j) => ({ ...j, filed: [...j.filed, key] })).catch(() => {});
  return lines;
}
