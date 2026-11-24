// Where the verify skill and its map live (ADR 0027). Every reader and writer of the map asks here, never git or
// the disk directly:
//
// - the skill's name is kitchen.yaml's `verify.skill`, chosen once from the main checkout, never from a worktree;
// - `verify.map: repo`: the map is in the repo (`.claude/skills/<name>/`), read at a commit and committed with the
//   change that taught it;
// - `verify.map: local`: the repo ignores that path (or hasn't committed it yet), so the map is Kitchen's own, in
//   `.kitchen/verify/skill/<name>/` on this machine: copied into each checkout Kitchen makes (where git ignores the
//   usual path), read from there for intake and the merge check, and QA's updates are written back to it.
//
// A map update never blocks a change: when writing or committing it fails, the change moves on and the job says
// "map update skipped: <reason>".
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { type Config, configFile, parseConfig } from "../config.ts";
import { git, gitOut } from "../engine/git.ts";
import { kitchenDir, writeAtomic } from "../engine/store.ts";
import { type Feature, type FeatureMap, featuresRel, parseFeature, readMap, readMapDir, SKILL_ROOTS, skillName } from "./map.ts";
import { appName, skillFacts, writeSkillDir, writeVerifySkill } from "./skill.ts";

export type NamedMap = FeatureMap & { name: string | null };
export type MapMode = "repo" | "local";
/** What git says about `.claude/skills/<name>/` in the main checkout. */
export type Place = "tracked" | "ignored" | "untracked" | "none";

export const KITCHEN_IDENTITY = ["-c", "user.name=Kitchen", "-c", "user.email=kitchen@localhost", "-c", "commit.gpgSign=false"];
const MAIN = SKILL_ROOTS[0];
const EMPTY: NamedMap = { name: null, readme: null, features: [] };

/** The one-time line when the map moves to this machine because the repo ignores its usual path. */
export const LOCAL_LINE = "This repo ignores .claude/: the verify map stays on this machine (.kitchen/verify/skill).";
const untrackedLine = (name: string) =>
  `commit ${MAIN}/${name} so jobs see it: until a commit has it, the verify map stays on this machine (.kitchen/verify/skill)`;

export const localRoot = (repo: string) => path.join(kitchenDir(repo), "verify", "skill");
export const localSkillDir = (repo: string, name: string) => path.join(localRoot(repo), name);
/** Why the map is local (`ignored` or `untracked`): an untracked one goes back to the repo once a commit has it. */
const reasonFile = (repo: string) => path.join(kitchenDir(repo), "verify", "skill.json");
const readReason = (repo: string): Place | null => {
  try {
    return (JSON.parse(fs.readFileSync(reasonFile(repo), "utf8")) as { why: Place }).why;
  } catch {
    return null;
  }
};

/** The skill's name: kitchen.yaml's verify.skill, else the main checkout's verify-* skill, else verify-<app> of the main checkout. */
export const skillNameOf = (repo: string, cfg: Pick<Config, "verify">): string => cfg.verify.skill ?? skillName(repo) ?? `verify-${appName(repo)}`;

export const mapMode = (cfg: Pick<Config, "verify">): MapMode => cfg.verify.map;

const ignoredIn = async (dir: string, rel: string) => (await git(dir, ["check-ignore", "-q", "--", rel], { allowFail: true })).code === 0;

export async function placeOf(repo: string, name: string): Promise<Place> {
  const rel = `${MAIN}/${name}`;
  const ls = await git(repo, ["ls-files", "--", rel], { allowFail: true });
  if (ls.code) return "none";
  if (ls.stdout.trim()) return "tracked";
  if (await ignoredIn(repo, `${rel}/SKILL.md`)) return "ignored";
  return fs.existsSync(path.join(repo, rel, "SKILL.md")) ? "untracked" : "none";
}

