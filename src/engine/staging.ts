// Auto-merge into a job's target (ADR 0016 §5; ADR 0026: staging, or the branch its ticket named), adapted from
// super-board's merge gate (MIT, see NOTICE): take the target's lock (one merge per target at a time; different
// targets don't wait for each other), merge the reviewed
// head into the target as it is right now in a scratch worktree, run the checks there, and only then move the target.
// Local repos move the local branch (compare-and-swap on its old tip); GitHub repos push the job branch, open (or
// find) its PR into the target and merge it with `--match-head-commit`, pinned to the head the review passed.
// ADR 0026 §4, `staging.merge: pr`: the same merge check, then the PR is opened (or updated) with the Report and a
// person merges it on GitHub; Kitchen never does.
//
// Kitchen never pushes to or merges into the base branch or main itself: `assertNotProtected` refuses it here, and
// the protected-push guard hook refuses it for agents.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type AppForCheck, type OnCheck, prepareOf, runChecks } from "../checks/run-checks.ts";
import { type Config, checksFor, neverMerges, protectedTarget, targetOf } from "../config.ts";
import { withFileLock } from "../lock.ts";
import { composeProject, startApp, stopApp } from "../qa/app.ts";
import { branchExists, git, gitOut, revParse, worktrees } from "./git.ts";
import type { Job } from "./machine.ts";
import { kitchenDir } from "./store.ts";

/** A trial merge kept for its touched features to be driven before it lands (ADR 0017 §3). */
export type Drive = { onto: string; sha: string; wt: string; features: string[] };

export type MergeOutcome =
  /** `via: "pr"` (staging.merge: pr): not merged, its PR is open (or updated) for a person; `sha` is the merge check's commit. */
  | { ok: true; sha: string; via: "local" | "github" | "pr"; pr?: number; url?: string; onto?: string }
  /**
   * `back`: the work goes back to Build (a conflict, checks red on staging); else it stops at Ready. `cause` and
   * `onto` (staging's tip it merged onto) let Kitchen tell a catch-up from a round (ADR 0018 §3).
   */
  | { ok: false; why: string; back: boolean; log?: string; drive?: undefined; cause?: "conflict" | "checks"; onto?: string; tail?: string; mergeOnly?: boolean }
  /** Not merged yet: these features must be driven on the trial merge first (its worktree is kept). */
  | { ok: false; why: string; back: false; drive: Drive };

const IDENTITY = ["-c", "user.name=Kitchen", "-c", "user.email=kitchen@localhost"];

export function assertNotProtected(cfg: Config, branch: string) {
  if (protectedTarget(cfg, branch)) throw new Error(`Kitchen never merges into ${branch}`);
}

/**
 * ADR 0026 §3: why a branch can't be a ticket's target, or null. It must exist (on origin for GitHub, else locally):
 * Kitchen never creates it. With `merge: kitchen` the base, main and master are refused, as for staging.
 */
export async function refuseTarget(repo: string, cfg: Config, branch: string): Promise<string | null> {
  if ((await git(repo, ["check-ref-format", "--branch", branch], { allowFail: true })).code) return `${branch} is not a branch name`;
  if (cfg.staging.merge === "kitchen" && protectedTarget(cfg, branch))
    return `--into ${branch}: ${neverMerges(cfg)} (with staging.merge: pr a person merges it)`;
  if (cfg.forge.kind === "github") {
    const r = await git(repo, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], { allowFail: true });
    if (r.code) return `there is no branch ${branch} on origin: Kitchen never creates a target, push it first`;
  } else if (!(await branchExists(repo, branch))) return `there is no branch ${branch}: Kitchen never creates a target, make it first`;
  return null;
}

/** The lock merges into one target take (ADR 0026 §5): merges into the same target wait, others don't. */
export const targetLock = (repo: string, target: string) => path.join(kitchenDir(repo), "merge", `${encodeURIComponent(target)}.lock`);

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

/** The commit a branch points at (origin's on GitHub, after a fetch). */
export async function targetTip(repo: string, cfg: Config, branch: string): Promise<string | null> {
  if (cfg.forge.kind === "github") {
    await git(repo, ["fetch", "-q", "origin", branch], { allowFail: true });
    return (await revParse(repo, `refs/remotes/origin/${branch}`)) ?? (await revParse(repo, branch));
  }
  return revParse(repo, branch);
}

/** The commit staging points at (origin's on GitHub, after a fetch). */
export const stagingTip = (repo: string, cfg: Config) => targetTip(repo, cfg, cfg.staging.branch);

export type CatchUp = { tip: string; merged: "already" | "clean" | "conflict"; conflicts: string[] };

/**
 * Bring the target's tip into a job's worktree before a Build round, so a job that conflicted with its target (or
 * that the target moved under) is rebuilt on top of the target as it is now. A clean merge is committed (as Kitchen);
 * a conflicting one is left in progress for the builder to resolve and commit. Null when there is no target branch.
 */
