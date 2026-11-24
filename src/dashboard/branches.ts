// ADR 0026: the branches the New ticket sheet offers as a target ("Into"), for GET /branches.json. Asked for only when
// the sheet opens, never on the poll. Local branches, and origin's for a GitHub forge (a target must exist there);
// not the default (the page lists it first), not Kitchen's own (job branches, the old evidence branch), and not the
// base, main or master when Kitchen merges.
import { type Config, loadConfig, protectedTarget } from "../config.ts";
import { git } from "../engine/git.ts";

export type Branches = { default: string; branches: string[] };

/** An earlier Kitchen kept evidence on this orphan branch; never a target. */
const OLD_EVIDENCE = "kitchen-evidence";

/** Pure: the branch names `for-each-ref` printed, as the sheet lists them. */
export function targetChoices(cfg: Pick<Config, "staging" | "forge">, refs: string[]): string[] {
  const out = new Set<string>();
  for (const r of refs) {
    const name = r.startsWith("refs/heads/") ? r.slice(11) : r.startsWith("refs/remotes/origin/") && cfg.forge.kind === "github" ? r.slice(20) : null;
    if (!name || name === "HEAD" || name === cfg.staging.branch || name.startsWith("kitchen/") || name === OLD_EVIDENCE) continue;
    if (cfg.staging.merge === "kitchen" && protectedTarget(cfg, name)) continue;
    out.add(name);
  }
  return [...out].sort();
}

const CACHE = new Map<string, { at: number; b: Promise<Branches> }>();
/** The repo's target choices, cached ten seconds (the sheet opened twice in a row asks git once). */
export function branchesOf(repo: string, now = Date.now()): Promise<Branches> {
  const c = CACHE.get(repo);
  if (c && now - c.at < 10_000) return c.b;
  const b = (async () => {
    const cfg = loadConfig(repo);
    const r = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"], { allowFail: true });
    return { default: cfg.staging.branch, branches: targetChoices(cfg, r.stdout.split("\n").filter(Boolean)) };
  })();
  b.catch(() => CACHE.delete(repo));
  CACHE.set(repo, { at: now, b });
  return b;
}
