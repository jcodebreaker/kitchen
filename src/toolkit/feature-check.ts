// `toolkit check --feature <x>` for the drives stage (PLAN §2 "Toolkit contract",
// steps 3–4 for one feature drive): on the job's running app, `reset`, run the
// drive, `reset`, run it again. Both runs go through `kitchen drive` (stamped,
// role engine, criterion `drives`), so a drive that only works once, or only
// from a dirty session, is caught before any proof depends on it.
// W2: the full `kitchen toolkit check` (src/toolkit/check.ts: prepare, up,
// doctor, drives, reset, down, two slots) is being built in Wave 2. Until it is
// merged this is the drives stage's check, calling fixture-agnostic bin/dev
// through the W1 seam (src/toolkit/run.ts). Replace the body with
// `check({ feature, src })` from check.ts once it lands; the signature stays.
import { resetUp } from "../engine/instance.ts";
import { runDrive } from "../proof/drive.ts";
import { DriveFormatError } from "../proof/drive-format.ts";

export type FeatureCheck = { drive: string; ok: boolean; why?: string; evidence: string[] };

export async function checkFeatureDrive(o: {
  job: { toolkitBin: string; slotId: string; worktree: string; slot: { n: number; ports: number[] } | null };
  jobDir: string;
  drive: string;
  args: Record<string, string>;
  log?: (m: string) => void;
}): Promise<FeatureCheck> {
  const evidence: string[] = [];
  for (const pass of [1, 2]) {
    try {
      await resetUp(o.job, o.jobDir);
      const r = await runDrive({
        jobDir: o.jobDir,
        request: { feature: o.drive, args: o.args },
        criterion: "drives",
        role: "engine",
        tag: { phase: `toolkit-check-${pass}` },
        log: o.log,
      });
      evidence.push(...r.steps.flatMap((s) => s.evidence));
      if (r.gap) return { drive: o.drive, ok: false, why: `needs primitive ${r.gap}`, evidence };
      if (!r.ok) return { drive: o.drive, ok: false, why: `run ${pass}: step "${r.failedAt?.step}" failed`, evidence };
    } catch (e) {
      if (e instanceof DriveFormatError) return { drive: o.drive, ok: false, why: e.message, evidence };
      return { drive: o.drive, ok: false, why: `run ${pass}: ${(e as Error).message}`, evidence };
    }
  }
  return { drive: o.drive, ok: true, evidence };
}
