// The engine-owned Toolkit checkout (PLAN §2 "Which bin/dev runs"): a clean,
// detached checkout of the base at `toolkitRef`: `.worktrees/_toolkit@<sha>` in the repo for an untrusted sha,
// `$KITCHEN_HOME/repos/<repo>/checkouts/_trusted@<sha>` for a trusted one (placeOf).
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
import { wrappedBin } from "./sandbox.ts";
import { listSlots } from "./slots.ts";
import { binFor, readApproval, type Trust, trustHome, trustOf } from "./trust.ts";

export const TOOLKIT_BIN = path.join(".kitchen", "toolkit", "bin", "dev");
const PREFIX = "_toolkit@";
/** A trusted checkout's folder name (its git worktree id too: the two kinds never share one). */
const TRUSTED = "_trusted@";
export const short = (sha: string) => sha.slice(0, 12);

/**
 * `release` drops this process's lease; until then (or until the process dies) GC leaves the checkout alone.
 * `bin` is what to run: for a sha neither on the base nor approved (`trust: null`, agent-written code no
 * human has accepted: init's check of kitchen/setup, `toolkit check --rev …`) it is the sandbox-exec wrapper
 * (ADR 0008, 0015; `sandboxed: false` where the OS has none), else the checkout's own bin/dev.
 * `meta`: the folder holding this checkout's prepared marker and leases (with the checkout's own kind, below).
 */
export type Checkout = {
  sha: string;
  dir: string;
  bin: string;
  git: GitRepo;
  trust: Trust | null;
  sandboxed: boolean;
  meta: string;
  release: () => void;
};

/**
 * Where a checkout of `sha` lives (review H1, round 2). Untrusted: in the repo, `.worktrees/_toolkit@<sha12>`, which
 * its sandboxed bin/dev can read. Trusted (on the base or approved): `$KITCHEN_HOME/repos/<repo>/checkouts/_trusted@<sha12>`,
 * which the sandbox denies as a whole, so no untrusted run can plant code (an ignored `node_modules/` file included)
 * in what will run unsandboxed. The two kinds never share a folder, a marker or a lease.
 */
type Place = { id: string; dir: string; meta: string };
function placeOf(repo: string, sha: string, trusted: boolean): Place {
  if (!trusted) {
    const id = `${PREFIX}${short(sha)}`;
    return { id, dir: path.join(repo, ".worktrees", id), meta: path.join(kitchenDir(repo), "toolkit-checkouts") };
  }
  const id = `${TRUSTED}${short(sha)}`;
  return { id, dir: path.join(trustHome(repo), "checkouts", id), meta: path.join(trustHome(repo), "checkouts-meta") };
}
/** Both folders checkouts live in, with their names' prefix and their meta folder. */
const roots = (repo: string) => [
  { root: path.join(repo, ".worktrees"), prefix: PREFIX, meta: path.join(kitchenDir(repo), "toolkit-checkouts") },
  { root: path.join(trustHome(repo), "checkouts"), prefix: TRUSTED, meta: path.join(trustHome(repo), "checkouts-meta") },
];
const markerOf = (meta: string, id: string) => path.join(meta, `${id}.json`);
const leasesOf = (meta: string, id: string) => path.join(meta, `${id}.leases`);
const gcLock = (repo: string) => path.join(kitchenDir(repo), "toolkit-checkouts", "gc.lock");

type Lease = { pid: number; start: string | null; at: string };

