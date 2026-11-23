// Which Toolkit sha Kitchen trusts to run unsandboxed (ADR 0015, amending ADR 0008): one on the base
// (an ancestor of it: a human took it in), or the one the person approved (pinned to a sha). Anything
// else, the setup bridge's uncommitted worktree included, runs under sandbox-exec. Every caller asks
// `trustOf` and runs `binFor`'s answer: toolkitCheckout (jobs, `toolkit check`, `toolkit up`, maintain,
// the re-proof), and the setup bridge.
// The records that make a sha trusted live outside the repo (review H1, round 2): the approval, the shas
// that passed a full `toolkit check` (approval takes only one of those, and the offers among them), and
// toolkit.proven are in $KITCHEN_HOME/repos/<hash of the repo's real path>/, with the trusted Toolkit
// checkouts. The sandbox denies $KITCHEN_HOME as a whole, and no folder above it can be renamed from
// inside the sandbox, so an untrusted bin/dev can't move a record aside and write its own.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { BASE_REF } from "../engine/base.ts";
import { openGit, plainCheckout } from "../engine/git.ts";
import { kitchenDir, writeAtomic } from "../engine/store.ts";
import { ensureHome, kitchenHome } from "../home.ts";
import { sandboxedBin } from "./sandbox.ts";

const RECORDS = ["toolkit.approved", "toolkit.passed", "toolkit.proven"] as const;

/** The repo's real path (what the folder in $KITCHEN_HOME is keyed by). */
function realRepo(repo: string): string {
  try {
    return fs.realpathSync(repo);
  } catch {
    return path.resolve(repo);
  }
}

/**
 * $KITCHEN_HOME/repos/<hash>/: this repo's trust records and trusted Toolkit checkouts (made 0700 when first written:
 * `trustHomeMade`). The first use moves the records a repo kept in `.kitchen/` before, once: after that they are
 * never read from the repo again. A repo with nothing to move and nothing written yet leaves no folder behind.
 */
export function trustHome(repo: string): string {
  const real = realRepo(repo);
  const dir = path.join(kitchenHome(), "repos", createHash("sha256").update(real).digest("hex").slice(0, 16));
  if (fs.existsSync(path.join(dir, "migrated"))) return dir;
  const old = RECORDS.map((f) => path.join(kitchenDir(real), f)).filter((f) => fs.existsSync(f));
  if (!old.length && !fs.existsSync(dir)) return dir; // nothing to move: made by the first write
  trustHomeMade(dir, real);
  for (const f of old) {
    const to = path.join(dir, path.basename(f));
    if (!fs.existsSync(to)) fs.copyFileSync(f, to);
    fs.rmSync(f, { force: true });
  }
  return dir;
}
/** The folder made (0700, in a 0700 $KITCHEN_HOME), with its repo noted, and marked migrated: no in-repo record counts from now on. */
function trustHomeMade(dir: string, real: string) {
  if (fs.existsSync(path.join(dir, "migrated"))) return;
  ensureHome(path.dirname(path.dirname(dir)));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(path.join(dir, "repo"), `${real}\n`);
  writeAtomic(path.join(dir, "migrated"), `${new Date().toISOString()}\n`);
}
/** The repo's trust folder, made if missing: for a write. */
export function trustHomeForWrite(repo: string): string {
  const dir = trustHome(repo);
  trustHomeMade(dir, realRepo(repo));
  return dir;
}
/** One of the repo's trust records, in $KITCHEN_HOME (never `.kitchen/` in the repo). */
export const trustFile = (repo: string, name: (typeof RECORDS)[number]) => path.join(trustHome(repo), name);

/** Why a sha is trusted: it is on the base, or the person approved it. */
export type Trust = "base" | "approved";
export type Approval = { sha: string; at: string; by: string };

export const approvedFile = (repo: string) => trustFile(repo, "toolkit.approved");
export const passedFile = (repo: string) => trustFile(repo, "toolkit.passed");

export function readApproval(repo: string): Approval | null {
  try {
    const a = JSON.parse(fs.readFileSync(approvedFile(repo), "utf8")) as Approval;
    return typeof a?.sha === "string" && /^[0-9a-f]{40}$/.test(a.sha) ? a : null;
  } catch {
    return null;
  }
}

