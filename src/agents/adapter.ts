// The one seam between the engine and a coding agent (PLAN §3, ADR 0006).

import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export type Tier = "read" | "write";

/** The engine bridge (`kitchen mcp`), started by the agent tool as the MCP server named "kitchen". */
export type BridgeServer = { command: string; args: string[]; env: Record<string, string> };

export type AgentRequest = {
  role: string;
  prompt: string;
  /** Worktree (write tier) or the repo / worktree to read (read tier). */
  cwd: string;
  model: string;
  tier: Tier;
  resumeSession?: string;
  timeoutSec: number;
  maxTurns: number;
  /** The one file the role writes, e.g. `intake.md`. */
  outFile: string;
  /** Where it goes. Default `<cwd>/.kitchen-out`; read roles without a worktree get an engine scratch dir. */
  outDir?: string;
  /** The scrubbed env (env.ts). The adapter never adds the parent env to it. */
  env: Record<string, string>;
  /** Give the agent the engine bridge's tools (mcp__kitchen__*). */
  bridge?: BridgeServer;
  /** Engine-owned folders the agent may not even read. Default: $KITCHEN_HOME (the engine key). */
  denyRead?: string[];
};

export type AgentResult = {
  ok: boolean;
  /** The agent's last line. */
  line: string;
  sessionId?: string;
  rateLimited?: boolean;
  timedOut?: boolean;
  /** Turn limit hit (Claude: native; Codex: counted tool calls, the adapter stops it). */
  maxTurnsHit?: boolean;
  usage?: { usd?: number; inTok?: number; outTok?: number };
  transcriptPath?: string;
  /** Absolute path of the role's file, when the agent wrote it. The engine copies it, then deletes it. */
  outPath?: string;
  error?: string;
};

export interface AgentAdapter {
  name: "claude" | "codex" | "fake";
  run(req: AgentRequest): Promise<AgentResult>;
}

export function outDirOf(req: Pick<AgentRequest, "cwd" | "outDir">): string {
  return req.outDir ?? join(req.cwd, ".kitchen-out");
}

export function outPathOf(req: Pick<AgentRequest, "cwd" | "outDir" | "outFile">): string {
  return join(outDirOf(req), req.outFile);
}

/** The out path if the agent wrote it. */
export function foundOut(req: Pick<AgentRequest, "cwd" | "outDir" | "outFile">): string | undefined {
  const p = outPathOf(req);
  return existsSync(p) ? p : undefined;
}

export function isInside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Appended to every role prompt: where the one file goes, and the one-line answer. */
export function contractFooter(req: AgentRequest): string {
  return [
    "",
    "---",
    `Write your output file to ${outPathOf(req)} (create the folder if needed). Write nothing else outside it${
      req.tier === "write" ? " except your edits in this worktree" : ""
    }.`,
    "Your final message is a single line that states the outcome.",
  ].join("\n");
}

const RATE_LIMIT = /rate.?limit|usage limit|429|too many requests|overloaded|quota/i;
export const looksRateLimited = (s: string | undefined) => !!s && RATE_LIMIT.test(s);

export const lastLine = (s: string | undefined) =>
  (s ?? "")
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .pop()
    ?.trim() ?? "";
