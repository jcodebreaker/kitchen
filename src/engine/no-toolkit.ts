// Jobs without a Toolkit (ADR 0010). Quick init leaves a repo with checks but
// no Toolkit, and jobs run: their proofs are `test <file>`, `cmd` and Gate's
// checks. A job whose criteria need the running app pauses (waitFor
// no-toolkit) until the person builds the Toolkit (`kitchen toolkit build`) and
// approves it (ADR 0015), or chooses to go on without it (`kitchen resume`): then those
// criteria are reported "not proven (no Toolkit)". A high-risk job can't go on
// without one.
//
// Waking the pause: the runner wakes it by itself once the base has a Toolkit
// or one is approved (`kitchen toolkit approve` wakes it at once too);
// `kitchen resume` wakes it either way. With a Toolkit on the base, a job that
// has committed nothing yet (it paused at intake or spec) moves its base to the
// new tip; one with commits only takes the tip as its toolkitRef (Ready syncs
// the base later, and re-proves). An approved Toolkit only becomes the job's
// toolkitRef: its files never need to be in the job worktree.
import type { Criterion } from "../checks/spec-lint.ts";
import type { Config } from "../config.ts";
import { baseTip, toolkitAt } from "./base.ts";
import { contractOf, needsApp, reproCriterion } from "./contract.ts";
import { openGit } from "./git.ts";
import { approvedToolkit } from "./job-toolkit.ts";
import { effectiveRisk, type Facts, isActive, type Job } from "./machine.ts";

export type Wake = { toolkit: true; facts: NonNullable<Facts["wake"]> } | { toolkit: false };

/**
 * The base tip when it has a Toolkit: the wake facts, and the job's worktree fast-forwarded to it when it holds no
 * commit. Idempotent: a worktree already at the tip (a wake whose move was refused or raced) still moves the base.
 * Else the approved Toolkit (ADR 0015): only the job's toolkitRef moves.
 * `tip`: the runner's once-per-pass base tip (baseTipThrottled; "" when it couldn't be read); `kitchen resume` reads it fresh.
 */
export async function wakeWithToolkit(repo: string, cfg: Config, job: Job, tip?: string): Promise<Wake> {
  tip ??= await baseTip(repo, cfg);
  if (!tip || !(await toolkitAt(repo, tip))) {
    const approved = await approvedToolkit(repo);
    return approved ? { toolkit: true, facts: { toolkitRef: approved, toolkitFrom: "approved" } } : { toolkit: false };
  }
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

/**
 * A job whose Toolkit was dropped while it ran (its approval revoked, ADR 0015 review H3): what it can no longer
 * prove, when that makes it wait (a criterion drives the app, or it is high risk), else null. Past intake only (intake
 * decides that itself); a job the person resumed into checks only goes on.
 */
export function toolkitDropped(jobDir: string, job: Job): { needsApp: string[]; highRisk: boolean } | null {
  if (job.stage === "intake" || !isActive(job.stage)) return null;
  const highRisk = effectiveRisk(job) === "high";
  const needs = (contractOf(jobDir)?.criteria ?? []).filter(needsApp).map((c) => c.id);
  if (highRisk) return { needsApp: needs, highRisk };
  return needs.length && !job.checksOnly ? { needsApp: needs, highRisk } : null;
}

/** Why the job can't go on without a Toolkit (high risk, or what checks and tests can't prove), or null. */
export function needsToolkitToGoOn(jobDir: string, job: Job): string | null {
  if (effectiveRisk(job) === "high") return "it is high risk, and a high-risk job never reaches ready without a Toolkit";
  return unprovableWithoutToolkit(contractOf(jobDir)?.criteria ?? [], job.kind);
}
