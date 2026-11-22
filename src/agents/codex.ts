// Codex adapter: `codex exec --json`, JSONL events on stdout (ADR 0006).

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  type AgentAdapter, type AgentRequest, type AgentResult,
  contractFooter, foundOut, lastLine, looksRateLimited, outDirOf, outPathOf,
} from './adapter.js';

/** Codex has no turn flag; these item types count as one turn each and the adapter stops the run past maxTurns. */
const TURN_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

/**
 * The writable root is the process cwd under `workspace-write`. Write tier: the worktree.
 * Read tier: only the out folder, so the agent runs *in* it and reads the repo by absolute path.
 */
export function codexRoot(req: AgentRequest): string {
  return req.tier === 'write' ? req.cwd : outDirOf(req);
}

export function codexArgs(req: AgentRequest): string[] {
  const common = [
    '--json',
    '--model', req.model,
    '--ignore-user-config',            // no user MCP servers, notify hooks or profiles; auth still from CODEX_HOME
    '--ignore-rules',                  // no user execpolicy rules
    '--skip-git-repo-check',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="workspace-write"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', 'model_reasoning_effort="low"',
  ];
  // `exec resume` has no -C/-s: the root comes from the process cwd and sandbox_mode above
  return req.resumeSession
    ? ['exec', 'resume', ...common, req.resumeSession, '-']
    : ['exec', ...common, '-C', codexRoot(req), '-'];
}

export function codexTranscriptPath(sessionId: string, env: Record<string, string>): string | undefined {
  const root = join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'), 'sessions');
  if (!existsSync(root)) return undefined;
  // sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl; newest days first
  const walk = (dir: string, depth: number): string | undefined => {
    const names = readdirSync(dir).sort().reverse();
    for (const n of names) {
      const p = join(dir, n);
      if (depth < 3) {
        if (statSync(p).isDirectory()) { const f = walk(p, depth + 1); if (f) return f; }
      } else if (n.endsWith(`${sessionId}.jsonl`)) return p;
    }
    return undefined;
  };
  return walk(root, 0);
}

type CodexEvent = {
  type: string; thread_id?: string; message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
};

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex' as const;
  /** `rawLog`: append every JSONL event there (debugging; Codex keeps its own transcript too). */
  constructor(private bin = process.env.KITCHEN_CODEX_BIN ?? 'codex', private binArgs: string[] = [], private rawLog?: string) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    mkdirSync(outDirOf(req), { recursive: true });
    rmSync(outPathOf(req), { force: true });
    const p = execa(this.bin, [...this.binArgs, ...codexArgs(req)], {
      cwd: codexRoot(req),
      env: req.env,
      extendEnv: false,
      input: req.prompt + contractFooter(req),
      timeout: req.timeoutSec * 1000,
      forceKillAfterDelay: 5000,
      reject: false,
      lines: true,
    });

    let sessionId = req.resumeSession;
    let message = '';
    let errorMsg: string | undefined;
    let turns = 0;
    let maxTurnsHit = false;
    let inTok = 0, outTok = 0;
    for await (const raw of p) {
      if (this.rawLog) appendFileSync(this.rawLog, `${raw}\n`);
      let e: CodexEvent;
      try { e = JSON.parse(String(raw)) as CodexEvent; } catch { continue; }
      if (e.type === 'thread.started' && e.thread_id) sessionId = e.thread_id;
      else if (e.type === 'item.completed' && e.item?.type === 'agent_message') message = e.item.text ?? message;
      else if (e.type === 'item.started' && TURN_ITEMS.has(e.item?.type ?? '') && ++turns > req.maxTurns) {
        maxTurnsHit = true;
        p.kill('SIGTERM');
      } else if (e.type === 'turn.completed' && e.usage) {
        inTok += e.usage.input_tokens ?? 0;
        outTok += e.usage.output_tokens ?? 0;
      } else if (e.type === 'turn.failed') errorMsg = e.error?.message ?? 'turn failed';
      else if (e.type === 'error') errorMsg = e.message ?? 'error';
    }
    const done = await p;
    const base = {
      sessionId,
      transcriptPath: sessionId ? codexTranscriptPath(sessionId, req.env) : undefined,
      outPath: foundOut(req),
      usage: { inTok, outTok }, // Codex reports tokens, not dollars
    };
    if (done.timedOut) return { ...base, ok: false, line: lastLine(message), timedOut: true, error: `timeout after ${req.timeoutSec}s` };
    if (maxTurnsHit) return { ...base, ok: false, line: lastLine(message), maxTurnsHit, error: `more than ${req.maxTurns} tool calls` };
    if (errorMsg || done.exitCode !== 0) {
      const err = errorMsg ?? (lastLine(String(done.stderr)) || `exit ${done.exitCode}`);
      return { ...base, ok: false, line: lastLine(message), rateLimited: looksRateLimited(err), error: err };
    }
    return { ...base, ok: true, line: lastLine(message) };
  }
}
