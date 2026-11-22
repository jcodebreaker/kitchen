// The engine-owned Toolkit checkout (PLAN §2 "Which bin/dev runs"): a clean,
// detached checkout of the base at `toolkitRef`, `.worktrees/_toolkit@<sha>`.
// Primitives always resolve from it, never from the user's main checkout (which
// may be dirty or on another branch). `prepare` readies it (Playwright, browser
// binaries…) together with a source tree, and is cached per sha and source.
// A checkout no live job and no `toolkit.proven` points at is removed when
// `kitchen run` starts. Every git call goes through engine/git.ts.
import fs from "node:fs";
import path from "node:path";
import { type GitRepo, linkedWorktree, openGit, plainCheckout } from "../engine/git.ts";
import { isActive } from "../engine/machine.ts";
import { kitchenDir, listJobs, writeAtomic } from "../engine/store.ts";
import { validate } from "./contract.ts";
import { runToolkit } from "./run.ts";

export const TOOLKIT_BIN = path.join(".kitchen", "toolkit", "bin", "dev");
const PREFIX = "_toolkit@";
export const short = (sha: string) => sha.slice(0, 12);

export type Checkout = { sha: string; dir: string; bin: string; git: GitRepo };

const checkoutsRoot = (repo: string) => path.join(repo, ".worktrees");
const markerOf = (repo: string, sha: string) => path.join(kitchenDir(repo), "toolkit-checkouts", `${short(sha)}.json`);

/** A full commit sha for a rev of the main repo (HEAD, a branch, a sha). */
export async function resolveRev(repo: string, rev: string): Promise<string> {
  const git = await openGit(plainCheckout(repo));
  return (await git.run(["rev-parse", "--verify", `${rev}^{commit}`])).stdout.trim();
}

/** The checkout of `sha`, created if missing. Throws if the base has no Toolkit at that sha. */
export async function toolkitCheckout(repo: string, rev: string): Promise<Checkout> {
  repo = fs.realpathSync(repo);
  const sha = await resolveRev(repo, rev);
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

export function markPrepared(repo: string, sha: string, src: string, secs: number) {
  const m = readMarker(repo, sha);
  m.prepared[path.resolve(src)] = { at: new Date().toISOString(), secs };
  writeAtomic(markerOf(repo, sha), JSON.stringify(m, null, 2));
}

export const isPrepared = (repo: string, sha: string, src: string) => !!readMarker(repo, sha).prepared[path.resolve(src)];

/** `prepare --src` with this checkout's bin/dev, once per sha and source. */
export async function ensurePrepared(repo: string, co: Checkout, src: string): Promise<{ cached: boolean; secs: number }> {
  if (isPrepared(repo, co.sha, src)) return { cached: true, secs: 0 };
  const t0 = Date.now();
  const r = await runToolkit(co.bin, ["prepare", `--src=${src}`], { src, timeoutMs: 30 * 60_000 });
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

/** Remove every `_toolkit@<sha>` checkout not in `keep`. Returns the removed sha12s. */
export async function gcCheckouts(repo: string, keep: Set<string>): Promise<string[]> {
  const root = checkoutsRoot(repo);
  if (!fs.existsSync(root)) return [];
  const gone: string[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const sha = name.slice(PREFIX.length);
    if (keep.has(sha)) continue;
    await removeDir(repo, path.join(root, name));
    fs.rmSync(path.join(kitchenDir(repo), "toolkit-checkouts", `${sha}.json`), { force: true });
    gone.push(sha);
  }
  return gone;
}
