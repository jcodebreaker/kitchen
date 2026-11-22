// repro: write tier. The repro role adds a regression test (or feature drive)
// that must fail on the base sha; the engine commits it.
// W1: whether it failed as expected is read from repro.md. W3a replaces that
// with the engine running `kitchen drive <job> <C> --repro` on the base sha.
import path from "node:path";
import { commitAll } from "../worktree.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import type { StageHandler } from "./types.ts";

export const repro: StageHandler = async (ctx) => {
  const r = await runRole(ctx, {
    role: "repro",
    file: "repro.md",
    tier: "write",
    prompt: prompt({ role: "repro", job: ctx.job, jobDir: ctx.jobDir }),
    dest: path.join(ctx.jobDir, `repro-${ctx.job.attempts.repro + 1}.md`),
  });
  const h = headers(r.text);
  const job = ctx.refresh();
  const gap = h.GAP || undefined;
  const failed = h.REPRO === "FAILED-AS-EXPECTED";
  const c = failed ? await commitAll(job, `kitchen(${job.id}): regression test (repro)`) : null;
  const facts = { repro: { failedAsExpected: failed, onBase: true, committed: !!c && c.ahead && c.clean, missingPrimitive: gap } };
  const to = failed ? "build" : gap ? "toolkit" : job.attempts.repro + 1 < 2 ? "repro" : "needs-info";
  if (to === "needs-info") await ctx.source.ask(job, { key: `ask/repro/m${job.moves}`, text: `Kitchen could not reproduce this after 2 tries.\n\n${r.text}` });
  return { to, facts };
};
