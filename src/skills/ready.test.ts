import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { blockerReason, planRole, readinessLines } from "./plan.ts";
import { type Env, enabledPlugins, findSkill } from "./ready.ts";
import { loadRegistry } from "./registry.ts";

let root = "";
let env: Env;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-skills-"));
  env = { home: path.join(root, "home"), repo: path.join(root, "repo") };
  fs.mkdirSync(env.home, { recursive: true });
  fs.mkdirSync(env.repo, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const skill = (dir: string, text = "---\nname: x\n---\n# Body\n") => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), text);
  return path.join(dir, "SKILL.md");
};
const json = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v));
};
/** A plugin laid out like mattpocock-skills 1.3.1 on a real machine: nested skill folders listed in its manifest. */
function plugin(key: string, o: { scope?: string; projectPath?: string; manifest?: boolean } = {}) {
  const [name, market] = key.split("@");
  const dir = path.join(env.home, ".claude", "plugins", "cache", market, name, "1.3.1");
  skill(path.join(dir, "skills", "engineering", "tdd"), "---\nname: tdd\n---\n# TDD\nRed, green.\n");
  skill(path.join(dir, "skills", "in-progress", "loop-me"));
  if (o.manifest !== false) json(path.join(dir, ".claude-plugin", "plugin.json"), { name, skills: ["./skills/engineering/tdd"] });
  const f = path.join(env.home, ".claude", "plugins", "installed_plugins.json");
  const have = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { version: 2, plugins: {} };
  have.plugins[key] = [{ scope: o.scope ?? "user", installPath: dir, version: "1.3.1", ...(o.projectPath ? { projectPath: o.projectPath } : {}) }];
  json(f, have);
  return dir;
}
const enable = (file: string, key: string, on = true) => json(file, { enabledPlugins: { [key]: on } });
const userSettings = () => path.join(env.home, ".claude", "settings.json");

test("Claude: the repo's .claude/skills first, then ~/.claude/skills; a SKILL.md must be a readable, non-empty file", () => {
  assert.equal(findSkill("tdd", "claude", env), null);
  const user = skill(path.join(env.home, ".claude", "skills", "tdd"));
  assert.deepEqual([findSkill("tdd", "claude", env)?.where, findSkill("tdd", "claude", env)?.path], ["user", user]);
  const repo = skill(path.join(env.repo, ".claude", "skills", "tdd"), "# repo tdd\n");
  const f = findSkill("tdd", "claude", env);
  assert.deepEqual([f?.where, f?.path, f?.name, f?.host], ["repo", repo, "tdd", "claude"]);
  assert.equal(f?.sha256, createHash("sha256").update("# repo tdd\n").digest("hex"));
  fs.writeFileSync(repo, "  \n");
  assert.equal(findSkill("tdd", "claude", env)?.where, "user", "an empty SKILL.md doesn't count");
  fs.rmSync(path.dirname(repo), { recursive: true });
  fs.mkdirSync(repo, { recursive: true }); // a folder named SKILL.md
  assert.equal(findSkill("tdd", "claude", env)?.where, "user");
  assert.equal(findSkill("tdd", "codex", env), null, "Claude's folders are not Codex's");
});

test("symlinks are followed: a linked skill folder and a linked SKILL.md count, a dangling link doesn't", () => {
  const real = skill(path.join(root, "elsewhere", "tdd"), "# linked\n");
  fs.mkdirSync(path.join(env.home, ".claude", "skills"), { recursive: true });
  fs.symlinkSync(path.dirname(real), path.join(env.home, ".claude", "skills", "tdd"));
  assert.equal(findSkill("tdd", "claude", env)?.text, "# linked\n");
  fs.mkdirSync(path.join(env.repo, ".claude", "skills", "tdd"), { recursive: true });
  fs.symlinkSync(path.join(root, "nowhere.md"), path.join(env.repo, ".claude", "skills", "tdd", "SKILL.md"));
  assert.equal(findSkill("tdd", "claude", env)?.where, "user", "the repo's dangling link is skipped");
  fs.rmSync(path.join(env.repo, ".claude", "skills", "tdd", "SKILL.md"));
  fs.symlinkSync(real, path.join(env.repo, ".claude", "skills", "tdd", "SKILL.md"));
  assert.equal(findSkill("tdd", "claude", env)?.where, "repo");
});

