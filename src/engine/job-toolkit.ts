// Which bin/dev a job runs (PLAN §2 "Which bin/dev runs"): the engine-owned
// checkout `.worktrees/_toolkit@<toolkitRef>`, never the repo's own
// .kitchen/toolkit/bin/dev (the user's main checkout may be dirty or on another
// branch). Primitives resolve from it; feature drives from `--src <worktree>`.
// A toolkitRef not merged into the base (a job pinned to an open Toolkit PR)
// gets the sandbox-exec wrapper (ADR 0008), like every unmerged Toolkit sha.
//
// The checkout is created on demand and its bin recorded in job.toolkitBin, so
// the bridge and `kitchen drive` run the same one. GC keeps a checkout any active
// or paused job's toolkitRef names (toolkit/checkout.ts referencedShas).
import fs from "node:fs";
import { toolkitCheckout } from "../toolkit/checkout.ts";
import { runToolkit } from "../toolkit/run.ts";
import type { Job } from "./machine.ts";
import { updateJob } from "./store.ts";

/** The job with toolkitBin pointing at its toolkitRef's checkout. No toolkitRef: no Toolkit (toolkitBin ""). */
export async function ensureJobToolkit(repo: string, job: Job, log: (m: string) => void = () => {}): Promise<Job> {
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
  log(`Toolkit ${job.toolkitRef.slice(0, 12)}${co.merged ? "" : ` (not merged: bin/dev runs ${co.sandboxed ? "under sandbox-exec" : "UNSANDBOXED"})`}`);
  return updateJob(repo, job.id, (j) => {
    j.toolkitBin = co.bin;
    return j;
  });
}
