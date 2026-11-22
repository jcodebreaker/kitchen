// Claude Code adapter: `claude -p` in stream-json both ways (ADR 0006, ADR 0009).
//
// The prompt goes in as the first user message on stdin. While the agent runs, steering messages
// (req.steer) are written as further user messages: Claude Code takes one after the tool call it is
// in, inside the same turn (spikes/w6-steer). The session waits for input while stdin is open, so
// stdin closes once a `result` arrives and every message written has been answered (an assistant
// event after it); one never answered goes back to the queue for the next role. The last `result`
// event is the object `--output-format json` printed: cost, turns, session, error text.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import { claudeBin } from "./find-bin.ts";

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
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose", // stream-json output needs it with -p
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

export type ClaudeJson = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

/** One user message on stream-json stdin. */
export const userLine = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;

/** How long stdin stays open after a `result` for a written message that has not been answered yet. */
export const ANSWER_GRACE_MS = 5000;

/**
 * The stdout side of one run, line by line: the last `result`, which written messages the agent
 * answered, and when stdin may close. No I/O: the adapter feeds it lines and the clock.
 */
export class ClaudeStream {
  /** The last `result` event; null again once a later turn starts. */
  result: ClaudeJson | null = null;
  /** The last `result` ever seen, kept when a later turn never finishes. */
  final: ClaudeJson | null = null;
  readonly written = new Set<string>();
  private unanswered: string[] = [];
  private resultAt = 0;
  /** The last stdout line that was not JSON, for an error message. */
  junk = "";

  /** Returns the ids the agent answered with this line (an assistant event after they were written). */
  line(text: string, now: number): string[] {
    let e: ClaudeJson;
    try {
      e = JSON.parse(text) as ClaudeJson;
    } catch {
      if (text.trim()) this.junk = text.trim();
      return [];
    }
    if (e.type === "result") {
      this.result = this.final = e;
      this.resultAt = now;
      return [];
    }
    if (e.type !== "assistant") return [];
    this.result = null; // a turn is running (one a late message started)
    const read = this.unanswered;
    this.unanswered = [];
    return read;
  }

  wrote(id: string) {
    this.written.add(id);
    this.unanswered.push(id);
  }

  /** stdin may close: a result is in and nothing written waits for an answer (or the wait is over). */
  canClose(now: number): boolean {
    return !!this.result && (!this.unanswered.length || now - this.resultAt > ANSWER_GRACE_MS);
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude" as const;
  private readonly bin: string;
  constructor(bin = claudeBin()) {
    this.bin = bin;
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    mkdirSync(outDirOf(req), { recursive: true });
    rmSync(outPathOf(req), { force: true }); // a stale file must never pass as this run's
    if (req.streamFile) mkdirSync(dirname(req.streamFile), { recursive: true });
    const sessionId = req.resumeSession ?? randomUUID();
    // Its own process group, recorded for the job: a restart after kill -9 kills it (src/procs.ts).
    const sub = execa(this.bin, claudeArgs(req, sessionId), {
      cwd: req.cwd,
      env: req.env,
      extendEnv: false,
      stdin: "pipe",
      timeout: req.timeoutSec * 1000,
      forceKillAfterDelay: 5000,
      reject: false,
      detached: true,
    });
    const done = trackGroup(req.procsDir, sub.pid, `agent ${req.role}`);
    const s = new ClaudeStream();
    let open = true;
    const close = () => {
      if (!open) return;
      open = false;
      sub.stdin?.end();
    };
    sub.stdin?.on("error", () => {}); // the agent exited first: nothing more to write
    sub.stdin?.write(userLine(req.prompt + contractFooter(req)));
    let buf = "";
    sub.stdout?.on("data", (d: Buffer | string) => {
      buf += String(d);
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const text = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!text.trim()) continue;
        if (req.streamFile)
          try {
            appendFileSync(req.streamFile, `${JSON.stringify({ _t: new Date().toISOString(), ...(JSON.parse(text) as object) })}\n`);
          } catch {
            /* not JSON, or the folder went away: the run goes on */
          }
        const read = s.line(text, Date.now());
        if (read.length) req.steer?.read(read);
      }
    });
    const tick = setInterval(() => {
      if (!open) return;
      if (!s.result)
        for (const m of req.steer?.take() ?? []) {
          if (s.written.has(m.id)) continue;
          sub.stdin?.write(userLine(m.text));
          s.wrote(m.id);
        }
      if (s.canClose(Date.now())) close();
    }, 250);
    let p: Awaited<typeof sub>;
    try {
      p = await sub;
    } finally {
      clearInterval(tick);
      open = false;
      done();
    }
    const transcriptPath = claudeTranscriptPath(req.cwd, sessionId, req.env);
    const base = { sessionId, transcriptPath, outPath: foundOut(req), ran: { adapter: this.name, model: req.model } };
    if (p.timedOut) return { ...base, ok: false, line: "", timedOut: true, error: `timeout after ${req.timeoutSec}s` };

    const j = s.final;
    if (!j) {
      const err = lastLine(String(p.stderr)) || s.junk || `exit ${p.exitCode}`;
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
