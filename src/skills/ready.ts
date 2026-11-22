// The readiness check (ADR 0014 §3): is a skill installed where its host really loads it?
// It counts a skill only when a readable, non-empty SKILL.md is there (symlinks followed),
// never guesses a location and never installs anything.
//
// Claude Code:
//   <repo>/.claude/skills/<name>/SKILL.md, ~/.claude/skills/<name>/SKILL.md, then the skills of
//   enabled plugins: ~/.claude/plugins/installed_plugins.json lists installs (scope user, or
//   project/local with a projectPath that must be this repo); `enabledPlugins` in
//   ~/.claude/settings.json, <repo>/.claude/settings.json and settings.local.json (later wins)
//   must say true. A plugin's skills are the folders its .claude-plugin/plugin.json `skills`
//   lists, else every <installPath>/skills/**/<name>/SKILL.md. Named `<plugin>:<name>`; a bare
//   name matches too.
// Codex: .agents/skills from the working folder up to the repo root, ~/.agents/skills, and
//   $CODEX_HOME/skills (default ~/.codex/skills). Codex has no plugin names.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bare, type Host } from "./registry.ts";

export type Env = {
  home: string;
  repo: string;
  /** The role's working folder (the job worktree): where Codex starts looking. Default: the repo. */
  cwd?: string;
  /** $CODEX_HOME. Default: <home>/.codex. */
  codexHome?: string;
};

export type Found = {
  /** The name it is loaded as: `tdd`, or `mattpocock-skills:tdd` from a plugin. */
  name: string;
  host: Host;
  /** The SKILL.md path where it was found (before symlinks). */
  path: string;
  /** Which place: `repo`, `user`, `plugin mattpocock-skills@claude-plugins-official`, `codex home`… */
  where: string;
  text: string;
  sha256: string;
};

/** The SKILL.md's text if it is a readable, non-empty file (symlinks followed), else null. */
function readSkill(file: string): string | null {
  try {
    if (!fs.statSync(file).isFile()) return null;
    const text = fs.readFileSync(file, "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
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

/** Every <dir>/**\/<name>/SKILL.md under `root`, symlinked folders followed once each. */
function walkSkills(root: string, depth = 6, seen = new Set<string>()): Map<string, string> {
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
    if (readSkill(path.join(d, "SKILL.md")) !== null && !out.has(n)) out.set(n, path.join(d, "SKILL.md"));
    for (const [k, v] of walkSkills(d, depth - 1, seen)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

export type Plugin = { key: string; name: string; installPath: string; skills: Map<string, string> };

/** The skill folders of one installed plugin: its manifest's `skills` paths, else skills/**. */
function pluginSkills(installPath: string): Map<string, string> {
  const manifest = readJson(path.join(installPath, ".claude-plugin", "plugin.json")) as { skills?: unknown } | null;
  const listed = typeof manifest?.skills === "string" ? [manifest.skills] : Array.isArray(manifest?.skills) ? manifest.skills : null;
  const out = new Map<string, string>();
  if (!listed) return walkSkills(path.join(installPath, "skills"));
  for (const p of listed) {
    if (typeof p !== "string") continue;
    const dir = path.resolve(installPath, p);
    if (!(dir + path.sep).startsWith(path.resolve(installPath) + path.sep)) continue; // a manifest path outside the plugin
    const own = path.join(dir, "SKILL.md");
    if (readSkill(own) !== null) {
      if (!out.has(path.basename(dir))) out.set(path.basename(dir), own);
    } else for (const [k, v] of walkSkills(dir, 1)) if (!out.has(k)) out.set(k, v);
  }
  // The default folder is read beside the manifest's paths: skills/<name>/SKILL.md.
  for (const [k, v] of walkSkills(path.join(installPath, "skills"), 0)) if (!out.has(k)) out.set(k, v);
  return out;
}

type Install = { scope?: string; installPath?: string; projectPath?: string };

/** Claude Code plugins installed for this repo and enabled in settings (user < project < local), by key order. */
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
  for (const key of Object.keys(installed?.plugins ?? {}).sort()) {
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

/** The folders, in order, where `host` loads plain (non-plugin) skills. */
export function skillRoots(host: Host, env: Env): { dir: string; where: string }[] {
  if (host === "claude")
    return [
      { dir: path.join(env.repo, ".claude", "skills"), where: "repo" },
      { dir: path.join(env.home, ".claude", "skills"), where: "user" },
    ];
  const roots: { dir: string; where: string }[] = [];
  const repo = path.resolve(env.repo);
  let d = path.resolve(env.cwd ?? env.repo);
  // From the working folder up to the repo root (a folder outside the repo: only itself, then the repo).
  for (;;) {
    roots.push({ dir: path.join(d, ".agents", "skills"), where: d === repo ? "repo" : `folder ${path.relative(repo, d) || d}` });
    if (d === repo || !d.startsWith(repo + path.sep)) break;
    d = path.dirname(d);
  }
  if (!roots.some((r) => r.where === "repo")) roots.push({ dir: path.join(repo, ".agents", "skills"), where: "repo" });
  roots.push({ dir: path.join(env.home, ".agents", "skills"), where: "user" });
  roots.push({ dir: path.join(env.codexHome ?? path.join(env.home, ".codex"), "skills"), where: "codex home" });
  return roots;
}

/** Where `host` would load `name` from, or null. A plugin-qualified name only matches that plugin. */
export function findSkill(name: string, host: Host, env: Env, plugins?: Plugin[]): Found | null {
  const plugin = name.includes(":") ? name.slice(0, name.indexOf(":")) : null;
  const n = bare(name);
  const hit = (file: string, where: string, as: string): Found | null => {
    const text = readSkill(file);
    return text === null ? null : { name: as, host, path: file, where, text, sha256: sha256(text) };
  };
  if (!plugin)
    for (const r of skillRoots(host, env)) {
      const f = hit(path.join(r.dir, n, "SKILL.md"), r.where, n);
      if (f) return f;
    }
  if (host !== "claude") return null;
  for (const p of plugins ?? enabledPlugins(env)) {
    if (plugin && p.name !== plugin) continue;
    const file = p.skills.get(n);
    const f = file ? hit(file, `plugin ${p.key}`, `${p.name}:${n}`) : null;
    if (f) return f;
  }
  return null;
}
