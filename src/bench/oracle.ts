// The hidden oracle: criteria in the spec format that no role ever sees, run by
// the engine's own proof runner (proof/prove.ts) on a clean checkout of the job's
// final branch, with the base's Toolkit (main's HEAD, so a merged Toolkit PR is in)
// on a fresh app in its own slot. It decides whether a `done` job did the job.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseCriteria } from "../checks/spec-lint.ts";
import { linkedWorktree, openGit, plainCheckout } from "../engine/git.ts";
import { bringUp, down } from "../engine/instance.ts";
import { createJob } from "../proof/job.ts";
import { prove } from "../proof/prove.ts";
import { toolkitCheckout } from "../toolkit/checkout.ts";
import { acquireSlot, releaseSlot } from "../toolkit/slots.ts";
import type { BenchTicket } from "./set.ts";

export type OracleResult = { pass: boolean; results: { id: string; status: string; why?: string }[]; error?: string };

export async function runOracle(o: {
  kitchenRoot: string;
  repo: string;
  branch: string;
  ticket: BenchTicket;
  testCmd: string;
  log?: (m: string) => void;
}): Promise<OracleResult> {
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
      const p = await prove({ jobDir, criterion: c, role: "oracle", testCmd: o.testCmd, log });
      results.push({ id: c.id, status: p.status, why: p.why ?? p.assert?.why });
      log(`oracle ${c.id}: ${p.status}${p.why ? ` (${p.why})` : ""}`);
    }
    return { pass: results.every((r) => r.status === "pass"), results };
  } catch (e) {
    return { pass: false, results: [], error: (e as Error).message };
  } finally {
    if (slot) await down({ toolkitBin: co.bin, slotId, worktree: wt, slot }, jobDir).catch(() => {});
    await releaseSlot(slotId).catch(() => {});
    co.release();
    await main.run(["worktree", "remove", "--force", "--force", wt]).catch(() => {});
  }
}
