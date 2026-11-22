// drives: the verifier (drives mode) writes any missing feature drives; the
// engine commits them before any proof runs, then checks that the commits since
// gate.md touch nothing but feature drives (else Gate runs again).
// W1: "every spec drive resolves" is read from drives.md and `toolkit check
// --feature` is not run yet (W2 / W3a make both engine checks).
import path from "node:path";
import { roundDir } from "../store.ts";
import { commitAll } from "../worktree.ts";
import { gateStillValid } from "./gate.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import type { StageHandler } from "./types.ts";

export const drives: StageHandler = async (ctx) => {
  const r = await runRole(ctx, {
    role: "verifier",
    file: "drives.md",
    tier: "write",
    prompt: prompt({ role: "verifier", mode: "drives", job: ctx.job, jobDir: ctx.jobDir }),
    dest: path.join(roundDir(ctx.jobDir, ctx.job.round), `drives-${ctx.job.attempts.drives + 1}.md`),
  });
  const h = headers(r.text);
  const job = ctx.refresh();
  await commitAll(job, `kitchen(${job.id}): feature drives`);
  const gateValid = await gateStillValid(ctx.jobDir, job);
  const status = h.DRIVES ?? "";
  const facts = {
    drives: {
      gateValid,
      resolved: status === "OK",
      featureChecks: status === "OK",
      unreachable: status === "UNREACHABLE",
      missingPrimitive: h.GAP || undefined,
      writeFailed: status === "FAILED",
    },
  };
  const to = !gateValid
    ? "gate"
    : facts.drives.missingPrimitive
      ? "toolkit"
      : status === "UNREACHABLE"
        ? "build"
        : status === "FAILED"
          ? job.attempts.drives + 1 < 2
            ? "drives"
            : "needs-human"
          : "verify";
  return { to, facts };
};
