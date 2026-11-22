// The base check (review W3a: trivially-true criteria): before anyone builds, the
// engine runs every mechanical criterion once on the BASE, on a fresh app, stamped
// `phase: base`, and records which already pass (jobs/<id>/base-check.json). A
// feature criterion that already holds before the change can't tell the change
// from no change: the spec role is asked once to strengthen it (spec stage), and
// Verify flags it as non-discriminating in its verdict. A bug needs none of this:
// its repro already must fail on the base.
// A criterion whose proof needs what doesn't exist yet (a new drive, a new test
// file) can't run on the base then, and is skipped. Once the drives stage has
// written those files (review W3a round 2), the engine runs those criteria on a
// checkout of the base code plus only the new drive and test files
// (`<repo>/.worktrees/<id>.base`, same slot, fresh app, stamped `phase: base`):
// one that already holds there is NON-DISCRIMINATING too (`afterDrives`).
// A regression guard (a criterion covering only `(unchanged)` requirements of
// intake.md) holds on the base by design: it runs, but is never counted.
import fs from "node:fs";
import path from "node:path";
import { checksPrepareOf } from "../../checks/run-checks.ts";
import { type Criterion, guardCriteria, parseRequirements } from "../../checks/spec-lint.ts";
import { isJudged } from "../../proof/assert.ts";
import { prove } from "../../proof/prove.ts";
import { namedDrives, testFilesOf } from "../contract.ts";
import { linkedWorktree, openGit, plainCheckout } from "../git.ts";
import { freshUp, resetUp } from "../instance.ts";
import type { Job } from "../machine.ts";
import { writeAtomic } from "../store.ts";
import { changedFiles, headOf } from "../worktree.ts";
import { FEATURES_DIR, featureDrives, hasToolkit } from "./toolkit-info.ts";
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
  /** After the drives stage: the criteria that needed new drives or tests, run on the base plus those files only. */
  afterDrives?: { head: string; files: string[]; results: BaseResult[]; passing: string[] };
};

/** The contract's regression guards, from intake.md's `(unchanged)` requirements. */
function guardsOf(jobDir: string, criteria: Criterion[]): string[] {
  const f = path.join(jobDir, "intake.md");
  return guardCriteria(criteria, parseRequirements(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""));
}

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
  return b && b.key === keyOf(criteria) ? [...new Set([...b.passing, ...(b.afterDrives?.passing ?? [])])] : [];
}

/** Criteria whose proof needs a feature drive or a test file `base` doesn't have. Pure but for reading `base`. */
function needsNew(criteria: Criterion[], base: string): Criterion[] {
  const have = featureDrives(base).drives;
  return criteria.filter(
    (c) => !isJudged(c.expect) && ([...namedDrives([c]).keys()].some((d) => !have[d]) || testFilesOf(c).some((t) => !fs.existsSync(path.join(base, t)))),
  );
}

/**
 * After the drives stage (features only: a bug's repro already failed on the base): run every
 * mechanical criterion the first base check skipped for want of a new drive or test file, on a
 * checkout of the base with only the job's new feature drive files and the contract's test
 * files copied in, on a fresh app in the job's slot, stamped `phase: base`. One that passes there
 * is NON-DISCRIMINATING (Verify's verdict, review). Reuses the result for the same HEAD.
 */
export async function runBaseCheckAfterDrives(ctx: StageContext, job: Job, criteria: Criterion[], head: string): Promise<BaseCheck["afterDrives"] | null> {
  if (!hasToolkit(job) || !job.worktree || job.kind === "bug") return null;
  const key = keyOf(criteria);
  const prev = readBaseCheck(ctx.jobDir);
  const b: BaseCheck = prev && prev.key === key ? prev : { head: job.base, key, results: [], skipped: [], passing: [] };
  if (b.afterDrives?.head === head) return b.afterDrives;
  const files = [
    ...(await changedFiles(job, job.base, head)).filter((f) => f.startsWith(`${FEATURES_DIR}/`) && f.endsWith(".md")),
    ...criteria.flatMap(testFilesOf),
  ].filter((f, i, a) => a.indexOf(f) === i && fs.existsSync(path.join(job.worktree, f)));
  const id = `${path.basename(job.worktree)}.base`;
  const dir = path.join(path.dirname(job.worktree), id);
  const main = await openGit(plainCheckout(ctx.repo));
  const remove = async () => {
    await main.run(["worktree", "remove", "--force", dir]).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    await main.run(["worktree", "prune"]);
  };
  await remove(); // a crash may have left one
  await main.run(["worktree", "add", "--quiet", "--detach", dir, job.base]);
  const out: NonNullable<BaseCheck["afterDrives"]> = { head, files, results: [], passing: [] };
  const guards = guardsOf(ctx.jobDir, criteria);
  // `prepare` is cached per source folder: keep the job worktree's marker, so Verify doesn't prepare again.
  const marker = path.join(ctx.jobDir, "prepared.json");
  const kept = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null;
  try {
    const todo = needsNew(criteria, dir);
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(job.worktree, f), path.join(dir, f));
    }
    if (todo.length) {
      const source = linkedWorktree(ctx.repo, id, dir);
      const inst = { ...job, worktree: source.workTree };
      await freshUp(inst, ctx.jobDir, (m) => ctx.log(`[base after drives] ${m}`));
      for (const c of todo) {
        await resetUp(inst, ctx.jobDir);
        const p = await prove({
          jobDir: ctx.jobDir,
          criterion: c,
          role: "engine",
          testCmd: ctx.config.test_cmd,
          checksPrepare: checksPrepareOf(ctx.config),
          tag: { phase: "base" },
          source: { worktree: source.workTree, gitDir: source.gitDir },
          log: (m) => ctx.log(`[base after drives] ${m}`),
        });
        out.results.push({ criterion: c.id, status: p.status, ...(p.why ? { why: p.why } : {}), evidence: p.evidence });
        if (p.status === "pass" && !guards.includes(c.id)) out.passing.push(c.id);
      }
    }
  } finally {
    if (kept !== null) fs.writeFileSync(marker, kept);
    await remove();
  }
  b.afterDrives = out;
  writeAtomic(baseCheckFile(ctx.jobDir), `${JSON.stringify(b, null, 2)}\n`);
  ctx.log(
    `base check after drives (base + ${files.join(", ") || "no new files"}): ${out.results.map((r) => `${r.criterion} ${r.status}`).join(", ") || "nothing needed new drives"}${out.passing.length ? `; NON-DISCRIMINATING: ${out.passing.join(", ")}` : ""}`,
  );
  return out;
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
  const guards = guardsOf(ctx.jobDir, criteria);
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
        checksPrepare: checksPrepareOf(ctx.config),
        tag: { phase: "base" },
        log: (m) => ctx.log(`[base] ${m}`),
      });
      out.results.push({ criterion: c.id, status: p.status, ...(p.why ? { why: p.why } : {}), evidence: p.evidence });
      if (p.status === "pass" && !guards.includes(c.id)) out.passing.push(c.id);
    }
  }
  writeAtomic(baseCheckFile(ctx.jobDir), `${JSON.stringify(out, null, 2)}\n`);
  ctx.log(
    `base check on ${head.slice(0, 8)}: ${out.results.map((r) => `${r.criterion} ${r.status}`).join(", ") || "nothing ran"}${out.skipped.length ? `; skipped ${out.skipped.map((s) => s.criterion).join(", ")} (new drives or tests)` : ""}`,
  );
  return out;
}
