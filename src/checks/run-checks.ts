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
import { openGit } from "../engine/git.ts";
import { readJobAt } from "../engine/store.ts";
import { readJob } from "../proof/job.ts";
import { type StampedCmd, stampCommand } from "../proof/stamp-cmd.ts";

export type ChecksResult = { ok: boolean; sha: string | null; results: StampedCmd[] };
/**
 * `network`: "base-deps" is the network only while the worktree's dependency files are the base's, byte for byte
 * (review N1: the base's dependencies are as trusted as the base; a builder's change to them runs offline).
 */
export type PrepareStep = { name: string; cmd: string; network: boolean | "base-deps" };
/** What readies a worktree, in order. `cmd`: all of it as one line, the cache key. */
export type ChecksPrepare = { cmd: string; steps: PrepareStep[] };
/** `yarn`: Yarn Berry (2+); `yarn-classic`: Yarn 1, whose install takes other flags and has no rebuild (review Y1). */
export type PackageManager = "npm" | "pnpm" | "yarn" | "yarn-classic" | "bun";

/**
 * Pure: kitchen.yaml `checks_install` as steps (ADR 0010, review R2). The frozen download is the only step with the
 * network for sure, and it runs no package's scripts (`--ignore-scripts`; Yarn Berry: `--mode=skip-build`), so a
 * `postinstall` the builder adds, or a git dependency's, never runs while it downloads. The lifecycle scripts run
 * after, in a rebuild (Yarn 1 has none: `npm rebuild` walks its node_modules). The rebuild has the network with
 * `checks_network: true`, or while the dependency files are the base's (a native module's prebuilt download); else
 * it runs offline. Bun has no rebuild: its dependencies' scripts don't run.
 */
export function installSteps(pm: PackageManager, checksNetwork: boolean): PrepareStep[] {
  const download: Record<PackageManager, string> = {
    npm: "npm ci --ignore-scripts",
    pnpm: "pnpm install --frozen-lockfile --ignore-scripts",
    yarn: "yarn install --immutable --mode=skip-build",
    // Yarn 1 opens ~/.npmrc and ~/.yarnrc and fails on the sandbox's EPERM (npm takes it): its home is the run's own temp.
    "yarn-classic": 'test -z "$TMPDIR" || export HOME="$TMPDIR"; yarn install --frozen-lockfile --ignore-scripts',
    bun: "bun install --frozen-lockfile --ignore-scripts",
  };
  const rebuild = pm === "yarn-classic" ? "npm rebuild" : `${pm} rebuild`;
  return [
    { name: "install", cmd: download[pm], network: true },
    ...(pm === "bun" ? [] : [{ name: "install-scripts", cmd: rebuild, network: checksNetwork ? true : ("base-deps" as const) }]),
  ];
}

/** Pure: a dependency manifest or lockfile, at any depth (a workspace's package.json too). */
export const isDependencyFile = (p: string) => DEPENDENCY_FILES.includes(path.basename(p));

/** Whether the worktree's dependency files are the base's, byte for byte: none changed, added or removed since `base`. */
export async function sameDepsAsBase(repo: { gitDir: string; workTree: string }, base: string): Promise<boolean> {
  const git = await openGit(repo);
  const changed = (await git.run(["diff", "--name-only", "--no-renames", base, "--"])).stdout.split("\n").filter(Boolean);
  // Porcelain paths are from the worktree root whatever the cwd (the engine's git runs in the git dir).
  const added = (await git.run(["status", "--porcelain=v1", "--untracked-files=all"])).stdout
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3));
  return ![...changed, ...added].some(isDependencyFile);
}

export const OFFLINE_REBUILD_NOTE =
  "The install scripts ran offline because this job changed its dependency files (a builder's change never gets the network). A package that downloads while it installs (node-pre-gyp, prebuild-install, puppeteer, prisma) fails then. checks_network: true gives the rebuild, the checks and the proofs the network: the builder's code could then reach it too.";

/**
 * What readies a job worktree: the frozen install (`checks_install`), then the person's own `checks_prepare`, which
 * has the network only with `checks_network: true`, as it always had.
 */
export function checksPrepareOf(cfg: Pick<Config, "checks_install" | "checks_prepare" | "checks_network">): ChecksPrepare | undefined {
  const steps = [
    ...(cfg.checks_install ? installSteps(cfg.checks_install, cfg.checks_network) : []),
    ...(cfg.checks_prepare ? [{ name: "checks_prepare", cmd: cfg.checks_prepare, network: cfg.checks_network }] : []),
  ];
  return steps.length ? { cmd: steps.map((s) => s.cmd).join(" && "), steps } : undefined;
}

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
  const job = readJob(o.jobDir);
  const worktree = o.source?.worktree ?? job.worktree;
  const key = prepareKey(o.prepare.cmd, worktree);
  if (readMarker(o.jobDir)[worktree] === key) return null;
  let r: StampedCmd | null = null;
  // Step by step, each with its own network rule; the first that fails stops it.
  for (const s of o.prepare.steps) {
    // A checkout of the base (`source`) has the base's dependencies by definition.
    const network =
      s.network !== "base-deps"
        ? s.network
        : !!o.source || (await sameDepsAsBase({ gitDir: job.gitDir, workTree: worktree }, readJobAt(o.jobDir).base).catch(() => false));
    r = await stampCommand({
      jobDir: o.jobDir,
      name: s.name,
      cmd: s.cmd,
      role: o.role,
      criterion: o.criterion,
      timeoutSec: 1800,
      sandbox: true,
      network,
      ...(o.source ? { source: o.source } : {}),
    });
    if (!r.ok) return s.network === "base-deps" && !network ? { ...r, tail: `${OFFLINE_REBUILD_NOTE}\n${r.tail}` } : r;
  }
  if (!r) return null;
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