/** The local copy has the skill: copied from the main checkout's (either tool's), else written from what init detects. */
function seedLocal(repo: string, cfg: Config, name: string) {
  const dir = localSkillDir(repo, name);
  if (fs.existsSync(path.join(dir, "SKILL.md"))) return;
  const from = SKILL_ROOTS.map((r) => path.join(repo, r, name)).find((d) => fs.existsSync(path.join(d, "SKILL.md")));
  if (from) fs.cpSync(from, dir, { recursive: true });
  else writeSkillDir(dir, { ...skillFacts(repo, cfg), name });
}

/** Write verify.skill and verify.map into kitchen.yaml, keeping its comments; refused when the result doesn't load. */
function writeKeys(repo: string, keys: { skill?: string; map?: MapMode }) {
  const f = configFile(repo);
  const text = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  const doc = parseDocument(text);
  let next: string;
  if (doc.has("verify")) {
    if (keys.skill) doc.setIn(["verify", "skill"], keys.skill);
    if (keys.map) doc.setIn(["verify", "map"], keys.map);
    next = doc.toString();
  } else
    next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}# The verify skill (ADR 0027): its name, and where its map lives (repo: committed with each change; local: .kitchen/verify/skill on this machine)\nverify:\n${keys.skill ? `  skill: ${keys.skill}\n` : ""}${keys.map ? `  map: ${keys.map}\n` : ""}`;
  parseConfig(next);
  fs.writeFileSync(f, next);
}

/** The map moves to (or stays on) this machine: the local copy seeded, why kept, kitchen.yaml written when it changes. */
function goLocal(repo: string, cfg: Config, name: string, why: Place) {
  seedLocal(repo, cfg, name);
  writeAtomic(reasonFile(repo), `${JSON.stringify({ why })}\n`);
  if (cfg.verify.map !== "local" || !cfg.verify.skill || !hasKey(repo, "map")) writeKeys(repo, { skill: cfg.verify.skill ? undefined : name, map: "local" });
}

const hasKey = (repo: string, key: "skill" | "map") => {
  const f = configFile(repo);
  return fs.existsSync(f) && parseDocument(fs.readFileSync(f, "utf8")).hasIn(["verify", key]);
};

/**
 * Settle the verify keys (`kitchen init`, and `kitchen run` before a session): backfill `verify.skill` and
 * `verify.map` when kitchen.yaml lacks them, from git in the main checkout. Init decides from git each time (`before`:
 * the place before init wrote its own skill). A run keeps what kitchen.yaml says, except that a repo map whose path
 * git ignores moves to this machine (once, with LOCAL_LINE), and a map kept local only because it wasn't committed
 * goes back to the repo when a commit has it. Returns what to tell the person.
 */
export async function settleMap(repo: string, o: { init?: boolean; before?: Place } = {}): Promise<string[]> {
  const f = configFile(repo);
  if (!fs.existsSync(f)) return [];
  const cfg = parseConfig(fs.readFileSync(f, "utf8"));
  const had = hasKey(repo, "map") ? cfg.verify.map : undefined;
  const name = skillNameOf(repo, cfg);
  const place = o.before ?? (await placeOf(repo, name));
  const wantLocal = place === "ignored" || place === "untracked";
  let mode: MapMode = had ?? (wantLocal ? "local" : "repo");
  if (o.init) mode = wantLocal ? "local" : "repo";
  else if (had === "repo" && place === "ignored") mode = "local";
  else if (had === "local" && place === "tracked" && readReason(repo) === "untracked") mode = "repo";
  if (mode === "local") {
    const was = readReason(repo);
    const why = wantLocal ? place : (was ?? "ignored");
    goLocal(repo, cfg, name, why);
    if (had !== "local" || was !== why || o.init) return place === "ignored" ? [LOCAL_LINE] : place === "untracked" ? [untrackedLine(name)] : [];
    return [];
  }
  const lines: string[] = [];
  if (had === "local") {
    fs.rmSync(reasonFile(repo), { force: true });
    lines.push(`${MAIN}/${name} is committed now: the verify map lives in the repo again (verify.map: repo)`);
    const local = readMapDir(path.join(localSkillDir(repo, name), "features"));
    const here = readMapDir(path.join(repo, MAIN, name, "features"));
    const ahead = local.features.filter((x) => here.features.find((y) => y.id === x.id)?.text !== x.text).map((x) => x.id);
    if (ahead.length)
      lines.push(
        `  the copy on this machine has map updates the committed one lacks (${ahead.join(", ")}): copy them from ${path.relative(repo, localSkillDir(repo, name))}/features into ${MAIN}/${name}/features and commit`,
      );
  }
  if (!cfg.verify.skill || had !== mode) writeKeys(repo, { skill: cfg.verify.skill ? undefined : name, map: had !== mode ? mode : undefined });
  return lines;
}

