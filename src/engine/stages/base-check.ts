// The base check (review W3a: trivially-true criteria): before anyone builds, the
// engine runs every mechanical criterion once on the BASE, on a fresh app, stamped
// `phase: base`, and records which already pass (jobs/<id>/base-check.json). A
// feature criterion that already holds before the change can't tell the change
// from no change: the spec role is asked once to strengthen it (spec stage), and
// Verify flags it as non-discriminating in its verdict. A bug needs none of this:
// its repro already must fail on the base.
// A criterion whose proof needs what doesn't exist yet (a new drive, a new test
// file) can't run on the base and is skipped: it can't hold there either.
import fs from "node:fs";
import path from "node:path";
import type { Criterion } from "../../checks/spec-lint.ts";
import { isJudged } from "../../proof/assert.ts";
import { prove } from "../../proof/prove.ts";
import { namedDrives, testFilesOf } from "../contract.ts";
import { freshUp, resetUp } from "../instance.ts";
import type { Job } from "../machine.ts";
import { writeAtomic } from "../store.ts";
import { headOf } from "../worktree.ts";
import { featureDrives, hasToolkit } from "./toolkit-info.ts";
import type { StageContext } from "./types.ts";

export type BaseResult = { criterion: string; status: string; why?: string; evidence: string[] };
export type BaseCheck = {
  head: string;
  /** The criteria checked, as written: a changed contract is checked again. */
  key: string;
  results: BaseResult[];
  skipped: { criterion: string; why: string }[];
  /** Criteria whose expect already held on the base. */
  passing: string[];
};

export const baseCheckFile = (jobDir: string) => path.join(jobDir, "base-check.json");
const keyOf = (criteria: Criterion[]) => JSON.stringify(criteria.map((c) => [c.id, c.proof, c.expect]));

export function readBaseCheck(jobDir: string): BaseCheck | null {
  try {
    return JSON.parse(fs.readFileSync(baseCheckFile(jobDir), "utf8")) as BaseCheck;
  } catch {
    return null;
  }
}

/** Criteria flagged non-discriminating for this contract (the last base check's passes), or []. */
export function nonDiscriminating(jobDir: string, criteria: Criterion[]): string[] {
  const b = readBaseCheck(jobDir);
  return b && b.key === keyOf(criteria) ? b.passing : [];
}

/**
 * Run every mechanical criterion once on the base (the worktree must be clean at the
 * base). Reuses a result recorded for the same contract and base.
 */
export async function runBaseCheck(ctx: StageContext, job: Job, criteria: Criterion[]): Promise<BaseCheck | null> {
  if (!hasToolkit(job) || !job.worktree) return null;
  const head = await headOf(job);
  if (head !== job.base) return null; // only before anything is built
  const key = keyOf(criteria);
  const prev = readBaseCheck(ctx.jobDir);
  if (prev && prev.key === key && prev.head === head) return prev;
  const have = featureDrives(job.worktree).drives;
  const out: BaseCheck = { head, key, results: [], skipped: [], passing: [] };
  const todo: Criterion[] = [];
  for (const c of criteria) {
    if (isJudged(c.expect)) continue;
    const newDrives = [...namedDrives([c]).keys()].filter((d) => !have[d]);
    const newTests = testFilesOf(c).filter((t) => !fs.existsSync(path.join(job.worktree, t)));
    if (newDrives.length || newTests.length)
      out.skipped.push({ criterion: c.id, why: `needs what the base doesn't have: ${[...newDrives, ...newTests].join(", ")}` });
    else todo.push(c);
  }
  if (todo.length) {
    await freshUp(job, ctx.jobDir, ctx.log);
    for (const c of todo) {
      await resetUp(job, ctx.jobDir);
      const p = await prove({
        jobDir: ctx.jobDir,
        criterion: c,
        role: "engine",
        testCmd: ctx.config.test_cmd,
        tag: { phase: "base" },
        log: (m) => ctx.log(`[base] ${m}`),
      });
      out.results.push({ criterion: c.id, status: p.status, ...(p.why ? { why: p.why } : {}), evidence: p.evidence });
      if (p.status === "pass") out.passing.push(c.id);
    }
  }
  writeAtomic(baseCheckFile(ctx.jobDir), `${JSON.stringify(out, null, 2)}\n`);
  ctx.log(
    `base check on ${head.slice(0, 8)}: ${out.results.map((r) => `${r.criterion} ${r.status}`).join(", ") || "nothing ran"}${out.skipped.length ? `; skipped ${out.skipped.map((s) => s.criterion).join(", ")} (new drives or tests)` : ""}`,
  );
  return out;
}
