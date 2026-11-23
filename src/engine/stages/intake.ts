// intake: read tier, before any worktree. Decides ACCEPT / NEEDS-INFO / REJECT,
// rates kind and risk; a low-risk ticket carries inline criteria, which must
// pass the full spec-lint against the Toolkit as it is on the repo's checkout.
// A negative those criteria leave to the base (spec-lint rule 3 c) is checked
// here, on the job's worktree at the base: the only time intake needs one.
import path from "node:path";
import { guardCriteria, lintSpec, parseRequirements } from "../../checks/spec-lint.ts";
import { testLayout } from "../../checks/test-layout.ts";
import type { Kind, Risk } from "../machine.ts";
import { unprovableWithoutToolkit } from "../no-toolkit.ts";
import { shortTitle, writeAtomic } from "../store.ts";
import { ensureWorktree } from "../worktree.ts";
import { baseNegativeProblems, guardBaseProblems, runBaseCheck } from "./base-check.ts";
import { fileBlock, testLayoutBlock, toolkitBlock } from "./context.ts";
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
      blocks: [
        await toolkitBlock(ctx.job, ctx.repo),
        ...testLayoutBlock(ctx.repo, ctx.config.test_cmd),
        ...fileBlock(ctx.jobDir, "intake-refused.md", "Your last intake.md was refused: fix this"),
      ],
    }),
    dest: path.join(ctx.jobDir, "intake.md"),
  });
  const h = headers(r.text);
  const decision = pick(h.DECISION, DECISIONS);
  const kind = pick<Kind>(h.KIND, ["feature", "bug", "ui", "chore"]);
  const risk = pick<Risk>(h.RISK, ["low", "medium", "high"]);
  const surfaces = (h.SURFACES ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((s): s is "ui" | "security" => s === "ui" || s === "security");
  if (!decision) return { to: "needs-info", facts: {}, note: `intake.md has no DECISION line (${h.DECISION ?? "missing"})` };
  const noToolkit = !hasToolkit(ctx.job);
  const view = noToolkit ? { primitives: [], drives: {} } : await toolkitView(ctx.job, ctx.repo);
  // The ticket's requirements, which the criteria (inline here, or the spec's) must cover: spec-lint rule 7.
  const requirements = parseRequirements(r.text);
  const criteria =
    risk === "low"
      ? lintSpec(r.text, {
          kind: kind ?? null,
          toolkit: view,
          protected: ctx.config.protected,
          requirements,
          testLayout: testLayout(ctx.repo, ctx.config.test_cmd),
          noToolkit,
        })
      : undefined;
  // No Toolkit (ADR 0010): a criterion that drives the app pauses the job before anything is built, unless the person chose checks only.
  const needsApp = criteria?.needsApp ?? [];
  const unprovable = noToolkit && criteria?.ok && needsApp.length ? unprovableWithoutToolkit(criteria.criteria, kind ?? null) : null;
  const waits = noToolkit && criteria?.ok && decision === "ACCEPT" && needsApp.length > 0 && (!ctx.job.checksOnly || !!unprovable);
  // spec-lint rule 3 (c): a negative no earlier step backs must be false on the base, and a regression guard must
  // hold there. The inline criteria run on the base now (the worktree at the base, a fresh app); build reuses the
  // result for the same criteria.
  const guards = criteria?.ok ? guardCriteria(criteria.criteria, requirements).filter((g) => !needsApp.includes(g)) : [];
  if (criteria?.ok && decision === "ACCEPT" && !waits && (criteria.baseNegatives.length || guards.length)) {
    const job = await ensureWorktree(ctx.repo, ctx.refresh());
    const b = await runBaseCheck(ctx, job, criteria.criteria);
    const why = [...baseNegativeProblems(criteria.baseNegatives, b, guards), ...guardBaseProblems(guards, b)];
    if (why.length) Object.assign(criteria, { ok: false, reason: why.join("\n") });
  }
  const refusal =
    criteria && !criteria.ok
      ? `inline criteria refused by spec-lint: ${criteria.reason}`
      : decision === "ACCEPT" && !requirements.length
        ? "intake.md lists no requirements (`## Requirements`, `- R1: …`)"
        : null;
  if (refusal) {
    ctx.log(refusal);
    writeAtomic(path.join(ctx.jobDir, "intake-refused.md"), `REASON: ${refusal}\n\n${r.text}`);
  }
  if (decision === "NEEDS-INFO") await ctx.source.ask(ctx.job, { key: `ask/m${ctx.job.moves}`, text: h.QUESTION ?? h.REASON ?? r.text });
  if (waits)
    ctx.log(`no Toolkit, and ${needsApp.join(", ")} drive${needsApp.length === 1 ? "s" : ""} the app: waiting for a Toolkit (build it, then approve it)`);
  const to = waits
    ? "paused"
    : decision === "REJECT"
      ? "rejected"
      : decision === "NEEDS-INFO"
        ? "needs-info"
        : risk !== "low"
          ? "spec"
          : kind === "bug"
            ? "repro"
            : "build";
  return {
    to,
    facts: {
      intake: {
        decision,
        kind,
        risk,
        surfaces,
        requirements: requirements.length,
        criteria: criteria && { ok: criteria.ok, reason: criteria.reason },
        ...(shortTitle(h.TITLE) ? { title: shortTitle(h.TITLE) ?? undefined } : {}),
      },
      why: h.QUESTION ?? h.REASON,
      ...(noToolkit ? { noToolkit: { needsApp, highRisk: false, ...(unprovable ? { unprovable } : {}) } } : {}),
    },
  };
};
