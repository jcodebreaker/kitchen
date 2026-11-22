// ready: engine only (PLAN §2 "ready"). In order:
//  1. The Toolkit PR (if the job pinned one): still open → paused(toolkit-pr). Nothing
//     else is worth doing first: the job can't be ready on an unmerged primitive.
//  2. Sync with the base (engine git, base.ts): the base tip not in HEAD → merge it in.
//     A conflict → build (a round; the builder resolves it, sync.json). A clean merge
//     → the job's base moves, and toolkitRef moves to the new base (its Toolkit now
//     has whatever primitive the job was pinned to), the branch is pushed, and Gate,
//     drives and Verify run again on the synced HEAD (re-verify only if base moved).
//  3. CI from the forge (`gh pr checks`): pending → paused(ci); red → build.
//  4. Gate still PASS on this HEAD (feature-drive commits since it allowed), else Gate.
import path from "node:path";
import { baseTip, toolkitAt } from "../base.ts";
import { mergeRev } from "../git.ts";
import type { Stage } from "../machine.ts";
import { once, roundDir, writeAtomic } from "../store.ts";
import { headOf, jobGitOf } from "../worktree.ts";
import { gateStillValid } from "./gate.ts";
import type { StageHandler } from "./types.ts";

export const syncFile = (jobDir: string) => path.join(jobDir, "sync.json");

export const ready: StageHandler = async (ctx) => {
  const job = ctx.refresh();
  const none = { synced: true, conflict: false, ci: "none", gatePass: true, baseMoved: false, recheckFailed: false } as const;
  const toolkitPr: "none" | "open" | "merged" = job.smith.toolkitPr === null ? "none" : (await ctx.forge.prMerged(job.smith.toolkitPr)) ? "merged" : "open";
  if (toolkitPr === "open") {
    ctx.log(`Toolkit PR ${job.smith.toolkitPr} is not merged yet`);
    return { to: "paused", facts: { ready: { ...none, toolkitPr } } };
  }
  const tip = await baseTip(ctx.repo, ctx.config);
  const git = await jobGitOf(job);
  const m = await mergeRev(git, tip, { message: `kitchen(${job.id}): sync with the base ${tip.slice(0, 12)}` });
  if (!m.ok) {
    ctx.log(`sync with the base ${tip.slice(0, 12)}: conflict in ${m.conflicts.join(", ")}`);
    writeAtomic(syncFile(ctx.jobDir), `${JSON.stringify({ base: tip, conflicts: m.conflicts, at: ctx.now().toISOString() }, null, 2)}\n`);
    writeAtomic(
      path.join(roundDir(ctx.jobDir, job.round), "sync-conflict.md"),
      `RESULT: CONFLICT\nBASE: ${tip}\n\nMerging the base into the job branch conflicts in:\n${m.conflicts.map((f) => `- ${f}`).join("\n")}\n`,
    );
    return { to: "build", facts: { ready: { ...none, synced: false, conflict: true, toolkitPr }, why: `sync conflict: ${m.conflicts.join(", ")}` } };
  }
  if (m.merged || job.base !== tip) {
    const toolkitRef = (await toolkitAt(ctx.repo, tip)) ? tip : job.toolkitRef;
    ctx.log(`synced with the base ${tip.slice(0, 12)} → ${m.head.slice(0, 12)}; toolkitRef ${toolkitRef.slice(0, 12)}: Gate, drives and Verify run again`);
    const pub = await once(ctx.repo, job.id, `publish/${m.head}`, () => ctx.forge.publish({ branch: job.branch, title: job.title, head: m.head }));
    if (pub.value?.pr && pub.value.pr !== job.pr) ctx.log(`PR ${pub.value.pr}`);
    return { to: "gate", facts: { ready: { ...none, gatePass: false, baseMoved: true, toolkitPr, newBase: tip, toolkitRef } } };
  }
  const ci = await ctx.forge.checks(job.pr);
  const gatePass = await gateStillValid(ctx.jobDir, job);
  const facts = { ready: { ...none, ci, toolkitPr, gatePass } };
  // Gate no longer PASS on this HEAD (commits since it touch more than feature drives): Gate again first.
  const to: Stage = !gatePass ? "gate" : ci === "fail" ? "build" : ci === "pending" ? "paused" : "report";
  if (ci !== "none") ctx.log(`CI ${ci}`);
  if (ci === "fail")
    writeAtomic(
      path.join(roundDir(ctx.jobDir, job.round), "ci.md"),
      `RESULT: FAIL\nPR: ${job.pr}\n\nThe PR's CI checks are red on ${(await headOf(job)).slice(0, 12)}. Run the project's own checks and tests in the worktree and fix what fails.\n`,
    );
  return { to, facts, ...(ci === "fail" ? { note: "CI is red" } : {}) };
};
