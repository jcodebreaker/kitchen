// review: one read-tier reviewer per lens. Lenses come from the risk path
// (the stricter of intake's rating and the diff floor) plus the job's surfaces.
// `code-if-diff>N` adds the code lens when the diff is over N lines or touches a feature drive.
import path from "node:path";
import { seedTouched } from "../../checks/risk-floor.ts";
import type { Config } from "../../config.ts";
import { effectiveRisk, type Job } from "../machine.ts";
import { roundDir } from "../store.ts";
import { diffStat } from "../worktree.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import type { StageHandler } from "./types.ts";

/** Pure. */
export function lensesFor(cfg: Config, job: Pick<Job, "risk" | "riskFloor" | "surfaces">, diff: { file: string; lines: number }[]): string[] {
  const out = new Set<string>();
  const lines = diff.reduce((n, d) => n + d.lines, 0);
  const touchesDrive = diff.some((d) => d.file.startsWith(".kitchen/toolkit/features/"));
  for (const l of cfg.paths[effectiveRisk(job)].review) {
    const m = /^code-if-diff>(\d+)$/.exec(l);
    if (!m) out.add(l);
    else if (lines > Number(m[1]) || touchesDrive) out.add("code");
  }
  for (const s of job.surfaces) for (const l of cfg.surfaces[s] ?? []) out.add(l);
  return [...out];
}

export const review: StageHandler = async (ctx) => {
  const job = ctx.refresh();
  const diff = await diffStat(job);
  const lenses = lensesFor(ctx.config, job, diff);
  const seeds = seedTouched(diff, ctx.config);
  let blocking: string | undefined;
  for (const lens of lenses) {
    const r = await runRole(ctx, {
      role: `reviewer-${lens}`,
      file: `review-${lens}.md`,
      tier: "read",
      prompt: prompt({
        role: `reviewer-${lens}`,
        job,
        jobDir: ctx.jobDir,
        extra: [
          `Lens: ${lens}`,
          `Worktree: ${job.worktree}`,
          `Base: ${job.base}`,
          ...(seeds.length ? [`Seed data or migrations changed (check nothing seeds the answer a proof reads): ${seeds.join(", ")}`] : []),
        ],
      }),
      dest: path.join(roundDir(ctx.jobDir, job.round), `review-${lens}.md`),
    });
    const h = headers(r.text);
    if (h.VERDICT !== "PASS") blocking ??= `${lens}: ${h.FINDING ?? h.VERDICT ?? "no verdict"}`;
  }
  ctx.log(`review: ${lenses.length ? lenses.join(", ") : "no lenses on this path"} → ${blocking ? `BLOCKING ${blocking}` : "PASS"}`);
  return blocking ? { to: "build", facts: { review: { pass: false, blocking } } } : { to: "ready", facts: { review: { pass: true } } };
};
