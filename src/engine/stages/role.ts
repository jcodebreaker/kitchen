// Running one role for a stage (PLAN §3): the agent writes one file into its
// outbox (.kitchen-out/ in the worktree, or an engine scratch folder for a
// read-tier role), the engine copies it into the job folder and deletes it.
// The run is keyed by the stage entry (job.moves) and the refusals so far, so
// a resumed stage reuses a file the role already wrote, and a refused or
// retried stage runs the role again.
import fs from "node:fs";
import path from "node:path";
import type { AgentRequest, BridgeServer, Tier } from "../../agents/adapter.ts";
import { buildAgentEnv } from "../../agents/env.ts";
import { bridgeServer } from "../../bridge/mcp.ts";
import { gapName } from "../../checks/verdict.ts";
import { modelFor } from "../../config.ts";
import { kitchenHome } from "../../home.ts";
import { appendLedger } from "../../ledger/append.ts";
import { procsDirOf, reapGroups } from "../../procs.ts";
import type { AgentRunRef } from "../machine.ts";
import { markRead, operatorNotes, steerLine, unread, unreadSteers } from "../messages.ts";
import { scratchOf, updateJob, writeAtomic } from "../store.ts";
import { ensureWorktree } from "../worktree.ts";
import { LockLost, RoleFailure, type StageContext } from "./types.ts";

const BRIDGE_ROLES = new Set(["builder", "verifier", "smith", "spec", "repro"]);
const AUTH = /not logged in|unauthori[sz]ed|authentication|invalid api key|401|please run .*login/i;

export type RoleRun = { text: string; line: string; reused: boolean; run: AgentRunRef };

/**
 * The missing primitive a `GAP:` header names, or undefined (verdict.ts gapName): `none`,
 * free text ("the `read` primitive fails…") and a primitive describe already lists name
 * no gap. Pure.
 */
export const named = (v: string | undefined, known: readonly string[] = []) => gapName(v, known);

/** `KEY: value` header lines of a role file (first occurrence wins). Pure. */
export function headers(text: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9-]*):\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in h)) h[m[1]] = m[2];
  }
  return h;
}

export async function runRole(
  ctx: StageContext,
  o: {
    role: string;
    file: string;
    tier: Tier;
    prompt: string;
    dest: string;
    /** Another engine-made worktree to run in (the smith's Toolkit branch). Default: the job's. */
    cwd?: string;
    /** Another bridge (the smith gets the setup bridge on its own worktree). */
    bridge?: BridgeServer;
  },
): Promise<RoleRun> {
  let job = ctx.refresh();
  const key = `${job.stage}/m${job.moves}/x${job.attempts.refused}/${o.role}/${o.file}`;
  const done = job.agentRuns.find((r) => r.key === key && r.ok);
  if (done && fs.existsSync(o.dest)) {
    ctx.log(`${o.role}: reusing ${path.relative(ctx.jobDir, o.dest)} from before the restart`);
    const text = fs.readFileSync(o.dest, "utf8");
    return { text, line: done.line, reused: true, run: done };
  }
  if (o.tier === "write" && !o.cwd) job = await ensureWorktree(ctx.repo, job);
  const cwd = o.cwd ?? (job.worktree || ctx.repo);
  const outDir = o.tier === "read" ? path.join(scratchOf(ctx.repo, job.id), `${o.role}-m${job.moves}`) : undefined;
  const model = modelFor(ctx.config, o.role);
  const t0 = Date.now();
  // Steers sent before this role started (a paused job, an engine-only step, a Codex role) open its prompt.
  // Every steer this run reads is put back to `sent` if the run doesn't produce its file (failed, stopped,
  // timed out, rate limited) or the lock is lost first: job roles never resume a session, so the next
  // role must read them again.
  const notes = unreadSteers(ctx.jobDir);
  const delivered = notes.map((m) => m.id);
  const marking: Promise<void>[] = [];
  await markRead(ctx.jobDir, delivered, o.role, "next-role");
  const stream = path.join("activity", `m${job.moves}-${o.role}-${t0}.jsonl`);
  const req: AgentRequest = {
    role: o.role,
    prompt: operatorNotes(notes) + o.prompt,
    cwd,
    model,
    tier: o.tier,
    timeoutSec: ctx.config.agent.timeout_sec,
    maxTurns: ctx.config.agent.max_turns,
    outFile: o.file,
    outDir,
    env: buildAgentEnv(path.join(kitchenHome(), "agent-scrub")),
    procsDir: procsDirOf(ctx.jobDir),
    streamFile: path.join(ctx.jobDir, stream),
    steer: {
      take: () => unreadSteers(ctx.jobDir).map((m) => ({ id: m.id, text: steerLine(m.text) })),
      read: (ids) => {
        delivered.push(...ids);
        marking.push(markRead(ctx.jobDir, ids, o.role, "mid-run").catch((e) => ctx.log(`messages: ${(e as Error).message}`)));
      },
    },
    ...(o.bridge
      ? { bridge: o.bridge }
      : o.tier === "write" && BRIDGE_ROLES.has(o.role)
        ? { bridge: bridgeServer({ repo: ctx.repo, job: job.id, role: o.role }) }
        : {}),
  };
  // Marks made while it ran land before anything else reads the thread.
  const giveBack = async () => {
    await Promise.all(marking);
    await unread(ctx.jobDir, delivered, o.role);
  };
  if (!ctx.holdsLock()) {
    await giveBack();
    throw new LockLost(`run lock lost before ${o.role} started`);
  }
  ctx.log(`${o.role}: ${ctx.agent.name} ${model} (${o.tier}) → ${o.file}`);
  let r: Awaited<ReturnType<typeof ctx.agent.run>>;
  try {
    r = await ctx.agent.run(req);
  } catch (e) {
    await giveBack();
    throw e;
  }
  await Promise.all(marking);
  if (!r.ok || !r.outPath) await unread(ctx.jobDir, delivered, o.role);
  const secs = (Date.now() - t0) / 1000;
  // A wrapper (a scripted adapter passing a real run through) reports what really ran.
  const ran = r.ran ?? { adapter: ctx.agent.name, model };
  // A bridge killed with its agent's group (SIGKILL: no exit handler) leaves the checks
  // and Toolkit calls it started running; they must not outlive the stage (src/procs.ts).
  for (const g of await reapGroups(procsDirOf(ctx.jobDir), { deadOwners: true })) {
    ctx.log(`killed ${g.what} left running by pid ${g.by} (process group ${g.pgid})`);
    appendLedger(ctx.repo, {
      job: job.id,
      stage: job.stage,
      round: job.round,
      event: "orphan-killed",
      key: `${job.id}/orphan/${g.pgid}/${g.at}`,
      detail: { ...g },
    });
  }
  const run: AgentRunRef = {
    key,
    role: o.role,
    stage: job.stage,
    round: job.round,
    adapter: ran.adapter,
    model: ran.model,
    sessionId: r.sessionId,
    stream: fs.existsSync(req.streamFile ?? "") ? stream : undefined,
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
    agent: ran.adapter,
    model: ran.model,
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
  // Kept for whoever holds the lock now (it reuses the file); this runner does nothing more with it.
  if (!ctx.holdsLock()) throw new LockLost(`run lock lost while ${o.role} ran`);
  return { text, line: r.line, reused: false, run };
}