export async function catchUpWithTarget(repo: string, cfg: Config, wt: string, job: Job): Promise<CatchUp | null> {
  const target = targetOf(cfg, job);
  const tip = await targetTip(repo, cfg, target);
  if (!tip) return null;
  const unmerged = async () => (await git(wt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true })).stdout.split("\n").filter(Boolean);
  // A merge already in progress (an earlier start of this round): the builder concludes that one.
  const pending = await revParse(wt, "MERGE_HEAD");
  if (pending) return { tip: pending, merged: "conflict", conflicts: await unmerged() };
  if ((await git(wt, ["merge-base", "--is-ancestor", tip, "HEAD"], { allowFail: true })).code === 0) return { tip, merged: "already", conflicts: [] };
  const m = await git(wt, [...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `Merge ${target} into ${job.branch}`, tip], { allowFail: true });
  if (!m.code) return { tip, merged: "clean", conflicts: [] };
  const conflicts = await unmerged();
  if (!conflicts.length) {
    // Not a conflict (e.g. an untracked file in the way): leave the worktree as it was.
    await git(wt, ["merge", "--abort"], { allowFail: true });
    throw new Error(`could not merge ${target} into ${job.branch}: ${(m.stderr || m.stdout).trim().split("\n").pop()}`);
  }
  return { tip, merged: "conflict", conflicts };
}

export const trialWorktree = (repo: string, id: string) => path.join(kitchenDir(repo), "merge", id);

/** Remove a trial merge's worktree. */
export async function dropTrial(repo: string, wt: string) {
  await git(repo, ["worktree", "remove", "--force", wt], { allowFail: true });
  fs.rmSync(wt, { recursive: true, force: true });
}

/**
 * ADR 0021 §1: the app for a `needs_app` merge check, started from the trial merge's folder like `kitchen qa up`
 * starts a job's (reset, a free port, the health check). A compose app runs in its own project, `kq<job>-merge`, so
 * it never shares containers or volumes with the job's QA stack.
 */
function mergeApp(cfg: Config, job: Job, wt: string, log: string): AppForCheck {
  return async () => {
    const project = composeProject(cfg.app, job.id);
    const r = await startApp(cfg, { wt, log, project: project ? `${project}-merge` : null });
    if (!r.ok) {
      if (r.app) await stopApp(r.app, log);
      return { ok: false, why: r.why };
    }
    const app = r.app;
    return { ok: true, url: app.url, stop: () => stopApp(app, log) };
  };
}

/** Merge `head` (the reviewed commit of the job branch) onto `onto` in a scratch worktree, then run the checks there. */
async function trialMerge(
  repo: string,
  cfg: Config,
  job: Job,
  onto: string,
  head: string,
  log: string,
  onCheck?: OnCheck,
): Promise<
  | { ok: true; sha: string; wt: string }
  | { ok: false; why: string; back: boolean; wt: string; cause: "conflict" | "checks"; tail?: string; mergeOnly?: boolean }
> {
  const wt = trialWorktree(repo, job.id);
  await dropTrial(repo, wt);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, onto]);
  const m = await git(wt, [...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `Merge ${job.branch}: ${job.title}`, head], { allowFail: true });
  if (m.code) {
    const conflicts = (await git(wt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true })).stdout.split("\n").filter(Boolean);
    await git(wt, ["merge", "--abort"], { allowFail: true });
    return {
      ok: false,
      why: `it conflicts with ${targetOf(cfg, job)}${conflicts.length ? ` in ${conflicts.join(", ")}` : ""}`,
      back: true,
      wt,
      cause: "conflict",
    };
  }
  // Every check, the `when: merge` ones too (ADR 0021); a `needs_app` one gets the app started from this merge.
  const checks = await runChecks({ dir: wt, checks: checksFor(cfg, "merge"), prepare: prepareOf(cfg), log, app: mergeApp(cfg, job, wt, log), onCheck });
  if (!checks.ok) {
    const bad = checks.results.find((r) => !r.ok);
    return {
      ok: false,
      why: `the checks fail on ${targetOf(cfg, job)} with this change merged (${bad?.name}: ${bad?.exit !== null ? `exit ${bad?.exit}` : bad.tail.startsWith("the app did not start") ? "the app did not start" : "timeout"})`,
      back: true,
      wt,
      cause: "checks",
      tail: bad?.tail,
      mergeOnly: cfg.checkList.find((c) => c.name === bad?.name)?.when === "merge",
    };
  }
  return { ok: true, sha: await gitOut(wt, ["rev-parse", "HEAD"]), wt };
}

/**
 * Merge the job's reviewed head into its target (ADR 0026: staging unless its ticket named another). The checks
 * re-run on the merged result first; the target moves only if they pass and it didn't move meanwhile (local:
 * update-ref with the old tip; GitHub: --match-head-commit). With `staging.merge: pr` nothing lands: the job branch is
 * pushed and its PR into the target opened or updated with `prBody`, for a person to merge on GitHub.
 *
 * ADR 0017 §3: `gate` names the features the merged result touches; when it names any, nothing lands yet: the
 * outcome is a `drive` and the trial worktree stays for the regress lane. `drove`: the trial merge whose features
 * were driven and passed; when the target is still where it was, that exact commit lands without another trial.
 * `merge`: who merges, when not kitchen.yaml's (the verify map's own upkeep always lands itself).
 */
