// The person's say over the Toolkit (ADR 0015): approve a proven sha so every job runs the app with
// it, revoke that, or commit it into the base to share it. Running Kitchen locally never needs a
// merge, a commit or a push: approval is a gitignored file (.kitchen/toolkit.approved) pinned to a
// sha, and jobs read it (engine/job-toolkit.ts). `kitchen toolkit approve|revoke|commit` and the
// dashboard's Approve button call these functions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Config, loadConfig } from "../config.ts";
import { toolkitAt } from "../engine/base.ts";
import { GitError, openGit, plainCheckout } from "../engine/git.ts";
import { wakeWithToolkit } from "../engine/no-toolkit.ts";
import { moveJob } from "../engine/runner.ts";
import { listJobs } from "../engine/store.ts";
import type { Forge } from "../forge/forge.ts";
import { readInitState } from "../init/build.ts";
import { runningInit } from "../init/status.ts";
import { clearApproval, ensureIgnored, hasPassed, mergedIntoBase, readApproval, writeApproval } from "./trust.ts";

type Out = (l: string) => void;
export const SETUP_REF = "refs/heads/kitchen/setup";
const IDENTITY = { GIT_AUTHOR_NAME: "Kitchen", GIT_AUTHOR_EMAIL: "kitchen@localhost", GIT_COMMITTER_NAME: "Kitchen", GIT_COMMITTER_EMAIL: "kitchen@localhost" };
/** What a commit of the Toolkit carries: nothing else of kitchen/setup. */
export const TOOLKIT_PATHS = [".kitchen/toolkit", ".env.kitchen"];
/** The same as pathspecs from the top: engine git runs with the gitdir as its cwd, inside the work tree of a plain checkout. */
const TOP = (paths: string[]) => paths.map((p) => `:(top)${p}`);

/** The two ways on from a proven Toolkit, as every message says them (ADR 0015). */
export const APPROVE_HOW = "approve it (kitchen toolkit approve), or commit it to share with your team (kitchen toolkit commit)";

/**
 * Where the Toolkit stands, for the words people see. Sync (status and the dashboard read it per row):
 * the build's state (.kitchen/init), the approval file and the passed record, no git.
 * - building: `kitchen toolkit build` is running;
 * - waiting: the build proved a sha on kitchen/setup that is not approved yet (a rebuild of an approved one too);
 * - approved: jobs use the approved sha;
 * - base: the base had a Toolkit when it was built (`existing`), so jobs take it from there;
 * - none: nothing built.
 */
export type ToolkitState = { state: "building" | "waiting" | "approved" | "base" | "none"; sha?: string; approved?: string };
export function toolkitState(repo: string): ToolkitState {
  const approved = readApproval(repo)?.sha;
  if (runningInit(repo)) return { state: "building", ...(approved ? { approved } : {}) };
  const st = readInitState(repo);
  const check = st?.steps.check;
  if (check?.ok && !check.static && !st?.steps.template?.existing && check.sha !== approved && hasPassed(repo, check.sha))
    return { state: "waiting", sha: check.sha, ...(approved ? { approved } : {}) };
  if (approved) return { state: "approved", sha: approved, approved };
  if (check?.ok && st?.steps.template?.existing) return { state: "base", sha: check.sha };
  return { state: "none" };
}

/** Pure: what a job paused no-toolkit says, from the Toolkit's state now (computed when it is shown). */
export function noToolkitWords(t: ToolkitState): string {
  if (t.state === "waiting")
    return `This ticket needs Kitchen to drive the app, and a proven Toolkit is waiting for you: ${APPROVE_HOW}. The job wakes by itself.`;
  if (t.state === "building")
    return "This ticket needs Kitchen to drive the app; the Toolkit is being built (kitchen toolkit build --status). Approve it when it is proven and the job wakes by itself.";
  if (t.state === "approved" || t.state === "base")
    return "This ticket needs Kitchen to drive the app; a Toolkit is ready, and the job wakes on the runner's next pass (kitchen run).";
  return "This ticket needs Kitchen to drive the app; run `kitchen toolkit build` (about 3–15 min), then approve it. The job wakes by itself.";
}

/** Pure: the sidebar's / status's one word on the Toolkit. */
export function toolkitLabel(t: ToolkitState): string {
  return t.state === "waiting"
    ? "proven · waiting for approval"
    : t.state === "approved"
      ? "approved"
      : t.state === "base"
        ? "proven"
        : t.state === "building"
          ? "being built"
          : "not built";
}

