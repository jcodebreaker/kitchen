// Bare `kitchen` (ADR 0011): one line about the current folder before the command list, so a folder that isn't set
// up never reads as set up. Files only: no git process, no network, no agent.
import fs from "node:fs";
import path from "node:path";
import { listJobs } from "../engine/store.ts";
import { liveRun } from "../run/orchestrator.ts";

/** The nearest folder at or above `dir` with a `.git` (a folder, or a worktree's file). */
export function gitRoot(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

export function hereLine(cwd: string): string {
  const repo = gitRoot(cwd);
  if (!repo) return "Not a git repository; Kitchen works inside one.";
  if (!fs.existsSync(path.join(repo, "kitchen.yaml")))
    return "Kitchen isn't set up here. Start with: kitchen init (or kitchen init --skill, then /kitchen set up Kitchen in Claude Code)";
  let jobs = 0;
  try {
    jobs = listJobs(repo).length;
  } catch {}
  const hooks = fs.existsSync(path.join(repo, ".claude", "hooks", "kitchen", "guard-secrets.py")) ? "installed" : "missing (kitchen init)";
  return `Kitchen is set up here · ${jobs} job${jobs === 1 ? "" : "s"} · guard hooks: ${hooks} · orchestrator: ${liveRun(repo) ? "running" : "stopped"}`;
}
