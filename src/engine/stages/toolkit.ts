// toolkit: the smith adds the missing primitive on its own Toolkit branch, in an
// engine-made worktree (`.worktrees/_smith-<job>-<n>` on `kitchen/toolkit/<job>-<n>`,
// started from the Toolkit the job runs now). Its edits never touch the job branch.
// It gets the setup bridge on that worktree (toolkit, toolkit_check; sandboxed:
// the code is agent-written and unmerged, ADR 0008).
//
// The engine then:
//  1. commits what the smith left under .kitchen/toolkit/ (anything else is put back);
//  2. proves it: `toolkit check` of that commit (base + the smith's branch) from its own
//     engine-owned checkout, sandboxed because it isn't merged, and describe must list
//     the primitive the gap named;
//  3. opens the Toolkit PR through the forge (once per attempt; a human merges it).
// The job goes back to returnTo pinned to that commit (toolkitRef = its real git sha);
// Ready waits for the PR to merge (paused toolkit-pr), then moves toolkitRef to the base.
import fs from "node:fs";
import path from "node:path";
import { setupBridgeServer } from "../../init/bridge.ts";
import { describeToolkit } from "../../proof/drive.ts";
import { runToolkitCheck } from "../../toolkit/check.ts";
import { toolkitCheckout } from "../../toolkit/checkout.ts";
import { once, roundDir, writeAtomic } from "../store.ts";
import { commitWith, ensureSmithWorktree, removeSmithWorktree } from "../worktree.ts";
import { contractBlock, fileBlock } from "./context.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import type { StageHandler } from "./types.ts";

const TOOLKIT = ".kitchen/toolkit/";

/** What the smith may leave for the engine to commit: Toolkit files outside features/. Pure. */
export function smithPolicy(file: string): string | null {
  if (!file.startsWith(TOOLKIT)) return "the smith changes the Toolkit only";
  if (file.startsWith(`${TOOLKIT}features/`)) return "feature drives belong to the job branch (the verifier writes them)";
  return null;
}

export const toolkit: StageHandler = async (ctx) => {
  let job = ctx.refresh();
  const gap = job.gap ?? "?";
  const n = job.smith.attempts; // counted when the job entered this stage
  const from = job.toolkitRef || job.base;
  if (!from) throw new Error("the job has no base to start a Toolkit branch from");
  const smith = await ensureSmithWorktree(ctx.repo, job, n, from);
  const dir = roundDir(ctx.jobDir, job.round);
  fs.mkdirSync(dir, { recursive: true });
  const checkFile = path.join(dir, `toolkit-check-${n}.json`);
  const lastCheck = fs.existsSync(checkFile) ? fs.readFileSync(checkFile, "utf8") : "";
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
        ...(lastCheck ? [{ title: "The engine's check of your last commit FAILED (fix this first)", body: lastCheck }] : []),
      ],
      extra: [`Missing primitive: ${gap}`, `Your worktree (the Toolkit branch ${smith.branch}): ${smith.worktree}`],
    }),
    dest: path.join(dir, `smith-${n}.md`),
  });
  const h = headers(r.text);
  const c = await commitWith(smith, `kitchen(${job.id}): Toolkit primitive ${gap}`, smithPolicy);
  for (const x of c.refused) ctx.log(`kept off the Toolkit branch: ${x}`);
  job = ctx.refresh();
  const fail = (why: string) => {
    ctx.log(`Toolkit check: FAIL (${why})`);
    writeAtomic(checkFile, `${JSON.stringify({ ok: false, sha: c.head, why }, null, 2)}\n`);
    return { to: job.returnTo ?? "drives", facts: { toolkit: { checkPassed: false, sha: c.head, pr: null } }, note: why } as const;
  };
  if (h.STATUS !== "READY") return fail(`smith: ${h.STATUS ?? "no STATUS"}${h.REASON ? `: ${h.REASON}` : ""}`);
  if (!c.ahead) return fail("the smith committed nothing");
  // The proof: the same check jobs rely on, of base + this branch, from its own checkout (sandboxed: not merged).
  const co = await toolkitCheckout(ctx.repo, c.head);
  let report: Awaited<ReturnType<typeof runToolkitCheck>>;
  let listed: string[] = [];
  try {
    listed = (await describeToolkit(co.bin, co.dir)).primitives;
    if (!listed.includes(gap)) {
      co.release();
      return fail(`describe at ${c.head.slice(0, 12)} does not list ${gap}`);
    }
    ctx.log(`toolkit check of ${c.head.slice(0, 12)} (${co.merged ? "merged" : co.sandboxed ? "unmerged: sandboxed" : "unmerged: UNSANDBOXED"})`);
    report = await runToolkitCheck({ repo: ctx.repo, toolkitBin: co.bin, src: co.dir, pathsRev: co.sha, print: (l) => ctx.log(`  ${l}`) });
  } finally {
    co.release();
  }
  writeAtomic(
    checkFile,
    `${JSON.stringify({ ok: report.ok, sha: c.head, failed: report.failed, steps: report.steps.filter((s) => !s.ok), secs: report.secs }, null, 2)}\n`,
  );
  if (!report.ok) return fail(`toolkit check: ${report.failed ?? "failed"}`);
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
        "",
        "The job's proofs run with this commit until it is merged; merging it moves the job back to the base Toolkit, and its drives and Verify run again.",
      ].join("\n"),
    }),
  );
  await removeSmithWorktree(ctx.repo, job, n).catch(() => {});
  ctx.log(`Toolkit PR ${pr.value ?? "?"} from ${smith.branch} at ${c.head.slice(0, 12)}`);
  return { to: job.returnTo ?? "drives", facts: { toolkit: { checkPassed: true, sha: c.head, pr: pr.value ?? null } } };
};
