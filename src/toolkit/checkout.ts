// The engine-owned Toolkit checkout (PLAN §2 "Which bin/dev runs"): a clean,
// detached checkout of the base at `toolkitRef`, `.worktrees/_toolkit@<sha>`.
// Primitives always resolve from it, never from the user's main checkout (which
// may be dirty or on another branch). `prepare` readies it (Playwright, browser
// binaries…) together with a source tree, and is cached per sha and source.
// A checkout no live job and no `toolkit.proven` points at is removed when
// `kitchen run` starts, unless a process still uses it: every user takes a lease
// (owner pid + start time, released when done; a dead owner's lease is void),
// and a live slot whose bin/dev is in it counts as a user too. Creating a
// checkout and removing one happen under one per-repo lock, so a checkout is
// never removed between its lease and its use. Every git call goes through engine/git.ts.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type GitRepo, linkedWorktree, openGit, plainCheckout } from "../engine/git.ts";
import { isActive } from "../engine/machine.ts";
import { kitchenDir, listJobs, writeAtomic } from "../engine/store.ts";
import { ownerAlive, processStart, withFileLock } from "../lock.ts";
import { validate } from "./contract.ts";
import { runToolkit } from "./run.ts";
import { sandboxedBin, wrappedBin } from "./sandbox.ts";
import { listSlots } from "./slots.ts";

export const TOOLKIT_BIN = path.join(".kitchen", "toolkit", "bin", "dev");
const PREFIX = "_toolkit@";
export const short = (sha: string) => sha.slice(0, 12);

/**
 * `release` drops this process's lease; until then (or until the process dies) GC leaves the checkout alone.
 * `bin` is what to run: for a sha not merged into the base (`merged: false`, agent-written code no human
 * has reviewed: init's check of kitchen/setup, `toolkit check --rev …`) it is the sandbox-exec wrapper
 * (ADR 0008; `sandboxed: false` where the OS has none), else the checkout's own bin/dev.
 */
export type Checkout = { sha: string; dir: string; bin: string; git: GitRepo; merged: boolean; sandboxed: boolean; release: () => void };

const checkoutsRoot = (repo: string) => path.join(repo, ".worktrees");
const markerOf = (repo: string, sha: string) => path.join(kitchenDir(repo), "toolkit-checkouts", `${short(sha)}.json`);
const leasesOf = (repo: string, sha12: string) => path.join(kitchenDir(repo), "toolkit-checkouts", `${sha12}.leases`);
const gcLock = (repo: string) => path.join(kitchenDir(repo), "toolkit-checkouts", "gc.lock");

type Lease = { pid: number; start: string | null; at: string };

