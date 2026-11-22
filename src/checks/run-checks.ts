// The kitchen.yaml `checks`, run in the job worktree with the untrusted env under
// the proof sandbox (they run builder-written code: proof/sandbox.ts; outbound
// network only with `checks_network: true`), each one stamped in the manifest
// (proof/stamp-cmd.ts). Gate runs them as the engine; the builder self-checks
// through the bridge's `checks` tool.
//
// `checks_prepare` (`npm ci`) readies the worktree first: a job worktree is a
// fresh checkout with no node_modules, and the Toolkit's `prepare` (which may
// install dependencies inside a container) runs after Gate. It runs under the
// same sandbox, stamped like a check, once per worktree until the command or a
// dependency file changes (jobs/<id>/checks-prepared.json). The builder can write
// to gitignored folders (node_modules) after that, so Gate and Verify forget the
// cache on entry (forgetChecksPrepared): what they judge runs on dependencies
// installed after the builder's last turn, never on ones it could have edited.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CheckSpec, Config } from "../config.ts";
import { readJob } from "../proof/job.ts";
import { type StampedCmd, stampCommand } from "../proof/stamp-cmd.ts";

export type ChecksResult = { ok: boolean; sha: string | null; results: StampedCmd[] };
export type ChecksPrepare = { cmd: string; network: boolean };

/**
 * The prepare step always has the network (it downloads the dependencies, ADR 0010); the checks and proofs
 * after it get it only with `checks_network: true`, so builder code never reaches the network by default.
 */
export const checksPrepareOf = (cfg: Pick<Config, "checks_prepare">): ChecksPrepare | undefined =>
  cfg.checks_prepare ? { cmd: cfg.checks_prepare, network: true } : undefined;

/** Dependency manifests and lockfiles at the worktree root: a change to one runs `checks_prepare` again. */
export const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "requirements.txt",
  "requirements-dev.txt",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "go.sum",
  "Cargo.lock",
];

/** What a prepared worktree was prepared for: the command and the dependency files' contents. */
export function prepareKey(cmd: string, worktree: string): string {
  const h = createHash("sha256").update(cmd);
  for (const f of DEPENDENCY_FILES) {
    const p = path.join(worktree, f);
    h.update(`\0${f}\0`);
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  return h.digest("hex");
}

const markerOf = (jobDir: string) => path.join(jobDir, "checks-prepared.json");
function readMarker(jobDir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(markerOf(jobDir), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Forget that `checks_prepare` ran in the job worktree, so the next check or proof runs it again (Gate and
 * Verify on entry: the builder may have edited the installed dependencies since). `npm ci`-style commands
 * reinstall from scratch.
 */
export function forgetChecksPrepared(jobDir: string): void {
  const m = readMarker(jobDir);
  if (!Object.keys(m).length) return;
  const worktree = readJob(jobDir).worktree;
  if (!(worktree in m)) return;
  delete m[worktree];
  fs.writeFileSync(`${markerOf(jobDir)}.tmp`, `${JSON.stringify(m, null, 2)}\n`);
  fs.renameSync(`${markerOf(jobDir)}.tmp`, markerOf(jobDir));
}

/**
 * Run `checks_prepare` in the worktree (or `source`) unless it already ran there for the same command and
 * dependency files. Returns the stamped run, or null when it was cached.
 */
export async function ensureChecksPrepared(o: {
  jobDir: string;
  prepare: ChecksPrepare;
  role: string;
  criterion: string;
  source?: { worktree: string; gitDir: string };
}): Promise<StampedCmd | null> {
  const worktree = o.source?.worktree ?? readJob(o.jobDir).worktree;
  const key = prepareKey(o.prepare.cmd, worktree);
  if (readMarker(o.jobDir)[worktree] === key) return null;
  const r = await stampCommand({
    jobDir: o.jobDir,
    name: "checks_prepare",
    cmd: o.prepare.cmd,
    role: o.role,
    criterion: o.criterion,
    timeoutSec: 1800,
    sandbox: true,
    network: o.prepare.network,
    ...(o.source ? { source: o.source } : {}),
  });
  if (r.ok) {
    const m = readMarker(o.jobDir);
    m[worktree] = key;
    fs.writeFileSync(`${markerOf(o.jobDir)}.tmp`, `${JSON.stringify(m, null, 2)}\n`);
    fs.renameSync(`${markerOf(o.jobDir)}.tmp`, markerOf(o.jobDir));
  }
  return r;
}

export async function runChecks(o: {
  jobDir: string;
  checks: CheckSpec[];
  role: string;
  criterion: string;
  network: boolean;
  /** kitchen.yaml `checks_prepare`: run first (cached); when it fails the checks don't run. */
  prepare?: ChecksPrepare;
}): Promise<ChecksResult> {
  const results: StampedCmd[] = [];
  if (o.prepare && o.checks.length) {
    const p = await ensureChecksPrepared({ jobDir: o.jobDir, prepare: o.prepare, role: o.role, criterion: o.criterion });
    if (p) results.push(p);
    if (p && !p.ok) return { ok: false, sha: p.sha, results };
  }
  for (const c of o.checks) {
    results.push(
      await stampCommand({
        jobDir: o.jobDir,
        name: c.name,
        cmd: c.run,
        role: o.role,
        criterion: o.criterion,
        timeoutSec: c.timeoutSec,
        sandbox: true,
        network: o.network,
      }),
    );
  }
  const shas = new Set(results.map((r) => r.sha));
  return { ok: results.every((r) => r.ok), sha: shas.size === 1 ? [...shas][0] : null, results };
}
