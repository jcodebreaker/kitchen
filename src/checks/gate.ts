// Gate (PLAN §2, gate → drives / build): the kitchen.yaml checks, run by the
// engine in the job worktree with the untrusted env under the proof sandbox
// (run-checks.ts), each stamped in the
// manifest (role engine, criterion gate). The result is pinned to HEAD: it
// counts only if every check ran on that HEAD with a clean tree and HEAD did
// not move while they ran; otherwise it is a FAIL that says why.
import type { CheckSpec } from "../config.ts";
import { type ChecksPrepare, runChecks } from "./run-checks.ts";

export type GateResult = { head: string; result: "PASS" | "FAIL"; lines: string[]; why?: string };

/** Pure: the gate's outcome from the HEADs around the run and each stamped check. */
export function gateOutcome(
  before: string,
  after: string,
  results: { name: string; ok: boolean; exit: number; secs: number; id: string; cmd: string; sha: string; dirty: boolean }[],
): Omit<GateResult, "lines"> & { checks: string[] } {
  const checks = results.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.name} (exit ${c.exit}, ${c.secs.toFixed(1)}s) {{${c.id}}}: \`${c.cmd}\``);
  if (after !== before)
    return { head: after, result: "FAIL", why: `HEAD moved from ${before.slice(0, 8)} to ${after.slice(0, 8)} while the checks ran`, checks };
  const off = results.find((r) => r.sha !== before);
  if (off) return { head: before, result: "FAIL", why: `${off.name} ran on ${off.sha.slice(0, 8)}, not HEAD ${before.slice(0, 8)}`, checks };
  const dirty = results.find((r) => r.dirty);
  if (dirty) return { head: before, result: "FAIL", why: `${dirty.name} ran on a tree that differs from HEAD (uncommitted changes)`, checks };
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  return { head: before, result: failed.length ? "FAIL" : "PASS", ...(failed.length ? { why: `failed: ${failed.join(", ")}` } : {}), checks };
}

export async function runGate(o: {
  jobDir: string;
  checks: CheckSpec[];
  network: boolean;
  headOf: () => Promise<string>;
  prepare?: ChecksPrepare;
}): Promise<GateResult> {
  const before = await o.headOf();
  const r = await runChecks({ jobDir: o.jobDir, checks: o.checks, role: "engine", criterion: "gate", network: o.network, prepare: o.prepare });
  const after = await o.headOf();
  const g = gateOutcome(before, after, r.results);
  const lines = [
    `HEAD: ${g.head}`,
    `RESULT: ${g.result}`,
    ...(g.why ? [`WHY: ${g.why}`] : []),
    "",
    ...(o.checks.length ? g.checks : ["- no checks in kitchen.yaml"]),
    ...(r.results.some((c) => !c.sandboxed) ? ["", "UNSANDBOXED: no OS sandbox on this platform; the checks ran unconfined (ADR 0006)"] : []),
  ];
  return { head: g.head, result: g.result, lines, ...(g.why ? { why: g.why } : {}) };
}
