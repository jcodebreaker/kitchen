// Auto-merge into staging (ADR 0016 §5), adapted from super-board's merge gate (MIT, see NOTICE): take the merge
// lock, merge the reviewed head into staging as it is right now in a scratch worktree, run the checks there, and
// only then move staging. Local repos move the local `staging` branch (compare-and-swap on its old tip); GitHub repos
// push the job branch, open (or find) its PR into staging and merge it with `--match-head-commit`, pinned to the
// head the review passed.
//
// Kitchen never pushes to or merges into the base branch or main: `assertNotProtected` refuses it here, and the
// protected-push guard hook refuses it for agents.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prepareOf, runChecks } from "../checks/run-checks.ts";
import type { Config } from "../config.ts";
import { withFileLock } from "../lock.ts";
import { branchExists, git, gitOut, revParse, worktrees } from "./git.ts";
import type { Job } from "./machine.ts";
import { kitchenDir } from "./store.ts";

/** A trial merge kept for its touched features to be driven before it lands (ADR 0017 §3). */
export type Drive = { onto: string; sha: string; wt: string; features: string[] };

export type MergeOutcome =
  | { ok: true; sha: string; via: "local" | "github"; pr?: number }
  /** `back`: the work needs another Build round (a conflict, checks red on staging); else it stops at Ready. */
  | { ok: false; why: string; back: boolean; log?: string; drive?: undefined }
  /** Not merged yet: these features must be driven on the trial merge first (its worktree is kept). */
  | { ok: false; why: string; back: false; drive: Drive };

const IDENTITY = ["-c", "user.name=Kitchen", "-c", "user.email=kitchen@localhost"];

export function assertNotProtected(cfg: Config, branch: string) {
  if ([cfg.staging.base, "main", "master"].includes(branch)) throw new Error(`Kitchen never merges into ${branch}`);
}

export type Gh = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export const realGh: Gh = (args, cwd) =>
  new Promise((resolve) => {
    execFile(process.env.KITCHEN_GH_BIN || "gh", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? Number((err as { code?: unknown }).code) || 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });

/** Create staging from the base when it is missing (init). Local: a branch; GitHub: also on origin. */
export async function ensureStaging(repo: string, cfg: Config, out: (l: string) => void, gh: Gh = realGh): Promise<void> {
  const name = cfg.staging.branch;
  assertNotProtected(cfg, name);
  if (cfg.forge.kind === "github") {
    await git(repo, ["fetch", "-q", "origin"], { allowFail: true });
    if (await revParse(repo, `refs/remotes/origin/${name}`)) {
      if (!(await branchExists(repo, name))) await git(repo, ["branch", "--track", name, `origin/${name}`]);
      out(`staging: origin/${name} is there`);
      return;
    }
    const base = (await revParse(repo, `refs/remotes/origin/${cfg.staging.base}`)) ?? (await revParse(repo, cfg.staging.base));
    if (!base) throw new Error(`no ${cfg.staging.base} to create ${name} from`);
    const repoName = cfg.forge.repo ?? (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], repo)).stdout.trim();
    const r = await gh(["api", `repos/${repoName}/git/refs`, "-f", `ref=refs/heads/${name}`, "-f", `sha=${base}`], repo);
    if (r.code) throw new Error(`could not create ${name} on GitHub: ${r.stderr.trim().split("\n").pop()}`);
    await git(repo, ["fetch", "-q", "origin", name], { allowFail: true });
    if (!(await branchExists(repo, name))) await git(repo, ["branch", "--track", name, `origin/${name}`], { allowFail: true });
    out(`staging: created ${name} on GitHub from ${cfg.staging.base} (${base.slice(0, 7)})`);
    return;
  }
  if (await branchExists(repo, name)) {
    out(`staging: ${name} is there`);
    return;
  }
  const base = await revParse(repo, cfg.staging.base);
  if (!base) throw new Error(`no ${cfg.staging.base} branch to create ${name} from (set staging.base in kitchen.yaml)`);
  await git(repo, ["branch", name, base]);
  out(`staging: created ${name} from ${cfg.staging.base} (${base.slice(0, 7)})`);
}

