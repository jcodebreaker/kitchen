// The kitchen.yaml `checks`, run in the job worktree with the untrusted env under
// the proof sandbox (they run builder-written code: proof/sandbox.ts; outbound
// network only with `checks_network: true`), each one stamped in the manifest
// (proof/stamp-cmd.ts). Gate runs them as the engine; the builder self-checks
// through the bridge's `checks` tool.
import type { CheckSpec } from "../config.ts";
import { type StampedCmd, stampCommand } from "../proof/stamp-cmd.ts";

export type ChecksResult = { ok: boolean; sha: string | null; results: StampedCmd[] };

export async function runChecks(o: { jobDir: string; checks: CheckSpec[]; role: string; criterion: string; network: boolean }): Promise<ChecksResult> {
  const results: StampedCmd[] = [];
  for (const c of o.checks) {
    results.push(
      await stampCommand({
        jobDir: o.jobDir,
        name: c.name,
        cmd: c.run,
        role: o.role,
        criterion: o.criterion,
        timeoutSec: c.timeoutSec,
        sandbox: true,
        network: o.network,
      }),
    );
  }
  const shas = new Set(results.map((r) => r.sha));
  return { ok: results.every((r) => r.ok), sha: shas.size === 1 ? [...shas][0] : null, results };
}
