// The one way the engine runs git (ADR 0006, "Engine git").
//
// A worktree is untrusted: an agent or app code can write any file in it,
// including a linked worktree's `.git` file, which tells git where the repo is.
// Pointed at a gitdir whose config sets `core.fsmonitor` (or a hook, a filter
// driver, …), a plain `git -C <worktree> …` runs that command as the engine.
// So the engine never lets git discover the repo from the worktree:
//
// - The gitdir is resolved once, from the engine side, when the job is created
//   (`linkedWorktree`: `<main repo>/.git/worktrees/<id>`, checked against the
//   back-pointer git keeps there; `plainCheckout`: `<src>/.git` must be a real
//   directory) and stored in job.json. The worktree's `.git` is never read.
// - Every call passes `--git-dir` and `--work-tree` explicitly, plus
//   command-scope config that turns off every key that makes the commands the
//   engine runs (rev-parse, read-tree, add, write-tree, status, commit, push)
//   execute a program. Command-scope `-c` beats every config file and reaches
//   child git processes too (GIT_CONFIG_PARAMETERS).
// - The env is the scrubbed one (no system config, the engine's own global
//   config, no credentials) without the worktree's `.env.kitchen`, which could
//   otherwise set PATH or GIT_* for git itself. Credentials are reserved for
//   `push`, the only command that may be given them.
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { engineGitEnv } from "../agents/env.ts";

export type GitRepo = { gitDir: string; workTree: string };

export class GitRepoError extends Error {}
export class GitError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  constructor(args: string[], exitCode: number, stderr: string) {
    super(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim().split("\n").pop() ?? ""}`);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Config keys that make the engine's git commands run a program, each set to a
 * value that runs nothing. Filter drivers (`filter.<name>.clean/smudge/process`,
 * run by add, status, commit) can't be wildcarded, so `openGit` lists the
 * drivers the config defines and empties each one. Not covered here because the
 * engine never runs the commands that use them: diff/textconv drivers
 * (`diff`, `log -p`: pass `--no-ext-diff --no-textconv` if that changes),
 * merge drivers (`merge`), `core.alternateRefsCommand` (fetch negotiation).
 * The push path must also push to an explicit URL with `--receive-pack`, so no
 * `remote.<name>.*` program applies.
 */
export const NEUTRAL_CONFIG = [
  "core.fsmonitor=false", // a command run on every index refresh (status, add, commit)
  "core.hooksPath=/dev/null", // no hooks: post-index-change (read-tree, add), pre-commit, commit-msg, post-commit, pre-push…
  "core.sshCommand=false", // the push path sets its own
  "core.askPass=",
  "credential.helper=", // empties the helper list; the push path names its own
  "protocol.ext.allow=never", // ext:: URLs run a command
  "core.editor=false",
  "sequence.editor=false",
  "core.pager=cat",
  "commit.gpgSign=false", // gpg.program / gpg.ssh.program
  "tag.gpgSign=false",
  "push.gpgSign=false",
  "submodule.recurse=false", // never descend into a nested repo, whose `.git` the worktree controls
  "diff.ignoreSubmodules=all", // status: don't spawn git inside nested repos
  "status.submoduleSummary=false",
] as const;

const asFlags = (kv: readonly string[]) => kv.flatMap((c) => ["-c", c]);

function realDir(p: string, what: string): string {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) throw new GitRepoError(`${what} ${p} does not exist`);
  if (!st.isDirectory()) throw new GitRepoError(`${what} ${p} is not a directory${st.isSymbolicLink() ? " (a symlink)" : ""}`);
  return fs.realpathSync(p);
}

/**
 * A linked worktree (`git worktree add`): its gitdir is `<mainRepo>/.git/worktrees/<id>`,
 * outside the worktree. Checked against the back-pointer git writes there
 * (`gitdir`, engine side), never against the worktree's own `.git` file.
 */
export function linkedWorktree(mainRepo: string, id: string, workTree: string): GitRepo {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw new GitRepoError(`bad worktree id ${JSON.stringify(id)}`);
  const common = realDir(path.join(mainRepo, ".git"), "main repo gitdir");
  const gitDir = realDir(path.join(common, "worktrees", id), "worktree gitdir");
  const wt = realDir(workTree, "worktree");
  let back: string;
  try {
    back = fs.readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
  } catch {
    throw new GitRepoError(`${gitDir} has no gitdir back-pointer: not a linked worktree`);
  }
  const backDir = path.dirname(path.resolve(gitDir, back));
  if (path.basename(back) !== ".git" || !fs.existsSync(backDir) || fs.realpathSync(backDir) !== wt)
    throw new GitRepoError(`${gitDir} belongs to ${backDir}, not ${wt}`);
  return { gitDir, workTree: wt };
}

/** A plain checkout (fixtures, spikes): `<src>/.git` must be a real directory. A `.git` file means a linked worktree. */
export function plainCheckout(src: string): GitRepo {
  const wt = realDir(src, "source");
  const dotGit = path.join(wt, ".git");
  const st = fs.lstatSync(dotGit, { throwIfNoEntry: false });
  if (st?.isFile()) throw new GitRepoError(`${dotGit} is a file (a linked worktree): give its main repo and worktree id`);
  if (!st) throw new GitRepoError(`${wt} is not a git checkout (no .git)`);
  return { gitDir: realDir(dotGit, "gitdir"), workTree: wt };
}

/** Engine side, once per job: the linked worktree when the main repo and id are known, else a plain checkout. */
export function resolveGitRepo(workTree: string, linked?: { mainRepo: string; id: string }): GitRepo {
  return linked ? linkedWorktree(linked.mainRepo, linked.id, workTree) : plainCheckout(workTree);
}

export type GitRun = { stdout: string; stderr: string };
export type GitOpts = {
  /** Extra variables for this call (e.g. GIT_INDEX_FILE). */
  env?: Record<string, string>;
  input?: string;
  /** Credentials: `push` only (W3). Refused for every other command. */
  credentials?: Record<string, string>;
};
export type Git = { repo: GitRepo; flags: string[]; run(args: string[], o?: GitOpts): Promise<GitRun> };

/** The command-line prefix for a repo: explicit gitdir and work tree, then the neutral config. Pure. */
export function baseArgs(repo: GitRepo, filterDrivers: string[] = []): string[] {
  const filters = filterDrivers.flatMap((d) => [`filter.${d}.clean=`, `filter.${d}.smudge=`, `filter.${d}.process=`, `filter.${d}.required=false`]);
  return [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`, "--no-pager", ...asFlags(NEUTRAL_CONFIG), ...asFlags(filters)];
}

