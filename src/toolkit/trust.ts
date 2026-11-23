// Which Toolkit sha Kitchen trusts to run unsandboxed (ADR 0015, amending ADR 0008): one on the base
// (an ancestor of it: a human took it in), or the one the person approved (.kitchen/toolkit.approved,
// gitignored, pinned to a sha). Anything else, the setup bridge's uncommitted worktree included, runs
// under sandbox-exec. Every caller asks `trustOf` and runs `binFor`'s answer: toolkitCheckout (jobs,
// `toolkit check`, `toolkit up`, maintain, the re-proof), and the setup bridge.
// Also the record of shas that passed a full `toolkit check` (.kitchen/toolkit.passed): approval
// takes only one of those.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { BASE_REF } from "../engine/base.ts";
import { openGit, plainCheckout } from "../engine/git.ts";
import { kitchenDir, writeAtomic } from "../engine/store.ts";
import { sandboxedBin } from "./sandbox.ts";

/** Why a sha is trusted: it is on the base, or the person approved it. */
export type Trust = "base" | "approved";
export type Approval = { sha: string; at: string; by: string };

export const approvedFile = (repo: string) => path.join(kitchenDir(repo), "toolkit.approved");
export const passedFile = (repo: string) => path.join(kitchenDir(repo), "toolkit.passed");

export function readApproval(repo: string): Approval | null {
  try {
    const a = JSON.parse(fs.readFileSync(approvedFile(repo), "utf8")) as Approval;
    return typeof a?.sha === "string" && /^[0-9a-f]{40}$/.test(a.sha) ? a : null;
  } catch {
    return null;
  }
}

export function writeApproval(repo: string, sha: string, by = "you"): Approval {
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

type Passed = { sha: string; at: string }[];
function readPassed(repo: string): Passed {
  try {
    const v = JSON.parse(fs.readFileSync(passedFile(repo), "utf8")) as Passed;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
/** A full `toolkit check` of `sha` passed (the last 50 kept); the file stays out of git status (ensureIgnored). */
export async function recordPassed(repo: string, sha: string): Promise<void> {
  await ensureIgnored(repo).catch(() => {});
  const list = readPassed(repo).filter((p) => p.sha !== sha);
  list.push({ sha, at: new Date().toISOString() });
  writeAtomic(passedFile(repo), `${JSON.stringify(list.slice(-50), null, 2)}\n`);
}
export const hasPassed = (repo: string, sha: string) => readPassed(repo).some((p) => p.sha === sha);

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

/**
 * The approval and passed records are Kitchen's state, never the person's history: a repo set up before they
 * existed lacks their .gitignore lines, so a path git doesn't ignore yet goes into the repo's own
 * info/exclude (untracked, so `git status` stays clean without touching .gitignore).
 */
export async function ensureIgnored(repo: string): Promise<void> {
  const g = await openGit(plainCheckout(repo));
  const missing: string[] = [];
  for (const rel of [".kitchen/toolkit.approved", ".kitchen/toolkit.passed"])
    await g.run(["check-ignore", "-q", "--no-index", rel]).catch(() => {
      missing.push(rel);
    });
  if (!missing.length) return;
  const common = (await g.run(["rev-parse", "--git-common-dir"])).stdout.trim();
  const file = path.join(path.isAbsolute(common) ? common : path.join(g.repo.gitDir, common), "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.appendFileSync(file, `${have && !have.endsWith("\n") ? "\n" : ""}# Kitchen (ADR 0015)\n${missing.join("\n")}\n`);
}