/** The commit staging points at (origin's on GitHub, after a fetch). */
export async function stagingTip(repo: string, cfg: Config): Promise<string | null> {
  if (cfg.forge.kind === "github") {
    await git(repo, ["fetch", "-q", "origin", cfg.staging.branch], { allowFail: true });
    return (await revParse(repo, `refs/remotes/origin/${cfg.staging.branch}`)) ?? (await revParse(repo, cfg.staging.branch));
  }
  return revParse(repo, cfg.staging.branch);
}

export type CatchUp = { tip: string; merged: "already" | "clean" | "conflict"; conflicts: string[] };

/**
 * Bring staging's tip into a job's worktree before a Build round, so a job that conflicted with staging (or that
 * staging moved under) is rebuilt on top of staging as it is now. A clean merge is committed (as Kitchen); a
 * conflicting one is left in progress for the builder to resolve and commit. Null when there is no staging.
 */
export async function catchUpWithStaging(repo: string, cfg: Config, wt: string, job: Job): Promise<CatchUp | null> {
  const tip = await stagingTip(repo, cfg);
  if (!tip) return null;
  const unmerged = async () => (await git(wt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true })).stdout.split("\n").filter(Boolean);
  // A merge already in progress (an earlier start of this round): the builder concludes that one.
  const pending = await revParse(wt, "MERGE_HEAD");
  if (pending) return { tip: pending, merged: "conflict", conflicts: await unmerged() };
  if ((await git(wt, ["merge-base", "--is-ancestor", tip, "HEAD"], { allowFail: true })).code === 0) return { tip, merged: "already", conflicts: [] };
  const m = await git(wt, [...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `Merge ${cfg.staging.branch} into ${job.branch}`, tip], { allowFail: true });
  if (!m.code) return { tip, merged: "clean", conflicts: [] };
  const conflicts = await unmerged();
  if (!conflicts.length) {
    // Not a conflict (e.g. an untracked file in the way): leave the worktree as it was.
    await git(wt, ["merge", "--abort"], { allowFail: true });
    throw new Error(`could not merge ${cfg.staging.branch} into ${job.branch}: ${(m.stderr || m.stdout).trim().split("\n").pop()}`);
  }
  return { tip, merged: "conflict", conflicts };
}

export const trialWorktree = (repo: string, id: string) => path.join(kitchenDir(repo), "merge", id);

/** Remove a trial merge's worktree. */
export async function dropTrial(repo: string, wt: string) {
  await git(repo, ["worktree", "remove", "--force", wt], { allowFail: true });
  fs.rmSync(wt, { recursive: true, force: true });
}

/** Merge `head` (the reviewed commit of the job branch) onto `onto` in a scratch worktree, then run the checks there. */
async function trialMerge(
  repo: string,
  cfg: Config,
  job: Job,
  onto: string,
  head: string,
  log: string,
): Promise<{ ok: true; sha: string; wt: string } | { ok: false; why: string; back: boolean; wt: string }> {
  const wt = trialWorktree(repo, job.id);
  await dropTrial(repo, wt);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, onto]);
  const m = await git(wt, [...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `Merge ${job.branch}: ${job.title}`, head], { allowFail: true });
  if (m.code) {
    const conflicts = (await git(wt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true })).stdout.split("\n").filter(Boolean);
    await git(wt, ["merge", "--abort"], { allowFail: true });
    return { ok: false, why: `it conflicts with ${cfg.staging.branch}${conflicts.length ? ` in ${conflicts.join(", ")}` : ""}`, back: true, wt };
  }
  const checks = await runChecks({ dir: wt, checks: cfg.checkList, prepare: prepareOf(cfg), log });
  if (!checks.ok) {
    const bad = checks.results.find((r) => !r.ok);
    return {
      ok: false,
      why: `the checks fail on ${cfg.staging.branch} with this change merged (${bad?.name}: exit ${bad?.exit ?? "timeout"})`,
      back: true,
      wt,
    };
  }
  return { ok: true, sha: await gitOut(wt, ["rev-parse", "HEAD"]), wt };
}

/**
 * Merge the job's reviewed head into staging. The checks re-run on the merged result first; staging moves only if
 * they pass and staging didn't move meanwhile (local: update-ref with the old tip; GitHub: --match-head-commit).
 *
 * ADR 0017 §3: `gate` names the features the merged result touches; when it names any, nothing lands yet: the
 * outcome is a `drive` and the trial worktree stays for the regress lane. `drove`: the trial merge whose features
 * were driven and passed; when staging is still where it was, that exact commit lands without another trial.
 */
