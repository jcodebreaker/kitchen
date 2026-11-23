// ready: engine only (PLAN §2 "ready"). In order:
//  1. The Toolkit PR (if the job pinned one): still open → paused(toolkit-pr). Nothing
//     else is worth doing first: the job can't be ready on an unmerged primitive.
//     Closed without merging → needs-human (the primitive will never reach the base).
//  2. Sync with the base (engine git, base.ts): the base tip not in HEAD → merge it in.
//     A conflict → build (a round; the builder resolves it, sync.json). A clean merge
//     → the job's base moves, and toolkitRef moves to the new base (its Toolkit now
//     has whatever primitive the job was pinned to), the branch is pushed, and Gate,
//     drives and Verify run again on the synced HEAD (re-verify only if base moved).
//  3. Publish HEAD (idempotent per head: `publish/<head>`). Commits made after build's
//     publish (the drives stage's feature drives) are pushed here, so CI and the report
//     are about the HEAD that was verified, never an older pushed one.
//  4. CI from the forge (`gh pr checks`) for that PR: pending → paused(ci); red → build.
//     No checks yet right after a push: green only when the repo has no workflow files,
//     else paused(ci) for the grace window (ci_grace_sec). A cancelled run is read once
//     more after the window before it counts as red.
//  5. Gate still PASS on this HEAD (feature-drive commits since it allowed), else Gate.
import fs from "node:fs";
import path from "node:path";
import { baseTip, toolkitAt } from "../base.ts";
import { mergeRev } from "../git.ts";
import type { Facts, Job, Stage } from "../machine.ts";
import { once, roundDir, writeAtomic } from "../store.ts";
import { jobGitOf } from "../worktree.ts";
import { gateStillValid } from "./gate.ts";
import type { StageHandler } from "./types.ts";

export const syncFile = (jobDir: string) => path.join(jobDir, "sync.json");
/** Per pushed head: when Ready first saw it pushed (the grace window starts there) and whether a cancelled run was already re-read. */
const ciFile = (jobDir: string) => path.join(jobDir, "ready-ci.json");
type CiMemo = { head: string; since: string; cancelledAt?: string };

function readCiMemo(jobDir: string, head: string, now: Date): CiMemo {
  try {
    const m = JSON.parse(fs.readFileSync(ciFile(jobDir), "utf8")) as CiMemo;
    if (m.head === head) return m;
  } catch {}
  const m = { head, since: now.toISOString() };
  writeAtomic(ciFile(jobDir), `${JSON.stringify(m, null, 2)}\n`);
  return m;
}

/**
 * What CI says about the pushed HEAD, as Ready acts on it. Pure.
 * - none: green when the repo has no workflow files; otherwise pending until the grace window
 *   after the push is over (then green: the workflows don't run for this branch).
 * - cancelled: pending once, until the window is over, then read again; cancelled twice is red.
 */
export function ciVerdict(o: {
  ci: "none" | "pending" | "pass" | "fail" | "cancelled";
  hasWorkflows: boolean;
  since: string;
  cancelledAt?: string;
  graceSec: number;
  now: Date;
}): { ci: "none" | "pending" | "pass" | "fail"; until?: string; note?: string; firstCancel?: boolean } {
  const end = (from: string) => new Date(Date.parse(from) + o.graceSec * 1000);
  if (o.ci === "none") {
    if (!o.hasWorkflows) return { ci: "none" };
    const until = end(o.since);
    if (o.now < until) return { ci: "pending", until: until.toISOString(), note: "no checks yet; the repo has workflows: waiting for CI to start" };
    return { ci: "none", note: `no checks ${o.graceSec}s after the push: the workflows don't run for this branch` };
  }
  if (o.ci === "cancelled") {
    if (!o.cancelledAt)
      return { ci: "pending", until: end(o.now.toISOString()).toISOString(), note: "a CI run was cancelled: reading it again", firstCancel: true };
    if (o.now < end(o.cancelledAt)) return { ci: "pending", until: end(o.cancelledAt).toISOString() };
    return { ci: "fail", note: "a CI run was cancelled twice" };
  }
  return { ci: o.ci };
}

