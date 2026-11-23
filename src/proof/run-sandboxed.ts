// One shell command in a checkout under the proof sandbox (sandbox.ts): the
// untrusted env plus CI=1, its own TMPDIR, its own process group (recorded in
// `procsDir` when given), a timeout. Gate's checks and cmd/test proofs run
// through it (stamp-cmd.ts, which stamps the result as evidence); so does quick
// init's one run of the checks on the person's checkout (init/quick.ts).
import fs from "node:fs";
import { execa } from "execa";
import { untrustedEnv } from "../agents/env.ts";
import { killGroup, trackGroup } from "../procs.ts";
import { proofSandboxProfile, proofTmpDir, sandboxedShell } from "./sandbox.ts";

export type SandboxedRun = { exit: number; timedOut: boolean; stdout: string; stderr: string; all: string; secs: number; sandboxed: boolean };

export async function runSandboxed(o: {
  cwd: string;
  cmd: string;
  timeoutSec: number;
  /** Outbound network (a dependency install); the filesystem rules stay. */
  network?: boolean;
  /** Paths the profile denies on top of the usual (job folders, the git config). */
  deny?: string[];
  /** Extra env (KITCHEN_APP_URL). */
  env?: Record<string, string>;
  procsDir?: string;
  what: string;
  /** Default true. False: the untrusted env only, no profile (a caller that asked for none). */
  sandbox?: boolean;
  /** Ctrl-C / SIGTERM while it runs kills its process group, then exits (a foreground command; the runner has its own handler). */
  killOnSignal?: boolean;
}): Promise<SandboxedRun> {
  const t0 = Date.now();
  // CI=1: test runners and linters don't wait for input or watch files.
  const env: Record<string, string> = { ...untrustedEnv(o.cwd), CI: "1", ...(o.env ?? {}) };
  const tmp = o.sandbox === false ? null : proofTmpDir();
  if (tmp) env.TMPDIR = tmp;
  const profile = tmp ? proofSandboxProfile({ worktree: o.cwd, tmp, network: !!o.network, pathEnv: env.PATH, deny: o.deny ?? [] }) : null;
  try {
    const [bin, argv] = sandboxedShell(o.cmd, profile);
    const sub = execa(bin, argv, {
      cwd: o.cwd,
      env,
      extendEnv: false,
      reject: false,
      stdin: "ignore",
      timeout: o.timeoutSec * 1000,
      forceKillAfterDelay: 5000,
      all: true,
      detached: true,
    });
    const untrack = trackGroup(o.procsDir, sub.pid, o.what);
    const onSignal = (sig: NodeJS.Signals) => {
      if (sub.pid) killGroup(sub.pid, "SIGKILL");
      process.exit(sig === "SIGINT" ? 130 : 143);
    };
    if (o.killOnSignal) {
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    }
    let r: Awaited<typeof sub>;
    try {
      r = await sub;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      untrack();
    }
    return {
      exit: r.timedOut ? 124 : (r.exitCode ?? 1),
      timedOut: !!r.timedOut,
      stdout: String(r.stdout ?? ""),
      stderr: String(r.stderr ?? ""),
      all: String(r.all ?? ""),
      secs: (Date.now() - t0) / 1000,
      sandboxed: !!profile,
    };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (profile) fs.rmSync(profile, { force: true });
  }
}