/** The local map, or an empty one when this machine has no copy yet. */
function readLocal(repo: string, name: string): NamedMap {
  const dir = localSkillDir(repo, name);
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) return EMPTY;
  return { name, ...readMapDir(path.join(dir, "features")) };
}

/** The map at a commit (read through git, no checkout), or an empty map. `want`: the skill's name, when it is there. */
export async function mapAt(repo: string, rev: string, want?: string): Promise<NamedMap> {
  if (!rev) return EMPTY;
  const ls = await git(repo, ["ls-tree", "-r", "--name-only", rev, "--", ...SKILL_ROOTS], { allowFail: true });
  const files = ls.code ? [] : ls.stdout.split("\n").filter(Boolean);
  let name: string | null = null;
  let root = "";
  for (const r of SKILL_ROOTS) {
    const hit =
      want && files.includes(`${r}/${want}/SKILL.md`)
        ? want
        : files
            .map((f) => new RegExp(`^${r.replace(".", "\\.")}/(verify-[\\w.-]+)/SKILL\\.md$`).exec(f)?.[1])
            .filter((x): x is string => !!x)
            .sort()[0];
    if (hit) {
      name = hit;
      root = r;
      break;
    }
  }
  if (!name) return EMPTY;
  const dir = `${root}/${name}/features/`;
  const show = async (p: string) => (await git(repo, ["show", `${rev}:${p}`])).stdout;
  const mds = files.filter((f) => f.startsWith(dir) && !f.slice(dir.length).includes("/") && f.endsWith(".md"));
  const readmePath = mds.find((f) => f.endsWith("/README.md"));
  const features: Feature[] = [];
  for (const f of mds.filter((x) => x !== readmePath).sort()) features.push(parseFeature(path.basename(f, ".md"), await show(f)));
  return { name, readme: readmePath ? await show(readmePath) : null, features };
}

/** The map as of a commit: the repo's at that commit, or (local) this machine's, which has no history. */
export async function mapOf(repo: string, cfg: Config, rev: string): Promise<NamedMap> {
  const name = skillNameOf(repo, cfg);
  return mapMode(cfg) === "local" ? readLocal(repo, name) : mapAt(repo, rev, name);
}

/** The map a lane works with in a checkout Kitchen made: the checkout's own, or (local) this machine's. */
export function mapIn(repo: string, cfg: Config, wt: string): NamedMap {
  const name = skillNameOf(repo, cfg);
  return mapMode(cfg) === "local" ? readLocal(repo, name) : readMap(wt, name);
}

/**
 * Where a lane in `wt` reads the skill: the usual path in the checkout, or (local, when git doesn't ignore that path
 * there, so no copy was made) the local copy's absolute path.
 */
export function skillIn(repo: string, cfg: Config, wt: string, name: string): { skill: string; local: boolean } {
  const usual = `${MAIN}/${name}`;
  if (mapMode(cfg) !== "local") return { skill: usual, local: false };
  return { skill: fs.existsSync(path.join(wt, usual, "SKILL.md")) ? usual : localSkillDir(repo, name), local: true };
}

/**
 * Local map: copy this machine's skill into a checkout Kitchen made (a job's worktree, intake's checkout, a trial
 * merge, a verify run), at the usual paths, so lanes and the skill loader find it. Only where git ignores the path
 * in that checkout: a copy git would see could be committed by a build. Nothing in repo mode or in the main checkout.
 */
