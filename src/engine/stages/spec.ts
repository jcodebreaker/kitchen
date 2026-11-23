// spec: write tier. The spec role writes the verification contract (it may try
// the app, running from the base, through the bridge); anything it changed in
// the worktree is thrown away. spec-lint (engine, full rules) decides: a
// missing primitive → toolkit, a bug → repro, else build. For a feature, the
// engine then runs every mechanical criterion on the base (base-check.ts): one
// that already passes there is sent back to the spec role once to strengthen;
// if it still passes after that, the job goes on and Verify flags it.
import fs from "node:fs";
import path from "node:path";
import { guardCriteria, lintSpec, parseRequirements, remarkProblems, withSpecMarks } from "../../checks/spec-lint.ts";
import { testLayout } from "../../checks/test-layout.ts";
import { nothingPolicy } from "../contract.ts";
import { ensureUp } from "../instance.ts";
import { effectiveRisk } from "../machine.ts";
import { unprovableWithoutToolkit } from "../no-toolkit.ts";
import { writeAtomic } from "../store.ts";
import { commitWith, ensureWorktree } from "../worktree.ts";
import { baseNegativeProblems, guardBaseProblems, runBaseCheck } from "./base-check.ts";
import { fileBlock, humanFeedback, testLayoutBlock, toolkitBlock } from "./context.ts";
import { prompt } from "./prompts.ts";
import { runRole } from "./role.ts";
import { hasToolkit, toolkitView } from "./toolkit-info.ts";
import type { StageHandler } from "./types.ts";

export const spec: StageHandler = async (ctx) => {
  // A high-risk job never reaches ready without a Toolkit (ADR 0010): it waits for one before any agent runs.
  const noToolkit = !hasToolkit(ctx.refresh());
  if (noToolkit && effectiveRisk(ctx.refresh()) === "high") {
    ctx.log("no Toolkit, and the job is high risk: waiting for kitchen toolkit build");
    return { to: "paused", facts: { noToolkit: { needsApp: [], highRisk: true } } };
  }
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
        ...fileBlock(ctx.jobDir, "spec-refused.md", "Your last spec.md was refused: fix this"),
        // A person sent the job back here (`kitchen feedback --to spec`): their words, and the spec they reacted to.
        ...(humanFeedback(ctx.jobDir).length
          ? [
              { title: "Feedback from a human (address it; it overrides your earlier spec)", body: humanFeedback(ctx.jobDir).join("\n\n") },
              ...fileBlock(ctx.jobDir, "spec.md", "Your earlier spec.md"),
            ]
          : []),
        ...testLayoutBlock(job.worktree, ctx.config.test_cmd),
        await toolkitBlock(job, job.worktree),
      ],
    }),
    dest: path.join(ctx.jobDir, "spec.md"),
  });
  job = ctx.refresh();
  const thrown = await commitWith(job, "unused", nothingPolicy);
  if (thrown.refused.length) ctx.log(`the spec role's worktree edits were thrown away: ${thrown.refused.map((x) => x.split(":")[0]).join(", ")}`);
  const view = noToolkit ? { primitives: [], drives: {} } : await toolkitView(job, job.worktree);
  // Rule 7: the criteria must cover the requirements intake read in the ticket.
  // The spec may re-mark a (negative) one as a boundary in its own ## Requirements (withSpecMarks): it stays a
  // negative whose absence may hold on the base; never on a job with a security surface.
  const intakeFile = path.join(ctx.jobDir, "intake.md");
  const intakeReqs = parseRequirements(fs.existsSync(intakeFile) ? fs.readFileSync(intakeFile, "utf8") : "");
  const security = job.surfaces?.includes("security") ?? false;
  const requirements = withSpecMarks(intakeReqs, r.text, { security });
  const linted = lintSpec(r.text, {
    kind: job.kind,
    toolkit: view,
    protected: ctx.config.protected,
    requirements,
    testLayout: testLayout(job.worktree, ctx.config.test_cmd),
    noToolkit,
  });
  const remarks = remarkProblems(intakeReqs, r.text, { security });
  const lint = remarks.length ? { ...linted, ok: false, reason: [...(linted.reason ? [linted.reason] : []), ...remarks].join("\n") } : linted;
  if (!lint.ok) {
    ctx.log(`spec-lint: ${lint.reason}`);
    writeAtomic(path.join(ctx.jobDir, "spec-refused.md"), `REASON: ${lint.reason}\n\n${r.text}`);
  }
  let { ok, reason } = lint;
  const needsApp = lint.needsApp ?? [];
  // No Toolkit (ADR 0010): a criterion that drives the app pauses the job before anything is built, unless the person chose checks only.
  const unprovable = noToolkit && lint.ok && needsApp.length ? unprovableWithoutToolkit(lint.criteria, job.kind) : null;
  const noToolkitFacts = noToolkit ? { noToolkit: { needsApp, highRisk: false, ...(unprovable ? { unprovable } : {}) } } : {};
  if (noToolkit && lint.ok && needsApp.length && (!job.checksOnly || unprovable)) {
    ctx.log(`no Toolkit, and ${needsApp.join(", ")} drive${needsApp.length === 1 ? "s" : ""} the app: waiting for kitchen toolkit build`);
    return { to: "paused", facts: { spec: { ok, reason }, ...noToolkitFacts } };
  }
  const guards = lint.ok ? guardCriteria(lint.criteria, requirements).filter((g) => !needsApp.includes(g)) : [];
  if (lint.ok && (job.kind !== "bug" || lint.baseNegatives.length || guards.length)) {
    const b = await runBaseCheck(ctx, job, lint.criteria);
    // spec-lint rule 3 (c): a negative no earlier step backs must be false on the base, and a regression guard
    // must hold there. A refusal like the lint's.
    const neg = [...baseNegativeProblems(lint.baseNegatives, b, guards), ...guardBaseProblems(guards, b)];
    if (neg.length) {
      ok = false;
      reason = neg.join("\n");
      ctx.log(`spec: ${reason}`);
      writeAtomic(path.join(ctx.jobDir, "spec-refused.md"), `REASON: ${reason}\n\n${r.text}`);
    }
    // One retry to strengthen (a refusal re-runs the stage once); after that the job goes on, flagged.
    else if (job.kind !== "bug" && b?.passing.length && job.attempts.refused === 0) {
      ok = false;
      reason = `non-discriminating: ${b.passing.join(", ")} already pass on the current code, before any change (evidence ${b.results
        .filter((x) => b.passing.includes(x.criterion))
        .flatMap((x) => x.evidence)
        .join(" ")})`;
      ctx.log(`spec: ${reason}`);
      writeAtomic(
        path.join(ctx.jobDir, "spec-refused.md"),
        [
          `REASON: ${reason}`,
          "",
          "A criterion that already holds before the change can't tell the change from no change. Strengthen each one so it fails on the current code and passes once the ticket is done: create the data it is about in an earlier step of the same proof, read what the change adds, or assert what must be different. A criterion that guards existing behaviour the change must not break covers only intake's `(unchanged)` requirements and is not counted here; any other one that stays will be flagged as non-discriminating.",
          "",
          r.text,
        ].join("\n"),
      );
    }
  }
  const to = lint.missingPrimitive ? "toolkit" : job.kind === "bug" ? "repro" : "build";
  return { to, facts: { spec: { ok, reason, missingPrimitive: lint.missingPrimitive }, ...noToolkitFacts } };
};
