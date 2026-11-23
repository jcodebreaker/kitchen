// Bare `kitchen` (ADR 0011): one line about the current folder before the command list, so a folder that isn't set
// up never reads as set up. Files only: no git process, no network, no agent.
import { execFileSync } from "node:child_process";
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

/**
 * The repo Kitchen works in, for a command run in `cwd`: the main checkout when `cwd` is inside one of Kitchen's job
 * worktrees (`<repo>/.worktrees/<job>`, where a lane agent works), so `kitchen qa up 001` there finds job 001.
 * Anywhere else, `cwd` itself (a git worktree of your own keeps its own kitchen.yaml and jobs).
 */
export function kitchenRepo(cwd: string): string {
  let top: string;
  let common: string;
  try {
    const env = { ...process.env };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[k];
    [top, common] = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    })
      .trim()
      .split("\n");
  } catch {
    return cwd;
  }
  if (!top || !common) return cwd;
  const main = path.dirname(common);
  const rel = path.relative(path.join(main, ".worktrees"), top);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) && fs.existsSync(path.join(main, ".kitchen")) ? main : cwd;
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
