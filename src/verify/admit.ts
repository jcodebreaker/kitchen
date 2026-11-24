// The map moves only through Kitchen (ADR 0017 §2, §4): QA writes the files it changed in its QA folder under
// `map/`; `kitchen job finish` checks them against the feature file contract and the weakening rule (map.ts), then
// copies them into the job branch as a Kitchen commit, into both tools' copies of the skill. Builders never edit
// `verify-*/`: a build whose own commits touch it is refused.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { git, gitOut } from "../engine/git.ts";
import { writeAtomic } from "../engine/store.ts";
import {
  contractProblems,
  type Feature,
  type FeatureMap,
  featuresRel,
  isVerifyPath,
  namedBy,
  parseFeature,
  type Removal,
  readMap,
  removals,
  SKILL_ROOTS,
} from "./map.ts";
import { writeVerifySkill } from "./skill.ts";

export const KITCHEN_IDENTITY = ["-c", "user.name=Kitchen", "-c", "user.email=kitchen@localhost", "-c", "commit.gpgSign=false"];

/** The map at a commit (read through git, no checkout), or an empty map. */
export async function mapAt(repo: string, rev: string): Promise<FeatureMap & { name: string | null }> {
  if (!rev) return { name: null, readme: null, features: [] };
  const ls = await git(repo, ["ls-tree", "-r", "--name-only", rev, "--", ...SKILL_ROOTS], { allowFail: true });
  const files = ls.code ? [] : ls.stdout.split("\n").filter(Boolean);
  let name: string | null = null;
  let root = "";
  for (const r of SKILL_ROOTS) {
    const hit = files
      .map((f) => new RegExp(`^${r.replace(".", "\\.")}/(verify-[\\w.-]+)/SKILL\\.md$`).exec(f)?.[1])
      .filter((x): x is string => !!x)
      .sort()[0];
    if (hit) {
      name = hit;
      root = r;
      break;
    }
  }
  if (!name) return { name: null, readme: null, features: [] };
  const dir = `${root}/${name}/features/`;
  const show = async (p: string) => (await git(repo, ["show", `${rev}:${p}`])).stdout;
  const mds = files.filter((f) => f.startsWith(dir) && !f.slice(dir.length).includes("/") && f.endsWith(".md"));
  const readmePath = mds.find((f) => f.endsWith("/README.md"));
  const features: Feature[] = [];
  for (const f of mds.filter((x) => x !== readmePath).sort()) features.push(parseFeature(path.basename(f, ".md"), await show(f)));
  return { name, readme: readmePath ? await show(readmePath) : null, features };
}

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
export type Admitted = { files: string[]; sha: string | null; changes: MapChange[]; note?: string };

/**
 * Check QA's map updates and commit them into the job's worktree. `base`: the commit the job started from (staging,
 * where the earlier checks live); `changes`: intake's CHANGES: entries. Refused when a file breaks the contract or a
 * removal isn't named by CHANGES.
 */
export async function admitMap(
  repo: string,
  wt: string,
  qaFolder: string,
  o: { base: string; changes: string[]; message: string; cfg: Config },
): Promise<Admitted | { refused: string }> {
  const files = mapUpdates(qaFolder);
  if (!files.length) return { files: [], sha: null, changes: [] };
  // Staging has no verify skill yet (init's files weren't committed): the first map commit brings the skeleton.
  if (!readMap(wt).name) writeVerifySkill(wt, o.cfg);
  const here = readMap(wt);
  if (!here.name) return { refused: "could not write the verify skill into the worktree" };
  const bad = files.find((f) => !/^[\w.-]+\.md$/.test(f));
  if (bad) return { refused: `map/${bad}: a feature file name is letters, digits, . _ - and .md` };
  const updated = new Map<string, Feature>();
  for (const f of files.filter((x) => x !== "README.md")) {
    const feat = parseFeature(f.replace(/\.md$/, ""), fs.readFileSync(path.join(qaFolder, "map", f), "utf8"));
    const p = contractProblems(feat);
    if (p.length) return { refused: `map/${f} breaks the feature file contract: it needs ${p.join("; ")}` };
    updated.set(feat.id, feat);
  }
  const after = [...here.features.filter((x) => !updated.has(x.id)), ...updated.values()];
  const before = (await mapAt(repo, o.base)).features;
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
  for (const root of SKILL_ROOTS) {
    const d = path.join(wt, featuresRel(here.name, root));
    fs.mkdirSync(d, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(qaFolder, "map", f), path.join(d, f));
    // The other tool's copy gets the skill file too, so both read the same skill.
    const skill = path.join(wt, root, here.name, "SKILL.md");
    const src = SKILL_ROOTS.map((r) => path.join(wt, r, here.name as string, "SKILL.md")).find((p) => fs.existsSync(p));
    if (!fs.existsSync(skill) && src) fs.copyFileSync(src, skill);
  }
  await git(wt, ["add", "-A", "--", ...SKILL_ROOTS.map((r) => `${r}/${here.name}`)]);
  const staged = (await git(wt, ["diff", "--cached", "--name-only"])).stdout.trim();
  const changes = rs.map((r) => ({ ...r, by: namedBy(r, o.changes) as string }));
  if (!staged) return { files, sha: null, changes };
  await git(wt, [...KITCHEN_IDENTITY, "commit", "-q", "-m", o.message]);
  return { files, sha: await gitOut(wt, ["rev-parse", "HEAD"]), changes };
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
