// intake: read tier, before any worktree. Decides ACCEPT / NEEDS-INFO / REJECT,
// rates kind and risk; a low-risk ticket carries inline criteria that must pass spec-lint.
import path from "node:path";
import { lintSpec } from "../../checks/spec-lint.ts";
import type { Kind, Risk } from "../machine.ts";
import { prompt } from "./prompts.ts";
import { headers, runRole } from "./role.ts";
import type { StageHandler } from "./types.ts";

const DECISIONS = ["ACCEPT", "NEEDS-INFO", "REJECT"] as const;
const pick = <T extends string>(v: string | undefined, of: readonly T[]): T | undefined =>
  of.find((x) => x === v?.trim().toLowerCase() || x === v?.trim().toUpperCase());

export const intake: StageHandler = async (ctx) => {
  const r = await runRole(ctx, {
    role: "intake",
    file: "intake.md",
    tier: "read",
    prompt: prompt({ role: "intake", job: ctx.job, jobDir: ctx.jobDir, extra: [`The repository (read only): ${ctx.repo}`] }),
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
  const criteria = risk === "low" ? lintSpec(r.text, { kind: kind ?? null, primitives: [] }) : undefined;
  if (decision === "NEEDS-INFO") await ctx.source.ask(ctx.job, { key: `ask/m${ctx.job.moves}`, text: h.QUESTION ?? h.REASON ?? r.text });
  const to = decision === "REJECT" ? "rejected" : decision === "NEEDS-INFO" ? "needs-info" : risk !== "low" ? "spec" : kind === "bug" ? "repro" : "build";
  return {
    to,
    facts: { intake: { decision, kind, risk, surfaces, criteria: criteria && { ok: criteria.ok, reason: criteria.reason } }, why: h.QUESTION ?? h.REASON },
  };
};