function takeLease(repo: string, sha: string): () => void {
  const dir = leasesOf(repo, short(sha));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}-${randomBytes(3).toString("hex")}.json`);
  const lease: Lease = { pid: process.pid, start: processStart(process.pid), at: new Date().toISOString() };
  writeAtomic(file, JSON.stringify(lease));
  return () => fs.rmSync(file, { force: true });
}

/** Whether a live process holds a lease on the checkout of `sha12`. Leases of dead owners (or reused pids) are removed. */
export function leased(repo: string, sha12: string, alive = ownerAlive): boolean {
  const dir = leasesOf(repo, sha12);
  if (!fs.existsSync(dir)) return false;
  let any = false;
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    let l: Lease | null = null;
    try {
      l = JSON.parse(fs.readFileSync(f, "utf8")) as Lease;
    } catch {}
    if (l && Number.isInteger(l.pid) && alive({ pid: l.pid, start: l.start })) any = true;
    else fs.rmSync(f, { force: true });
  }
  return any;
}

/** A full commit sha for a rev of the main repo (HEAD, a branch, a sha). */
export async function resolveRev(repo: string, rev: string): Promise<string> {
  const git = await openGit(plainCheckout(repo));
  return (await git.run(["rev-parse", "--verify", `${rev}^{commit}`])).stdout.trim();
}

/**
 * Whether `sha` is merged: an ancestor of the base, so a human has taken it in. The base is the
 * main checkout's HEAD, or (GitHub forge) the remote base the engine last fetched, `refs/kitchen/base`.
 */
export async function mergedIntoBase(repo: string, sha: string): Promise<boolean> {
  const git = await openGit(plainCheckout(repo));
  for (const base of ["HEAD", "refs/kitchen/base"]) {
    try {
      await git.run(["merge-base", "--is-ancestor", sha, base]);
      return true;
    } catch {} // exit 1 (not an ancestor), or no such ref: not merged there
  }
  return false;
}

/**
 * The checkout of `sha`, created if missing, leased to this process (call `release` when done).
 * Throws if the base has no Toolkit at that sha. A sha not merged into the base runs sandboxed (ADR 0008).
 */
export async function toolkitCheckout(repo: string, rev: string): Promise<Checkout> {
  repo = fs.realpathSync(repo);
  const sha = await resolveRev(repo, rev);
  fs.mkdirSync(path.dirname(gcLock(repo)), { recursive: true });
  const co = await withFileLock(gcLock(repo), async () => {
    const release = takeLease(repo, sha);
    try {
      return { ...(await checkoutOf(repo, sha)), release };
    } catch (e) {
      release();
      throw e;
    }
  });
  if (await mergedIntoBase(repo, sha)) return { ...co, merged: true, sandboxed: false };
  const sb = sandboxedBin(co.bin);
  return { ...co, bin: sb.bin, merged: false, sandboxed: sb.sandboxed };
}

async function checkoutOf(repo: string, sha: string): Promise<Omit<Checkout, "release" | "merged" | "sandboxed">> {
  const id = `${PREFIX}${short(sha)}`;
  const dir = path.join(checkoutsRoot(repo), id);
  const main = await openGit(plainCheckout(repo));
  let git: GitRepo | null = null;
  if (fs.existsSync(dir)) {
    try {
      git = linkedWorktree(repo, id, dir);
      const head = (await (await openGit(git)).run(["rev-parse", "HEAD"])).stdout.trim();
      if (head !== sha) git = null; // someone moved it: start over
    } catch {
      git = null;
    }
    if (!git) await removeDir(repo, dir);
  }
  if (!git) {
    await main.run(["worktree", "prune"]);
    fs.mkdirSync(checkoutsRoot(repo), { recursive: true });
    await main.run(["worktree", "add", "--quiet", "--detach", dir, sha]);
    git = linkedWorktree(repo, id, dir);
  }
  const bin = path.join(git.workTree, TOOLKIT_BIN);
  if (!fs.existsSync(bin)) throw new Error(`no Toolkit at ${short(sha)}: ${TOOLKIT_BIN} is missing (run kitchen init)`);
  return { sha, dir: git.workTree, bin, git };
}

type Marker = { sha: string; prepared: Record<string, { at: string; secs: number }> };

function readMarker(repo: string, sha: string): Marker {
  try {
    return JSON.parse(fs.readFileSync(markerOf(repo, sha), "utf8")) as Marker;
  } catch {
    return { sha, prepared: {} };
  }
}

/** Lockfiles whose content decides what `prepare` installs: the app's (at the source root) and the Toolkit's own. */
const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "requirements.txt",
  "Gemfile.lock",
  "go.sum",
  "Cargo.lock",
  "composer.lock",
];

/**
 * The hash `prepare` is cached by for a source tree: its lockfiles, the
 * Toolkit's package files (from the checkout that runs it), and the tree's
 * identity (a worktree removed and made again at the same path is new).
 * null when the source has no lockfile: then the cache is per Toolkit sha.
 */
export function prepareKey(src: string, toolkitDir: string): string | null {
  const h = createHash("sha256");
  let any = false;
  for (const f of LOCKFILES) {
    const p = path.join(src, f);
    if (!fs.existsSync(p)) continue;
    any = true;
    h.update(`${f}\0`).update(fs.readFileSync(p)).update("\0");
  }
  if (!any) return null;
  for (const f of ["package.json", "package-lock.json"]) {
    const p = path.join(toolkitDir, f);
    if (fs.existsSync(p)) h.update(`toolkit/${f}\0`).update(fs.readFileSync(p)).update("\0");
  }
  try {
    h.update(`birth:${fs.statSync(src).birthtimeMs}`);
  } catch {}
  return h.digest("hex");
}

const preparedIndex = (repo: string) => path.join(kitchenDir(repo), "toolkit-checkouts", "prepared.json");
type PreparedIndex = Record<string, { key: string; sha: string; at: string; secs: number }>;
function readIndex(repo: string): PreparedIndex {
  try {
    return JSON.parse(fs.readFileSync(preparedIndex(repo), "utf8")) as PreparedIndex;
  } catch {
    return {};
  }
}
const toolkitDirOf = (repo: string, sha: string) => path.join(checkoutsRoot(fs.realpathSync(repo)), `${PREFIX}${short(sha)}`, ".kitchen", "toolkit");

export function markPrepared(repo: string, sha: string, src: string, secs: number) {
  const m = readMarker(repo, sha);
  const at = new Date().toISOString();
  m.prepared[path.resolve(src)] = { at, secs };
  writeAtomic(markerOf(repo, sha), JSON.stringify(m, null, 2));
  const key = prepareKey(src, toolkitDirOf(repo, sha));
  if (key) {
    const idx = readIndex(repo);
    idx[path.resolve(src)] = { key, sha, at, secs };
    writeAtomic(preparedIndex(repo), JSON.stringify(idx, null, 2));
  }
}

/** Prepared for this Toolkit sha, or (where the source has lockfiles) with the same lockfiles under any Toolkit sha. */
export function isPrepared(repo: string, sha: string, src: string): boolean {
  if (readMarker(repo, sha).prepared[path.resolve(src)]) return true;
  const hit = readIndex(repo)[path.resolve(src)];
  return !!hit && hit.key === prepareKey(src, toolkitDirOf(repo, sha));
}

/** `prepare --src` with this checkout's bin/dev, once per sha and source. */
export async function ensurePrepared(repo: string, co: Checkout, src: string): Promise<{ cached: boolean; secs: number }> {
  if (isPrepared(repo, co.sha, src)) return { cached: true, secs: 0 };
  const t0 = Date.now();
  const r = await runToolkit(co.bin, ["prepare", `--src=${src}`], { src, timeoutMs: 30 * 60_000, stallMs: 5 * 60_000 });
  const v = validate("prepare", r.json);
  if (!v.ok || r.exit !== 0) throw new Error(`prepare failed: ${v.ok ? `exit ${r.exit}` : v.why} ${r.stderr.slice(-400)}`);
  const secs = (Date.now() - t0) / 1000;
  markPrepared(repo, co.sha, src, secs);
  return { cached: false, secs };
}

async function removeDir(repo: string, dir: string) {
  const main = await openGit(plainCheckout(repo));
  try {
    await main.run(["worktree", "remove", "--force", "--force", dir]);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await main.run(["worktree", "prune"]);
}

/** The sha12s some job or the proven record still needs. */
export function referencedShas(repo: string, proven: string | null): Set<string> {
  const keep = new Set<string>();
  if (proven) keep.add(short(proven));
  for (const j of listJobs(repo)) if (j.toolkitRef && (isActive(j.stage) || j.stage === "paused")) keep.add(short(j.toolkitRef));
  return keep;
}

/** The sha12s of this repo's checkouts whose bin/dev a live slot runs (shared registry: only paths under this repo count). */
export function slotShas(repo: string, slots = listSlots(), alive = ownerAlive): Set<string> {
  const root = checkoutsRoot(fs.realpathSync(repo)) + path.sep;
  const out = new Set<string>();
  for (const s of slots) {
    if (!alive({ pid: s.pid, start: s.pidStart ?? null })) continue;
    let bin = wrappedBin(s.toolkitBin) ?? s.toolkitBin; // a sandboxed run's wrapper names the checkout's bin/dev
    try {
      bin = fs.realpathSync(bin);
    } catch {}
    if (!bin.startsWith(root)) continue;
    const m = new RegExp(`^${PREFIX}([0-9a-f]{12})$`).exec(bin.slice(root.length).split(path.sep)[0]);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Remove every `_toolkit@<sha>` checkout not in `keep`, not leased by a live
 * process and not run by a live slot. Returns the removed sha12s.
 */
export async function gcCheckouts(repo: string, keep: Set<string>): Promise<string[]> {
  repo = fs.realpathSync(repo);
  const root = checkoutsRoot(repo);
  if (!fs.existsSync(root)) return [];
  fs.mkdirSync(path.dirname(gcLock(repo)), { recursive: true });
  return withFileLock(gcLock(repo), async () => {
    const gone: string[] = [];
    const inSlots = slotShas(repo);
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith(PREFIX)) continue;
      const sha = name.slice(PREFIX.length);
      if (keep.has(sha) || inSlots.has(sha) || leased(repo, sha)) continue;
      await removeDir(repo, path.join(root, name));
      fs.rmSync(path.join(kitchenDir(repo), "toolkit-checkouts", `${sha}.json`), { force: true });
      fs.rmSync(leasesOf(repo, sha), { recursive: true, force: true });
      gone.push(sha);
    }
    return gone;
  });
}