test("Claude plugins: only installed AND enabled ones, named <plugin>:<name>, matched by the bare name too", () => {
  const key = "mattpocock-skills@claude-plugins-official";
  const dir = plugin(key);
  assert.equal(findSkill("tdd", "claude", env), null, "installed but not enabled");
  enable(userSettings(), key, false);
  assert.equal(findSkill("tdd", "claude", env), null, "disabled");
  enable(userSettings(), key);
  const f = findSkill("tdd", "claude", env);
  assert.deepEqual([f?.name, f?.where, f?.path], [`mattpocock-skills:tdd`, `plugin ${key}`, path.join(dir, "skills", "engineering", "tdd", "SKILL.md")]);
  assert.equal(findSkill("mattpocock-skills:tdd", "claude", env)?.name, "mattpocock-skills:tdd");
  assert.equal(findSkill("other-plugin:tdd", "claude", env), null, "a qualified name matches only its plugin");
  assert.equal(findSkill("loop-me", "claude", env), null, "a folder the manifest doesn't list is not loaded");
  // The repo's settings override the user's: local wins over project.
  enable(path.join(env.repo, ".claude", "settings.json"), key, false);
  assert.equal(findSkill("tdd", "claude", env), null, "disabled for this project");
  enable(path.join(env.repo, ".claude", "settings.local.json"), key, true);
  assert.ok(findSkill("tdd", "claude", env), "enabled again locally");
  // A plain skill of the same name comes first.
  skill(path.join(env.home, ".claude", "skills", "tdd"));
  assert.equal(findSkill("tdd", "claude", env)?.where, "user");
  assert.equal(findSkill("mattpocock-skills:tdd", "claude", env)?.where, `plugin ${key}`);
});

test("a plugin without a skills list in its manifest: every skills/**/<name>/SKILL.md", () => {
  const key = "p@m";
  plugin(key, { manifest: false });
  enable(userSettings(), key);
  assert.equal(findSkill("loop-me", "claude", env)?.name, "p:loop-me");
  assert.equal(enabledPlugins(env)[0].skills.size, 2);
});

test("a project- or local-scope plugin counts only in its own project", () => {
  const key = "p@m";
  plugin(key, { scope: "project", projectPath: path.join(root, "another-repo") });
  enable(userSettings(), key);
  assert.equal(findSkill("tdd", "claude", env), null, "installed for another project");
  plugin(key, { scope: "local", projectPath: env.repo });
  assert.equal(findSkill("tdd", "claude", env)?.name, "p:tdd");
});

test("Codex: .agents/skills from the working folder up to the repo root, ~/.agents/skills, then $CODEX_HOME/skills", () => {
  const wt = path.join(env.repo, ".worktrees", "001-x");
  fs.mkdirSync(wt, { recursive: true });
  const e: Env = { ...env, cwd: wt };
  assert.equal(findSkill("tdd", "codex", e), null);
  skill(path.join(env.home, ".codex", "skills", "tdd"));
  assert.equal(findSkill("tdd", "codex", e)?.where, "codex home");
  const ch = path.join(root, "codex-home");
  skill(path.join(ch, "skills", "only-here"));
  assert.equal(findSkill("only-here", "codex", { ...e, codexHome: ch })?.where, "codex home");
  assert.equal(findSkill("only-here", "codex", e), null, "$CODEX_HOME replaces ~/.codex");
  skill(path.join(env.home, ".agents", "skills", "tdd"));
  assert.equal(findSkill("tdd", "codex", e)?.where, "user");
  skill(path.join(env.repo, ".agents", "skills", "tdd"));
  assert.equal(findSkill("tdd", "codex", e)?.where, "repo");
  skill(path.join(wt, ".agents", "skills", "tdd"));
  assert.equal(findSkill("tdd", "codex", e)?.where, "folder .worktrees/001-x");
  skill(path.join(env.home, ".claude", "skills", "claude-only"));
  assert.equal(findSkill("claude-only", "codex", e), null, "a Claude-only install is not Codex support");
  plugin("p@m");
  enable(userSettings(), "p@m");
  assert.equal(findSkill("p:tdd", "codex", e), null, "Codex has no plugin names");
});

test("a role's plan: found skills, a missing required one blocks with the install hint, a missing optional one is skipped", () => {
  const reg = loadRegistry();
  const facts = { kind: "feature", surfaces: ["security"], risk: "high", ticket: "" };
  const p = planRole(reg, "reviewer-security", facts, "claude", env);
  assert.deepEqual(
    p.blockers.map((b) => [b.name, b.why]),
    [["security-review", "high risk"]],
  );
  const why = blockerReason(p.blockers, "claude", env);
  assert.match(why, /reviewer-security needs the skill `security-review` \(high risk\) on claude; install it: put the security-review skill folder/);
  assert.match(why, /~\/\.claude\/skills and enabled Claude Code plugins/);
  skill(path.join(env.repo, ".claude", "skills", "security-review"));
  assert.deepEqual(
    planRole(reg, "reviewer-security", facts, "claude", env).found.map((f) => [f.name, f.need]),
    [["security-review", "required"]],
  );
  const b = planRole(reg, "builder", { ...facts, kind: "bug" }, "claude", env);
  assert.deepEqual(
    b.skipped.map((s) => s.name),
    ["diagnosing-bugs", "codebase-design"],
  );
  assert.equal(b.blockers.length, 0);
  const r = readinessLines(reg, "claude", env);
  assert.ok(r.lines.some((l) => /^ {2}ok {7}security-review +repo: /.test(l)));
  assert.ok(r.lines.some((l) => /^ {2}missing {2}tdd /.test(l)));
  assert.equal(r.missing, Object.keys(reg.skills).length - 1);
});