export async function mergeToTarget(
  repo: string,
  cfg: Config,
  job: Job,
  reviewedHead: string,
  o: {
    log: string;
    gh?: Gh;
    gate?: (t: { onto: string; sha: string; wt: string }) => Promise<string[]>;
    drove?: { onto: string; sha: string };
    onCheck?: OnCheck;
    merge?: "kitchen" | "pr";
    prBody?: (check: { onto: string; sha: string }) => string;
  },
): Promise<MergeOutcome> {
  const name = targetOf(cfg, job);
  const mode = o.merge ?? cfg.staging.merge;
  if (mode === "kitchen") assertNotProtected(cfg, name);
  const gh = o.gh ?? realGh;
  return withFileLock(
    targetLock(repo, name),
    async () => {
      const head = await revParse(repo, job.branch);
      if (head !== reviewedHead)
        return { ok: false, why: `${job.branch} moved since review (${head?.slice(0, 7)} is not the reviewed ${reviewedHead.slice(0, 7)})`, back: false };
      const onto = await targetTip(repo, cfg, name);
      if (!onto) return { ok: false, why: `there is no ${name} branch${name === cfg.staging.branch ? " (kitchen init creates it)" : ""}`, back: false };
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
          t = await trialMerge(repo, cfg, job, onto, reviewedHead, o.log, o.onCheck);
          if (!t.ok)
            return {
              ok: false,
              why: t.why,
              back: t.back,
              log: o.log,
              cause: t.cause,
              onto,
              ...(t.tail ? { tail: t.tail } : {}),
              ...(t.mergeOnly ? { mergeOnly: true } : {}),
            };
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
        // GitHub: the job branch goes up (Kitchen pushes, never an agent).
        const push = await git(repo, ["push", "-q", "origin", `${reviewedHead}:refs/heads/${job.branch}`], { allowFail: true });
        if (push.code) return { ok: false, why: `could not push ${job.branch}: ${push.stderr.trim().split("\n").pop()}`, back: false };
        const body = o.prBody?.({ onto, sha }) ?? `Kitchen job ${job.id}. The Report is in .kitchen/jobs/${job.id}/report.html on the machine that ran it.`;
        const pr = await openPr(repo, gh, job, name, body, mode === "pr");
        if ("why" in pr) return { ok: false, why: pr.why, back: false };
        // ADR 0026 §4: a person merges it on GitHub.
        if (mode === "pr") return { ok: true, sha, via: "pr", pr: pr.number, url: pr.url, onto };
        // Kitchen merges it, pinned to the reviewed head.
        const merged = await gh(["pr", "merge", String(pr.number), "--merge", "--match-head-commit", reviewedHead], repo);
        if (merged.code) return { ok: false, why: `gh pr merge #${pr.number} refused: ${merged.stderr.trim().split("\n").pop()}`, back: false };
        await git(repo, ["fetch", "-q", "origin", name], { allowFail: true });
        const landed = (await revParse(repo, `refs/remotes/origin/${name}`)) ?? sha;
        return { ok: true, sha: landed, via: "github", pr: pr.number, url: pr.url };
      } finally {
        if (t?.wt && !keep) await dropTrial(repo, t.wt);
      }
    },
    { timeoutMs: 30 * 60_000 },
  );
}

/** The job's open PR into `base`: the one it has, else one GitHub lists for its branch, else a new one. `update`: its body (and base) rewritten. */
async function openPr(repo: string, gh: Gh, job: Job, base: string, body: string, update: boolean): Promise<{ number: number; url: string } | { why: string }> {
  let pr = job.pr?.state === "open" ? { number: job.pr.number, url: job.pr.url } : null;
  if (!pr) {
    const found = await gh(["pr", "list", "--head", job.branch, "--base", base, "--state", "open", "--json", "number,url", "-q", ".[0]"], repo);
    try {
      const f = JSON.parse(found.stdout.trim() || "null") as { number?: number; url?: string } | null;
      if (f?.number) pr = { number: f.number, url: f.url ?? "" };
    } catch {}
    if (pr && !update) return pr;
  }
  if (pr) {
    if (!update) return pr;
    const ed = await gh(["pr", "edit", String(pr.number), "--base", base, "--body", body], repo);
    if (ed.code) return { why: `could not update PR #${pr.number}: ${ed.stderr.trim().split("\n").pop()}` };
    return pr;
  }
  const made = await gh(["pr", "create", "--base", base, "--head", job.branch, "--title", job.title, "--body", body], repo);
  if (made.code) return { why: `could not open the PR: ${made.stderr.trim().split("\n").pop()}` };
  const url = /https?:\/\/\S+\/pull\/\d+/.exec(made.stdout)?.[0] ?? "";
  const number = Number(/\/pull\/(\d+)/.exec(made.stdout)?.[1]) || 0;
  if (!number) return { why: `gh pr create printed no PR URL: ${made.stdout.trim()}` };
  return { number, url };
}
