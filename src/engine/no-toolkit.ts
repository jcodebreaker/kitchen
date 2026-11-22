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
import type { Config } from "../config.ts";
import { baseTip, toolkitAt } from "./base.ts";
import { contractOf, needsApp, reproCriterion } from "./contract.ts";
import { openGit, plainCheckout } from "./git.ts";
import { effectiveRisk, type Facts, type Job } from "./machine.ts";

export type Wake = { toolkit: true; facts: NonNullable<Facts["wake"]> } | { toolkit: false };

/** The base tip when it has a Toolkit: the wake facts (and the job's worktree fast-forwarded to it when it holds no commit). */
export async function wakeWithToolkit(repo: string, cfg: Config, job: Job): Promise<Wake> {
  const tip = await baseTip(repo, cfg);
  if (!(await toolkitAt(repo, tip))) return { toolkit: false };
  if (!job.worktree) return { toolkit: true, facts: { base: tip, toolkitRef: tip } };
  const wt = await openGit({ gitDir: job.gitDir, workTree: job.worktree });
  const head = (await wt.run(["rev-parse", "HEAD"])).stdout.trim();
  if (head !== job.base) return { toolkit: true, facts: { toolkitRef: tip } };
  await wt.run(["merge", "--ff-only", "--quiet", tip]);
  return { toolkit: true, facts: { base: tip, toolkitRef: tip } };
}

/** Why the job can't go on without a Toolkit (high risk, or a bug whose reproduction drives the app), or null. */
export function needsToolkitToGoOn(jobDir: string, job: Job): string | null {
  if (effectiveRisk(job) === "high") return "it is high risk, and a high-risk job never reaches ready without a Toolkit";
  const repro = job.kind === "bug" ? reproCriterion(contractOf(jobDir)?.criteria ?? []) : undefined;
  if (repro && needsApp(repro)) return `it is a bug whose reproduction (${repro.id}) drives the app`;
  return null;
}

/** A Toolkit proven on `kitchen/setup` that isn't on the base yet: the person still has to merge it. */
export async function unmergedSetup(repo: string): Promise<boolean> {
  try {
    return await toolkitAt(repo, (await (await openGit(plainCheckout(repo))).run(["rev-parse", "--verify", "refs/heads/kitchen/setup"])).stdout.trim());
  } catch {
    return false;
  }
}
