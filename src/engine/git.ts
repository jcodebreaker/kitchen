// Kitchen's git: plain `git -C <dir>` calls. Agents never push; Kitchen pushes only job branches (and, on GitHub,
// merges into staging through the PR). Nothing here ever pushes to or updates the base branch or main.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The git command an argv runs, past its global options (`-c k=v`, `-C dir`). */
const subcommand = (args: string[]) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "-C") i++;
    else if (!args[i].startsWith("-")) return args[i];
  }
  return args[0] ?? "";
};

export class GitError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  constructor(args: string[], exitCode: number, stderr: string) {
    super(`git ${subcommand(args)} failed (exit ${exitCode}): ${stderr.trim().split("\n").pop() ?? ""}`);
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

/**
 * ADR 0030: no fsmonitor in Kitchen's own git (finish, the merge): it costs nothing, and one a lane planted would run
 * outside its sandbox. The person's repo hooks (pre-commit, husky) still run on Kitchen's commits and merges: a Codex
 * lane can't write `.git/hooks` or the config (its writable roots), and a Claude lane can run any shell anyway.
 */
export const GIT_SAFE = ["-c", "core.fsmonitor=false"];

/** Pure: the argv Kitchen's git runs. */
export const gitArgv = (dir: string, args: string[]) => [...GIT_SAFE, "-C", dir, ...args];

/**
 * ADR 0030 §2: in a linked worktree (a job's checkout), its git dir named outright, from the worktree's `.git` file,
 * which no Codex lane may write. The repo's git dir is left to git (the worktree's `commondir`, which finish checks
 * against the repo before Kitchen's git trusts it): GIT_COMMON_DIR would reach the person's hooks, and a hook's own
 * `git -C <another repo>` would land in this one. {} for anything else.
 */
export function worktreeEnv(dir: string): NodeJS.ProcessEnv {
  try {
    const m = /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(dir, ".git"), "utf8"));
    if (!m) return {};
    const gitDir = path.resolve(dir, m[1].trim());
    if (path.basename(path.dirname(gitDir)) !== "worktrees") return {};
    return { GIT_DIR: gitDir, GIT_WORK_TREE: dir };
  } catch {
    return {};
  }
}

export function git(dir: string, args: string[], o: { input?: string; allowFail?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", gitArgv(dir, args), { env: { ...gitEnv(), ...worktreeEnv(dir) }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
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
