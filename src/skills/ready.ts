// The readiness check (ADR 0014 §3): where a registry skill comes from for a host. It counts a skill
// only as a non-empty SKILL.md, never guesses a location and never installs anything.
//
// Order, first found wins:
//   1. Kitchen's vendored copy (skills/vendor/…), the pinned default for a skill the registry vendors,
//      unless kitchen.yaml `skills.use_installed` names it.
//   2. The repo's committed skills, read from git at the job's base commit, never from a working
//      tree: Claude `.claude/skills/<name>/SKILL.md`, Codex `.agents/skills/<name>/SKILL.md`. A job
//      worktree is the agents' own space, so nothing an agent writes there can become a skill, and a
//      SKILL.md committed as a symlink is refused (its target is never read).
//   3. The user's folders, symlinks followed: Claude ~/.claude/skills; Codex ~/.agents/skills and
//      $CODEX_HOME/skills (default ~/.codex/skills).
//   4. Claude only: an enabled plugin. ~/.claude/plugins/installed_plugins.json lists installs (scope
//      user, or project/local with a projectPath that must be this repo); `enabledPlugins` in
//      ~/.claude/settings.json, <repo>/.claude/settings.json and settings.local.json (later wins) must
//      say true. A plugin's skills are the folders its .claude-plugin/plugin.json `skills` lists plus
//      skills/<name>/. A skill whose registry source names a plugin is taken from that plugin only;
//      a skill two enabled plugins provide is ambiguous and not used.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bare, type Host, type Registry, SKILLS_DIR } from "./registry.ts";

export type Env = {
  home: string;
  /** The main checkout (never a job worktree). */
  repo: string;
  /** The commit the repo's committed skills are read at (the job's base). Default: the repo's HEAD. */
  base?: string;
  /** $CODEX_HOME. Default: <home>/.codex. */
  codexHome?: string;
  /** Vendored skills to take from the user's install instead (kitchen.yaml skills.use_installed). */
  useInstalled?: readonly string[];
  /** Kitchen's skills folder (tests). Default: the shipped one. */
  kitchenSkills?: string;
};

export type Found = {
  /** The name it is loaded as: `tdd`, or `mattpocock-skills:tdd` from a plugin. */
  name: string;
  host: Host;
  /** Where the SKILL.md is: a file path, or `<repo>/<path>` for a committed one. */
  path: string;
  /** Its source, as the prompt and the ledger name it: `kitchen (vendored)`, `repo at <sha12>`, `user`, `codex home`, `plugin <key>`. */
  where: string;
  text: string;
  /** sha256 of the file's raw bytes. */
  sha256: string;
};
export type Ambiguous = { ambiguous: string[] };
export type Lookup = Found | Ambiguous | null;
export const isFound = (l: Lookup): l is Found => !!l && "text" in l;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const found = (name: string, host: Host, p: string, where: string, bytes: Buffer | null): Found | null => {
  const text = bytes?.toString("utf8") ?? "";
  return text.trim() ? { name, host, path: p, where, text, sha256: sha256(bytes as Buffer) } : null;
};

/** A readable regular file's bytes (symlinks followed), else null. */
function readFile(file: string): Buffer | null {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readJson = (f: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const same = (a: string, b: string) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

// ---------- the repo's committed skills (git, at a commit) ----------

const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });

