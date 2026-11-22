// What the stages ask the Toolkit (through src/toolkit/run.ts, untrusted env).
// No Toolkit: no primitives, doctor not ok.
// W3b: W1 runs the repo's own .kitchen/toolkit/bin/dev; W3b runs the engine-owned
// checkout at the job's toolkitRef.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { describeToolkit } from "../../proof/drive.ts";
import { runToolkit } from "../../toolkit/run.ts";
import type { Job } from "../machine.ts";

export const hasToolkit = (job: Job) => !!job.toolkitBin && fs.existsSync(job.toolkitBin);

export async function primitives(job: Job): Promise<{ list: string[]; sha: string }> {
  if (!hasToolkit(job)) return { list: [], sha: "" };
  const d = await describeToolkit(job.toolkitBin, job.worktree || process.cwd());
  // W3b: `sha` must be the Toolkit PR's commit sha (toolkitRef pins the proofs to it).
  // W1 has no Toolkit PR branch, so this is a hash of `describe` output: it changes when
  // the primitive list changes, and pins nothing.
  return { list: d.primitives, sha: createHash("sha256").update(JSON.stringify(d.raw)).digest("hex").slice(0, 12) };
}

export async function doctorOk(job: Job, jobDir?: string): Promise<boolean> {
  if (!hasToolkit(job)) return false;
  const r = await runToolkit(job.toolkitBin, ["doctor", `--id=${job.slotId}`], { src: job.worktree, jobDir });
  return r.json?.status === "ok";
}