export const ready: StageHandler = async (ctx) => {
  const job = ctx.refresh();
  const none = { synced: true, conflict: false, ci: "none", gatePass: true, baseMoved: false, recheckFailed: false } as const;
  const toolkitPr = job.smith.toolkitPr === null ? "none" : await ctx.forge.prState(job.smith.toolkitPr);
  if (toolkitPr === "open") {
    ctx.log(`Toolkit PR ${job.smith.toolkitPr} is not merged yet`);
    return { to: "paused", facts: { ready: { ...none, toolkitPr } } };
  }
  if (toolkitPr === "closed") {
    const why = `Toolkit PR ${job.smith.toolkitPr} was closed without merging: the job's proofs ran on a primitive (toolkitRef ${job.toolkitRef.slice(0, 12)}) that will not reach the base. Reopen and merge it, then \`kitchen feedback ${job.id}\`; or \`kitchen reject ${job.id}\``;
    ctx.log(why);
    return { to: "needs-human", facts: { ready: { ...none, toolkitPr }, why } };
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
  // HEAD on the remote: the sync's merge commit, or the drives stage's commits since build published.
  const head = m.head;
  const pub = await once(ctx.repo, job.id, `publish/${head}`, () => ctx.forge.publish({ branch: job.branch, title: job.title, head }));
  const pr = pub.value?.pr ?? job.pr;
  const pushed = ctx.forge.kind === "local" || !!pub.value?.pushed;
  if (pr !== job.pr) ctx.log(`PR ${pr}`);
  if (m.merged || job.base !== tip) {
    const onBase = await toolkitAt(ctx.repo, tip);
    const toolkitRef = onBase ? tip : job.toolkitRef;
    ctx.log(`synced with the base ${tip.slice(0, 12)} → ${head.slice(0, 12)}; toolkitRef ${toolkitRef.slice(0, 12)}: Gate, drives and Verify run again`);
    return {
      to: "gate",
      facts: {
        ready: {
          ...none,
          gatePass: false,
          baseMoved: true,
          toolkitPr,
          newBase: tip,
          toolkitRef,
          ...(onBase ? { toolkitFrom: "base" as const } : {}),
          pushed,
          pr,
        },
      },
    };
  }
  const now = ctx.now();
  const memo = readCiMemo(ctx.jobDir, head, now);
  const raw = await ctx.forge.checks(pr);
  const hasWorkflows = raw === "none" && ctx.forge.kind !== "local" ? await workflowsAt(job) : false;
  const v = ciVerdict({ ci: raw, hasWorkflows, since: memo.since, cancelledAt: memo.cancelledAt, graceSec: ctx.config.ci_grace_sec, now });
  if (v.firstCancel) writeAtomic(ciFile(ctx.jobDir), `${JSON.stringify({ ...memo, cancelledAt: now.toISOString() }, null, 2)}\n`);
  if (v.note) ctx.log(v.note);
  const ci = v.ci;
  const gatePass = await gateStillValid(ctx.jobDir, job);
  const facts: Omit<Facts, "now"> = { ready: { ...none, ci, toolkitPr, gatePass, pushed, pr, ...(v.until ? { until: v.until } : {}) } };
  // Gate no longer PASS on this HEAD (commits since it touch more than feature drives): Gate again first.
  const to: Stage = !gatePass ? "gate" : ci === "fail" ? "build" : ci === "pending" ? "paused" : "report";
  if (raw !== "none") ctx.log(`CI ${raw} on ${head.slice(0, 12)}`);
  if (ci === "fail")
    writeAtomic(
      path.join(roundDir(ctx.jobDir, job.round), "ci.md"),
      `RESULT: FAIL\nPR: ${pr}\n\nThe PR's CI checks are red on ${head.slice(0, 12)}${raw === "cancelled" ? " (a run was cancelled twice)" : ""}. Run the project's own checks and tests in the worktree and fix what fails.\n`,
    );
  return { to, facts, ...(ci === "fail" ? { note: "CI is red" } : {}) };
};

/** Whether the job's HEAD has GitHub Actions workflow files (.github/workflows/*.yml|yaml). */
async function workflowsAt(job: Job): Promise<boolean> {
  const out = (await (await jobGitOf(job)).run(["ls-tree", "-r", "--full-tree", "--name-only", "HEAD", "--", ".github/workflows"])).stdout;
  return out.split("\n").some((f) => /\.ya?ml$/.test(f));
}
