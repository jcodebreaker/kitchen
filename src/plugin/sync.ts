// The Claude Code and Codex plugin (ADR 0011): this repository is a plugin marketplace, and its one
// plugin, plugins/kitchen, carries the /kitchen skill. The plugin's SKILL.md is the repo skill
// (skills/kitchen/SKILL.md) with its "how to run Kitchen" block replaced: in a repo where Kitchen
// isn't installed yet, the plugin runs the CLI with `npx -y devkitchen@<this version>`, falling back
// to a `kitchen` on PATH. The manifests carry the same version. All of it is generated from
// package.json and the repo skill, so nothing drifts: `npm run plugin:sync` rewrites it and a test
// fails when it is stale.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUN_START = /<!-- kitchen-run:start[^>]*-->\n/;
const RUN_END = "<!-- kitchen-run:end -->\n";

const DESCRIPTION = "Kitchen turns tickets into pull requests proven by driving your real app, with Claude Code or Codex doing the judgment.";
const KEYWORDS = ["kitchen", "pull-requests", "verification", "agents", "software-factory"];

/** Pure: how the plugin runs Kitchen, pinned to `version`. */
export function runBlock(version: string): string {
  return `This skill comes from the Kitchen plugin, pinned to devkitchen ${version}.
Find how to run Kitchen once per session, from the repo root:

1. \`npx -y devkitchen@${version} --version\`. If it prints \`${version}\`, use
   \`npx -y devkitchen@${version}\` wherever this page says \`kitchen\`.
2. Otherwise (no network, or the package can't be fetched) \`kitchen --version\`:
   if it prints a version, use \`kitchen\` from PATH, and say which version it
   is if it isn't ${version}.
3. If neither works, tell the user Kitchen isn't installed and how to get it:
   \`npm install -g devkitchen@${version}\`. Don't install it yourself unless
   they say so.

Run every command below from the repo root.
`;
}

/** Pure: the plugin's SKILL.md from the repo skill. Throws without the block. */
export function pluginSkill(repoSkill: string, version: string): string {
  const a = RUN_START.exec(repoSkill);
  const b = repoSkill.indexOf(RUN_END);
  if (!a || b < a.index) throw new Error("skills/kitchen/SKILL.md has no kitchen-run:start … kitchen-run:end block");
  return `${repoSkill.slice(0, a.index)}${runBlock(version)}${repoSkill.slice(b + RUN_END.length)}`;
}

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

/** Pure: every generated file, path → content. */
export function pluginFiles(pkg: { version: string; repository?: { url?: string } }, repoSkill: string): Record<string, string> {
  const v = pkg.version;
  const repo = /github\.com\/([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? "")?.[1];
  const homepage = repo ? `https://github.com/${repo}` : undefined;
  const author = { name: "Kitchen contributors" };
  return {
    // Claude Code: `/plugin marketplace add <owner>/kitchen`, then `/plugin install kitchen@kitchen`.
    ".claude-plugin/marketplace.json": json({
      name: "kitchen",
      owner: author,
      metadata: { description: DESCRIPTION, version: v },
      plugins: [{ name: "kitchen", source: "./plugins/kitchen", description: DESCRIPTION, version: v, category: "development", keywords: KEYWORDS }],
    }),
    "plugins/kitchen/.claude-plugin/plugin.json": json({
      name: "kitchen",
      version: v,
      description: DESCRIPTION,
      author,
      ...(homepage ? { homepage, repository: homepage } : {}),
      license: "Apache-2.0",
      keywords: KEYWORDS,
    }),
    // Codex: `codex plugin marketplace add <owner>/kitchen`, then `codex plugin install kitchen@kitchen`.
    // Codex reads .agents/plugins/marketplace.json first (it also reads .claude-plugin/marketplace.json).
    ".agents/plugins/marketplace.json": json({
      name: "kitchen",
      interface: { displayName: "Kitchen" },
      plugins: [{ name: "kitchen", source: { source: "local", path: "./plugins/kitchen" }, category: "Coding" }],
    }),
    "plugins/kitchen/.codex-plugin/plugin.json": json({
      name: "kitchen",
      version: v,
      description: DESCRIPTION,
      keywords: KEYWORDS,
      skills: "./skills",
      interface: {
        displayName: "Kitchen",
        shortDescription: "Tickets to proven pull requests",
        longDescription: DESCRIPTION,
        developerName: "Kitchen contributors",
        category: "Coding",
        ...(homepage ? { websiteURL: homepage } : {}),
      },
    }),
    "plugins/kitchen/skills/kitchen/SKILL.md": pluginSkill(repoSkill, v),
  };
}

export function currentFiles(root = ROOT): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string; repository?: { url?: string } };
  return pluginFiles(pkg, fs.readFileSync(path.join(root, "skills", "kitchen", "SKILL.md"), "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let n = 0;
  for (const [f, text] of Object.entries(currentFiles())) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p) && fs.readFileSync(p, "utf8") === text) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    console.log(`plugin: wrote ${f}`);
    n++;
  }
  if (!n) console.log("plugin: every file is current");
}
