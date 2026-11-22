// toolkit: the smith adds the missing primitive on its own Toolkit branch, in an
// engine-made worktree (`.worktrees/_smith-<job>-<n>` on `kitchen/toolkit/<job>-<n>`,
// started from the Toolkit the job runs now, or from its own failed try n-1). Its
// edits never touch the job branch. It gets the setup bridge on that worktree
// (toolkit, toolkit_check; sandboxed: the code is agent-written and unmerged, ADR 0008).
//
// The engine then:
//  1. commits what the smith left under .kitchen/toolkit/ (anything else is put back);
//  2. proves it: `toolkit check` of that commit (base + the smith's branch) from its own
//     engine-owned checkout, sandboxed because it isn't merged, and describe must list
//     the primitive the gap named. A drive that already fails on the base (the base's
//     own check, run once per base sha and cached: a bug in the app an existing drive
//     exercises) is tolerated; the contract probe, every drive that uses the new
//     primitive and every drive that passes on the base must pass;
//  3. opens the Toolkit PR through the forge (once per attempt; a human merges it).
// The job goes back to returnTo pinned to that commit (toolkitRef = its real git sha);
// Ready waits for the PR to merge (paused toolkit-pr), then moves toolkitRef to the base.
// A failed proof goes to the smith's second try (toolkit → toolkit while smith.attempts < 2),
// which reads toolkit-check-<n-1>.json; after that, needs-human (smith limit).
import fs from "node:fs";
import path from "node:path";
import { setupBridgeServer } from "../../init/bridge.ts";
import { describeToolkit } from "../../proof/drive.ts";
import { runToolkitCheck } from "../../toolkit/check.ts";
import { toolkitCheckout } from "../../toolkit/checkout.ts";
import { kitchenDir, once, roundDir, writeAtomic } from "../store.ts";
import { commitWith, ensureSmithWorktree, removeSmithWorktree } from "../worktree.ts";
import { contractBlock, fileBlock } from "./context.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import type { StageContext, StageHandler } from "./types.ts";

const TOOLKIT = ".kitchen/toolkit/";

/** What the smith may leave for the engine to commit: Toolkit files outside features/. Pure. */
export function smithPolicy(file: string): string | null {
  if (!file.startsWith(TOOLKIT)) return "the smith changes the Toolkit only";
  if (file.startsWith(`${TOOLKIT}features/`)) return "feature drives belong to the job branch (the verifier writes them)";
  return null;
}

/**
 * Which failed drives the smith's proof tolerates: the ones that already fail on the base,
 * unless the drive uses the new primitive (that one must work). Pure.
 */
export function toleratedOnBase(baseFailing: string[], gap: string): (drive: string, primitives: string[]) => boolean {
  return (drive, primitives) => baseFailing.includes(drive) && !primitives.includes(gap);
}

/** What one try's proof left (toolkit-check-<n>.json). */
type CheckRecord = { ok: boolean; sha: string; gap: string; why?: string; failed?: string; known?: string[]; steps?: unknown[]; secs?: number };

function readRecord(file: string): CheckRecord | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CheckRecord;
  } catch {
    return null;
  }
}

/** The base's own drive failures. `ok: false` means the base check could not run its drives at all (`failed` says where). */
export type BaseCheck = { sha: string; ok: boolean; failing: string[]; failed?: string; at: string; secs: number };
export const baseCheckFile = (repo: string, sha: string) => path.join(kitchenDir(repo), "toolkit-base-checks", `${sha}.json`);

/**
 * The base's own check, once per base sha (cached in .kitchen/toolkit-base-checks/<sha>.json): its
 * drives, twice with a reset between, every failure tolerated so all are listed. No probe, no second
 * slot: only which drives fail on the app as it is matters here.
 */
export async function baseDriveFailures(ctx: Pick<StageContext, "repo" | "log">, sha: string): Promise<BaseCheck> {
  const file = baseCheckFile(ctx.repo, sha);
  const had = (() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as BaseCheck;
    } catch {
      return null;
    }
  })();
  if (had?.sha === sha) return had;
  const co = await toolkitCheckout(ctx.repo, sha);
  try {
    ctx.log(`the base's own check at ${sha.slice(0, 12)} (drives only, failures listed)`);
    const r = await runToolkitCheck({
      repo: ctx.repo,
      toolkitBin: co.bin,
      src: co.dir,
      pathsRev: co.sha,
      tolerate: () => true,
      drivesOnly: true,
      print: (l) => ctx.log(`  base: ${l}`),
    });
    const out: BaseCheck = { sha, ok: r.ok, failing: r.tolerated, ...(r.ok ? {} : { failed: r.failed }), at: new Date().toISOString(), secs: r.secs };
    writeAtomic(file, `${JSON.stringify(out, null, 2)}\n`);
    return out;
  } finally {
    co.release();
  }
}

