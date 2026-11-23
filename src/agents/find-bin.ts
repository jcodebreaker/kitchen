// Finds the agent binary Kitchen starts, as an absolute path.
//
// Some terminals put a session wrapper named `claude` (or `codex`) first on PATH, in the OS temp folder
// (cmux, for one). Such a wrapper belongs to that terminal session: it may need the session's
// environment, which Kitchen scrubs from agents, and it may be gone while a detached
// `kitchen run` is still working. So Kitchen never pins an agent to a binary under the temp
// folder; it takes the first one installed anywhere else. KITCHEN_CLAUDE_BIN or
// KITCHEN_CODEX_BIN still wins.

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `dir` is inside `tmp` (both resolved, so /var and /private/var compare equal). */
export function isSessionDir(dir: string, tmp = tmpdir()): boolean {
  const d = real(dir) + sep;
  const t = real(tmp) + sep;
  return d.startsWith(t);
}

/** The first `name` on `pathVar` outside the temp folder, as an absolute path; `name` if none. */
export function findBin(name: string, pathVar: string | undefined, tmp = tmpdir()): string {
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir || isSessionDir(dir, tmp)) continue;
    const candidate = join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return name;
}

/** KITCHEN_CLAUDE_BIN, else the installed `claude` on PATH. */
export function claudeBin(env: NodeJS.ProcessEnv = process.env, tmp = tmpdir()): string {
  return env.KITCHEN_CLAUDE_BIN || findBin("claude", env.PATH, tmp);
}

/** KITCHEN_CODEX_BIN, else the installed `codex` on PATH. */
export function codexBin(env: NodeJS.ProcessEnv = process.env, tmp = tmpdir()): string {
  return env.KITCHEN_CODEX_BIN || findBin("codex", env.PATH, tmp);
}
