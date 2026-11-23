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
// intake.md, or negatives the spec re-marked as boundaries) holds on the base by
// design: it runs, must pass there, and is never counted.
// The base check never fails open: once HEAD has moved past the base (a person sent
// the job back to the spec after a build), it runs on a checkout of the base
// (`<repo>/.worktrees/<id>.base`), and a check that could not run at all refuses
// what it was asked to back.
import fs from "node:fs";
import path from "node:path";
import { checksPrepareOf } from "../../checks/run-checks.ts";
import { type BaseNegative, type Criterion, guardCriteria } from "../../checks/spec-lint.ts";
import { type ClauseResult, isJudged } from "../../proof/assert.ts";
import { prove } from "../../proof/prove.ts";
import { namedDrives, testFilesOf } from "../contract.ts";
import { linkedWorktree, openGit, plainCheckout } from "../git.ts";
import { freshUp, resetUp } from "../instance.ts";
import type { Job } from "../machine.ts";
import { writeAtomic } from "../store.ts";
import { changedFiles, headOf } from "../worktree.ts";
import { jobRequirements } from "./context.ts";
import { FEATURES_DIR, featureDrives, hasToolkit, toolkitDirOf } from "./toolkit-info.ts";
import type { StageContext } from "./types.ts";

export type BaseResult = { criterion: string; status: string; why?: string; evidence: string[]; clauses?: ClauseResult[] };
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

/** The contract's regression guards, from the `(unchanged)` requirements (intake.md's, with the spec's re-marks). */
function guardsOf(jobDir: string, criteria: Criterion[]): string[] {
  return guardCriteria(criteria, jobRequirements(jobDir));
}

/**
 * spec-lint rule 3 (c): a negative clause no earlier step backs counts only when the base shows the thing,
 * i.e. the clause is FALSE on the base (the old heading, the wrong total, the error the change removes is
 * there before it). One line per clause that the base doesn't back: it held there too (it holds whatever
 * the code does), or its proof couldn't run on the base. Pure.
 */
export function baseNegativeProblems(pending: BaseNegative[], b: BaseCheck | null, guards: string[] = []): string[] {
  if (!b)
    return pending.map(
      (n) =>
        `${n.criterion}: \`${n.clause}\` needs the base check (nothing earlier in the proof makes what must not show), and it could not run (no Toolkit or worktree to run it on): make what must not show in an earlier step of the same proof`,
    );
  const out: string[] = [];
  const how =
    'If the requirement means existing behaviour stays as it is, mark it `(unchanged)` (intake: in its `## Requirements`; the spec: re-mark it in its own `## Requirements`, `- R4 (unchanged): … — why`) and prove it positively (the same output, `$x == …`); if something must disappear, make it show first in an earlier step of the same proof (its text as an arg: `toolkit <feature>.create --name "<text>" ; … ; open --path /list`), or read a value after a step that makes something and assert `$v != "<the wrong value>"`';
  for (const n of pending) {
    const skipped = b.skipped.find((s) => s.criterion === n.criterion);
    const r = b.results.find((x) => x.criterion === n.criterion);
    if (skipped)
      out.push(`${n.criterion}: \`${n.clause}\` can't be checked on the base (${skipped.why}), so nothing shows the thing is there before the change. ${how}`);
    else if (!r) continue;
    else if (r.status !== "pass" && r.status !== "assert-fail")
      out.push(
        `${n.criterion}: \`${n.clause}\`: the proof doesn't run on the base (${r.why ?? r.status}), so nothing shows the thing is there before the change: put this negative in a criterion whose every step runs on the current code (check the new behaviour in another criterion). ${how}`,
      );
    // A negative the spec re-marked as a boundary may hold on the base (its guard must, guardBaseProblems).
    else if (r.clauses?.find((c) => c.clause === n.clause)?.pass && !guards.includes(n.criterion))
      out.push(
        `${n.criterion}: \`${n.clause}\` already holds on the base, before any change (evidence ${r.evidence.join(" ")}): the thing never shows there, so its absence proves nothing. ${how}`,
      );
  }
  return out;
}

