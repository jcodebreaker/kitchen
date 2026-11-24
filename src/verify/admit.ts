// The map moves only through Kitchen (ADR 0017 §2, §4): QA writes the files it changed in its QA folder under
// `map/`; `kitchen job finish` checks them against the feature file contract and the weakening rule (map.ts), then
// copies them into the job branch as a Kitchen commit, into both tools' copies of the skill (or, for a map kept on
// this machine, into .kitchen/verify/skill: ADR 0027, where.ts). Builders never edit
// `verify-*/`: a build whose own commits touch it is refused.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { git } from "../engine/git.ts";
import { writeAtomic } from "../engine/store.ts";
import { contractProblems, type Feature, isVerifyPath, namedBy, parseFeature, type Removal, removals } from "./map.ts";
import { landMap, mapIn, mapOf } from "./where.ts";

/** The files QA left in `<qa folder>/map/` (only `*.md` directly in it). */
export function mapUpdates(qaFolder: string): string[] {
  const d = path.join(qaFolder, "map");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".md") && fs.statSync(path.join(d, f)).isFile())
    .sort();
}

export type MapChange = Removal & { by: string };
/** `skipped`: the files passed the checks but couldn't be written or committed (ADR 0027 §3): the change moves on. */
export type Admitted = { files: string[]; sha: string | null; changes: MapChange[]; note?: string; skipped?: string };

/**
 * Check QA's map updates and land them (ADR 0027: committed into the job's worktree, or written to this machine's
 * map). `base`: the commit the job started from (staging, where the earlier checks live); `changes`: intake's
 * CHANGES: entries. Refused when a file breaks the contract or a removal isn't named by CHANGES.
 */
export async function admitMap(
  repo: string,
  wt: string,
  qaFolder: string,
  o: { base: string; changes: string[]; message: string; cfg: Config },
): Promise<Admitted | { refused: string }> {
  const files = mapUpdates(qaFolder);
  if (!files.length) return { files: [], sha: null, changes: [] };
  const bad = files.find((f) => !/^[\w.-]+\.md$/.test(f));
  if (bad) return { refused: `map/${bad}: a feature file name is letters, digits, . _ - and .md` };
  const updated = new Map<string, Feature>();
  for (const f of files.filter((x) => x !== "README.md")) {
    const feat = parseFeature(f.replace(/\.md$/, ""), fs.readFileSync(path.join(qaFolder, "map", f), "utf8"));
    const p = contractProblems(feat);
    if (p.length) return { refused: `map/${f} breaks the feature file contract: it needs ${p.join("; ")}` };
    updated.set(feat.id, feat);
  }
  const here = mapIn(repo, o.cfg, wt);
  const after = [...here.features.filter((x) => !updated.has(x.id)), ...updated.values()];
  const before = (await mapOf(repo, o.cfg, o.base)).features;
  const rs = removals(before, after);
  const unnamed = rs.filter((r) => !namedBy(r, o.changes));
  if (unnamed.length)
    return {
      refused: `the map update weakens an earlier check that intake's CHANGES: line doesn't name: ${unnamed
        .slice(0, 5)
        .map(
          (r) =>
            `${r.kind === "sub" ? "sub-feature" : r.kind === "step" ? "recipe step" : "expected result of"} ${r.item}${r.kind === "expected" ? ` (was "${r.was}", now "${r.now}")` : " removed"}`,
        )
        .join("; ")}. Keep it (fix how to reach it, never what is expected), or FAIL the criterion`,
    };
  const changes = rs.map((r) => ({ ...r, by: namedBy(r, o.changes) as string }));
  const landed = await landMap(repo, o.cfg, wt, path.join(qaFolder, "map"), files, o.message);
  return { files, changes, ...landed };
}

/**
 * The verify-skill paths a build changed: the branch's net change to verify-*\/ since `base`, less the paths Kitchen's
 * own map commits wrote. A change put back by a later commit is no change.
 */
export async function builderMapEdits(repo: string, base: string, branch: string, kitchenCommits: string[]): Promise<string[]> {
  const net = (await git(repo, ["diff", "--name-only", base, branch])).stdout.split("\n").filter((p) => p && isVerifyPath(p));
  if (!net.length) return [];
  const ours = new Set<string>();
  for (const s of kitchenCommits)
    for (const p of (await git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", s], { allowFail: true })).stdout.split("\n")) if (p) ours.add(p);
  return net.filter((p) => !ours.has(p));
}

export const mapChangesFile = (jobDir: string) => path.join(jobDir, "map-changes.json");
export function writeMapChanges(jobDir: string, c: MapChange[]) {
  writeAtomic(mapChangesFile(jobDir), `${JSON.stringify(c, null, 2)}\n`);
}
export function readMapChanges(jobDir: string): MapChange[] {
  try {
    return JSON.parse(fs.readFileSync(mapChangesFile(jobDir), "utf8")) as MapChange[];
  } catch {
    return [];
  }
}