/** The commit `rev` names in `repo`, or null (no git, no commits). */
export function commitOf(repo: string, rev = "HEAD"): string | null {
  try {
    return (
      git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}

/** <dir>/<name>/SKILL.md entries at a commit: name → blob id, or "symlink" (refused). Cached per commit (immutable). */
const trees = new Map<string, Map<string, string>>();
function committedSkills(repo: string, commit: string, dir: string): Map<string, string> {
  const key = `${repo}\0${commit}\0${dir}`;
  const have = trees.get(key);
  if (have) return have;
  const out = new Map<string, string>();
  try {
    for (const e of git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", dir]).toString().split("\0")) {
      const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(e);
      const n = m && new RegExp(`^${dir.replace(/[.]/g, "\\.")}/([^/]+)/SKILL\\.md$`).exec(m[3]);
      if (m && n) out.set(n[1], m[1] === "120000" ? "symlink" : m[2]);
    }
  } catch {}
  trees.set(key, out);
  return out;
}

/** The repo's committed `<dir>/<name>/SKILL.md` at the base commit: a regular file only. */
function repoSkill(name: string, host: Host, env: Env): Found | null {
  const commit = commitOf(env.repo, env.base ?? "HEAD");
  if (!commit) return null;
  const dir = host === "claude" ? ".claude/skills" : ".agents/skills";
  const blob = committedSkills(env.repo, commit, dir).get(name);
  if (!blob || blob === "symlink") return null;
  let bytes: Buffer | null = null;
  try {
    bytes = git(env.repo, ["cat-file", "blob", blob]);
  } catch {}
  return found(name, host, path.join(env.repo, dir, name, "SKILL.md"), `repo at ${commit.slice(0, 12)}`, bytes);
}

// ---------- plugins ----------

/** Every <dir>/<name>/SKILL.md under `root` down to `depth` folders, symlinked folders followed once each. */
function walkSkills(root: string, depth: number, seen = new Set<string>()): Map<string, string> {
  const out = new Map<string, string>();
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    return out;
  }
  if (seen.has(real) || depth < 0) return out;
  seen.add(real);
  let names: string[];
  try {
    names = fs.readdirSync(root).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    const d = path.join(root, n);
    if (!isDir(d)) continue;
    if (readFile(path.join(d, "SKILL.md")) && !out.has(n)) out.set(n, path.join(d, "SKILL.md"));
    for (const [k, v] of walkSkills(d, depth - 1, seen)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

export type Plugin = { key: string; name: string; installPath: string; skills: Map<string, string> };

/** The skill folders of one installed plugin: the ones its manifest lists, plus skills/<name>/. */
function pluginSkills(installPath: string): Map<string, string> {
  const manifest = readJson(path.join(installPath, ".claude-plugin", "plugin.json")) as { skills?: unknown } | null;
  const listed = typeof manifest?.skills === "string" ? [manifest.skills] : Array.isArray(manifest?.skills) ? manifest.skills : [];
  const out = new Map<string, string>();
  for (const p of listed) {
    if (typeof p !== "string") continue;
    const dir = path.resolve(installPath, p);
    if (!(dir + path.sep).startsWith(path.resolve(installPath) + path.sep)) continue; // a manifest path outside the plugin
    const own = path.join(dir, "SKILL.md");
    if (readFile(own)) {
      if (!out.has(path.basename(dir))) out.set(path.basename(dir), own);
    } else for (const [k, v] of walkSkills(dir, 0)) if (!out.has(k)) out.set(k, v);
  }
  for (const [k, v] of walkSkills(path.join(installPath, "skills"), 0)) if (!out.has(k)) out.set(k, v);
  return out;
}

type Install = { scope?: string; installPath?: string; projectPath?: string };

/** Claude Code plugins installed for this repo and enabled in settings (user < project < local). */
export function enabledPlugins(env: Env): Plugin[] {
  const installed = readJson(path.join(env.home, ".claude", "plugins", "installed_plugins.json")) as { plugins?: Record<string, Install[] | Install> } | null;
  const enabled: Record<string, unknown> = {};
  for (const f of [
    path.join(env.home, ".claude", "settings.json"),
    path.join(env.repo, ".claude", "settings.json"),
    path.join(env.repo, ".claude", "settings.local.json"),
  ]) {
    const s = readJson(f) as { enabledPlugins?: Record<string, unknown> } | null;
    if (s?.enabledPlugins && typeof s.enabledPlugins === "object") Object.assign(enabled, s.enabledPlugins);
  }
  const out: Plugin[] = [];
  for (const key of Object.keys(installed?.plugins ?? {})) {
    if (enabled[key] !== true) continue;
    const raw = installed?.plugins?.[key];
    const installs = (Array.isArray(raw) ? raw : [raw]).filter((i): i is Install => !!i && typeof i === "object");
    const mine = installs.find(
      (i) =>
        typeof i.installPath === "string" &&
        (i.scope === "user" || ((i.scope === "project" || i.scope === "local") && !!i.projectPath && same(i.projectPath, env.repo))),
    );
    if (!mine?.installPath || !isDir(mine.installPath)) continue;
    out.push({ key, name: key.split("@")[0], installPath: mine.installPath, skills: pluginSkills(mine.installPath) });
  }
  return out;
}

// ---------- the lookup ----------

/** The user's folders, in order, where `host` loads plain skills. */
export function userRoots(host: Host, env: Env): { dir: string; where: string }[] {
  if (host === "claude") return [{ dir: path.join(env.home, ".claude", "skills"), where: "user" }];
  return [
    { dir: path.join(env.home, ".agents", "skills"), where: "user" },
    { dir: path.join(env.codexHome ?? path.join(env.home, ".codex"), "skills"), where: "codex home" },
  ];
}

/** Every place `host` is searched, in words (the "needs you" reason). */
export function placesOf(host: Host, env: Env): string[] {
  const commit = commitOf(env.repo, env.base ?? "HEAD");
  const repo = `${path.join(env.repo, host === "claude" ? ".claude/skills" : ".agents/skills")} as committed at ${commit ? commit.slice(0, 12) : "(no commit)"}`;
  const user = userRoots(host, env).map((r) => r.dir.replace(env.home, "~"));
  return [repo, ...user, ...(host === "claude" ? ["enabled Claude Code plugins"] : [])];
}

/**
 * Where `host` gets the registry skill `name`, by the order above; an Ambiguous when only plugins have it
 * and more than one does; null when nowhere.
 */
export function findSkill(reg: Registry, name: string, host: Host, env: Env, plugins?: Plugin[]): Lookup {
  const qualified = name.includes(":") ? name.slice(0, name.indexOf(":")) : null;
  const n = bare(name);
  const entry = reg.skills[n];
  const vendored = () => {
    if (!entry?.vendored) return null;
    const f = path.join(env.kitchenSkills ?? SKILLS_DIR, entry.vendored, "SKILL.md");
    return found(n, host, f, "kitchen (vendored)", readFile(f));
  };
  const installed = !entry?.vendored || env.useInstalled?.includes(n);
  if (!installed) return vendored();
  if (!qualified) {
    const r = repoSkill(n, host, env);
    if (r) return r;
    for (const u of userRoots(host, env)) {
      const f = path.join(u.dir, n, "SKILL.md");
      const hit = found(n, host, f, u.where, readFile(f));
      if (hit) return hit;
    }
  }
  if (host === "claude") {
    const want = qualified ?? (entry ? reg.sources[entry.source]?.plugin : undefined);
    const hits = (plugins ?? enabledPlugins(env))
      .filter((p) => (want ? p.name === want : true) && p.skills.has(n))
      .map((p) => found(`${p.name}:${n}`, host, p.skills.get(n) as string, `plugin ${p.key}`, readFile(p.skills.get(n) as string)))
      .filter((f): f is Found => !!f);
    // Two plugins with it (or one plugin name from two marketplaces): never picked by order.
    if (hits.length > 1) return { ambiguous: hits.map((h) => h.where.slice("plugin ".length)) };
    if (hits.length) return hits[0];
  }
  // A vendored skill configured to come from the user's install, and missing there: Kitchen's copy.
  return vendored();
}