export async function mergeToStaging(
  repo: string,
  cfg: Config,
  job: Job,
  reviewedHead: string,
  o: { log: string; gh?: Gh; gate?: (t: { onto: string; sha: string; wt: string }) => Promise<string[]>; drove?: { onto: string; sha: string } },
): Promise<MergeOutcome> {
  const name = cfg.staging.branch;
  assertNotProtected(cfg, name);
  const gh = o.gh ?? realGh;
  return withFileLock(
    path.join(kitchenDir(repo), "merge.lock"),
    async () => {
      const head = await revParse(repo, job.branch);
      if (head !== reviewedHead)
        return { ok: false, why: `${job.branch} moved since review (${head?.slice(0, 7)} is not the reviewed ${reviewedHead.slice(0, 7)})`, back: false };
      const onto = await stagingTip(repo, cfg);
      if (!onto) return { ok: false, why: `there is no ${name} branch (kitchen init creates it)`, back: false };
      if (cfg.forge.kind === "local") {
        const holder = (await worktrees(repo)).find((w) => w.branch === name);
        if (holder) return { ok: false, why: `${name} is checked out in ${holder.path}: Kitchen won't move a branch under a checkout`, back: false };
      }
      let t: Awaited<ReturnType<typeof trialMerge>> | undefined;
      let keep = false;
      try {
        let sha: string;
        if (o.drove && o.drove.onto === onto) sha = o.drove.sha;
        else {
          t = await trialMerge(repo, cfg, job, onto, reviewedHead, o.log);
          if (!t.ok) return { ok: false, why: t.why, back: t.back, log: o.log };
          sha = t.sha;
          const features = o.gate ? await o.gate({ onto, sha, wt: t.wt }) : [];
          if (features.length) {
            keep = true;
            return { ok: false, why: `drive ${features.join(", ")} first`, back: false, drive: { onto, sha, wt: t.wt, features } };
          }
        }
        if (cfg.forge.kind === "local") {
          const r = await git(repo, ["update-ref", "-m", `kitchen: merge ${job.branch}`, `refs/heads/${name}`, sha, onto], { allowFail: true });
          if (r.code) return { ok: false, why: `${name} moved while the checks ran; the next pass tries again`, back: false };
          return { ok: true, sha, via: "local" };
        }
        // GitHub: the job branch goes up (Kitchen pushes, never an agent), its PR into staging merges pinned to the reviewed head.
        const push = await git(repo, ["push", "-q", "origin", `${reviewedHead}:refs/heads/${job.branch}`], { allowFail: true });
        if (push.code) return { ok: false, why: `could not push ${job.branch}: ${push.stderr.trim().split("\n").pop()}`, back: false };
        let pr = job.pr;
        if (!pr) {
          const found = await gh(["pr", "list", "--head", job.branch, "--base", name, "--state", "open", "--json", "number", "-q", ".[0].number"], repo);
          pr = Number(found.stdout.trim()) || null;
        }
        if (!pr) {
          const made = await gh(
            [
              "pr",
              "create",
              "--base",
              name,
              "--head",
              job.branch,
              "--title",
              job.title,
              "--body",
              `Kitchen job ${job.id}. The Report is in .kitchen/jobs/${job.id}/report.html on the machine that ran it.`,
            ],
            repo,
          );
          if (made.code) return { ok: false, why: `could not open the PR: ${made.stderr.trim().split("\n").pop()}`, back: false };
          pr = Number(/\/pull\/(\d+)/.exec(made.stdout)?.[1]) || null;
          if (!pr) return { ok: false, why: `gh pr create printed no PR URL: ${made.stdout.trim()}`, back: false };
        }
        const merged = await gh(["pr", "merge", String(pr), "--merge", "--match-head-commit", reviewedHead], repo);
        if (merged.code) return { ok: false, why: `gh pr merge #${pr} refused: ${merged.stderr.trim().split("\n").pop()}`, back: false };
        await git(repo, ["fetch", "-q", "origin", name], { allowFail: true });
        const landed = (await revParse(repo, `refs/remotes/origin/${name}`)) ?? sha;
        return { ok: true, sha: landed, via: "github", pr };
      } finally {
        if (t?.wt && !keep) await dropTrial(repo, t.wt);
      }
    },
    { timeoutMs: 30 * 60_000 },
  );
}
