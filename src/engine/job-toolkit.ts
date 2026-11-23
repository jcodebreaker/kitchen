// Which bin/dev a job runs (PLAN §2 "Which bin/dev runs"): the engine-owned
// checkout `.worktrees/_toolkit@<toolkitRef>`, never the repo's own
// .kitchen/toolkit/bin/dev (the user's main checkout may be dirty or on another
// branch). Primitives resolve from it; feature drives from `--src <worktree>`.
// A toolkitRef neither on the base nor approved (a job pinned to an open
// Toolkit PR) gets the sandbox-exec wrapper (ADR 0008, 0015).
// A job that took the approved Toolkit (ADR 0015) follows the approval: approve
// another sha and it takes that one; revoke it and the job has no Toolkit (it
// waits no-toolkit again where it needs the app).
//
// The checkout is created on demand and its bin recorded in job.toolkitBin, so
// the bridge and `kitchen drive` run the same one. GC keeps a checkout any active
// or paused job's toolkitRef names (toolkit/checkout.ts referencedShas).
import fs from "node:fs";
import { toolkitCheckout } from "../toolkit/checkout.ts";
import { runToolkit } from "../toolkit/run.ts";
import { readApproval, trustOf, untrustedNote } from "../toolkit/trust.ts";
import { toolkitAt } from "./base.ts";
import type { Job } from "./machine.ts";
import { updateJob } from "./store.ts";

/** The job with toolkitBin pointing at its toolkitRef's checkout. No toolkitRef: no Toolkit (toolkitBin ""). */
export async function ensureJobToolkit(repo: string, job: Job, log: (m: string) => void = () => {}): Promise<Job> {
  // Not a Toolkit PR's sha, and no longer trusted: the approval moved on (or was revoked).
  if (job.toolkitRef && job.smith.toolkitPr === null && !(await trustOf(repo, job.toolkitRef))) {
    const next = await approvedToolkit(repo);
    log(
      next
        ? `Toolkit ${job.toolkitRef.slice(0, 12)} is no longer approved: taking the approved ${next.slice(0, 12)}`
        : `Toolkit ${job.toolkitRef.slice(0, 12)} is no longer approved: the job has no Toolkit until you approve one`,
    );
    job = await updateJob(repo, job.id, (j) => {
      j.toolkitRef = next ?? "";
      return j;
    });
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

/** Which Toolkit a job on `base` uses: the base's own when it has one, else the approved sha, else none (""). */
export async function resolveToolkitRef(repo: string, base: string): Promise<string> {
  if (base && (await toolkitAt(repo, base))) return base;
  return (await approvedToolkit(repo)) ?? "";
}
