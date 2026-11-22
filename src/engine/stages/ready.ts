// ready: engine only. CI from the forge, the Toolkit PR (if any) merged, gate
// PASS on this HEAD. Pending CI or an open Toolkit PR pauses the job (its slot
// is released) until the runner sees the condition clear.
// W1: no sync with base yet (synced, base unmoved); W3b merges base in and
// re-verifies when it moved.
import { headOf } from "../worktree.ts";
import { readGate } from "./gate.ts";
import type { StageHandler } from "./types.ts";

export const ready: StageHandler = async (ctx) => {
  const job = ctx.refresh();
  const ci = await ctx.forge.checks(job.pr);
  const toolkitPr = job.smith.toolkitPr === null ? "none" : (await ctx.forge.prMerged(job.smith.toolkitPr)) ? "merged" : "open";
  const g = readGate(ctx.jobDir, job.round);
  const gatePass = !!g && g.result === "PASS" && g.head === (await headOf(job));
  const facts = { ready: { synced: true, conflict: false, ci, toolkitPr, gatePass, baseMoved: false, recheckFailed: false } } as const;
  const to = ci === "fail" ? "build" : ci === "pending" || toolkitPr === "open" ? "paused" : "report";
  return { to, facts };
};
