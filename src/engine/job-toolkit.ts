// Which bin/dev a job runs (PLAN §2 "Which bin/dev runs"): the engine-owned
// checkout `.worktrees/_toolkit@<toolkitRef>`, never the repo's own
// .kitchen/toolkit/bin/dev (the user's main checkout may be dirty or on another
// branch). Primitives resolve from it; feature drives from `--src <worktree>`.
// A toolkitRef neither on the base nor approved (a job pinned to an open
// Toolkit PR) gets the sandbox-exec wrapper (ADR 0008, 0015).
// Where toolkitRef came from is recorded (job.toolkitFrom). Only a job that took
// the approved Toolkit (ADR 0015) follows the approval: revoke it and the job has
// no Toolkit at once (the runner then pauses it no-toolkit where it needs the
// app); approve another sha and it takes that one only when it next enters
// intake, spec, repro, build or drives, so one stage's proofs never mix two
// Toolkits (verify starts its proofs over when the sha changed). A base-derived
// ref is never cleared (the main checkout switching branches doesn't touch it),
// nor a Toolkit PR's.
//
// The checkout is created on demand and its bin recorded in job.toolkitBin, so
// the bridge and `kitchen drive` run the same one. GC keeps a checkout any active
// or paused job's toolkitRef names (toolkit/checkout.ts referencedShas).
import fs from "node:fs";
import { toolkitCheckout } from "../toolkit/checkout.ts";
import { runToolkit } from "../toolkit/run.ts";
import { readApproval, untrustedNote } from "../toolkit/trust.ts";
import { toolkitAt } from "./base.ts";
import type { Job } from "./machine.ts";
import { updateJob } from "./store.ts";

/** The stages a job may change Toolkit on entering (review M4): none of their proofs feed a verdict yet. */
export const TOOLKIT_SWITCH_AT: readonly Job["stage"][] = ["intake", "spec", "repro", "build", "drives"];

/** The job with toolkitBin pointing at its toolkitRef's checkout. No toolkitRef: no Toolkit (toolkitBin ""). */
export async function ensureJobToolkit(repo: string, job: Job, log: (m: string) => void = () => {}): Promise<Job> {
  if (job.toolkitRef && job.toolkitFrom === "approved") {
    const approved = await approvedToolkit(repo);
    if (!approved) {
      log(`Toolkit ${job.toolkitRef.slice(0, 12)} is no longer approved (revoked): the job has no Toolkit until you approve one`);
      job = await updateJob(repo, job.id, (j) => {
        j.toolkitRef = "";
        j.toolkitFrom = undefined;
        j.toolkitLost = true; // the runner's next step decides whether it waits (review H3), whoever dropped it here
        return j;
      });
    } else if (approved !== job.toolkitRef) {
      if (TOOLKIT_SWITCH_AT.includes(job.stage)) {
        log(`Toolkit ${job.toolkitRef.slice(0, 12)} is no longer approved: taking the approved ${approved.slice(0, 12)}`);
        job = await updateJob(repo, job.id, (j) => {
          j.toolkitRef = approved;
          return j;
        });
      } else
        log(`keeps Toolkit ${job.toolkitRef.slice(0, 12)} through ${job.stage}; it takes the approved ${approved.slice(0, 12)} at its next build or drives`);
    }
  }
  if (!job.toolkitRef) {
    if (!job.toolkitBin) return job;
    return updateJob(repo, job.id, (j) => {
      j.toolkitBin = "";
      return j;
    });
  }
  const co = await toolkitCheckout(repo, job.toolkitRef);
  co.release(); // GC keeps it while the job is active or paused (referencedShas)
  if (co.bin === job.toolkitBin && fs.existsSync(co.bin)) return job;
  // The app in the job's slot was started by the old bin/dev: that one brings it down.
  if (job.slot && job.toolkitBin && fs.existsSync(job.toolkitBin))
    await runToolkit(job.toolkitBin, ["down", `--id=${job.slotId}`], { src: job.worktree || repo, timeoutMs: 5 * 60_000 }).catch(() => {});
  log(
    `Toolkit ${job.toolkitRef.slice(0, 12)}${co.trust === "approved" ? " (approved by you)" : co.trust ? "" : ` (${untrustedNote(job.toolkitRef, co.sandboxed)})`}`,
  );
  return updateJob(repo, job.id, (j) => {
    j.toolkitBin = co.bin;
    return j;
  });
}

/** The approved Toolkit sha, when it still has a Toolkit (ADR 0015), or null. */
export async function approvedToolkit(repo: string): Promise<string | null> {
  const a = readApproval(repo);
  return a && (await toolkitAt(repo, a.sha)) ? a.sha : null;
}

/** Which Toolkit a job on `base` uses, and where it came from: the base's own when it has one, else the approved sha, else none (""). */
export async function resolveToolkitRef(repo: string, base: string): Promise<{ ref: string; from?: "base" | "approved" }> {
  if (base && (await toolkitAt(repo, base))) return { ref: base, from: "base" };
  const a = await approvedToolkit(repo);
  return a ? { ref: a, from: "approved" } : { ref: "" };
}
