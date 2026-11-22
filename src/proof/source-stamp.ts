// What source a proof ran against: HEAD of the tested worktree, plus whether the
// working tree differs from HEAD and the git tree hash of what is actually on
// disk (tracked + untracked, minus ignored), at the moment of the drive.
// Never "unknown": no git, no proof. Every git call goes through the engine
// helper (src/engine/git.ts): explicit gitdir, nothing in the worktree runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type GitRepo, openGit } from "../engine/git.ts";

export type SourceStamp = { sha: string; dirty: boolean; tree: string };

export class NoSourceStamp extends Error {}

export async function sourceStamp(repo: GitRepo): Promise<SourceStamp> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-stamp-"));
  try {
    const git = await openGit(repo);
    const out = async (args: string[], env?: Record<string, string>) => (await git.run(args, { env })).stdout.trim();
    const sha = await out(["rev-parse", "--verify", "HEAD^{commit}"]);
    const headTree = await out(["rev-parse", "HEAD^{tree}"]);
    // Hash the working tree with a throwaway index, so the repo's own index is untouched.
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    await out(["read-tree", "HEAD"], env);
    await out(["add", "-A", "--", ":/"], env);
    const tree = await out(["write-tree"], env);
    return { sha, dirty: tree !== headTree, tree };
  } catch (e) {
    throw new NoSourceStamp(`no source stamp for ${repo.workTree}: ${(e as Error).message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
