// spec: write tier. The spec role writes the verification contract; spec-lint
// (engine) decides: a missing primitive → toolkit, a bug → repro, else build.
import path from "node:path";
import { lintSpec } from "../../checks/spec-lint.ts";
import { prompt } from "./prompts.ts";
import { runRole } from "./role.ts";
import { primitives } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

export const spec: StageHandler = async (ctx) => {
  const r = await runRole(ctx, {
    role: "spec",
    file: "spec.md",
    tier: "write",
    prompt: prompt({ role: "spec", job: ctx.job, jobDir: ctx.jobDir }),
    dest: path.join(ctx.jobDir, "spec.md"),
  });
  const job = ctx.refresh();
  const lint = lintSpec(r.text, { kind: job.kind, primitives: (await primitives(job)).list });
  const to = lint.missingPrimitive ? "toolkit" : job.kind === "bug" ? "repro" : "build";
  return { to, facts: { spec: { ok: lint.ok, reason: lint.reason, missingPrimitive: lint.missingPrimitive } } };
};
