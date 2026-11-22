// `kitchen drive <job> <C>`: run one spec criterion's proof and apply its
// mechanical `expect:` (PLAN §2 "Proofs"). The only way a criterion is proven:
// toolkit segments go through runDrive (one stamped entry per step), cmd and
// test proofs through stampCommand (untrusted env, stamped), all under the
// per-job drive lock, stamped with this criterion and the caller's role. Then
// assert.ts decides; the drive's saved vars are visible to the expect.
//
// What it does not decide: whether a failed step means the feature is broken or
// the Toolkit is (the caller asks `doctor`), and judged criteria (the verifier).
import fs from "node:fs";
import path from "node:path";
import type { Criterion } from "../checks/spec-lint.ts";
import { type AssertResult, evaluate, isJudged, needsPage, type Outcome, parseExpect } from "./assert.ts";
import { runDrive } from "./drive.ts";
import { DriveFormatError, substitute, type Value } from "./drive-format.ts";
import { evidenceDir } from "./job.ts";
import { ManifestTampered } from "./manifest.ts";
import { parseProof, type Segment } from "./proof-line.ts";
import { stampCommand } from "./stamp-cmd.ts";

export type ProveStatus = "pass" | "assert-fail" | "step-failed" | "gap" | "error";
export type ProveResult = {
  criterion: string;
  judged: boolean;
  /** pass: ran and the expect holds (judged: ran, the agent decides). assert-fail: ran, the expect does not hold.
   *  step-failed: a step or command failed before the expect could be applied. gap: a primitive is missing. error: the proof could not run. */
  status: ProveStatus;
  why?: string;
  gap?: string;
  outcome: Outcome;
  assert?: AssertResult;
  evidence: string[];
  /** The args each feature drive ran with (after --args), for the args-delta log. */
  driveArgs: { drive: string; spec: Record<string, string>; used: Record<string, string> }[];
};

export type ProveOpts = {
  jobDir: string;
  criterion: Pick<Criterion, "id" | "proof" | "expect">;
  role: string;
  /** kitchen.yaml test_cmd, with {file}. */
  testCmd: string;
  timeoutSec?: number;
  /** `--args`: concrete values for feature drive args, over the spec's. */
  argsOverride?: Record<string, string>;
  tag?: Record<string, string>;
  log?: (m: string) => void;
};

const shq = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const text = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

export async function prove(o: ProveOpts): Promise<ProveResult> {
  const c = o.criterion;
  const judged = isJudged(c.expect);
  const evidence: string[] = [];
  const driveArgs: ProveResult["driveArgs"] = [];
  const outcome: Outcome = { ok: false, exit: 1, output: "", vars: {} };
  const res = (status: ProveStatus, extra: Partial<ProveResult> = {}): ProveResult => ({
    criterion: c.id,
    judged,
    status,
    outcome,
    evidence,
    driveArgs,
    ...extra,
  });
  let segs: Segment[];
  try {
    if (!c.proof) return res("error", { why: `${c.id} has no proof` });
    segs = parseProof(c.proof);
  } catch (e) {
    return res("error", { why: (e as Error).message });
  }
  const clauses = judged ? [] : parseExpect(c.expect?.trim() ? c.expect : segs[0].kind === "toolkit" ? "ok" : "exit 0");
  const common = { jobDir: o.jobDir, criterion: c.id, role: o.role, tag: o.tag };
  try {
    if (segs[0].kind === "toolkit") {
      for (const s of segs) {
        if (s.kind !== "toolkit") return res("error", { why: "toolkit segments only" });
        const args = substitute(s.args as Record<string, Value>, outcome.vars) as Record<string, string>;
        const used = s.drive ? { ...args, ...pick(o.argsOverride, Object.keys(args)) } : args;
        if (s.drive) driveArgs.push({ drive: s.name, spec: s.args, used });
        const r = await runDrive({ ...common, request: s.drive ? { feature: s.name, args: used } : { primitive: s.name, args: used }, log: o.log });
        evidence.push(...r.steps.flatMap((x) => x.evidence));
        Object.assign(outcome.vars, r.vars);
        outcome.output = text(r.steps.at(-1)?.out);
        if (r.gap) return res("gap", { gap: r.gap, why: `the Toolkit has no primitive ${r.gap}` });
        if (!r.ok) {
          outcome.output = text(r.failedAt?.out);
          return res("step-failed", { why: `${s.name}: step "${r.failedAt?.step}" failed${r.failedAt?.why ? ` (${r.failedAt.why})` : ""}` });
        }
      }
      outcome.ok = true;
      outcome.exit = 0;
      if (needsPage(clauses)) {
        const r = await runDrive({ ...common, request: { primitive: "read", args: { target: "body" } }, log: o.log });
        evidence.push(...r.steps.flatMap((x) => x.evidence));
        if (!r.ok) return res("step-failed", { why: "reading the page body failed" });
        outcome.pageText = text(r.steps.at(-1)?.out);
      }
    } else {
      const s = segs[0];
      const cmd = s.kind === "cmd" ? s.cmd : o.testCmd.replaceAll("{file}", shq(s.kind === "test" ? s.file : ""));
      const r = await stampCommand({ ...common, name: `${c.id} ${s.kind}`, cmd, timeoutSec: o.timeoutSec ?? 600 });
      evidence.push(r.id);
      outcome.exit = r.exit;
      outcome.ok = r.exit === 0;
      const out = path.join(evidenceDir(o.jobDir), r.id, "stdout.txt");
      outcome.output = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : r.tail;
      if (r.timedOut) return res("step-failed", { why: `timed out after ${o.timeoutSec ?? 600}s` });
    }
  } catch (e) {
    if (e instanceof DriveFormatError || e instanceof ManifestTampered) return res("error", { why: e.message });
    throw e;
  }
  if (judged) return res("pass");
  const a = evaluate(clauses, outcome);
  return res(a.pass ? "pass" : "assert-fail", { assert: a, ...(a.why ? { why: a.why } : {}) });
}

function pick(o: Record<string, string> | undefined, keys: string[]): Record<string, string> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
}