export const toolkit: StageHandler = async (ctx) => {
  let job = ctx.refresh();
  const gap = job.gap ?? "?";
  const n = job.smith.attempts; // counted when the job entered this stage
  const base = job.toolkitRef || job.base; // the Toolkit the job runs now
  if (!base) throw new Error("the job has no base to start a Toolkit branch from");
  const dir = roundDir(ctx.jobDir, job.round);
  fs.mkdirSync(dir, { recursive: true });
  const checkFile = path.join(dir, `toolkit-check-${n}.json`);
  // The smith's second try for the same gap: it starts from its first try's commit and reads why it failed.
  const prev = n > 1 ? readRecord(path.join(dir, `toolkit-check-${n - 1}.json`)) : null;
  const retry = prev && !prev.ok && prev.gap === gap ? prev : null;
  const smith = await ensureSmithWorktree(ctx.repo, job, n, retry?.sha || base);
  const why = [
    ...fileBlock(ctx.jobDir, "spec-refused.md", "Why the spec was sent here"),
    ...fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /^(drives-\d+|verdict-m\d+)\.md$/.test(d.name))
      .map((d) => ({ title: `Round ${job.round}: ${d.name}`, body: fs.readFileSync(path.join(dir, d.name), "utf8") })),
  ];
  const r = await runRole(ctx, {
    role: "smith",
    file: "smith.md",
    tier: "write",
    cwd: smith.worktree,
    bridge: setupBridgeServer({ repo: ctx.repo, worktree: smith.worktree }),
    prompt: prompt({
      role: "toolkit-smith",
      job,
      jobDir: ctx.jobDir,
      blocks: [
        contractBlock(ctx.jobDir),
        ...why,
        ...(retry
          ? [
              {
                title: "The engine's check of your last commit FAILED (fix this first; your branch starts from that commit)",
                body: JSON.stringify(retry, null, 2),
              },
            ]
          : []),
      ],
      extra: [`Missing primitive: ${gap}`, `Your worktree (the Toolkit branch ${smith.branch}): ${smith.worktree}`],
    }),
    dest: path.join(dir, `smith-${n}.md`),
  });
  const h = headers(r.text);
  const c = await commitWith(smith, `kitchen(${job.id}): Toolkit primitive ${gap}`, smithPolicy);
  for (const x of c.refused) ctx.log(`kept off the Toolkit branch: ${x}`);
  job = ctx.refresh();
  const write = (rec: Omit<CheckRecord, "sha" | "gap">) => writeAtomic(checkFile, `${JSON.stringify({ ...rec, sha: c.head, gap }, null, 2)}\n`);
  const fail = (why: string, extra: Partial<CheckRecord> = {}) => {
    ctx.log(`Toolkit check: FAIL (${why})`);
    write({ ok: false, why, ...extra });
    // A second try while the smith has one (toolkit → toolkit); after that the machine refuses with smith-limit → needs-human.
    return { to: "toolkit", facts: { toolkit: { checkPassed: false, sha: c.head, pr: null } }, note: why } as const;
  };
  if (h.STATUS !== "READY") return fail(`smith: ${h.STATUS ?? "no STATUS"}${h.REASON ? `: ${h.REASON}` : ""}`);
  if (!c.ahead && !retry) return fail("the smith committed nothing");
  // What already fails on the base is not the smith's doing (cached per base sha).
  const onBase = await baseDriveFailures(ctx, base);
  if (onBase.failing.length) ctx.log(`drives that already fail on the base ${base.slice(0, 12)}: ${onBase.failing.join(", ")}`);
  if (!onBase.ok) ctx.log(`the base's own check stopped at ${onBase.failed}: no drive failure is tolerated`);
  // The proof: the same check jobs rely on, of base + this branch, from its own checkout (sandboxed: not merged).
  const co = await toolkitCheckout(ctx.repo, c.head);
  let report: Awaited<ReturnType<typeof runToolkitCheck>>;
  try {
    const listed = (await describeToolkit(co.bin, co.dir)).primitives;
    if (!listed.includes(gap)) return fail(`describe at ${c.head.slice(0, 12)} does not list ${gap}`);
    ctx.log(`toolkit check of ${c.head.slice(0, 12)} (${co.merged ? "merged" : co.sandboxed ? "unmerged: sandboxed" : "unmerged: UNSANDBOXED"})`);
    report = await runToolkitCheck({
      repo: ctx.repo,
      toolkitBin: co.bin,
      src: co.dir,
      pathsRev: co.sha,
      tolerate: toleratedOnBase(onBase.failing, gap),
      print: (l) => ctx.log(`  ${l}`),
    });
  } finally {
    co.release();
  }
  const known = report.tolerated;
  const failedSteps = report.steps.filter((s) => !s.ok);
  if (!report.ok) return fail(`toolkit check: ${report.failed ?? "failed"}`, { failed: report.failed, known, steps: failedSteps, secs: report.secs });
  write({ ok: true, known, steps: failedSteps, secs: report.secs });
  const pr = await once(ctx.repo, job.id, `toolkit-pr/${n}`, () =>
    ctx.forge.openToolkitPr({
      key: `${job.id}/toolkit-pr/${n}`,
      title: `Toolkit: add primitive ${gap}`,
      branch: smith.branch,
      head: c.head,
      body: [
        `Kitchen's Toolkit smith added the \`${gap}\` primitive for job \`${job.id}\` ("${job.title}").`,
        "",
        h.SUMMARY ? `**What it does:** ${h.SUMMARY}` : "",
        `**Proven:** \`kitchen toolkit check\` passed on the base plus this branch (${report.steps.length} steps, ${Math.round(report.secs)} s, run sandboxed because it is not merged).`,
        known.length
          ? `**Known on the base:** ${known.map((d) => `\`${d}\``).join(", ")} already fail on the base (${base.slice(0, 12)}) without this branch, so their failure here is not this PR's.`
          : "",
        "",
        "The job's proofs run with this commit until it is merged; merging it moves the job back to the base Toolkit, and its drives and Verify run again.",
      ].join("\n"),
    }),
  );
  await removeSmithWorktree(ctx.repo, job, n).catch(() => {});
  if (retry) await removeSmithWorktree(ctx.repo, job, n - 1).catch(() => {});
  ctx.log(`Toolkit PR ${pr.value ?? "?"} from ${smith.branch} at ${c.head.slice(0, 12)}`);
  return { to: job.returnTo ?? "drives", facts: { toolkit: { checkPassed: true, sha: c.head, pr: pr.value ?? null } } };
};
