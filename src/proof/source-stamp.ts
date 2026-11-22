// What source a proof ran against: HEAD of the tested worktree, plus whether the
// working tree differs from HEAD and the git tree hash of what is actually on
// disk (tracked + untracked, minus ignored). Never "unknown": no git, no proof.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

export type SourceStamp = { sha: string; dirty: boolean; tree: string };

export class NoSourceStamp extends Error {}

async function git(src: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const r = await execa("git", ["-C", src, ...args], { reject: false, env: { ...env, GIT_OPTIONAL_LOCKS: "0" } });
  if (r.exitCode !== 0) throw new NoSourceStamp(`git ${args[0]} in ${src} failed: ${String(r.stderr).trim().split("\n").pop()}`);
  return String(r.stdout).trim();
}

export async function sourceStamp(src: string): Promise<SourceStamp> {
  const sha = await git(src, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const headTree = await git(src, ["rev-parse", "HEAD^{tree}"]);
  // Hash the working tree with a throwaway index, so the repo's own index is untouched.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-stamp-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    await git(src, ["read-tree", "HEAD"], env);
    await git(src, ["add", "-A", "."], env);
    const tree = await git(src, ["write-tree"], env);
    return { sha, dirty: tree !== headTree, tree };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