export async function seedCheckout(repo: string, cfg: Config, wt: string): Promise<void> {
  if (mapMode(cfg) !== "local" || path.resolve(wt) === path.resolve(repo)) return;
  const name = skillNameOf(repo, cfg);
  const src = localSkillDir(repo, name);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) return;
  for (const r of SKILL_ROOTS) {
    const rel = `${r}/${name}`;
    if (!(await ignoredIn(wt, `${rel}/SKILL.md`))) continue;
    fs.rmSync(path.join(wt, rel), { recursive: true, force: true });
    fs.cpSync(src, path.join(wt, rel), { recursive: true });
  }
}

export type Landed = { sha: string | null; note?: string; skipped?: string };

/** Put a checkout's map paths back as they were (a failed map commit leaves nothing for the next lane to trip on). */
async function restore(wt: string, name: string) {
  const paths = SKILL_ROOTS.map((r) => `${r}/${name}`);
  await git(wt, ["reset", "-q", "--", ...paths], { allowFail: true });
  await git(wt, ["checkout", "-q", "--", ...paths], { allowFail: true });
  await git(wt, ["clean", "-fdq", "--", ...paths], { allowFail: true });
}

/**
 * Land QA's admitted map files (`src`: its `map/` folder): committed into the job branch (repo), or written to this
 * machine's copy (local). A repo map whose path git ignores moves to this machine first (once, with LOCAL_LINE).
 * Never throws: a failure is `skipped`, and the change moves on without it.
 */
export async function landMap(repo: string, cfg: Config, wt: string, src: string, files: string[], message: string): Promise<Landed> {
  const name = skillNameOf(repo, cfg);
  let mode = mapMode(cfg);
  let note: string | undefined;
  try {
    if (mode === "repo") {
      const targets = SKILL_ROOTS.flatMap((r) => ["SKILL.md", ...files.map((f) => `features/${f}`)].map((x) => `${r}/${name}/${x}`));
      if ((await git(wt, ["check-ignore", "-q", "--", ...targets], { allowFail: true })).code === 0) {
        goLocal(repo, cfg, name, "ignored");
        mode = "local";
        note = LOCAL_LINE;
      }
    }
    if (mode === "local") {
      seedLocal(repo, cfg, name);
      const d = path.join(localSkillDir(repo, name), "features");
      fs.mkdirSync(d, { recursive: true });
      for (const f of files) fs.copyFileSync(path.join(src, f), path.join(d, f));
      const saved = `map ${files.join(", ")} saved on this machine (.kitchen/verify/skill)`;
      return { sha: null, note: note ? `${note} ${saved}` : saved };
    }
    // Staging has no verify skill yet (init's files weren't committed): the first map commit brings the skeleton.
    if (!SKILL_ROOTS.some((r) => fs.existsSync(path.join(wt, r, name, "SKILL.md")))) writeVerifySkill(repo, cfg, { into: wt, name });
    for (const root of SKILL_ROOTS) {
      const d = path.join(wt, featuresRel(name, root));
      fs.mkdirSync(d, { recursive: true });
      for (const f of files) fs.copyFileSync(path.join(src, f), path.join(d, f));
      // The other tool's copy gets the skill file too, so both read the same skill.
      const skill = path.join(wt, root, name, "SKILL.md");
      const from = SKILL_ROOTS.map((r) => path.join(wt, r, name, "SKILL.md")).find((p) => fs.existsSync(p));
      if (!fs.existsSync(skill) && from) fs.copyFileSync(from, skill);
    }
    await git(wt, ["add", "-A", "--", ...SKILL_ROOTS.map((r) => `${r}/${name}`)]);
    if (!(await git(wt, ["diff", "--cached", "--name-only"])).stdout.trim()) return { sha: null };
    await git(wt, [...KITCHEN_IDENTITY, "commit", "-q", "-m", message]);
    return { sha: await gitOut(wt, ["rev-parse", "HEAD"]) };
  } catch (e) {
    if (mode === "repo") await restore(wt, name);
    return { sha: null, note, skipped: reasonOf(e) };
  }
}

const reasonOf = (e: unknown) =>
  ((e as Error)?.message ?? String(e))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);

/** The words for a skipped map update (the finish line, the Report). */
export const skippedLine = (why: string) => `map update skipped: ${why}`;
