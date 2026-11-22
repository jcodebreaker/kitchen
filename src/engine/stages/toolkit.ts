// toolkit: the smith adds the missing primitive on its own Toolkit PR; the
// engine proves it (`toolkit check` on main + that PR) and the job goes back
// to returnTo pinned to that Toolkit sha.
// A Toolkit primitive edit never rides on the job branch: whatever the smith
// changed under .kitchen/toolkit/ outside features/ in the job worktree is put
// back here, and every job commit does the same (worktree.ts stripToolkitEdits).
// W3b: the smith works in an engine-owned Toolkit checkout on its own PR branch;
// the proof is `toolkit check` on main + that PR (W1 reads `describe` of the
// repo's own Toolkit); toolkitRef is that PR's commit sha (W1: a hash of the
// `describe` output, toolkit-info.ts); the PR is opened from that branch.
import path from "node:path";
import { once, roundDir } from "../store.ts";
import { stripToolkitEdits } from "../worktree.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import { primitives } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

export const toolkit: StageHandler = async (ctx) => {
  const gap = ctx.job.gap ?? "?";
  const r = await runRole(ctx, {
    role: "smith",
    file: "smith.md",
    tier: "write",
    prompt: prompt({ role: "smith", job: ctx.job, jobDir: ctx.jobDir, extra: [`Missing primitive: ${gap}`] }),
    dest: path.join(roundDir(ctx.jobDir, ctx.job.round), `smith-${ctx.job.smith.attempts}.md`),
  });
  const h = headers(r.text);
  const job = ctx.refresh();
  const stripped = job.worktree ? await stripToolkitEdits(job) : [];
  if (stripped.length) ctx.log(`Toolkit primitive edits kept off the job branch: ${stripped.join(", ")}`);
  const p = await primitives(job);
  const checkPassed = h.STATUS === "READY" && p.list.includes(gap);
  let pr: number | null = null;
  if (checkPassed && ctx.forge.kind !== "local") {
    // W3b: opened from the smith's Toolkit branch; W1's fake forge records the call only.
    const t = await once(ctx.repo, job.id, `toolkit-pr/${job.smith.attempts}`, () =>
      ctx.forge.openToolkitPr({ key: `${job.id}/toolkit-pr/${job.smith.attempts}`, title: `Toolkit: add primitive ${gap}` }),
    );
    pr = t.value ?? null;
  }
  return { to: job.returnTo ?? "drives", facts: { toolkit: { checkPassed, sha: p.sha, pr } } };
};
