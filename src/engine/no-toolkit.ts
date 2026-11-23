// Jobs without a Toolkit (ADR 0010). Quick init leaves a repo with checks but
// no Toolkit, and jobs run: their proofs are `test <file>`, `cmd` and Gate's
// checks. A job whose criteria need the running app pauses (waitFor
// no-toolkit) until the person builds the Toolkit (`kitchen toolkit build`,
// merged) or chooses to go on without it (`kitchen resume`): then those
// criteria are reported "not proven (no Toolkit)". A high-risk job can't go on
// without one.
//
// Waking the pause: the runner wakes it by itself once the base has a Toolkit;
// `kitchen resume` wakes it either way. A job that has committed nothing yet
// (it paused at intake or spec) moves its base to the new tip, so its worktree
// has the Toolkit's feature files; one with commits only takes the tip as its
// toolkitRef (Ready syncs the base later, and re-proves).
import type { Criterion } from "../checks/spec-lint.ts";
import type { Config } from "../config.ts";
import { baseTip, toolkitAt } from "./base.ts";
import { contractOf, needsApp, reproCriterion } from "./contract.ts";
import { openGit, plainCheckout } from "./git.ts";
import { effectiveRisk, type Facts, type Job } from "./machine.ts";

export type Wake = { toolkit: true; facts: NonNullable<Facts["wake"]> } | { toolkit: false };

/**
 * The base tip when it has a Toolkit: the wake facts, and the job's worktree fast-forwarded to it when it holds no
 * commit. Idempotent: a worktree already at the tip (a wake whose move was refused or raced) still moves the base.
 * `tip`: the runner's once-per-pass base tip (baseTipThrottled); `kitchen resume` reads it fresh.
 */
export async function wakeWithToolkit(repo: string, cfg: Config, job: Job, tip?: string): Promise<Wake> {
  tip ??= await baseTip(repo, cfg);
  if (!(await toolkitAt(repo, tip))) return { toolkit: false };
  if (!job.worktree) return { toolkit: true, facts: { base: tip, toolkitRef: tip } };
  const wt = await openGit({ gitDir: job.gitDir, workTree: job.worktree });
  const head = (await wt.run(["rev-parse", "HEAD"])).stdout.trim();
  if (head === tip) return { toolkit: true, facts: { base: tip, toolkitRef: tip } };
  if (head !== job.base) return { toolkit: true, facts: { toolkitRef: tip } };
  await wt.run(["merge", "--ff-only", "--quiet", tip]);
  return { toolkit: true, facts: { base: tip, toolkitRef: tip } };
}

let tipCache: { repo: string; at: number; tip?: string; error?: string } | null = null;
/**
 * The base tip for the runner's no-toolkit waits: at most one read (a fetch, on GitHub) per `everyMs` (review M4).
 * Throws the read's error; the runner logs a new one once.
 */
export async function baseTipThrottled(repo: string, cfg: Config, now = Date.now(), everyMs = 60_000): Promise<string> {
  if (!tipCache || tipCache.repo !== repo || now - tipCache.at >= everyMs) {
    try {
      tipCache = { repo, at: now, tip: await baseTip(repo, cfg) };
    } catch (e) {
      tipCache = { repo, at: now, error: (e as Error).message };
    }
  }
  if (tipCache.error !== undefined) throw new Error(tipCache.error);
  return tipCache.tip as string;
}

/**
 * Pure: why checks and tests alone can't prove these criteria, or null: none can run without the app, a bug's
 * reproduction drives it, or a requirement is covered only by criteria that drive it (review M5).
 */
export function unprovableWithoutToolkit(criteria: Criterion[], kind: string | null): string | null {
  if (!criteria.length) return null;
  const ok = criteria.filter((c) => !needsApp(c));
  if (!ok.length) return "none of its criteria can be proven without driving the app";
  const repro = kind === "bug" ? reproCriterion(criteria) : undefined;
  if (repro && needsApp(repro)) return `it is a bug whose reproduction (${repro.id}) drives the app`;
  const reqs = [...new Set(criteria.flatMap((c) => c.covers))];
  const only = reqs.filter((r) => !ok.some((c) => c.covers.includes(r)));
  return only.length ? `${only.join(", ")} ${only.length === 1 ? "is" : "are"} proven only by driving the app` : null;
}

/** Why the job can't go on without a Toolkit (high risk, or what checks and tests can't prove), or null. */
export function needsToolkitToGoOn(jobDir: string, job: Job): string | null {
  if (effectiveRisk(job) === "high") return "it is high risk, and a high-risk job never reaches ready without a Toolkit";
  return unprovableWithoutToolkit(contractOf(jobDir)?.criteria ?? [], job.kind);
}

/** A Toolkit proven on `kitchen/setup` that isn't on the base yet: the person still has to merge it. */
export async function unmergedSetup(repo: string): Promise<boolean> {
  try {
    return await toolkitAt(repo, (await (await openGit(plainCheckout(repo))).run(["rev-parse", "--verify", "refs/heads/kitchen/setup"])).stdout.trim());
  } catch {
    return false;
  }
}