function takeLease(p: Place): () => void {
  const dir = leasesOf(p.meta, p.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}-${randomBytes(3).toString("hex")}.json`);
  const lease: Lease = { pid: process.pid, start: processStart(process.pid), at: new Date().toISOString() };
  writeAtomic(file, JSON.stringify(lease));
  return () => fs.rmSync(file, { force: true });
}

/** Whether a live process holds a lease on checkout `id` (its leases in `meta`). Leases of dead owners (or reused pids) are removed. */
export function leased(meta: string, id: string, alive = ownerAlive): boolean {
  const dir = leasesOf(meta, id);
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

export { mergeBaseRef, mergedIntoBase } from "./trust.ts";

/**
 * The checkout of `sha`, created if missing, leased to this process (call `release` when done).
 * Throws if there is no Toolkit at that sha. A sha neither on the base nor approved runs sandboxed (trust.ts).
 */
export async function toolkitCheckout(repo: string, rev: string): Promise<Checkout> {
  repo = fs.realpathSync(repo);
  const sha = await resolveRev(repo, rev);
  fs.mkdirSync(path.dirname(gcLock(repo)), { recursive: true });
  const trust = await trustOf(repo, sha);
  const place = placeOf(repo, sha, !!trust);
  const co = await withFileLock(gcLock(repo), async () => {
    const release = takeLease(place);
    try {
      return { ...(await checkoutOf(repo, sha, place, !!trust)), release };
    } catch (e) {
      release();
      throw e;
    }
  });
  const run = binFor(co.bin, trust);
  return { ...co, bin: run.bin, trust, sandboxed: run.sandboxed, meta: place.meta };
}

/**
 * The checkout of `sha` at `p`. A trusted one is about to run unsandboxed, so it must be exactly the sha (review L8):
 * HEAD is the sha and `git status` is clean; otherwise it is made again. Its ignored files (a trusted `prepare`'s
 * `node_modules/`) can only come from trusted runs: no sandboxed run can reach its folder. The git calls use the
 * engine's own record of the worktree's gitdir, never the checkout's `.git` file.
 */
async function checkoutOf(repo: string, sha: string, p: Place, trusted: boolean): Promise<Omit<Checkout, "release" | "trust" | "sandboxed" | "meta">> {
  const main = await openGit(plainCheckout(repo));
  let git: GitRepo | null = null;
  if (fs.existsSync(p.dir)) {
    try {
      git = linkedWorktree(repo, p.id, p.dir);
      const g = await openGit(git);
      const head = (await g.run(["rev-parse", "HEAD"])).stdout.trim();
      if (head !== sha)
        git = null; // someone moved it: start over
      else if (trusted && (await g.run(["status", "--porcelain", "--untracked-files=all"])).stdout.trim()) git = null; // changed: start from the sha
    } catch {
      git = null;
    }
    if (!git) {
      await removeDir(repo, p.dir);
      fs.rmSync(markerOf(p.meta, p.id), { force: true }); // what was prepared there is gone with it
    }
  }
  if (!git) {
    await main.run(["worktree", "prune"]);
    fs.mkdirSync(path.dirname(p.dir), { recursive: true, mode: 0o700 });
    await main.run(["worktree", "add", "--quiet", "--detach", p.dir, sha]);
    git = linkedWorktree(repo, p.id, p.dir);
  }
  const bin = path.join(git.workTree, TOOLKIT_BIN);
  if (!fs.existsSync(bin)) throw new Error(`no Toolkit at ${short(sha)}: ${TOOLKIT_BIN} is missing (run kitchen init)`);
  return { sha, dir: git.workTree, bin, git };
}

type Marker = { sha: string; prepared: Record<string, { at: string; secs: number }> };

function readMarker(co: Pick<Checkout, "sha" | "dir" | "meta">): Marker {
  try {
    return JSON.parse(fs.readFileSync(markerOf(co.meta, path.basename(co.dir)), "utf8")) as Marker;
  } catch {
    return { sha: co.sha, prepared: {} };
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

const preparedIndex = (meta: string) => path.join(meta, "prepared.json");
type PreparedIndex = Record<string, { key: string; sha: string; at: string; secs: number }>;
function readIndex(meta: string): PreparedIndex {
  try {
    return JSON.parse(fs.readFileSync(preparedIndex(meta), "utf8")) as PreparedIndex;
  } catch {
    return {};
  }
}
const toolkitDirOf = (co: Pick<Checkout, "dir">) => path.join(co.dir, ".kitchen", "toolkit");

/** `prepare --src` ran with this checkout (its own kind's records: a trusted checkout's never come from an untrusted run). */
export function markPrepared(co: Pick<Checkout, "sha" | "dir" | "meta">, src: string, secs: number) {
  const m = readMarker(co);
  const at = new Date().toISOString();
  m.prepared[path.resolve(src)] = { at, secs };
  fs.mkdirSync(co.meta, { recursive: true });
  writeAtomic(markerOf(co.meta, path.basename(co.dir)), JSON.stringify(m, null, 2));
  const key = prepareKey(src, toolkitDirOf(co));
  if (key) {
    const idx = readIndex(co.meta);
    idx[path.resolve(src)] = { key, sha: co.sha, at, secs };
    writeAtomic(preparedIndex(co.meta), JSON.stringify(idx, null, 2));
  }
}

/** Prepared for this checkout, or (where the source has lockfiles) with the same lockfiles under another checkout of its kind. */
export function isPrepared(co: Pick<Checkout, "sha" | "dir" | "meta">, src: string): boolean {
  if (readMarker(co).prepared[path.resolve(src)]) return true;
  const hit = readIndex(co.meta)[path.resolve(src)];
  return !!hit && hit.key === prepareKey(src, toolkitDirOf(co));
}

/** `prepare --src` with this checkout's bin/dev, once per checkout and source. */
export async function ensurePrepared(_repo: string, co: Checkout, src: string): Promise<{ cached: boolean; secs: number }> {
  if (isPrepared(co, src)) return { cached: true, secs: 0 };
  const t0 = Date.now();
  const r = await runToolkit(co.bin, ["prepare", `--src=${src}`], { src, timeoutMs: 30 * 60_000, stallMs: 5 * 60_000 });
  const v = validate("prepare", r.json);
  if (!v.ok || r.exit !== 0) throw new Error(`prepare failed: ${v.ok ? `exit ${r.exit}` : v.why} ${r.stderr.slice(-400)}`);
  const secs = (Date.now() - t0) / 1000;
  markPrepared(co, src, secs);
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

/** The sha12s some job, the proven record or the approval still needs. */
export function referencedShas(repo: string, proven: string | null): Set<string> {
  const keep = new Set<string>();
  if (proven) keep.add(short(proven));
  const approved = readApproval(repo)?.sha;
  if (approved) keep.add(short(approved));
  for (const j of listJobs(repo)) if (j.toolkitRef && (isActive(j.stage) || j.stage === "paused")) keep.add(short(j.toolkitRef));
  return keep;
}

/** The checkout folder names of this repo (either kind) whose bin/dev a live slot runs (shared registry: only this repo's paths count). */
export function slotShas(repo: string, slots = listSlots(), alive = ownerAlive): Set<string> {
  repo = fs.realpathSync(repo);
  const out = new Set<string>();
  for (const s of slots) {
    if (!alive({ pid: s.pid, start: s.pidStart ?? null })) continue;
    let bin = wrappedBin(s.toolkitBin) ?? s.toolkitBin; // a sandboxed run's wrapper names the checkout's bin/dev
    try {
      bin = fs.realpathSync(bin);
    } catch {}
    for (const r of roots(repo)) {
      let root = r.root;
      try {
        root = fs.realpathSync(root);
      } catch {}
      if (!bin.startsWith(root + path.sep)) continue;
      const m = new RegExp(`^${r.prefix}([0-9a-f]{12})$`).exec(bin.slice(root.length + 1).split(path.sep)[0]);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

/**
 * Remove every checkout (either kind) whose sha is not in `keep`, not leased by a live process and not run by a live
 * slot. Returns the removed sha12s.
 */
export async function gcCheckouts(repo: string, keep: Set<string>): Promise<string[]> {
  repo = fs.realpathSync(repo);
  fs.mkdirSync(path.dirname(gcLock(repo)), { recursive: true });
  return withFileLock(gcLock(repo), async () => {
    const gone: string[] = [];
    const inSlots = slotShas(repo);
    for (const r of roots(repo)) {
      if (!fs.existsSync(r.root)) continue;
      for (const name of fs.readdirSync(r.root)) {
        if (!name.startsWith(r.prefix)) continue;
        const sha = name.slice(r.prefix.length);
        if (keep.has(sha) || inSlots.has(sha) || leased(r.meta, name)) continue;
        await removeDir(repo, path.join(r.root, name));
        fs.rmSync(markerOf(r.meta, name), { force: true });
        fs.rmSync(leasesOf(r.meta, name), { recursive: true, force: true });
        gone.push(sha);
      }
    }
    return gone;
  });
}
