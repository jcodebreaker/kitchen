// ready: engine only. CI from the forge, the Toolkit PR (if any) merged, gate
// PASS on this HEAD (feature-drive commits since it allowed). Pending CI or an
// open Toolkit PR pauses the job (its slot is released) until the runner sees
// the condition clear.
// W1: no sync with base yet (synced, base unmoved); W3b merges base in and
// re-verifies when it moved.
import { gateStillValid } from "./gate.ts";
import type { StageHandler } from "./types.ts";

export const ready: StageHandler = async (ctx) => {
  const job = ctx.refresh();
  const ci = await ctx.forge.checks(job.pr);
  const toolkitPr = job.smith.toolkitPr === null ? "none" : (await ctx.forge.prMerged(job.smith.toolkitPr)) ? "merged" : "open";
  const gatePass = await gateStillValid(ctx.jobDir, job);
  const facts = { ready: { synced: true, conflict: false, ci, toolkitPr, gatePass, baseMoved: false, recheckFailed: false } } as const;
  // Gate no longer PASS on this HEAD (commits since it touch more than feature drives): Gate again first.
  const to = !gatePass ? "gate" : ci === "fail" ? "build" : ci === "pending" || toolkitPr === "open" ? "paused" : "report";
  return { to, facts };
};
