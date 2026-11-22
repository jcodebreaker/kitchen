// build: write tier. The builder edits the worktree, self-checking through the
// bridge (checks, drive, restart_app, toolkit_status) against the app running
// from its worktree; the engine commits what it left, minus anything the layer
// rules refuse (any Toolkit file, kitchen.yaml and other protected paths, the
// repro's regression test), and publishes (local forge in W3a: a branch only).
import fs from "node:fs";
import path from "node:path";
import { builderPolicy } from "../contract.ts";
import { ensureUp } from "../instance.ts";
import { once, roundDir, writeAtomic } from "../store.ts";
import { commitWith, ensureWorktree } from "../worktree.ts";
import { contractBlock, earlierRoundsBlock, toolkitBlock } from "./context.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import { hasToolkit } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

/** Human feedback (`kitchen feedback`) the builder must address, newest last. */
function feedback(jobDir: string): string[] {
  const d = path.join(jobDir, "feedback");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .sort()
    .map((f) => fs.readFileSync(path.join(d, f), "utf8").trim());
}

export const build: StageHandler = async (ctx) => {
  let job = await ensureWorktree(ctx.repo, ctx.refresh());
  if (hasToolkit(job) && job.slot) await ensureUp(job, ctx.jobDir, ctx.log).catch((e) => ctx.log(`app not up for the builder: ${(e as Error).message}`));
  const fb = feedback(ctx.jobDir);
  const repro = job.reproFiles ?? [];
  const r = await runRole(ctx, {
    role: "builder",
    file: "build.md",
    tier: "write",
    prompt: prompt({
      role: "builder",
      job,
      jobDir: ctx.jobDir,
      blocks: [
        contractBlock(ctx.jobDir),
        ...(repro.length ? [{ title: "The repro (committed; you may not edit these)", body: repro.map((f) => `- ${f}`).join("\n") }] : []),
        ...earlierRoundsBlock(ctx.jobDir, job),
        ...(fb.length ? [{ title: "Feedback from a human", body: fb.join("\n\n") }] : []),
        await toolkitBlock(job, job.worktree),
      ],
    }),
    dest: path.join(roundDir(ctx.jobDir, ctx.job.round), "build.md"),
  });
  const h = headers(r.text);
  const status = h.STATUS === "READY" ? "READY" : "BLOCKED";
  job = ctx.refresh();
  const localForge = ctx.forge.kind === "local";
  if (status === "BLOCKED") return { to: "needs-human", facts: { build: { status, committed: false, pushed: false, pr: null, localForge }, why: h.REASON } };
  const c = await commitWith(job, `kitchen(${job.id}): round ${job.round}\n\n${job.title}`, builderPolicy(ctx.config.protected, repro));
  if (c.refused.length) {
    for (const x of c.refused) ctx.log(`kept off the job branch: ${x}`);
    writeAtomic(path.join(roundDir(ctx.jobDir, job.round), "build-refused.md"), `${c.refused.map((x) => `- ${x}`).join("\n")}\n`);
  }
  let pushed = false;
  let pr: number | null = job.pr;
  if (c.ahead) {
    const pub = await once(ctx.repo, job.id, `publish/${c.head}`, () => ctx.forge.publish({ branch: job.branch, title: job.title, head: c.head }));
    pushed = !!pub.value?.pushed;
    pr = pub.value?.pr ?? pr;
  }
  return { to: "gate", facts: { build: { status, committed: c.ahead && c.clean, pushed, pr, localForge } } };
};
