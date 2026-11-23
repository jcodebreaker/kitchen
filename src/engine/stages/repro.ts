// repro: a bug is shown on the base before anyone fixes it (PLAN §2, repro → build).
// 1. If the repro criterion's proof needs something that doesn't exist yet (a
//    new feature drive, the regression test file), the verifier (repro mode)
//    writes it against the app running from the base.
// 2. The engine commits only new files and feature drives (no fix: reproPolicy)
//    and records them as the job's repro files: the builder may not edit them.
// 3. The engine runs the proof itself, `kitchen drive <job> <C> --repro`, on a
//    fresh app started from that commit, whose diff from the base is only those
//    files ("on the base sha"). It failed as expected when every step ran and
//    the mechanical expect is false, or a `wait` for the text the expect asks
//    for timed out after every earlier step ran.
import fs from "node:fs";
import path from "node:path";
import { changedExistingDrive } from "../../checks/feature-lint.ts";
import { checksPrepareOf } from "../../checks/run-checks.ts";
import { waitMatchesExpect } from "../../proof/assert.ts";
import { prove } from "../../proof/prove.ts";
import { featureFileProblems } from "../../toolkit/feature-check.ts";
import { contractOf, namedDrives, reproCriterion, reproPolicy, testFilesOf } from "../contract.ts";
import { freshUp } from "../instance.ts";
import { updateJob, writeAtomic } from "../store.ts";
import { changedFiles, commitWith, ensureWorktree, headOf } from "../worktree.ts";
import { contractBlock, testLayoutBlock, toolkitBlock } from "./context.ts";
import { featureFilesAt } from "./drives.ts";
import { prompt } from "./prompts.ts";
import { headers, named, runRole } from "./role.ts";
import { described, featureDrives, hasToolkit, toolkitDirOf } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

const FEATURE_FILE = /^\.kitchen\/toolkit\/features\/[^/]+\.md$/;

