// The drives stage's checks of what a job adds to the Toolkit's feature files
// (PLAN §2 "Toolkit contract", drives → verify):
// - checkChain: each affected criterion's WHOLE proof chain, run twice on the
//   job's running app with `reset` before each run, and every step must run (the
//   expect is not applied: that is Verify's job). A drive is checked where it is
//   used, after the segments before it, so a drive that needs state an earlier
//   segment made (a project, a login) is checked in that state, and a drive that
//   only works once, or only from a dirty session, is caught before any proof
//   depends on it. Stamped through `kitchen drive` (role engine, criterion
//   `drives`, tags phase + chain).
// - checkLineAlone: every `check:` line a job adds is run by itself from seed state
//   (reset, then that one drive with its check args), the way `toolkit check` runs it
//   after the job is merged; a drive that only works after an earlier segment of a
//   proof passes checkChain but fails here.
// - featureFileProblems: a feature file a job wrote must also pass W2's feature
//   rules (src/toolkit/contract.ts parseFeature: one ```kitchen block, every drive
//   with args has a `check:` line, describe lists the file), so the base-change
//   re-proof (`toolkit check`) can drive it once the job is merged.
import type { Criterion } from "../checks/spec-lint.ts";
import { resetUp } from "../engine/instance.ts";
import { runDrive } from "../proof/drive.ts";
import { prove } from "../proof/prove.ts";
import { parseFeature } from "./contract.ts";

export type ChainCheck = { criterion: string; ok: boolean; why?: string; evidence: string[] };

export async function checkChain(o: {
  job: { toolkitBin: string; slotId: string; worktree: string; slot: { n: number; ports: number[] } | null };
  jobDir: string;
  criterion: Pick<Criterion, "id" | "proof">;
  testCmd: string;
  log?: (m: string) => void;
}): Promise<ChainCheck> {
  const evidence: string[] = [];
  for (const pass of [1, 2]) {
    try {
      await resetUp(o.job, o.jobDir);
      const p = await prove({
        jobDir: o.jobDir,
        // Every step runs: the chain's own expect is Verify's, not this check's.
        criterion: { id: o.criterion.id, proof: o.criterion.proof, expect: "ok" },
        role: "engine",
        stampAs: "drives",
        testCmd: o.testCmd,
        tag: { phase: `toolkit-check-${pass}`, chain: o.criterion.id },
        log: o.log,
      });
      evidence.push(...p.evidence);
      if (p.status === "gap") return { criterion: o.criterion.id, ok: false, why: `needs primitive ${p.gap}`, evidence };
      if (p.status !== "pass") return { criterion: o.criterion.id, ok: false, why: `run ${pass}: ${p.why ?? p.status}`, evidence };
    } catch (e) {
      return { criterion: o.criterion.id, ok: false, why: `run ${pass}: ${(e as Error).message}`, evidence };
    }
  }
  return { criterion: o.criterion.id, ok: true, evidence };
}

/** The `check:` lines of a feature file (repo-relative path), or [] when it doesn't parse (featureFileProblems says why). Pure. */
export function checkLinesOf(rel: string, text: string): { file: string; drive: string; args: Record<string, string> }[] {
  try {
    return parseFeature(rel.replace(/^\.kitchen\/toolkit\//, ""), text).checks.map((c) => ({ file: rel, ...c }));
  } catch {
    return [];
  }
}

/** One `check:` line, alone from seed: reset, then the drive with the line's args. Stamped `drives`, phase check-line. */
export async function checkLineAlone(o: {
  job: { toolkitBin: string; slotId: string; worktree: string; slot: { n: number; ports: number[] } | null };
  jobDir: string;
  line: { file: string; drive: string; args: Record<string, string> };
  log?: (m: string) => void;
}): Promise<ChainCheck> {
  const label = `check line ${o.line.drive}`;
  try {
    await resetUp(o.job, o.jobDir);
    const r = await runDrive({
      jobDir: o.jobDir,
      request: { feature: o.line.drive, args: o.line.args },
      criterion: "drives",
      role: "engine",
      tag: { phase: "check-line", drive: o.line.drive },
      log: o.log,
    });
    const evidence = r.steps.flatMap((s) => s.evidence);
    if (r.ok) return { criterion: label, ok: true, evidence };
    const why = r.gap ? `needs primitive ${r.gap}` : `step "${r.failedAt?.step}" failed${r.failedAt?.why ? ` (${r.failedAt.why})` : ""}`;
    return { criterion: label, ok: false, why: `run alone from seed with ${JSON.stringify(o.line.args)}: ${why}`, evidence };
  } catch (e) {
    return { criterion: label, ok: false, why: (e as Error).message, evidence: [] };
  }
}

/**
 * Why a feature file (`.kitchen/toolkit/features/<x>.md`) a job wrote would break the
 * Toolkit's own check, or []. `described`: describe's `features` list, from the worktree. Pure.
 */
export function featureFileProblems(rel: string, text: string, described: readonly string[]): string[] {
  const short = rel.replace(/^\.kitchen\/toolkit\//, "");
  if (short === "features/README.md") return [];
  const out: string[] = [];
  if (!described.includes(short)) out.push(`describe doesn't list ${short}`);
  try {
    const f = parseFeature(short, text);
    for (const d of f.drives)
      if (!f.checks.some((c) => c.drive === d.name))
        out.push(`${short}: drive ${d.name} has no check line (add \`check: { drive: ${d.name}, args: { … } }\` to the file's \`\`\`kitchen block)`);
  } catch (e) {
    out.push((e as Error).message);
  }
  return out;
}
