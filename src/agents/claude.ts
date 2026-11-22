// Claude Code adapter: `claude -p`, one JSON result on stdout (ADR 0006).

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { kitchenHome } from "../home.ts";
import { trackGroup } from "../procs.ts";
import {
  type AgentAdapter,
  type AgentRequest,
  type AgentResult,
  contractFooter,
  foundOut,
  isInside,
  lastLine,
  looksRateLimited,
  outDirOf,
  outPathOf,
} from "./adapter.ts";

/**
 * Sandbox for every Bash call: writes only in the working dirs, no escape hatch,
 * and engine-owned folders unreadable both to Bash (sandbox denyRead) and to the
 * Read/Grep/Glob tools (permission deny rules). `denyWrite` paths (the
 * worktree's `.git`, file or folder) are closed to Bash (sandbox denyWrite) and
 * to Edit/Write (permission deny rules), so an agent can't redirect the worktree
 * to another gitdir.
 */
export function claudeSettings(denyRead: string[], denyWrite: string[] = []) {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead, denyWrite },
    },
    permissions: {
      // Read(...) rules also cover Grep and Glob; Edit(...) rules also cover Write. `//` = absolute path
      deny: [...denyRead.map((d) => `Read(/${d}/**)`), ...denyWrite.flatMap((d) => [`Edit(/${d})`, `Edit(/${d}/**)`])],
    },
  };
}

export function claudeArgs(req: AgentRequest, sessionId: string): string[] {
  const out = outDirOf(req);
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    req.model,
    "--max-turns",
    String(req.maxTurns),
    "--settings",
    JSON.stringify(claudeSettings(req.denyRead ?? [kitchenHome()], [join(req.cwd, ".git")])),
    "--setting-sources",
    "", // no user/project/local settings: only ours
    "--strict-mcp-config", // only the MCP servers given here (none, or the bridge)
    "--disable-slash-commands", // no user skills or commands
    "--permission-prompts",
    "none", // anything that would ask is denied
  ];
  if (req.effort) args.push("--effort", req.effort);
  if (req.resumeSession) args.push("--resume", req.resumeSession);
  else args.push("--session-id", sessionId);

  if (req.tier === "write") {
    // edits inside the worktree auto-accepted; Bash auto-allowed because it is sandboxed
    args.push("--permission-mode", "acceptEdits", "--tools", "Bash,Read,Edit,Write,Glob,Grep");
  } else {
    // read anything; the only write allowed is into the out folder
    args.push(
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Glob,Grep,Write",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      `Edit(/${out}/**)`,
      `Write(/${out}/**)`,
    );
  }
  if (req.bridge) {
    const { command, args: bargs, env } = req.bridge;
    args.push("--mcp-config", JSON.stringify({ mcpServers: { kitchen: { type: "stdio", command, args: bargs, env } } }));
    args.push("--allowedTools", "mcp__kitchen__*");
  }
  if (!isInside(out, req.cwd)) args.push("--add-dir", out);
  return args;
}

export function claudeTranscriptPath(cwd: string, sessionId: string, env: Record<string, string>): string | undefined {
  const base = join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "projects");
  const guess = join(base, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (existsSync(guess)) return guess;
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base)) {
    const p = join(base, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

type ClaudeJson = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude" as const;
  private readonly bin: string;
  constructor(bin = process.env.KITCHEN_CLAUDE_BIN ?? "claude") {
    this.bin = bin;
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    mkdirSync(outDirOf(req), { recursive: true });
    rmSync(outPathOf(req), { force: true }); // a stale file must never pass as this run's
    const sessionId = req.resumeSession ?? randomUUID();
    // Its own process group, recorded for the job: a restart after kill -9 kills it (src/procs.ts).
    const sub = execa(this.bin, claudeArgs(req, sessionId), {
      cwd: req.cwd,
      env: req.env,
      extendEnv: false,
      input: req.prompt + contractFooter(req),
      timeout: req.timeoutSec * 1000,
      forceKillAfterDelay: 5000,
      reject: false,
      detached: true,
    });
    const done = trackGroup(req.procsDir, sub.pid, `agent ${req.role}`);
    let p: Awaited<typeof sub>;
    try {
      p = await sub;
    } finally {
      done();
    }
    const transcriptPath = claudeTranscriptPath(req.cwd, sessionId, req.env);
    const base = { sessionId, transcriptPath, outPath: foundOut(req), ran: { adapter: this.name, model: req.model } };
    if (p.timedOut) return { ...base, ok: false, line: "", timedOut: true, error: `timeout after ${req.timeoutSec}s` };

    let j: ClaudeJson | undefined;
    try {
      j = JSON.parse(String(p.stdout)) as ClaudeJson;
    } catch {
      /* not JSON */
    }
    if (!j) {
      const err = lastLine(String(p.stderr)) || lastLine(String(p.stdout)) || `exit ${p.exitCode}`;
      return { ...base, ok: false, line: "", rateLimited: looksRateLimited(err), error: err };
    }
    const u = j.usage ?? {};
    const usage = {
      usd: j.total_cost_usd,
      inTok: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outTok: u.output_tokens,
    };
    const maxTurnsHit = j.subtype === "error_max_turns";
    const ok = !j.is_error && j.subtype === "success";
    return {
      ...base,
      sessionId: j.session_id ?? sessionId,
      ok,
      line: lastLine(j.result),
      usage,
      maxTurnsHit,
      rateLimited: !ok && looksRateLimited(j.result),
      error: ok ? undefined : (j.subtype ?? "error") + (j.result ? `: ${lastLine(j.result)}` : ""),
    };
  }
}
