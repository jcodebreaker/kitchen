// intake: read tier, before any worktree. Decides ACCEPT / NEEDS-INFO / REJECT,
// rates kind and risk; a low-risk ticket carries inline criteria, which must
// pass the full spec-lint against the Toolkit as it is on the repo's checkout.
import path from "node:path";
import { lintSpec } from "../../checks/spec-lint.ts";
import type { Kind, Risk } from "../machine.ts";
import { writeAtomic } from "../store.ts";
import { fileBlock, toolkitBlock } from "./context.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import { hasToolkit, toolkitView } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

const DECISIONS = ["ACCEPT", "NEEDS-INFO", "REJECT"] as const;
const pick = <T extends string>(v: string | undefined, of: readonly T[]): T | undefined =>
  of.find((x) => x === v?.trim().toLowerCase() || x === v?.trim().toUpperCase());

export const intake: StageHandler = async (ctx) => {
  const r = await runRole(ctx, {
    role: "intake",
    file: "intake.md",
    tier: "read",
    prompt: prompt({
      role: "intake",
      job: ctx.job,
      jobDir: ctx.jobDir,
      blocks: [await toolkitBlock(ctx.job, ctx.repo), ...fileBlock(ctx.jobDir, "intake-refused.md", "Your last intake.md was refused by spec-lint: fix this")],
    }),
    dest: path.join(ctx.jobDir, "intake.md"),
  });
  const h = headers(r.text);
  const decision = pick(h.DECISION, DECISIONS);
  const kind = pick<Kind>(h.KIND, ["feature", "bug", "chore"]);
  const risk = pick<Risk>(h.RISK, ["low", "medium", "high"]);
  const surfaces = (h.SURFACES ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((s): s is "ui" | "security" => s === "ui" || s === "security");
  if (!decision) return { to: "needs-info", facts: {}, note: `intake.md has no DECISION line (${h.DECISION ?? "missing"})` };
  const view = hasToolkit(ctx.job) ? await toolkitView(ctx.job, ctx.repo) : { primitives: [], drives: {} };
  const criteria = risk === "low" ? lintSpec(r.text, { kind: kind ?? null, toolkit: view, protected: ctx.config.protected }) : undefined;
  if (criteria && !criteria.ok) {
    ctx.log(`inline criteria refused by spec-lint: ${criteria.reason}`);
    writeAtomic(path.join(ctx.jobDir, "intake-refused.md"), `REASON: ${criteria.reason}\n\n${r.text}`);
  }
  if (decision === "NEEDS-INFO") await ctx.source.ask(ctx.job, { key: `ask/m${ctx.job.moves}`, text: h.QUESTION ?? h.REASON ?? r.text });
  const to = decision === "REJECT" ? "rejected" : decision === "NEEDS-INFO" ? "needs-info" : risk !== "low" ? "spec" : kind === "bug" ? "repro" : "build";
  return {
    to,
    facts: { intake: { decision, kind, risk, surfaces, criteria: criteria && { ok: criteria.ok, reason: criteria.reason } }, why: h.QUESTION ?? h.REASON },
  };
};
