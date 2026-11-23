// Bare `kitchen` (ADR 0011): one line about the current folder before the command list, so a
// folder that isn't set up never reads as set up. Files only: no git process, no network, no agent.
import fs from "node:fs";
import path from "node:path";
import { readRunLock, staleReason } from "../engine/lock.ts";
import { listJobs } from "../engine/store.ts";
import { latestOffer, readApproval, trustFile } from "../toolkit/trust.ts";

/** The nearest folder at or above `dir` with a `.git` (a folder, or a worktree's file). */
export function gitRoot(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

export function hereLine(cwd: string, now = Date.now()): string {
  const repo = gitRoot(cwd);
  if (!repo) return "Not a git repository; Kitchen works inside one.";
  if (!fs.existsSync(path.join(repo, "kitchen.yaml")))
    return "Kitchen isn't set up here. Start with: kitchen init (or kitchen init --skill, then /kitchen set up Kitchen in Claude Code)";
  let jobs = 0;
  try {
    jobs = listJobs(repo).length;
  } catch {}
  const k = path.join(repo, ".kitchen");
  const approved = readApproval(repo)?.sha;
  const offer = latestOffer(repo);
  const toolkit =
    offer && offer.sha !== approved
      ? "proven · waiting for approval"
      : approved
        ? "approved"
        : fs.existsSync(trustFile(repo, "toolkit.proven"))
          ? "proven"
          : fs.existsSync(path.join(k, "toolkit", "bin", "dev"))
            ? "built, not proven"
            : "not built";
  let runner = "stopped";
  try {
    const l = readRunLock(repo);
    if (l && !staleReason(l.info, now)) runner = "running";
  } catch {}
  return `Kitchen is set up here · ${jobs} job${jobs === 1 ? "" : "s"} · Toolkit: ${toolkit} · runner: ${runner}`;
}