export const repro: StageHandler = async (ctx) => {
  let job = await ensureWorktree(ctx.repo, ctx.refresh());
  const contract = contractOf(ctx.jobDir);
  const crit = contract && reproCriterion(contract.criteria);
  const n = job.attempts.repro + 1;
  const record = path.join(ctx.jobDir, `repro-${n}.json`);
  if (!crit) return { to: "repro", facts: { repro: { failedAsExpected: false, onBase: false, committed: false } }, note: "no repro: true criterion" };
  const missing = () => {
    const have = featureDrives(job.worktree, toolkitDirOf(job)).drives;
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
          ...testLayoutBlock(job.worktree, ctx.config.test_cmd),
          await toolkitBlock(job, job.worktree),
        ],
      }),
      dest: path.join(ctx.jobDir, `repro-${n}.md`),
    });
    gap = named(headers(r.text).GAP, (await described(job)).primitives);
  }
  job = ctx.refresh();
  const before = await featureFilesAt(job, job.base);
  const policy = reproPolicy(ctx.config.protected);
  const wt = job.worktree;
  const tk = await described(job);
  const c = await commitWith(job, `kitchen(${job.id}): regression test (repro)`, (f, status) => {
    const layer = policy(f, status);
    if (layer || !FEATURE_FILE.test(f)) return layer;
    const text = fs.readFileSync(path.join(wt, f), "utf8");
    const changed = before.has(f) ? changedExistingDrive(before.get(f) ?? "", text) : null;
    if (changed) return changed;
    // A drive the repro adds must pass W2's feature rules too, or it breaks the Toolkit's re-proof once merged.
    const problems = featureFileProblems(f, text, tk.features);
    return problems.length ? `refused: ${problems.join("; ")}` : null;
  });
  for (const x of c.refused) ctx.log(`kept off the job branch: ${x}`);
  // What the builder may not edit: what this stage added, plus the drives and test files the repro proof runs.
  const used = featureDrives(job.worktree, toolkitDirOf(job)).files;
  const reproFiles = [
    ...new Set([
      ...(job.reproFiles ?? []),
      ...c.files,
      ...[...namedDrives([crit]).keys()].flatMap((d) => (used[d] ? [used[d]] : [])),
      ...testFilesOf(crit).filter((f) => fs.existsSync(path.join(job.worktree, f))),
    ]),
  ];
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
      checksPrepare: checksPrepareOf(ctx.config),
      tag: { phase: "repro" },
      log: (m) => ctx.log(`[drive] ${m}`),
    });
    // Failed as expected: every step ran and the expect is false, or a `wait` timed out after every
    // earlier step ran AND what it waited for is what the criterion's own expect asks for (the state
    // never showed up). A wait for anything else (a page heading, a button) is a broken proof.
    failedAsExpected = p.status === "assert-fail" || (p.status === "step-failed" && !!p.waitTimedOut && waitMatchesExpect(p.waitText, crit.expect));
    why =
      p.status === "pass" ? "the expect holds on the base: nothing reproduced" : failedAsExpected ? `failed as expected: ${p.why}` : `${p.status}: ${p.why}`;
    writeAtomic(
      record,
      `${JSON.stringify({ criterion: crit.id, head, status: p.status, failedAsExpected, why, evidence: p.evidence, assert: p.assert }, null, 2)}\n`,
    );
  } else why = !onBase ? `the branch differs from the base by more than the repro files: ${diff.join(", ")}` : `not committed: ${missing().join(", ")}`;
  ctx.log(`repro ${crit.id}: ${why}`);
  // On try 1 the contract itself is the problem when its own proof (nothing for the repro role to write) ran on the
  // base and can't show the bug as written (a step failed before the expect was read, or the expect held), or when
  // the repro role could not write what the contract names (a drive the Toolkit can't express, with no primitive
  // gap named). The repro role can't change the contract, so its author (intake, or spec above low risk) rewrites it
  // once, with the evidence and the role's note, like a spec-lint refusal; then the usual two tries, then
  // needs-info. A drive or test the repro role did write but got wrong gets its retry first.
  const contractAtFault = need.length ? !committed && !gap : onBase && committed && !failedAsExpected;
  const contractProblem = n === 1 && contractAtFault && (job.attempts.contract ?? 0) === 0 ? why : undefined;
  if (contractProblem) {
    const file = job.risk === "low" ? "intake-refused.md" : "spec-refused.md";
    const own = job.risk === "low" ? "intake.md" : "spec.md";
    writeAtomic(
      path.join(ctx.jobDir, file),
      [
        `REASON: the repro criterion ${crit.id} could not reproduce the bug on the base (${job.base.slice(0, 12)}): ${why}`,
        "",
        'Kitchen ran its proof, exactly as written, on a fresh app from the base. A repro must run every step there and end with its expect FALSE: that is the bug, shown. A step that fails before the expect is read is a broken proof, not a reproduction (an `http` answered with a 4xx fails its step unless `--expect_status` names that status; `read --equals` and a pinned `--expect_exit` fail the step too): read the value instead (`toolkit read --target status --save code`) and put the right value in the expect (`$code == "201"`), which the bug makes false. An expect that already holds on the base does not test the bug the ticket reports: find what goes wrong and assert the right behaviour. When the repro role could not write a drive the proof names (its note says why: the Toolkit cannot express it), use what exists instead (a seeded value typed as a literal, an existing drive or primitive). Rewrite the criteria (keep the requirements unless they were wrong).',
        "",
        ...lastAttempt(ctx.jobDir, n).map((b) => `## ${b.title}\n\n${b.body}`),
        "",
        `## Your ${own}`,
        "",
        fs.existsSync(path.join(ctx.jobDir, own)) ? fs.readFileSync(path.join(ctx.jobDir, own), "utf8") : "",
      ].join("\n"),
    );
    return { to: job.risk === "low" ? "intake" : "spec", facts: { repro: { failedAsExpected, onBase, committed, contractProblem } }, note: why };
  }
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
