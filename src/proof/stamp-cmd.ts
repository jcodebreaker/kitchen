// One shell command run in the job worktree and stamped as evidence, the way
// `kitchen drive` stamps a primitive: under the per-job drive lock, after the
// manifest verifies, with the worktree's source stamp (engine git), its own
// entry folder e<N>/ (stdout.txt, stderr.txt, call.json) and the new head
// stored before anything else runs. The command gets the untrusted env.
// Used by Gate (role engine) and the builder's `checks` bridge tool.
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { untrustedEnv } from "../agents/env.ts";
import { procsDirOf, trackGroup } from "../procs.ts";
import { evidenceDir, jobGit, readJob, sealOf, storeHead, withJobLock } from "./job.ts";
import { appendEntry, nextId, verifyManifest } from "./manifest.ts";
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
};

export function stampCommand(o: {
  jobDir: string;
  name: string;
  cmd: string;
  role: string;
  criterion: string;
  timeoutSec: number;
  tag?: Record<string, string>;
}): Promise<StampedCmd> {
  return withJobLock(o.jobDir, async () => {
    const job = readJob(o.jobDir);
    const seal = sealOf(job);
    const ev = evidenceDir(o.jobDir);
    verifyManifest(ev, job.manifestHead, seal);
    const source = await sourceStamp(jobGit(job));
    const id = nextId(job.manifestHead);
    const dir = path.join(ev, id);
    fs.rmSync(dir, { recursive: true, force: true }); // a crashed run may have left files here
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const sub = execa("sh", ["-c", o.cmd], {
      cwd: job.worktree,
      env: untrustedEnv(job.worktree),
      extendEnv: false,
      reject: false,
      stdin: "ignore",
      timeout: o.timeoutSec * 1000,
      forceKillAfterDelay: 5000,
      all: true,
      detached: true, // its own process group, recorded for the job (src/procs.ts)
    });
    const untrack = trackGroup(procsDirOf(o.jobDir), sub.pid, `check ${o.name}`);
    let r: Awaited<typeof sub>;
    try {
      r = await sub;
    } finally {
      untrack();
    }
    const secs = (Date.now() - t0) / 1000;
    const exit = r.timedOut ? 124 : (r.exitCode ?? 1);
    fs.writeFileSync(path.join(dir, "stdout.txt"), String(r.stdout));
    fs.writeFileSync(path.join(dir, "stderr.txt"), String(r.stderr));
    fs.writeFileSync(path.join(dir, "call.json"), JSON.stringify({ name: o.name, cmd: o.cmd, cwd: job.worktree, exit, timedOut: !!r.timedOut, secs }, null, 2));
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
      tail: String(r.all ?? "").slice(-800),
      sha: source.sha,
      dirty: source.dirty,
      timedOut: !!r.timedOut,
    };
  });
}
