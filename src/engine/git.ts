// Kitchen's git: plain `git -C <dir>` calls. Agents never push; Kitchen pushes only job branches (and, on GitHub,
// merges into staging through the PR). Nothing here ever pushes to or updates the base branch or main.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export class GitError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  constructor(args: string[], exitCode: number, stderr: string) {
    super(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim().split("\n").pop() ?? ""}`);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** The environment git runs with: no GIT_DIR or GIT_WORK_TREE leaking in from a hook or a parent git. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR)$/.test(k)) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0" };
}

export function git(dir: string, args: string[], o: { input?: string; allowFail?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", dir, ...args], { env: gitEnv(), maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : 1) : 0;
      if (code && !o.allowFail) reject(new GitError(args, code, String(stderr)));
      else resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
    if (o.input !== undefined) child.stdin?.end(o.input);
  });
}

export const gitOut = async (dir: string, args: string[]) => (await git(dir, args)).stdout.trim();

/** The commit `rev` names, or null. */
export async function revParse(dir: string, rev: string): Promise<string | null> {
  const r = await git(dir, ["rev-parse", "--verify", "-q", `${rev}^{commit}`], { allowFail: true });
  return r.code ? null : r.stdout.trim();
}

export const branchExists = async (dir: string, name: string) => (await revParse(dir, `refs/heads/${name}`)) !== null;

/** The branch checked out in the main checkout ("" when detached). */
export async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true })).stdout.trim();
}

/** Worktrees and the branch each has checked out. */
export async function worktrees(dir: string): Promise<{ path: string; branch: string | null }[]> {
  const out = (await git(dir, ["worktree", "list", "--porcelain"])).stdout;
  return out
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({
      path: /^worktree (.+)$/m.exec(b)?.[1] ?? "",
      branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? null,
    }));
}

/** Lines added plus removed between two commits, and the files changed. */
export async function diffSize(dir: string, from: string, to: string): Promise<{ lines: number; files: { p: string; a: number; d: number }[] }> {
  const out = (await git(dir, ["diff", "--numstat", "--no-renames", `${from}...${to}`])).stdout;
  const files = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, d, p] = l.split("\t");
      return { p, a: a === "-" ? 0 : Number(a), d: d === "-" ? 0 : Number(d) };
    });
  return { lines: files.reduce((s, f) => s + f.a + f.d, 0), files };
}

/** The main checkout of the repo at `dir` (the common dir's parent), so a call from a worktree finds the same repo. */
export async function mainCheckout(dir: string): Promise<string> {
  const common = await gitOut(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return path.basename(common) === ".git" ? path.dirname(common) : fs.realpathSync(dir);
}
