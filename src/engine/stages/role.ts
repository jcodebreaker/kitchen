// Running one role for a stage (PLAN §3): the agent writes one file into its
// outbox (.kitchen-out/ in the worktree, or an engine scratch folder for a
// read-tier role), the engine copies it into the job folder and deletes it.
// The run is keyed by the stage entry (job.moves) and the refusals so far, so
// a resumed stage reuses a file the role already wrote, and a refused or
// retried stage runs the role again.
import fs from "node:fs";
import path from "node:path";
import type { AgentRequest, Tier } from "../../agents/adapter.ts";
import { buildAgentEnv } from "../../agents/env.ts";
import { bridgeServer } from "../../bridge/mcp.ts";
import { modelFor } from "../../config.ts";
import { kitchenHome } from "../../home.ts";
import { appendLedger } from "../../ledger/append.ts";
import type { AgentRunRef } from "../machine.ts";
import { scratchOf, updateJob, writeAtomic } from "../store.ts";
import { ensureWorktree } from "../worktree.ts";
import { RoleFailure, type StageContext } from "./types.ts";

const BRIDGE_ROLES = new Set(["builder", "verifier", "smith", "spec", "repro"]);
const AUTH = /not logged in|unauthori[sz]ed|authentication|invalid api key|401|please run .*login/i;

export type RoleRun = { text: string; line: string; reused: boolean; run: AgentRunRef };

/** `KEY: value` header lines of a role file (first occurrence wins). Pure. */
export function headers(text: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9-]*):\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in h)) h[m[1]] = m[2];
  }
  return h;
}

export async function runRole(ctx: StageContext, o: { role: string; file: string; tier: Tier; prompt: string; dest: string }): Promise<RoleRun> {
  let job = ctx.refresh();
  const key = `${job.stage}/m${job.moves}/x${job.attempts.refused}/${o.role}/${o.file}`;
  const done = job.agentRuns.find((r) => r.key === key && r.ok);
  if (done && fs.existsSync(o.dest)) {
    ctx.log(`${o.role}: reusing ${path.relative(ctx.jobDir, o.dest)} from before the restart`);
    const text = fs.readFileSync(o.dest, "utf8");
    return { text, line: done.line, reused: true, run: done };
  }
  if (o.tier === "write") job = await ensureWorktree(ctx.repo, job);
  const cwd = job.worktree || ctx.repo;
  const outDir = o.tier === "read" ? path.join(scratchOf(ctx.repo, job.id), `${o.role}-m${job.moves}`) : undefined;
  const model = modelFor(ctx.config, o.role);
  const req: AgentRequest = {
    role: o.role,
    prompt: o.prompt,
    cwd,
    model,
    tier: o.tier,
    timeoutSec: ctx.config.agent.timeout_sec,
    maxTurns: ctx.config.agent.max_turns,
    outFile: o.file,
    outDir,
    env: buildAgentEnv(path.join(kitchenHome(), "agent-scrub")),
    ...(o.tier === "write" && BRIDGE_ROLES.has(o.role) ? { bridge: bridgeServer({ repo: ctx.repo, job: job.id, role: o.role }) } : {}),
  };
  const t0 = Date.now();
  ctx.log(`${o.role}: ${ctx.agent.name} ${model} (${o.tier}) → ${o.file}`);
  const r = await ctx.agent.run(req);
  const secs = (Date.now() - t0) / 1000;
  const run: AgentRunRef = {
    key,
    role: o.role,
    stage: job.stage,
    round: job.round,
    adapter: ctx.agent.name,
    model,
    sessionId: r.sessionId,
    ok: r.ok && !!r.outPath,
    line: r.line,
    usd: r.usage?.usd,
    secs,
    at: ctx.now().toISOString(),
  };
  appendLedger(ctx.repo, {
    job: job.id,
    stage: job.stage,
    round: job.round,
    event: "agent",
    key: `${job.id}/${key}/${run.ok ? "ok" : `fail-${t0}`}`,
    result: run.ok ? "ok" : r.rateLimited ? "rate-limited" : "error",
    role: o.role,
    agent: ctx.agent.name,
    model,
    secs,
    usd: r.usage?.usd,
    detail: { line: r.line, sessionId: r.sessionId, error: r.error, inTok: r.usage?.inTok, outTok: r.usage?.outTok },
  });
  if (!r.ok || !r.outPath) {
    const why = r.error ?? (r.outPath ? r.line : `no ${o.file} written`);
    throw new RoleFailure(`${o.role}: ${why}`, { rateLimited: r.rateLimited, authFailure: !r.rateLimited && AUTH.test(why) });
  }
  const text = fs.readFileSync(r.outPath, "utf8");
  writeAtomic(o.dest, text);
  fs.rmSync(r.outPath, { force: true });
  run.file = path.relative(ctx.jobDir, o.dest);
  await updateJob(ctx.repo, job.id, (j) => {
    j.agentRuns.push(run);
    return j;
  });
  return { text, line: r.line, reused: false, run };
}
