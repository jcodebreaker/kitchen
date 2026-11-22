// One shell command run in the job worktree and stamped as evidence, the way
// `kitchen drive` stamps a primitive: under the per-job drive lock, after the
// manifest verifies, with the worktree's source stamp (engine git), its own
// entry folder e<N>/ (stdout.txt, stderr.txt, call.json) and the new head
// stored before anything else runs. The command gets the untrusted env; a
// `cmd`/`test` proof and every kitchen.yaml check also run under the proof
// sandbox (`sandbox: true`, proof/sandbox.ts), with a fresh TMPDIR of their own. What it printed goes through proof/redact.ts before it
// lands on disk. Used by Gate (role engine), the builder's `checks` bridge
// tool and `cmd`/`test` proofs (prove.ts).
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { untrustedEnv } from "../agents/env.ts";
import { procsDirOf, trackGroup } from "../procs.ts";
import { evidenceDir, jobGit, readJob, sealOf, storeHead, withJobLock } from "./job.ts";
import { appendEntry, nextId, verifyManifest } from "./manifest.ts";
import { redact } from "./redact.ts";
import { proofSandboxProfile, proofTmpDir, sandboxedShell } from "./sandbox.ts";
import { sourceStamp } from "./source-stamp.ts";

export type StampedCmd = {
  id: string;
  name: string;
  cmd: string;
  exit: number;
  ok: boolean;
  secs: number;
  tail: string;
  sha: string;
  dirty: boolean;
  timedOut: boolean;
  /** Ran under the proof sandbox (false where asked for but there is none: Linux). */
  sandboxed: boolean;
};

export function stampCommand(o: {
  jobDir: string;
  name: string;
  cmd: string;
  role: string;
  criterion: string;
  timeoutSec: number;
  tag?: Record<string, string>;
  /** Run against this checkout instead of the job worktree (the base check after drives). The manifest and job.json stay the job's. */
  source?: { worktree: string; gitDir: string };
  /** Run under the proof sandbox (cmd/test proofs, checks): no network, $HOME unreadable, writes only in the worktree and its own TMPDIR. */
  sandbox?: boolean;
  /** With `sandbox`: allow outbound network (kitchen.yaml `checks_network`); the filesystem rules stay. */
  network?: boolean;
}): Promise<StampedCmd> {
  return withJobLock(o.jobDir, async () => {
    const job = readJob(o.jobDir);
    // The source the command runs in: the job worktree, or (base check) a checkout of the base. Never stored.
    const src = { ...job, ...(o.source ?? {}) };
    const seal = sealOf(job);
    const ev = evidenceDir(o.jobDir);
    verifyManifest(ev, job.manifestHead, seal);
    const source = await sourceStamp(jobGit(src));
    const id = nextId(job.manifestHead);
    const dir = path.join(ev, id);
    fs.rmSync(dir, { recursive: true, force: true }); // a crashed run may have left files here
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const env = untrustedEnv(src.worktree);
    // The job folders (evidence, job.json) and the repo's shared config (a remote URL may hold a token) are denied too.
    const common = src.gitDir ? path.resolve(src.gitDir, "..", "..") : null;
    // Its own temp dir, the only writable temp under the profile (not /tmp: another job's worktree may live there).
    const tmp = o.sandbox ? proofTmpDir() : null;
    if (tmp) env.TMPDIR = tmp;
    const profile = tmp
      ? proofSandboxProfile({
          worktree: src.worktree,
          tmp,
          network: !!o.network,
          pathEnv: env.PATH,
          deny: [path.dirname(o.jobDir), ...(common ? [path.join(common, "config")] : [])],
        })
      : null;
    let r: Awaited<ReturnType<typeof execa>>;
    try {
      const [bin, argv] = sandboxedShell(o.cmd, profile);
      const sub = execa(bin, argv, {
        cwd: src.worktree,
        env,
        extendEnv: false,
        reject: false,
        stdin: "ignore",
        timeout: o.timeoutSec * 1000,
        forceKillAfterDelay: 5000,
        all: true,
        detached: true, // its own process group, recorded for the job (src/procs.ts)
      });
      const untrack = trackGroup(procsDirOf(o.jobDir), sub.pid, `check ${o.name}`);
      try {
        r = await sub;
      } finally {
        untrack();
      }
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      if (profile) fs.rmSync(profile, { force: true });
    }
    const secs = (Date.now() - t0) / 1000;
    const exit = r.timedOut ? 124 : (r.exitCode ?? 1);
    const sandboxed = !!profile;
    // Redacted before it lands on disk: the evidence never holds what the command printed of a secret.
    fs.writeFileSync(path.join(dir, "stdout.txt"), redact(String(r.stdout)));
    fs.writeFileSync(path.join(dir, "stderr.txt"), redact(String(r.stderr)));
    fs.writeFileSync(
      path.join(dir, "call.json"),
      redact(JSON.stringify({ name: o.name, cmd: o.cmd, cwd: src.worktree, exit, timedOut: !!r.timedOut, secs, ...(o.sandbox ? { sandboxed } : {}) }, null, 2)),
    );
    const files = ["call.json", "stderr.txt", "stdout.txt"].map((f) => `${id}/${f}`);
    const { head } = appendEntry(
      ev,
      job.manifestHead,
      {
        ...o.tag,
        sha: source.sha,
        dirty: source.dirty,
        tree: source.tree,
        round: job.round,
        criterion: o.criterion,
        role: o.role,
        check: o.name,
        cmd: o.cmd,
        exit,
        ok: exit === 0,
        ...(o.sandbox ? { sandboxed } : {}),
        files,
      } as never,
      seal,
    );
    job.manifestHead = head;
    storeHead(o.jobDir, job);
    return {
      id,
      name: o.name,
      cmd: o.cmd,
      exit,
      ok: exit === 0,
      secs,
      tail: redact(String(r.all ?? "")).slice(-800),
      sha: source.sha,
      dirty: source.dirty,
      timedOut: !!r.timedOut,
      sandboxed,
    };
  });
}
