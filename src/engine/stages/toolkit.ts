// toolkit: the smith adds the missing primitive on its own Toolkit PR; the
// engine proves it (`toolkit check` on main + that PR) and the job goes back
// to returnTo pinned to that Toolkit sha.
// W1: the smith edits the repo's Toolkit directly and the proof is that
// `describe` now lists the primitive. W2/W3b: `toolkit check`, an engine-owned
// checkout at the PR's sha, the PR on the forge.
import path from "node:path";
import { once, roundDir } from "../store.ts";
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
  const p = await primitives(job);
  const checkPassed = h.STATUS === "READY" && p.list.includes(gap);
  let pr: number | null = null;
  if (checkPassed && ctx.forge.kind !== "local") {
    const t = await once(ctx.repo, job.id, `toolkit-pr/${job.smith.attempts}`, () =>
      ctx.forge.openToolkitPr({ key: `${job.id}/toolkit-pr/${job.smith.attempts}`, title: `Toolkit: add primitive ${gap}` }),
    );
    pr = t.value ?? null;
  }
  return { to: job.returnTo ?? "drives", facts: { toolkit: { checkPassed, sha: p.sha, pr } } };
};
