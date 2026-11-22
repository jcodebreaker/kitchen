// The plugin files are generated (npm run plugin:sync): they must match package.json's version and
// the repo skill, and the plugin skill must run Kitchen pinned, falling back to PATH.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { currentFiles, pluginSkill, ROOT } from "./sync.ts";

test("the committed plugin files are current (run npm run plugin:sync when this fails)", () => {
  for (const [f, text] of Object.entries(currentFiles())) assert.equal(fs.readFileSync(path.join(ROOT, f), "utf8"), text, f);
});

test("the plugin skill runs npx -y devkitchen@<version> first, then kitchen on PATH, and is otherwise the repo skill", () => {
  const version = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
  const repo = fs.readFileSync(path.join(ROOT, "skills", "kitchen", "SKILL.md"), "utf8");
  const plugin = pluginSkill(repo, version);
  assert.match(plugin, new RegExp(`npx -y devkitchen@${version.replace(/\./g, "\\.")} --version`));
  assert.match(plugin, /use `kitchen` from PATH/);
  assert.ok(!plugin.includes("kitchen-run:start"));
  const strip = (s: string) =>
    s
      .replace(/<!-- kitchen-run:start[\s\S]*?kitchen-run:end -->\n/, "")
      .replace(/This skill comes from the Kitchen plugin[\s\S]*?Run every command below from the repo root\.\n/, "");
  assert.equal(strip(plugin), strip(repo));
  assert.throws(() => pluginSkill("no block", version), /kitchen-run:start/);
});

test("the marketplaces name the plugin kitchen at ./plugins/kitchen, for Claude Code and Codex, at the package version", () => {
  const f = currentFiles();
  const claude = JSON.parse(f[".claude-plugin/marketplace.json"]);
  const codex = JSON.parse(f[".agents/plugins/marketplace.json"]);
  assert.equal(claude.name, "kitchen");
  assert.deepEqual(
    claude.plugins.map((p: { name: string; source: string }) => [p.name, p.source]),
    [["kitchen", "./plugins/kitchen"]],
  );
  assert.deepEqual(codex.plugins[0].source, { source: "local", path: "./plugins/kitchen" });
  const v = JSON.parse(f["plugins/kitchen/.claude-plugin/plugin.json"]).version;
  assert.equal(JSON.parse(f["plugins/kitchen/.codex-plugin/plugin.json"]).version, v);
  assert.equal(claude.plugins[0].version, v);
});