export function writeApproval(repo: string, sha: string, by = "you"): Approval {
  trustHomeForWrite(repo);
  const a: Approval = { sha, at: new Date().toISOString(), by };
  writeAtomic(approvedFile(repo), `${JSON.stringify(a, null, 2)}\n`);
  return a;
}

/** Removes the approval; returns the sha it named, or null. */
export function clearApproval(repo: string): string | null {
  const a = readApproval(repo);
  fs.rmSync(approvedFile(repo), { force: true });
  return a?.sha ?? null;
}

/**
 * `offer`: a new Toolkit sha offered to the person for approval, and what made it: `kitchen/setup` (a build),
 * `toolkit maintain`, or the smith filling a gap. A re-proof of the base is no offer.
 */
export type PassedEntry = { sha: string; at: string; offer?: string };
type Passed = PassedEntry[];
function readPassed(repo: string): Passed {
  try {
    const v = JSON.parse(fs.readFileSync(passedFile(repo), "utf8")) as Passed;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
/** A full `toolkit check` of `sha` passed (the last 50 kept). */
export async function recordPassed(repo: string, sha: string, offer?: string): Promise<void> {
  trustHomeForWrite(repo);
  const old = readPassed(repo).find((p) => p.sha === sha);
  const list = readPassed(repo).filter((p) => p.sha !== sha);
  const label = offer ?? old?.offer;
  list.push({ sha, at: new Date().toISOString(), ...(label ? { offer: label } : {}) });
  writeAtomic(passedFile(repo), `${JSON.stringify(list.slice(-50), null, 2)}\n`);
}
export const hasPassed = (repo: string, sha: string) => readPassed(repo).some((p) => p.sha === sha);
/** The newest sha offered for approval (a build, a maintain fix, the smith's), or null. */
export const latestOffer = (repo: string): PassedEntry | null =>
  readPassed(repo)
    .filter((p) => p.offer)
    .at(-1) ?? null;

/**
 * The ref "on the base" is measured against: the main checkout's HEAD (local and fake forges), or on the
 * GitHub forge only the remote base the engine last fetched, `refs/kitchen/base`, never the local
 * HEAD: a branch merged in someone's local checkout but not on the remote has not been taken in.
 * A kitchen.yaml that doesn't parse counts as the GitHub case (the stricter one). Pure but for the file read.
 */
export function mergeBaseRef(repo: string): string {
  try {
    return loadConfig(repo).forge.kind === "github" ? BASE_REF : "HEAD";
  } catch {
    return BASE_REF;
  }
}

/** Whether `sha` is an ancestor of the base (`mergeBaseRef`). No such ref (the base never fetched): no. */
export async function mergedIntoBase(repo: string, sha: string): Promise<boolean> {
  const git = await openGit(plainCheckout(repo));
  try {
    await git.run(["merge-base", "--is-ancestor", sha, mergeBaseRef(repo)]);
    return true;
  } catch {
    return false; // exit 1 (not an ancestor), or no such ref
  }
}

/** THE trust predicate: a full sha runs unsandboxed only if it is on the base or approved; null: sandboxed. */
export async function trustOf(repo: string, sha: string): Promise<Trust | null> {
  if (!sha) return null;
  if (await mergedIntoBase(repo, sha)) return "base";
  return readApproval(repo)?.sha === sha ? "approved" : null;
}

/** What to run for a bin/dev of this trust: itself when trusted, else the sandbox-exec wrapper (`sandboxed: false` where the OS has none). */
export function binFor(bin: string, trust: Trust | null): { bin: string; sandboxed: boolean } {
  return trust ? { bin, sandboxed: false } : sandboxedBin(bin);
}

/** Pure: how a run of an untrusted sha is announced. */
export const untrustedNote = (sha: string, sandboxed: boolean) =>
  `${sha.slice(0, 12)} is neither on the base nor approved: bin/dev runs ${sandboxed ? "under sandbox-exec" : "UNSANDBOXED: no OS sandbox on this platform"} (ADR 0008, 0015)`;
