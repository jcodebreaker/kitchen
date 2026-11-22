// Codex adapter: `codex exec --json`, JSONL events on stdout (ADR 0006).

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { kitchenHome } from "../home.ts";
import { trackGroup } from "../procs.ts";
import {
  type AgentAdapter,
  type AgentRequest,
  type AgentResult,
  type BridgeServer,
  contractFooter,
  foundOut,
  lastLine,
  looksRateLimited,
  outDirOf,
  outPathOf,
} from "./adapter.ts";
import { codexBin } from "./find-bin.ts";

/** Codex has no turn flag; these item types count as one turn each and the adapter stops the run past maxTurns. */
const TURN_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

/**
 * The writable root is the process cwd. Write tier: the worktree.
 * Read tier: only the out folder, so the agent runs *in* it and reads the repo by absolute path.
 */
export function codexRoot(req: AgentRequest): string {
  return req.tier === "write" ? req.cwd : outDirOf(req);
}

/** A TOML basic string (JSON's escapes are valid TOML for the characters we pass). */
const tomlStr = (s: string) => JSON.stringify(s);
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k));
const tomlTable = (o: Record<string, string | Record<string, string>>): string =>
  `{${Object.entries(o)
    .map(([k, v]) => `${tomlKey(k)}=${typeof v === "string" ? tomlStr(v) : tomlTable(v)}`)
    .join(",")}}`;

/**
 * Permission profile "kitchen": read everything except the engine-owned folders
 * (denyRead), write only the workspace root (the cwd), no network. Same
 * writable root as `sandbox_mode="workspace-write"` with /tmp and $TMPDIR
 * excluded, plus the read denial that sandbox_mode can't express.
 */
export function codexProfile(denyRead: string[]): string[] {
  const fsTable: Record<string, string | Record<string, string>> = { ":root": "read" };
  for (const d of denyRead) fsTable[d] = "deny";
  fsTable[":workspace_roots"] = { ".": "write" };
  return [
    "-c",
    'default_permissions="kitchen"',
    "-c",
    `permissions.kitchen.filesystem=${tomlTable(fsTable)}`,
    "-c",
    "permissions.kitchen.network.enabled=false",
  ];
}

/** The bridge as Codex MCP config. Codex passes an MCP server only a few env vars, so the bridge's env is explicit. */
export function codexBridge(b: BridgeServer): string[] {
  return [
    "-c",
    `mcp_servers.kitchen.command=${tomlStr(b.command)}`,
    "-c",
    `mcp_servers.kitchen.args=[${b.args.map(tomlStr).join(",")}]`,
    "-c",
    `mcp_servers.kitchen.env=${tomlTable(b.env)}`,
    // Without this an MCP call needs approval, which approval_policy="never" turns into a refusal (W0 finding).
    "-c",
    'mcp_servers.kitchen.default_tools_approval_mode="approve"',
    "-c",
    "mcp_servers.kitchen.tool_timeout_sec=300",
  ];
}

export function codexArgs(req: AgentRequest): string[] {
  const common = [
    "--json",
    "--model",
    req.model,
    "--ignore-user-config", // no user MCP servers, notify hooks, profiles or project trust; auth still from CODEX_HOME
    "--ignore-rules", // no user execpolicy rules
    "--skip-git-repo-check",
    "-c",
    'approval_policy="never"',
    ...codexProfile(req.denyRead ?? [kitchenHome()]),
    "-c",
    `model_reasoning_effort="${req.effort ?? "low"}"`,
    ...(req.bridge ? codexBridge(req.bridge) : []),
  ];
  // `exec resume` has no -C: the workspace root comes from the process cwd
  return req.resumeSession ? ["exec", "resume", ...common, req.resumeSession, "-"] : ["exec", ...common, "-C", codexRoot(req), "-"];
}

export function codexTranscriptPath(sessionId: string, env: Record<string, string>): string | undefined {
  const root = join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "sessions");
  if (!existsSync(root)) return undefined;
  // sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl; newest days first
  const walk = (dir: string, depth: number): string | undefined => {
    const names = readdirSync(dir).sort().reverse();
    for (const n of names) {
      const p = join(dir, n);
      if (depth < 3) {
        if (statSync(p).isDirectory()) {
          const f = walk(p, depth + 1);
          if (f) return f;
        }
      } else if (n.endsWith(`${sessionId}.jsonl`)) return p;
    }
    return undefined;
  };
  return walk(root, 0);
}

type CodexEvent = {
  type: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
};

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex" as const;
  /** `rawLog`: append every JSONL event there (debugging; Codex keeps its own transcript too). */
  private readonly bin: string;
  private readonly binArgs: string[];
  private readonly rawLog?: string;
  constructor(bin = codexBin(), binArgs: string[] = [], rawLog?: string) {
    this.bin = bin;
    this.binArgs = binArgs;
    this.rawLog = rawLog;
  }

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
      detached: true, // its own process group, recorded for the job (src/procs.ts)
    });
    const untrack = trackGroup(req.procsDir, p.pid, `agent ${req.role}`);
    try {
      return await this.collect(req, p);
    } finally {
      untrack();
    }
  }

  private async collect(req: AgentRequest, p: ReturnType<typeof execa<{ lines: true; reject: false }>>): Promise<AgentResult> {
    let sessionId = req.resumeSession;
    let message = "";
    let errorMsg: string | undefined;
    let turns = 0;
    let maxTurnsHit = false;
    let inTok = 0;
    let outTok = 0;
    if (req.streamFile) mkdirSync(dirname(req.streamFile), { recursive: true });
    for await (const raw of p) {
      if (this.rawLog) appendFileSync(this.rawLog, `${raw}\n`);
      let e: CodexEvent;
      try {
        e = JSON.parse(String(raw)) as CodexEvent;
      } catch {
        continue;
      }
      // `codex exec` takes no input mid-run: steering messages wait for the next role (ADR 0009).
      if (req.streamFile) appendFileSync(req.streamFile, `${JSON.stringify({ _t: new Date().toISOString(), ...e })}\n`);
      if (e.type === "thread.started" && e.thread_id) sessionId = e.thread_id;
      else if (e.type === "item.completed" && e.item?.type === "agent_message") message = e.item.text ?? message;
      else if (e.type === "item.started" && TURN_ITEMS.has(e.item?.type ?? "") && ++turns > req.maxTurns) {
        maxTurnsHit = true;
        p.kill("SIGTERM");
      } else if (e.type === "turn.completed" && e.usage) {
        inTok += e.usage.input_tokens ?? 0;
        outTok += e.usage.output_tokens ?? 0;
      } else if (e.type === "turn.failed") errorMsg = e.error?.message ?? "turn failed";
      else if (e.type === "error") errorMsg = e.message ?? "error";
    }
    const done = await p;
    const base = {
      sessionId,
      transcriptPath: sessionId ? codexTranscriptPath(sessionId, req.env) : undefined,
      outPath: foundOut(req),
      ran: { adapter: this.name, model: req.model },
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
