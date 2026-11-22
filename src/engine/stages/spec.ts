// spec: write tier. The spec role writes the verification contract (it may try
// the app, running from the base, through the bridge); anything it changed in
// the worktree is thrown away. spec-lint (engine, full rules) decides: a
// missing primitive → toolkit, a bug → repro, else build.
import path from "node:path";
import { lintSpec } from "../../checks/spec-lint.ts";
import { nothingPolicy } from "../contract.ts";
import { ensureUp } from "../instance.ts";
import { writeAtomic } from "../store.ts";
import { commitWith, ensureWorktree } from "../worktree.ts";
import { fileBlock, toolkitBlock } from "./context.ts";
import { prompt } from "./prompts.ts";
import { runRole } from "./role.ts";
import { hasToolkit, toolkitView } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

export const spec: StageHandler = async (ctx) => {
  let job = await ensureWorktree(ctx.repo, ctx.refresh());
  if (hasToolkit(job) && job.slot) await ensureUp(job, ctx.jobDir, ctx.log).catch((e) => ctx.log(`app not up for the spec role: ${(e as Error).message}`));
  const r = await runRole(ctx, {
    role: "spec",
    file: "spec.md",
    tier: "write",
    prompt: prompt({
      role: "spec",
      job,
      jobDir: ctx.jobDir,
      blocks: [
        ...fileBlock(ctx.jobDir, "intake.md"),
        ...fileBlock(ctx.jobDir, "spec-refused.md", "Your last spec.md was refused by spec-lint: fix this"),
        await toolkitBlock(job, job.worktree),
      ],
    }),
    dest: path.join(ctx.jobDir, "spec.md"),
  });
  job = ctx.refresh();
  const thrown = await commitWith(job, "unused", nothingPolicy);
  if (thrown.refused.length) ctx.log(`the spec role's worktree edits were thrown away: ${thrown.refused.map((x) => x.split(":")[0]).join(", ")}`);
  const view = hasToolkit(job) ? await toolkitView(job, job.worktree) : { primitives: [], drives: {} };
  const lint = lintSpec(r.text, { kind: job.kind, toolkit: view, protected: ctx.config.protected });
  if (!lint.ok) {
    ctx.log(`spec-lint: ${lint.reason}`);
    writeAtomic(path.join(ctx.jobDir, "spec-refused.md"), `REASON: ${lint.reason}\n\n${r.text}`);
  }
  const to = lint.missingPrimitive ? "toolkit" : job.kind === "bug" ? "repro" : "build";
  return { to, facts: { spec: { ok: lint.ok, reason: lint.reason, missingPrimitive: lint.missingPrimitive } } };
};
