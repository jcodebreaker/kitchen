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
import { type ChecksPrepare, ensureChecksPrepared } from "../checks/run-checks.ts";
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
  /** step-failed at a `wait` (its text never showed up) after every earlier step ran: the expected state is absent. */
  waitTimedOut?: boolean;
  /** The text that timed-out wait polled for (after `$var` substitution). */
  waitText?: string;
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
  /** Run against this checkout instead of the job worktree (the base check after drives). The manifest and job.json stay the job's. */
  source?: { worktree: string; gitDir: string };
  /** Stamp the entries for this criterion name instead of the criterion's id (the drives check stamps `drives`). */
  stampAs?: string;
  /** kitchen.yaml `checks_prepare`: readies the worktree (or `source`) before a cmd or test proof, cached (run-checks.ts). */
  checksPrepare?: ChecksPrepare;
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
  let clauses = judged ? [] : parseExpect(c.expect?.trim() ? c.expect : segs[0].kind === "toolkit" ? "ok" : "exit 0");
  // A cmd or test proof that crashed proves nothing: its expect holds only with exit 0, unless the expect is about the exit code.
  if (segs[0].kind !== "toolkit" && !judged && !clauses.some((x) => x.kind === "exit")) clauses = [...parseExpect("exit 0"), ...clauses];
  const common = { jobDir: o.jobDir, criterion: o.stampAs ?? c.id, role: o.role, tag: o.tag, source: o.source };
  let lastExit: number | null = null;
  // A command step's output is {exit, stdout, stderr} (the cli primitive): `json`, `rows` and `--save` read its
  // stdout, `contains` what the terminal shows (stdout and stderr), `exit` its exit code. An http step's output
  // is {status, body}: `json`, `rows` and `--save` read its body (a key the body lacks still reads the
  // response: `json .status`), `contains` the whole response; a failed status proves no absence.
  const setOutput = (out: unknown) => {
    const cmd = commandOut(out);
    const resp = cmd ? null : responseOut(out);
    outcome.output = cmd ? cmd.stdout : resp ? text(resp.body) : text(out);
    outcome.shown = cmd ? [cmd.stdout, cmd.stderr].filter((x) => x.trim()).join("\n") : resp ? resp.full : undefined;
    outcome.response = resp ? { status: resp.status, full: resp.full } : undefined;
  };
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
        setOutput(r.steps.at(-1)?.out);
        for (const st of r.steps) if (exitOf(st.out) !== null) lastExit = exitOf(st.out);
        if (r.gap) return res("gap", { gap: r.gap, why: `the Toolkit has no primitive ${r.gap}` });
        if (!r.ok) {
          setOutput(r.failedAt?.out);
          const waitTimedOut = r.failedAt?.wait !== undefined && !r.failedAt.why;
          return res("step-failed", {
            why: `${s.name}: step "${r.failedAt?.step}" failed${r.failedAt?.why ? ` (${r.failedAt.why})` : ""}`,
            waitTimedOut,
            ...(waitTimedOut ? { waitText: r.failedAt?.wait } : {}),
          });
        }
        // `--save <var>` on a primitive segment: its output, as a drive's `save:` keeps it (an http step's body;
        // its status as `$<var>_status`).
        if (s.save) {
          outcome.vars[s.save] = outcome.output;
          if (outcome.response) {
            outcome.vars[`${s.save}_status`] = String(outcome.response.status);
            outcome.responses = { ...outcome.responses, [s.save]: outcome.response };
          }
        }
      }
      outcome.ok = true;
      // A command step (the cli primitive) is ok whatever its exit code: the last one's exit is the proof's,
      // and, as for a cmd proof, an expect that says nothing about `exit` also requires exit 0.
      outcome.exit = lastExit ?? 0;
      if (lastExit !== null && !judged && !clauses.some((x) => x.kind === "exit")) clauses = [...parseExpect("exit 0"), ...clauses];
      if (needsPage(clauses)) {
        const r = await runDrive({ ...common, request: { primitive: "read", args: { target: "body" } }, log: o.log });
        evidence.push(...r.steps.flatMap((x) => x.evidence));
        if (!r.ok) return res("step-failed", { why: "reading the page body failed" });
        outcome.pageText = text(r.steps.at(-1)?.out);
      }
    } else {
      const s = segs[0];
      const cmd = s.kind === "cmd" ? s.cmd : o.testCmd.replaceAll("{file}", shq(s.kind === "test" ? s.file : ""));
      // spec-lint's denylist (outside paths, $HOME, env dumps, network tools) is the first line; the proof sandbox
      // (no network, $HOME and $KITCHEN_HOME unreadable, writes only in the worktree) is the boundary. Untrusted env.
      if (o.checksPrepare) {
        const p = await ensureChecksPrepared({ jobDir: o.jobDir, prepare: o.checksPrepare, role: o.role, criterion: common.criterion, source: o.source });
        if (p) evidence.push(p.id);
        if (p && !p.ok) return res("step-failed", { why: `checks_prepare failed (exit ${p.exit}): ${p.tail.slice(-300)}` });
      }
      const r = await stampCommand({ ...common, name: `${c.id} ${s.kind}`, cmd, timeoutSec: o.timeoutSec ?? 600, sandbox: true });
      if (!r.sandboxed) o.log?.(`${c.id} ${s.kind} proof ran UNSANDBOXED (no sandbox-exec on this platform)`);
      evidence.push(r.id);
      outcome.exit = r.exit;
      outcome.ok = r.exit === 0;
      // As for a cli step: `json`/`rows` read stdout, `contains` what the terminal shows (stdout and stderr).
      const read = (f: string) => {
        const file = path.join(evidenceDir(o.jobDir), r.id, f);
        return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      };
      const stdout = read("stdout.txt");
      outcome.output = stdout ?? r.tail;
      if (stdout !== null) outcome.shown = [stdout, read("stderr.txt") ?? ""].filter((x) => x.trim()).join("\n");
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

/** A command step's output (`{exit, stdout, stderr}`, the cli primitive), or null. */
export function commandOut(out: unknown): { exit: number; stdout: string; stderr: string } | null {
  const exit = exitOf(out);
  if (exit === null) return null;
  const o = out as { stdout?: unknown; stderr?: unknown };
  if (typeof o.stdout !== "string" && typeof o.stderr !== "string") return null;
  return { exit, stdout: typeof o.stdout === "string" ? o.stdout : "", stderr: typeof o.stderr === "string" ? o.stderr : "" };
}

/** An http step's output (`{status, body}`, as an object or its JSON text), or null. */
export function responseOut(out: unknown): { status: number; body: unknown; full: string } | null {
  let o = out;
  if (typeof o === "string" && o.startsWith("{")) {
    try {
      o = JSON.parse(o);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const status = r.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599 || !("body" in r)) return null;
  if (!Object.keys(r).every((k) => k === "status" || k === "body" || k === "headers")) return null;
  return { status, body: r.body, full: typeof out === "string" ? out : JSON.stringify(out) };
}

/** The exit code a command step reported (`{exit, stdout, stderr}`, the cli primitive), or null. */
export function exitOf(out: unknown): number | null {
  if (!out || typeof out !== "object" || Array.isArray(out)) return null;
  const e = (out as { exit?: unknown }).exit;
  return typeof e === "number" && Number.isInteger(e) ? e : null;
}

function pick(o: Record<string, string> | undefined, keys: string[]): Record<string, string> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
}
