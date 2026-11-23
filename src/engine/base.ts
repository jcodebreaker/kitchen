// The base a job starts from and Ready syncs with (PLAN §2 "ready"), and taking
// a ticket in. Local forge: the main checkout's HEAD. GitHub forge: the remote's
// base branch, fetched by the engine from the explicit URL into refs/kitchen/base
// (ADR 0006: engine git, never a named remote). Every git call: engine/git.ts.
import type { Config } from "../config.ts";
import type { IncomingTicket } from "../sources/source.ts";
import { fetchFrom, openGit, plainCheckout } from "./git.ts";
import { resolveToolkitRef } from "./job-toolkit.ts";
import type { Job } from "./machine.ts";
import { createJob } from "./store.ts";

export const BASE_REF = "refs/kitchen/base";

/** The URL the engine pushes to and fetches from (GitHub forge). Pure. */
export function remoteUrl(cfg: Config): string {
  if (cfg.forge.url) return cfg.forge.url;
  if (!cfg.forge.repo) throw new Error("kitchen.yaml: forge.repo (owner/name) is required for the github forge");
  return `https://github.com/${cfg.forge.repo}.git`;
}

/** The credential helper the engine's push and fetch use against GitHub: the engine's own `gh`. Never given to an agent. */
export const ghHelper = (cfg: Config) => (cfg.forge.kind === "github" && !cfg.forge.url?.startsWith("/") ? "!gh auth git-credential" : undefined);

/** The base tip now. GitHub: fetched first. */
export async function baseTip(repo: string, cfg: Config): Promise<string> {
  const git = await openGit(plainCheckout(repo));
  if (cfg.forge.kind === "github") {
    await fetchFrom(git, { url: remoteUrl(cfg), refspecs: [`+refs/heads/${cfg.forge.base}:${BASE_REF}`], helper: ghHelper(cfg) });
    return (await git.run(["rev-parse", "--verify", `${BASE_REF}^{commit}`])).stdout.trim();
  }
  return (await git.run(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
}

/** Whether `sha` has a committed Toolkit (.kitchen/toolkit/bin/dev). */
export async function toolkitAt(repo: string, sha: string): Promise<boolean> {
  try {
    await (await openGit(plainCheckout(repo))).run(["cat-file", "-e", `${sha}:.kitchen/toolkit/bin/dev`]);
    return true;
  } catch {
    return false;
  }
}

/** A new job from a ticket: base = the base tip, toolkitRef = that sha when it has a Toolkit, else the approved one (ADR 0015). Idempotent for sources with stable ids. */
export async function takeTicket(repo: string, cfg: Config, t: IncomingTicket): Promise<{ job: Job; created: boolean; warning?: string }> {
  let base = "";
  let warning: string | undefined;
  try {
    base = await baseTip(repo, cfg);
  } catch (e) {
    warning = `no base commit (${(e as Error).message}); the job can't get a worktree until there is one`;
  }
  const toolkitRef = await resolveToolkitRef(repo, base);
  const r = await createJob(repo, { title: t.title, ticket: t.ref, body: t.body, roundLimit: cfg.round_limit, base, toolkitRef });
  return { ...r, warning };
}