/** Driver names from `git config --name-only --get-regexp ^filter\.` output (a name may contain dots). Pure. */
export function filterDriversOf(names: string): string[] {
  const out = new Set<string>();
  for (const line of names.split("\n")) {
    const m = /^filter\.(.+)\.[^.]+$/.exec(line.trim());
    if (m) out.add(m[1]);
  }
  return [...out];
}

async function exec(repo: GitRepo, argv: string[], env: Record<string, string>, input?: string) {
  return execa("git", argv, { cwd: repo.workTree, env, extendEnv: false, reject: false, input, stripFinalNewline: false });
}

/** Open a repo for engine git calls: lists the config's filter drivers once, so every call empties them. */
export async function openGit(repo: GitRepo, parentEnv: NodeJS.ProcessEnv = process.env): Promise<Git> {
  const env = { ...engineGitEnv(parentEnv), GIT_OPTIONAL_LOCKS: "0" };
  // Reading config runs nothing; exit 1 just means no filter keys.
  const listed = await exec(repo, [...baseArgs(repo), "config", "--name-only", "--get-regexp", "^filter\\."], env);
  if (listed.exitCode !== 0 && listed.exitCode !== 1) throw new GitError(["config"], listed.exitCode ?? -1, String(listed.stderr));
  const flags = baseArgs(repo, filterDriversOf(String(listed.stdout)));
  return {
    repo,
    flags,
    async run(args, o = {}) {
      if (o.credentials && args[0] !== "push") throw new GitRepoError(`credentials are for push only, not git ${args[0]}`);
      const r = await exec(repo, [...flags, ...args], { ...env, ...o.env, ...o.credentials }, o.input);
      if (r.exitCode !== 0) throw new GitError(args, r.exitCode ?? -1, String(r.stderr));
      return { stdout: String(r.stdout), stderr: String(r.stderr) };
    },
  };
}
