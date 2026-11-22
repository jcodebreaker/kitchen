// gate: engine only, no agent. Runs the kitchen.yaml checks on the job HEAD
// (checks/gate.ts: stamped, role engine, pinned to HEAD) and writes
// rounds/<N>/gate.md with the HEAD it ran on. A gate.md for the current HEAD is reused, so a
// resumed gate doesn't run the checks again. Then the risk floor from the diff.
import fs from "node:fs";
import path from "node:path";
import { runGate } from "../../checks/gate.ts";
import { riskFloor, seedTouched } from "../../checks/risk-floor.ts";
import { checksPrepareOf } from "../../checks/run-checks.ts";
import type { Job } from "../machine.ts";
import { roundDir, writeAtomic } from "../store.ts";
import { changedFiles, diffStat, headOf } from "../worktree.ts";
import { headers } from "./role.ts";
import type { StageHandler } from "./types.ts";

const FEATURE_DRIVE = /^\.kitchen\/toolkit\/features\/[^/]+\.md$/;

/**
 * The latest gate (this round's, or an earlier round's when this round has none,
 * as after `kitchen feedback` sends a job back to verify) PASSed, and the commits
 * since its HEAD touch nothing but feature drives (PLAN §2, drives → verify).
 */
export async function gateStillValid(jobDir: string, job: Job): Promise<boolean> {
  let g: ReturnType<typeof readGate> = null;
  for (let r = job.round; r >= 1 && !g; r--) g = readGate(jobDir, r);
  if (g?.result !== "PASS") return false;
  return (await changedFiles(job, g.head)).every((f) => FEATURE_DRIVE.test(f));
}

export const gateFileOf = (jobDir: string, round: number) => path.join(roundDir(jobDir, round), "gate.md");

/** The gate result recorded for this round, if any: { head, result }. */
export function readGate(jobDir: string, round: number): { head: string; result: "PASS" | "FAIL" } | null {
  const f = gateFileOf(jobDir, round);
  if (!fs.existsSync(f)) return null;
  const h = headers(fs.readFileSync(f, "utf8"));
  return h.HEAD && (h.RESULT === "PASS" || h.RESULT === "FAIL") ? { head: h.HEAD, result: h.RESULT } : null;
}

export const gate: StageHandler = async (ctx) => {
  const job = ctx.refresh();
  const head = await headOf(job);
  let g = readGate(ctx.jobDir, job.round);
  if (!g || g.head !== head) {
    const r = await runGate({
      jobDir: ctx.jobDir,
      checks: ctx.config.checkList,
      network: ctx.config.checks_network,
      headOf: () => headOf(job),
      prepare: checksPrepareOf(ctx.config),
    });
    writeAtomic(gateFileOf(ctx.jobDir, job.round), `${r.lines.join("\n")}\n`);
    g = { head: r.head, result: r.result };
    ctx.log(`gate ${g.result} on ${r.head.slice(0, 8)} (${ctx.config.checkList.length} checks)${r.why ? `: ${r.why}` : ""}`);
  }
  const diff = await diffStat(job);
  const floor = riskFloor(diff, ctx.config);
  const seeds = seedTouched(diff, ctx.config);
  if (seeds.length) {
    // The app every proof drives is built from these: risk goes to high and they are listed for review.
    const f = path.join(roundDir(ctx.jobDir, job.round), "seed-diff.md");
    writeAtomic(f, `SEED-DIFF: ${seeds.join(", ")}\n\nThe job's diff touches seed data or migrations; review what each proof reads from them.\n`);
    ctx.log(`gate: seed/migration files changed (risk → high, listed for review): ${seeds.join(", ")}`);
  }
  return {
    to: g.result === "PASS" ? "drives" : "build",
    facts: { gate: { head: g.head, currentHead: await headOf(job), result: g.result, riskFloor: floor } },
  };
};