/**
 * A regression guard (a criterion covering only `(unchanged)` requirements) states what the current code
 * already does, so it must hold on the base. One that fails there misreads the current behaviour (the wrong
 * output shape, a value the code never gives) and would fail a correct build: one line per such guard. Pure.
 */
export function guardBaseProblems(guards: string[], b: BaseCheck | null): string[] {
  if (!b)
    return guards.map(
      (g) =>
        `${g} guards existing behaviour, and a guard must hold on the current code, but the base check could not run (no Toolkit or worktree to run it on)`,
    );
  return [
    ...b.skipped
      .filter((x) => guards.includes(x.criterion))
      .map(
        (x) =>
          `${x.criterion} guards existing behaviour, so it must run and hold on the current code, but it can't run there (${x.why}): prove the old behaviour with what the current code has`,
      ),
    ...b.results
      .filter((r) => guards.includes(r.criterion) && r.status !== "pass")
      .map(
        (r) =>
          `${r.criterion} guards existing behaviour (it covers only \`(unchanged)\` requirements) but fails on the current code (${r.why ?? r.status}; evidence ${r.evidence.join(" ")}): a guard must hold before the change. Assert what the current code really gives: read the proof's last output as it is (an \`http\` step's \`json\`/\`--save\` read its body; a drive's output is its last step's), and use the values the current code shows`,
      ),
  ];
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
function needsNew(criteria: Criterion[], base: string, toolkitDir: string | null): Criterion[] {
  const have = featureDrives(base, toolkitDir).drives;
  return criteria.filter(
    (c) => !isJudged(c.expect) && ([...namedDrives([c]).keys()].some((d) => !have[d]) || testFilesOf(c).some((t) => !fs.existsSync(path.join(base, t)))),
  );
}

/**
 * A checkout of the job's base at `<repo>/.worktrees/<id>.base` (any left by a crash is removed first), handed
 * to `fn` with its linked source; removed afterwards. The job's `prepare` marker is kept as it was (prepare is
 * cached per source folder), so Verify doesn't prepare again.
 */
async function onBaseCheckout<T>(ctx: StageContext, job: Job, fn: (dir: string, source: { workTree: string; gitDir: string }) => Promise<T>): Promise<T> {
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
  const marker = path.join(ctx.jobDir, "prepared.json");
  const kept = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null;
  try {
    return await fn(dir, linkedWorktree(ctx.repo, id, dir));
  } finally {
    if (kept !== null) fs.writeFileSync(marker, kept);
    await remove();
  }
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
  const out: NonNullable<BaseCheck["afterDrives"]> = { head, files, results: [], passing: [] };
  const guards = guardsOf(ctx.jobDir, criteria);
  await onBaseCheckout(ctx, job, async (dir, source) => {
    const todo = needsNew(criteria, dir, toolkitDirOf(job)); // before the new files are copied in
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(job.worktree, f), path.join(dir, f));
    }
    if (!todo.length) return;
    const inst = { ...job, worktree: source.workTree };
    await freshUp(inst, ctx.jobDir, (m) => ctx.log(`[base after drives] ${m}`));
    for (const c of todo) {
      await resetUp(inst, ctx.jobDir);
      const r = await proveOnBase(ctx, c, source, "[base after drives]");
      out.results.push(r);
      if (r.status === "pass" && !guards.includes(c.id)) out.passing.push(c.id);
    }
  });
  b.afterDrives = out;
  writeAtomic(baseCheckFile(ctx.jobDir), `${JSON.stringify(b, null, 2)}\n`);
  ctx.log(
    `base check after drives (base + ${files.join(", ") || "no new files"}): ${out.results.map((r) => `${r.criterion} ${r.status}`).join(", ") || "nothing needed new drives"}${out.passing.length ? `; NON-DISCRIMINATING: ${out.passing.join(", ")}` : ""}`,
  );
  return out;
}