async function resolve(repo: string, rev: string): Promise<string | null> {
  try {
    return (await (await openGit(plainCheckout(repo))).run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Waiting no-toolkit jobs that can take a Toolkit now are woken (the runner does the same each pass). Returns how many. */
export async function wakeWaiting(repo: string): Promise<number> {
  const cfg = loadConfig(repo);
  let n = 0;
  for (const job of listJobs(repo)) {
    if (job.stage !== "paused" || job.waitFor !== "no-toolkit" || !job.pausedFrom) continue;
    const w = await wakeWithToolkit(repo, cfg, job).catch(() => ({ toolkit: false }) as const);
    if (!w.toolkit) continue;
    const r = await moveJob(
      repo,
      job,
      { to: job.pausedFrom, facts: { waitCleared: true, wake: w.facts }, note: "no-toolkit cleared: Toolkit approved" },
      () => {},
    );
    if (r === "moved") n++;
  }
  return n;
}

/**
 * `kitchen toolkit approve [--sha]`: the default is kitchen/setup's tip. Refused unless that sha passed a
 * full `toolkit check` and has a Toolkit. Prints one line and wakes the jobs waiting for a Toolkit.
 */
export async function approveToolkit(repo: string, o: { sha?: string } = {}, out: Out = () => {}): Promise<number> {
  repo = plainCheckout(repo).workTree;
  const rev = o.sha ?? SETUP_REF;
  const sha = await resolve(repo, rev);
  if (!sha) {
    out(o.sha ? `toolkit approve: no commit ${o.sha}` : "toolkit approve: no Toolkit to approve yet: run kitchen toolkit build first");
    return 1;
  }
  if (!(await toolkitAt(repo, sha))) {
    out(`toolkit approve: ${sha.slice(0, 12)} has no Toolkit (.kitchen/toolkit/bin/dev)`);
    return 1;
  }
  if (await mergedIntoBase(repo, sha)) {
    out(`toolkit approve: ${sha.slice(0, 12)} is on the base already: jobs use it, nothing to approve`);
    return 0;
  }
  if (!hasPassed(repo, sha)) {
    out(`toolkit approve: ${sha.slice(0, 12)} hasn't passed kitchen toolkit check: prove it first (kitchen toolkit check --rev ${sha.slice(0, 12)})`);
    return 1;
  }
  const before = readApproval(repo)?.sha;
  await ensureIgnored(repo);
  writeApproval(repo, sha);
  const woke = await wakeWaiting(repo);
  out(
    `Approved Toolkit ${sha.slice(0, 12)}${before && before !== sha ? ` (was ${before.slice(0, 12)})` : ""}: every job runs your app with it${
      woke ? `; ${woke} waiting job${woke === 1 ? "" : "s"} woke` : ""
    }. Undo: kitchen toolkit revoke`,
  );
  return 0;
}

/** `kitchen toolkit revoke`: jobs no longer use the approved sha; those that need the app wait again. */
export function revokeToolkit(repo: string, out: Out = () => {}): number {
  const sha = clearApproval(plainCheckout(repo).workTree);
  out(
    sha
      ? `Revoked Toolkit ${sha.slice(0, 12)}: jobs that need the app wait until you approve one again (kitchen toolkit approve)`
      : "toolkit revoke: no Toolkit is approved",
  );
  return 0;
}

/**
 * `kitchen toolkit commit`: share the Toolkit. One Kitchen commit on the base branch holding only
 * `.kitchen/toolkit` and `.env.kitchen` as the Toolkit sha has them, made only after `confirm`. On the
 * GitHub forge the same commit goes on its own branch as a PR instead. Refused unless the main checkout
 * is on the base branch with nothing staged and those paths untouched.
 */
export async function commitToolkit(
  repo: string,
  o: { sha?: string; confirm: (q: string) => Promise<boolean>; forge?: Forge; cfg?: Config },
  out: Out = () => {},
): Promise<number> {
  repo = plainCheckout(repo).workTree;
  const cfg = o.cfg ?? loadConfig(repo);
  const sha = await resolve(repo, o.sha ?? readApproval(repo)?.sha ?? SETUP_REF);
  if (!sha || !(await toolkitAt(repo, sha))) {
    out("toolkit commit: no Toolkit to commit: run kitchen toolkit build first");
    return 1;
  }
  if (!hasPassed(repo, sha) && !(await mergedIntoBase(repo, sha))) {
    out(`toolkit commit: ${sha.slice(0, 12)} hasn't passed kitchen toolkit check`);
    return 1;
  }
  const git = await openGit(plainCheckout(repo));
  const branch = (await git.run(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
  if (branch !== cfg.forge.base) {
    out(`toolkit commit: check out ${cfg.forge.base} first (this checkout is on ${branch || "a detached HEAD"})`);
    return 1;
  }
  const head = (await git.run(["rev-parse", "HEAD"])).stdout.trim();
  const dirty = (await git.run(["status", "--porcelain", "--untracked-files=all", "--", ...TOP(TOOLKIT_PATHS)])).stdout.trim();
  const staged = await git.run(["diff", "--cached", "--quiet"]).then(
    () => false,
    (e) => (e instanceof GitError && e.exitCode === 1 ? true : Promise.reject(e)),
  );
  if (dirty || staged) {
    out(`toolkit commit: ${staged ? "something is staged" : `${TOOLKIT_PATHS.join(" or ")} has local changes`}: commit or stash it first`);
    return 1;
  }
  // The tree: HEAD's, with the Toolkit paths replaced by the sha's. A private index, so the person's stays as it was.
  const index = path.join(os.tmpdir(), `kitchen-commit-index-${process.pid}-${Date.now()}`);
  const env = { ...IDENTITY, GIT_INDEX_FILE: index };
  let commit: string;
  try {
    await git.run(["read-tree", head], { env });
    await git.run(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...TOP(TOOLKIT_PATHS)], { env });
    const entries = (await git.run(["ls-tree", "-r", "--full-tree", sha, "--", ...TOOLKIT_PATHS])).stdout;
    await git.run(["update-index", "--index-info"], { env, input: entries });
    const tree = (await git.run(["write-tree"], { env })).stdout.trim();
    if (tree === (await git.run(["rev-parse", `${head}^{tree}`])).stdout.trim()) {
      out(`toolkit commit: ${cfg.forge.base} already holds this Toolkit`);
      return 0;
    }
    const files = (await git.run(["diff", "--name-only", head, tree])).stdout.split("\n").filter(Boolean);
    const github = cfg.forge.kind === "github";
    const q = github
      ? `Open a PR that adds the Toolkit (${files.length} file${files.length === 1 ? "" : "s"} under .kitchen/toolkit and .env.kitchen) to ${cfg.forge.base}? [y/N] `
      : `Commit the Toolkit (${files.length} file${files.length === 1 ? "" : "s"} under .kitchen/toolkit and .env.kitchen) to ${cfg.forge.base} as one Kitchen commit? [y/N] `;
    if (!(await o.confirm(q))) {
      out("toolkit commit: nothing committed");
      return 1;
    }
    commit = (await git.run(["commit-tree", tree, "-p", head, "-m", `kitchen: add the Toolkit (${sha.slice(0, 12)})`], { env: IDENTITY })).stdout.trim();
    if (github) {
      if (!o.forge) throw new Error("toolkit commit: no forge");
      const br = `kitchen/toolkit-${sha.slice(0, 12)}`;
      await git.run(["branch", "-f", br, commit]);
      const pr = await o.forge.openPr({
        key: `toolkit-commit/${sha}`,
        branch: br,
        head: commit,
        title: "Kitchen Toolkit",
        body: `The Toolkit Kitchen proved (${sha}): \`.kitchen/toolkit\` and \`.env.kitchen\` only.\n\nFiles:\n${files.map((f) => `- ${f}`).join("\n")}`,
      });
      out(`toolkit commit: PR #${pr} (${br}) adds the Toolkit to ${cfg.forge.base}; jobs use it once it is merged`);
      return 0;
    }
    await git.run(["update-ref", "-m", "kitchen toolkit commit", `refs/heads/${branch}`, commit, head]);
    // The person's index and files follow the new commit for the Toolkit paths only.
    await git.run(["checkout", "HEAD", "--", ...TOP(TOOLKIT_PATHS.filter((p) => files.some((f) => f === p || f.startsWith(`${p}/`))))]);
  } finally {
    fs.rmSync(index, { force: true });
  }
  out(
    `Committed the Toolkit to ${cfg.forge.base} as ${commit.slice(0, 12)} (only .kitchen/toolkit and .env.kitchen). Push it when you want your team to have it.`,
  );
  return 0;
}
