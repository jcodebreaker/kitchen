// The hidden oracle: criteria in the spec format that no role ever sees, run by
// the engine's own proof runner (proof/prove.ts) on a clean checkout of the job's
// final branch, with the base's Toolkit (main's HEAD, so a merged Toolkit PR is in)
// on a fresh app in its own slot. It decides whether a `done` job did the job.
//
// An oracle's proof may name the slot's ports as `{port:<i>}` (the i-th port the
// Toolkit's `up` was given, in the order its `describe` lists). A `cmd` proof reads
// the app's own database that way, over loopback (the proof sandbox allows only
// that), which no primitive of the base Toolkit can and which must not depend on a
// primitive the job's smith wrote (a-primitive).
//
// Infrastructure is not a verdict: an exception (worktree, Toolkit checkout, slot,
// prepare, up) or a step that failed while `doctor` says the app is unwell comes back
// as `infra`, neither pass nor fail, and the bench runs the oracle once more
// (runOracleRetrying).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseCriteria } from "../checks/spec-lint.ts";
import { linkedWorktree, openGit, plainCheckout } from "../engine/git.ts";
import { bringUp, doctorOk, down } from "../engine/instance.ts";
import { createJob } from "../proof/job.ts";
import { prove } from "../proof/prove.ts";
import { toolkitCheckout } from "../toolkit/checkout.ts";
import { acquireSlot, releaseSlot } from "../toolkit/slots.ts";
import type { BenchTicket } from "./set.ts";

export type OracleResult = {
  pass: boolean;
  results: { id: string; status: string; why?: string }[];
  error?: string;
  /** The error is the infrastructure's (startup, an unwell app), not the oracle's: worth one more try. */
  infra?: boolean;
};
export type OracleOpts = {
  kitchenRoot: string;
  repo: string;
  branch: string;
  ticket: BenchTicket;
  testCmd: string;
  log?: (m: string) => void;
};

/** Pure: `{port:<i>}` in a proof line → the slot's i-th port. Throws when there is no such port. */
export function fillPorts(proof: string, ports: number[] | null): string {
  return proof.replace(/\{port:(\d+)\}/g, (_, i: string) => {
    const p = ports?.[Number(i)];
    if (!p) throw new Error(`the oracle names {port:${i}}, but ${ports ? `the slot has ${ports.length} ports` : "no app is up (no toolkit segment)"}`);
    return String(p);
  });
}

/** Pure: run the oracle again? Once, and only after an infrastructure error. */
export const retryOracle = (r: OracleResult, attempt: number): boolean => attempt === 1 && !!r.error && r.infra === true;

/** The oracle, run once more after an infrastructure error. `retried`: why the first try didn't count. */
export async function runOracleRetrying(o: OracleOpts): Promise<OracleResult & { retried?: string }> {
  // Before the slot: the oracle checkout or the Toolkit checkout could not be made.
  const run = () => runOracle(o).catch((e): OracleResult => ({ pass: false, results: [], error: (e as Error).message, infra: true }));
  const first = await run();
  if (!retryOracle(first, 1)) return first;
  o.log?.(`oracle: infrastructure error, retrying once: ${first.error}`);
  return { ...(await run()), retried: first.error };
}

export async function runOracle(o: OracleOpts): Promise<OracleResult> {
  const oracle = o.ticket.oracle;
  if (!oracle) return { pass: true, results: [] };
  const log = o.log ?? (() => {});
  const criteria = parseCriteria(`## Criteria\n${oracle.criteria}`);
  if (!criteria.length) return { pass: false, results: [], error: "the oracle has no criteria (ids are C<n>)" };
  const tag = randomBytes(3).toString("hex");
  const id = `_oracle-${tag}`;
  const wt = path.join(o.repo, ".worktrees", id);
  const main = await openGit(plainCheckout(o.repo));
  await main.run(["worktree", "add", "--quiet", "--detach", wt, o.branch]);
  const co = await toolkitCheckout(o.repo, "HEAD");
  const jobDir = path.join(o.repo, ".kitchen", "bench-oracle", tag);
  const slotId = `o-${tag}`;
  let slot: { n: number; ports: number[] } | null = null;
  try {
    for (const [name, rel] of Object.entries(oracle.files)) fs.copyFileSync(path.join(o.kitchenRoot, "bench", rel), path.join(wt, name));
    fs.mkdirSync(path.dirname(jobDir), { recursive: true });
    createJob(
      jobDir,
      { id: `oracle-${tag}`, worktree: linkedWorktree(o.repo, id, wt).workTree, toolkitBin: co.bin, slotId, round: 1 },
      { mainRepo: o.repo, id },
    );
    if (criteria.some((c) => /(^|;)\s*toolkit /.test(c.proof ?? ""))) {
      const s = (await acquireSlot({ id: slotId, toolkitBin: co.bin, src: wt })).slot;
      slot = { n: s.n, ports: s.ports };
      await bringUp({ toolkitBin: co.bin, slotId, worktree: wt, slot }, jobDir, { fresh: true, log });
    }
    const results: OracleResult["results"] = [];
    for (const c of criteria) {
      let proof: string | null;
      try {
        proof = c.proof && fillPorts(c.proof, slot?.ports ?? null);
      } catch (e) {
        return { pass: false, results, error: (e as Error).message };
      }
      const p = await prove({ jobDir, criterion: { ...c, proof }, role: "oracle", testCmd: o.testCmd, log });
      results.push({ id: c.id, status: p.status, why: p.why ?? p.assert?.why });
      log(`oracle ${c.id}: ${p.status}${p.why ? ` (${p.why})` : ""}`);
      // A step that failed on an unwell app says nothing about the branch (Verify's INCONCLUSIVE).
      if (p.status === "step-failed" && slot && !(await doctorOk({ toolkitBin: co.bin, slotId, worktree: wt, slot }, jobDir)))
        return { pass: false, results, error: `${c.id}: a step failed and doctor says the app is unwell (${p.why ?? "no reason"})`, infra: true };
    }
    return { pass: results.every((r) => r.status === "pass"), results };
  } catch (e) {
    return { pass: false, results: [], error: (e as Error).message, infra: true };
  } finally {
    if (slot) await down({ toolkitBin: co.bin, slotId, worktree: wt, slot }, jobDir).catch(() => {});
    await releaseSlot(slotId).catch(() => {});
    co.release();
    await main.run(["worktree", "remove", "--force", "--force", wt]).catch(() => {});
  }
}
