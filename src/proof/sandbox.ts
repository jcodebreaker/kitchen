// The OS sandbox for `cmd` and `test` proofs (ADR 0006 "cmd and test proofs"):
// worktree code the builder wrote, run by the engine. spec-lint's cmd denylist
// is a first line that catches the obvious; this profile is the real boundary.
// On macOS each such proof runs under `sandbox-exec` with a profile that:
//   - denies the network, except loopback (a test may start a server on localhost);
//   - denies writing anywhere but the worktree, temp and /dev;
//   - denies reading under $HOME, except the worktree, the toolchains on PATH that
//     live under $HOME (nvm, volta, pyenv…) and the npm cache;
//   - denies reading or writing the developer's credentials, the agent tools' auth
//     and $KITCHEN_HOME (the engine key) wherever they are (the W2 deny list,
//     src/toolkit/sandbox.ts), the repo's job folders (evidence, job.json) and
//     the git config (a remote URL can carry a token).
// Linux (or a Mac without sandbox-exec): unsandboxed; the caller logs it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHome, kitchenHome } from "../home.ts";
import { deniedPaths, SANDBOX_EXEC } from "../toolkit/sandbox.ts";

export type ProofSandboxOpts = {
  worktree: string;
  /** Extra paths to deny (the repo's job folders, the git config). */
  deny?: string[];
  /** PATH of the env the proof runs with: toolchains under $HOME on it stay readable. */
  pathEnv?: string;
  home?: string;
  kHome?: string;
  tmp?: string;
};

/** Toolchain and cache folders under $HOME a test command may need to read (when they exist). */
const TOOL_DIRS = [".nvm", ".volta", ".fnm", ".asdf", ".pyenv", ".rbenv", ".bun", ".deno", ".cargo", ".rustup", ".npm", ".node-gyp", ".yarn", "Library/pnpm"];
/** Under $HOME, written by a test command's own tooling (npm logs and cache). */
const WRITABLE_IN_HOME = [".npm"];

const both = (p: string): string[] => {
  try {
    const r = fs.realpathSync(p);
    return r === p ? [p] : [p, r];
  } catch {
    return [p];
  }
};
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const subs = (ps: string[]) => [...new Set(ps.flatMap(both))].map((p) => `(subpath ${q(p)})`).join(" ");
const under = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

/** Pure (but for realpath): the SBPL profile for one job's cmd/test proofs. In SBPL the last matching rule wins. */
export function proofProfileText(o: Required<Pick<ProofSandboxOpts, "worktree" | "home" | "kHome" | "tmp">> & ProofSandboxOpts): string {
  const home = o.home;
  const onPath = (o.pathEnv ?? "")
    .split(":")
    .filter((e) => path.isAbsolute(e) && under(e, home) && e !== home)
    .map((e) => (path.basename(e) === "bin" ? path.dirname(e) : e));
  const tools = TOOL_DIRS.map((d) => path.join(home, d)).filter((d) => fs.existsSync(d));
  const scrub = path.join(o.kHome, "scrub");
  // Node looks for a package.json in every folder above a script and fails on EPERM (not ENOENT): those stay readable.
  const pkgAbove: string[] = [];
  for (let d = path.dirname(o.worktree); d !== path.dirname(d); d = path.dirname(d)) pkgAbove.push(path.join(d, "package.json"));
  const lits = [...new Set(pkgAbove.flatMap(both))].map((p) => `(literal ${q(p)})`).join(" ");
  return [
    "(version 1)",
    ";; Kitchen cmd/test proof: worktree code, no network, $HOME unreadable (ADR 0006).",
    "(allow default)",
    "(deny network*)",
    // Loopback only. Not `(allow network* (local ip …))`: an outbound socket matches that too (seen: 1.1.1.1:443 connected).
    '(allow network-bind network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "(deny file-write*)",
    `(allow file-write* ${subs([o.worktree, o.tmp, "/private/tmp", "/private/var/folders", "/dev", ...WRITABLE_IN_HOME.map((d) => path.join(home, d))])})`,
    `(deny file-read* ${subs([home])})`,
    "(allow file-read-metadata)",
    `(allow file-read* ${lits} ${subs([o.worktree, ...onPath, ...tools])})`,
    `(deny file-read* file-write* ${subs(deniedPaths(home, o.kHome, o.deny ?? []))})`,
    `(allow file-read* ${subs([scrub])})`,
    "",
  ].join("\n");
}

/**
 * The profile file for this job's proofs, written into $KITCHEN_HOME/sandbox/,
 * or null where there is no sandbox-exec (Linux: unsandboxed).
 */
export function proofSandboxProfile(o: ProofSandboxOpts): string | null {
  if (process.platform !== "darwin" || !fs.existsSync(SANDBOX_EXEC)) return null;
  const kHome = ensureHome(o.kHome ?? kitchenHome());
  fs.mkdirSync(path.join(kHome, "scrub"), { recursive: true, mode: 0o700 });
  const text = proofProfileText({ ...o, home: o.home ?? os.homedir(), kHome, tmp: o.tmp ?? os.tmpdir() });
  const dir = path.join(kHome, "sandbox");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `proof-${createHash("sha256").update(o.worktree).digest("hex").slice(0, 12)}.sb`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/** argv that runs `sh -c cmd` under the profile, or plain `sh -c cmd` without one. */
export const sandboxedShell = (cmd: string, profile: string | null): [string, string[]] =>
  profile ? [SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", cmd]] : ["sh", ["-c", cmd]];
