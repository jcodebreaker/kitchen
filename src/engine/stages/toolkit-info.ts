// What the stages ask the Toolkit (through src/toolkit/run.ts, untrusted env).
// W1 runs the repo's own .kitchen/toolkit/bin/dev; the engine-owned checkout at
// toolkitRef comes in W3b. No Toolkit: no primitives, doctor not ok.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { describeToolkit } from "../../proof/drive.ts";
import { runToolkit } from "../../toolkit/run.ts";
import type { Job } from "../machine.ts";

export const hasToolkit = (job: Job) => !!job.toolkitBin && fs.existsSync(job.toolkitBin);

export async function primitives(job: Job): Promise<{ list: string[]; sha: string }> {
  if (!hasToolkit(job)) return { list: [], sha: "" };
  const d = await describeToolkit(job.toolkitBin, job.worktree || process.cwd());
  return { list: d.primitives, sha: createHash("sha256").update(JSON.stringify(d.raw)).digest("hex").slice(0, 12) };
}

export async function doctorOk(job: Job): Promise<boolean> {
  if (!hasToolkit(job)) return false;
  const r = await runToolkit(job.toolkitBin, ["doctor", `--id=${job.slotId}`], { src: job.worktree });
  return r.json?.status === "ok";
}
