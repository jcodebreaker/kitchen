// repro: a bug is shown on the base before anyone fixes it (PLAN §2, repro → build).
// 1. If the repro criterion's proof needs something that doesn't exist yet (a
//    new feature drive, the regression test file), the verifier (repro mode)
//    writes it against the app running from the base.
// 2. The engine commits only new files and feature drives (no fix: reproPolicy)
//    and records them as the job's repro files: the builder may not edit them.
// 3. The engine runs the proof itself, `kitchen drive <job> <C> --repro`, on a
//    fresh app started from that commit, whose diff from the base is only those
//    files ("on the base sha"). It failed as expected when every step ran and
//    the mechanical expect is false.
import fs from "node:fs";
import path from "node:path";
import { prove } from "../../proof/prove.ts";
import { contractOf, namedDrives, reproCriterion, reproPolicy, testFilesOf } from "../contract.ts";
import { freshUp } from "../instance.ts";
import { updateJob, writeAtomic } from "../store.ts";
import { changedFiles, commitWith, ensureWorktree, headOf } from "../worktree.ts";
import { contractBlock, toolkitBlock } from "./context.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import { featureDrives, hasToolkit } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

export const repro: StageHandler = async (ctx) => {
  let job = await ensureWorktree(ctx.repo, ctx.refresh());
  const contract = contractOf(ctx.jobDir);
  const crit = contract && reproCriterion(contract.criteria);
  const n = job.attempts.repro + 1;
  const record = path.join(ctx.jobDir, `repro-${n}.json`);
  if (!crit) return { to: "repro", facts: { repro: { failedAsExpected: false, onBase: false, committed: false } }, note: "no repro: true criterion" };
  const missing = () => {
    const have = featureDrives(job.worktree).drives;
    return [
      ...[...namedDrives([crit]).keys()].filter((d) => !have[d]).map((d) => `feature drive ${d}`),
      ...testFilesOf(crit)
        .filter((f) => !fs.existsSync(path.join(job.worktree, f)))
        .map((f) => `test file ${f}`),
    ];
  };
  let gap: string | undefined;
  const need = missing();
  if (need.length || job.attempts.repro > 0) {
    // The agent writes what the proof needs, trying it on the app running from the base.
    if (hasToolkit(job)) await freshUp(job, ctx.jobDir, ctx.log);
    const r = await runRole(ctx, {
      role: "verifier",
      file: "repro.md",
      tier: "write",
      prompt: prompt({
        role: "verifier",
        mode: "repro",
        job,
        jobDir: ctx.jobDir,
        blocks: [
          contractBlock(ctx.jobDir),
          {
            title: "What the repro needs",
            body: `Repro criterion: ${crit.id}\n${need.length ? `Missing: ${need.join(", ")}` : "Nothing is missing, but the last attempt did not reproduce; see below."}`,
          },
          ...lastAttempt(ctx.jobDir, n - 1),
          await toolkitBlock(job, job.worktree),
        ],
      }),
      dest: path.join(ctx.jobDir, `repro-${n}.md`),
    });
    gap = headers(r.text).GAP || undefined;
  }
  job = ctx.refresh();
  const c = await commitWith(job, `kitchen(${job.id}): regression test (repro)`, reproPolicy(ctx.config.protected));
  for (const x of c.refused) ctx.log(`kept off the job branch: ${x}`);
  const reproFiles = [...new Set([...(job.reproFiles ?? []), ...c.files])];
  job = await updateJob(ctx.repo, job.id, (j) => {
    j.reproFiles = reproFiles;
    return j;
  });
  if (gap) return { to: "toolkit", facts: { repro: { failedAsExpected: false, onBase: false, committed: false, missingPrimitive: gap } } };
  // "On the base": the job branch differs from the base only by the repro's own files, and the tree is clean.
  const head = await headOf(job);
  const diff = await changedFiles(job, job.base, head);
  const onBase = c.clean && diff.every((f) => reproFiles.includes(f));
  const committed = c.clean && missing().length === 0;
  let failedAsExpected = false;
  let why = "";
  if (onBase && committed) {
    if (hasToolkit(job)) await freshUp(job, ctx.jobDir, ctx.log);
    const p = await prove({
      jobDir: ctx.jobDir,
      criterion: crit,
      role: "engine",
      testCmd: ctx.config.test_cmd,
      tag: { phase: "repro" },
      log: (m) => ctx.log(`[drive] ${m}`),
    });
    failedAsExpected = p.status === "assert-fail";
    why =
      p.status === "pass"
        ? "the expect holds on the base: nothing reproduced"
        : p.status === "assert-fail"
          ? `failed as expected: ${p.why}`
          : `${p.status}: ${p.why}`;
    writeAtomic(record, `${JSON.stringify({ criterion: crit.id, head, status: p.status, why, evidence: p.evidence, assert: p.assert }, null, 2)}\n`);
  } else why = !onBase ? `the branch differs from the base by more than the repro files: ${diff.join(", ")}` : `not committed: ${missing().join(", ")}`;
  ctx.log(`repro ${crit.id}: ${why}`);
  const to = failedAsExpected ? "build" : job.attempts.repro + 1 < 2 ? "repro" : "needs-info";
  if (to === "needs-info")
    await ctx.source.ask(job, {
      key: `ask/repro/m${job.moves}`,
      text: `Kitchen could not reproduce this after 2 tries (${crit.id}: ${why}). What exactly do you do, and what do you see?`,
    });
  return { to, facts: { repro: { failedAsExpected, onBase, committed } }, note: why };
};

function lastAttempt(jobDir: string, n: number) {
  if (n < 1) return [];
  const blocks = [];
  for (const f of [`repro-${n}.md`, `repro-${n}.json`]) {
    const p = path.join(jobDir, f);
    if (fs.existsSync(p)) blocks.push({ title: `Last attempt (${f})`, body: fs.readFileSync(p, "utf8") });
  }
  return blocks;
}