/** One criterion's proof on the base, stamped `phase: base` (on `source` when given, else the job worktree). */
async function proveOnBase(ctx: StageContext, c: Criterion, source: { workTree: string; gitDir: string } | null, tag: string): Promise<BaseResult> {
  const p = await prove({
    jobDir: ctx.jobDir,
    criterion: c,
    role: "engine",
    testCmd: ctx.config.test_cmd,
    checksPrepare: checksPrepareOf(ctx.config),
    tag: { phase: "base" },
    ...(source ? { source: { worktree: source.workTree, gitDir: source.gitDir } } : {}),
    log: (m) => ctx.log(`${tag} ${m}`),
  });
  return { criterion: c.id, status: p.status, ...(p.why ? { why: p.why } : {}), evidence: p.evidence, ...(p.assert ? { clauses: p.assert.results } : {}) };
}

/**
 * Run every mechanical criterion once on the base: on the job worktree while it is still at the base, else on
 * a checkout of the base (a person sent the job back to the spec after a build). Without a Toolkit, only the
 * `cmd`/`test` criteria run (the toolkit ones are skipped, which refuses what they were to back). Reuses a
 * result recorded for the same contract and base. Null only when there is no worktree to run on.
 */
export async function runBaseCheck(ctx: StageContext, job: Job, criteria: Criterion[]): Promise<BaseCheck | null> {
  if (!job.worktree) return null;
  const key = keyOf(criteria);
  const prev = readBaseCheck(ctx.jobDir);
  if (prev && prev.key === key && prev.head === job.base) return prev;
  const toolkit = hasToolkit(job);
  const out: BaseCheck = { head: job.base, key, results: [], skipped: [], passing: [] };
  const guards = guardsOf(ctx.jobDir, criteria);
  const run = async (dir: string, source: { workTree: string; gitDir: string } | null) => {
    const have = toolkit ? featureDrives(dir, toolkitDirOf(job)).drives : {};
    const todo: Criterion[] = [];
    for (const c of criteria) {
      if (isJudged(c.expect)) continue;
      const isToolkit = (c.proof ?? "").trim().startsWith("toolkit");
      if (isToolkit && !toolkit) {
        out.skipped.push({ criterion: c.id, why: "the repo has no Toolkit to run it with" });
        continue;
      }
      const newDrives = [...namedDrives([c]).keys()].filter((d) => !have[d]);
      const newTests = testFilesOf(c).filter((t) => !fs.existsSync(path.join(dir, t)));
      if (newDrives.length || newTests.length)
        out.skipped.push({ criterion: c.id, why: `needs what the base doesn't have: ${[...newDrives, ...newTests].join(", ")}` });
      else todo.push(c);
    }
    if (!todo.length) return;
    const inst = source ? { ...job, worktree: source.workTree } : job;
    if (toolkit) await freshUp(inst, ctx.jobDir, ctx.log);
    for (const c of todo) {
      if (toolkit) await resetUp(inst, ctx.jobDir);
      const r = await proveOnBase(ctx, c, source, "[base]");
      out.results.push(r);
      if (r.status === "pass" && !guards.includes(c.id)) out.passing.push(c.id);
    }
  };
  const head = await headOf(job);
  if (head === job.base) await run(job.worktree, null);
  else await onBaseCheckout(ctx, job, (dir, source) => run(dir, source));
  writeAtomic(baseCheckFile(ctx.jobDir), `${JSON.stringify(out, null, 2)}\n`);
  ctx.log(
    `base check on ${job.base.slice(0, 8)}${head === job.base ? "" : " (a checkout of the base: HEAD has moved)"}: ${out.results.map((r) => `${r.criterion} ${r.status}`).join(", ") || "nothing ran"}${out.skipped.length ? `; skipped ${out.skipped.map((s) => `${s.criterion} (${s.why})`).join(", ")}` : ""}`,
  );
  return out;
}
