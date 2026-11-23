// The plugin files are generated (npm run plugin:sync): they must match package.json's version and
// the repo skill, and the plugin skill runs npx only for the tarball pinned at release, else PATH.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { currentFiles, PIN_FILE, pluginSkill, ROOT, readPin } from "./sync.ts";

const version = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const repoSkill = fs.readFileSync(path.join(ROOT, "skills", "kitchen", "SKILL.md"), "utf8");
const HASH = "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==";

test("the committed plugin files are current (run npm run plugin:sync when this fails)", () => {
  for (const [f, text] of Object.entries(currentFiles())) assert.equal(fs.readFileSync(path.join(ROOT, f), "utf8"), text, f);
});

test("no pin (nothing published and pinned): the skill never runs npx; kitchen on PATH, else how to install", () => {
  const plugin = pluginSkill(repoSkill, version, null);
  assert.doesNotMatch(plugin, /npx -y/);
  assert.match(plugin, /never run Kitchen through `npx`/);
  // Two clean steps: PATH, else how to install. No empty step.
  assert.match(plugin, /\n1\. `kitchen --version`[\s\S]*\n2\. If it doesn't, tell the user Kitchen isn't installed/);
  assert.doesNotMatch(plugin, /\n3\. |Nothing else to try/);
  assert.match(plugin, /use `kitchen` from PATH/);
  assert.match(plugin, new RegExp(`npm install -g devkitchen@${version.replace(/\./g, "\\.")}`));
});

test("pinned: npx only when the registry's dist.integrity equals the pin, checked with a short timeout; otherwise PATH", () => {
  const plugin = pluginSkill(repoSkill, version, HASH);
  const v = version.replace(/\./g, "\\.");
  assert.match(plugin, new RegExp(`npm view devkitchen@${v} dist\\.integrity --fetch-timeout=5000 --fetch-retries=0`));
  assert.match(plugin, new RegExp(`Only if it prints exactly\\s+\`${HASH.replace(/[+/=]/g, "\\$&")}\`, use \`npx -y devkitchen@${v}\``));
  assert.match(plugin, /use `kitchen` from\s+PATH/);
  assert.ok(!plugin.includes("kitchen-run:start"));
  assert.match(plugin, /`\/kitchen:kitchen` in Claude Code/, "plugin skills are namespaced: the skill says how it is invoked");
  // Otherwise it is the repo skill, word for word.
  const strip = (s: string) =>
    s
      .replace(/<!-- kitchen-run:start[\s\S]*?kitchen-run:end -->\n/, "")
      .replace(/This skill comes from the Kitchen plugin[\s\S]*?that is this skill\.\)\n/, "");
  assert.equal(strip(plugin), strip(repoSkill));
  assert.throws(() => pluginSkill("no block", version), /kitchen-run:start/);
});

test("the pin counts only for this version and only as a sha512 integrity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-pin-"));
  fs.mkdirSync(path.join(dir, path.dirname(PIN_FILE)), { recursive: true });
  const write = (o: object) => fs.writeFileSync(path.join(dir, PIN_FILE), JSON.stringify(o));
  write({ package: "devkitchen", version, integrity: HASH });
  assert.equal(readPin(dir, version), HASH);
  assert.equal(readPin(dir, "9.9.9"), null, "a pin for an older version is no pin");
  write({ package: "devkitchen", version, integrity: "sha1-abc; rm -rf /" });
  assert.equal(readPin(dir, version), null);
  fs.rmSync(dir, { recursive: true, force: true });
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
  // Logo B, the cook (scripts/brand/gen-icons.mjs): a 1024 px PNG both manifests name.
  assert.equal(JSON.parse(f["plugins/kitchen/.claude-plugin/plugin.json"]).icon, "./assets/icon.png");
  assert.equal(JSON.parse(f["plugins/kitchen/.codex-plugin/plugin.json"]).interface.logo, "./assets/icon.png");
  const png = fs.readFileSync(path.join(ROOT, "plugins", "kitchen", "assets", "icon.png"));
  assert.equal(png.readUInt32BE(16), 1024, "width");
  assert.equal(png.readUInt32BE(20), 1024, "height");
});
