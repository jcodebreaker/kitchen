// gate: engine only, no agent. Runs the kitchen.yaml checks on the job HEAD
// (each stamped in the manifest, role engine) and writes rounds/<N>/gate.md
// with the HEAD it ran on. A gate.md for the current HEAD is reused, so a
// resumed gate doesn't run the checks again. Then the risk floor from the diff.
import fs from "node:fs";
import path from "node:path";
import { riskFloor } from "../../checks/risk-floor.ts";
import { runChecks } from "../../checks/run-checks.ts";
import { roundDir, writeAtomic } from "../store.ts";
import { diffStat, headOf } from "../worktree.ts";
import { headers } from "./role.ts";
import type { StageHandler } from "./types.ts";

export const gateFileOf = (jobDir: string, round: number) => path.join(roundDir(jobDir, round), "gate.md");

/** The gate result recorded for this round, if any: { head, result }. */
export function readGate(jobDir: string, round: number): { head: string; result: "PASS" | "FAIL" } | null {
  const f = gateFileOf(jobDir, round);
  if (!fs.existsSync(f)) return null;
  const h = headers(fs.readFileSync(f, "utf8"));
  return h.HEAD && (h.RESULT === "PASS" || h.RESULT === "FAIL") ? { head: h.HEAD, result: h.RESULT } : null;
}

export const gate: StageHandler = async (ctx) => {
  const job = ctx.refresh();
  const head = await headOf(job);
  let g = readGate(ctx.jobDir, job.round);
  if (!g || g.head !== head) {
    const checks = ctx.config.checkList;
    const r = await runChecks({ jobDir: ctx.jobDir, checks, role: "engine", criterion: "gate" });
    const ranOn = r.sha ?? head;
    const lines = [
      `HEAD: ${ranOn}`,
      `RESULT: ${r.ok ? "PASS" : "FAIL"}`,
      "",
      ...(checks.length
        ? r.results.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.name} (exit ${c.exit}, ${c.secs.toFixed(1)}s) {{${c.id}}}: \`${c.cmd}\``)
        : ["- no checks in kitchen.yaml"]),
    ];
    writeAtomic(gateFileOf(ctx.jobDir, job.round), `${lines.join("\n")}\n`);
    g = { head: ranOn, result: r.ok ? "PASS" : "FAIL" };
    ctx.log(`gate ${g.result} on ${ranOn.slice(0, 8)} (${checks.length} checks)`);
  }
  const floor = riskFloor(await diffStat(job), ctx.config);
  return {
    to: g.result === "PASS" ? "drives" : "build",
    facts: { gate: { head: g.head, currentHead: await headOf(job), result: g.result, riskFloor: floor } },
  };
};
