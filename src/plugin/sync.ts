// The Claude Code and Codex plugin (ADR 0011): this repository is a plugin marketplace, and its one
// plugin, plugins/kitchen, carries the /kitchen skill. The plugin's SKILL.md is the repo skill
// (skills/kitchen/SKILL.md) with its "how to run Kitchen" block replaced: in a repo where Kitchen
// isn't installed yet, the plugin runs the CLI with `npx -y devkitchen@<this version>`, falling back
// to a `kitchen` on PATH. The manifests carry the same version. All of it is generated from
// package.json and the repo skill, so nothing drifts: `npm run plugin:sync` rewrites it and a test
// fails when it is stale.
//
// npx runs whatever the registry serves under that name. So the skill runs it only when the registry's
// `dist.integrity` for that version equals the hash pinned here, at release, from the tarball the
// maintainer published (`npm run plugin:sync -- --pin`, kept in plugins/kitchen/pin.json). With no pin
// (not published yet) the skill never runs npx: it uses `kitchen` on PATH or says how to install it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUN_START = /<!-- kitchen-run:start[^>]*-->\n/;
const RUN_END = "<!-- kitchen-run:end -->\n";

const DESCRIPTION =
  "Kitchen turns tickets into reviewed changes on a staging branch: one Claude Code session runs intake, build, QA (Playwright, against your running app) and review agents.";
const KEYWORDS = ["kitchen", "pull-requests", "verification", "agents", "software-factory"];

/** The published tarball's integrity the skill trusts, written at release (null: nothing published and pinned yet). */
export type Pin = { package: "devkitchen"; version: string; integrity: string | null };
export const PIN_FILE = path.join("plugins", "kitchen", "pin.json");

/** Pure: how the plugin runs Kitchen: npx only for the pinned tarball, else `kitchen` on PATH. */
export function runBlock(version: string, integrity: string | null): string {
  const install = (n: number, lead: string) => `${n}. ${lead}, tell the user Kitchen isn't installed and how to get it:
   \`npm install -g devkitchen@${version}\`. Don't install it yourself unless
   they say so.`;
  if (!integrity)
    return `This skill comes from the Kitchen plugin, for devkitchen ${version}. The plugin has no pinned package yet, so
never run Kitchen through \`npx\`. Find how to run it once per session, from the repo root:

1. \`kitchen --version\`: if it prints a version, use \`kitchen\` from PATH, and say
   which version it is if it isn't ${version}.
${install(2, "If it doesn't")}

Run every command below from the repo root. (This plugin's skill is \`/kitchen:kitchen\` in Claude Code and
\`kitchen:kitchen\` in Codex: plugin skills are namespaced; where this page says \`/kitchen\`, that is this skill.)
`;
  return `This skill comes from the Kitchen plugin, pinned to devkitchen ${version} and to one tarball:
\`${integrity}\`.
Find how to run Kitchen once per session, from the repo root:

1. \`npm view devkitchen@${version} dist.integrity --fetch-timeout=5000 --fetch-retries=0\`
   (a few seconds at most; offline it fails). Only if it prints exactly
   \`${integrity}\`, use \`npx -y devkitchen@${version}\` wherever this page says
   \`kitchen\`. Any other answer means the registry serves something this plugin
   didn't pin: don't run it, and tell the user.
2. Otherwise \`kitchen --version\`: if it prints a version, use \`kitchen\` from
   PATH, and say which version it is if it isn't ${version}.
${install(3, "If neither works")}

Run every command below from the repo root. (This plugin's skill is \`/kitchen:kitchen\` in Claude Code and
\`kitchen:kitchen\` in Codex: plugin skills are namespaced; where this page says \`/kitchen\`, that is this skill.)
`;
}

/** Pure: the plugin's SKILL.md from the repo skill. Throws without the block. */
export function pluginSkill(repoSkill: string, version: string, integrity: string | null = null): string {
  const a = RUN_START.exec(repoSkill);
  const b = repoSkill.indexOf(RUN_END);
  if (!a || b < a.index) throw new Error("skills/kitchen/SKILL.md has no kitchen-run:start … kitchen-run:end block");
  return `${repoSkill.slice(0, a.index)}${runBlock(version, integrity)}${repoSkill.slice(b + RUN_END.length)}`;
}

/** The pin for `version`: a pin for another version (before a re-pin) counts as none. */
export function readPin(root: string, version: string): string | null {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(root, PIN_FILE), "utf8")) as Pin;
    return p.version === version && typeof p.integrity === "string" && /^sha512-[A-Za-z0-9+/=]+$/.test(p.integrity) ? p.integrity : null;
  } catch {
    return null;
  }
}

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

/** Pure: every generated file, path → content. */
export function pluginFiles(
  pkg: { version: string; repository?: { url?: string } },
  repoSkill: string,
  integrity: string | null = null,
): Record<string, string> {
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
      icon: "./assets/icon.png",
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
        logo: "./assets/icon.png",
        composerIcon: "./assets/icon.png",
        ...(homepage ? { websiteURL: homepage } : {}),
      },
    }),
    "plugins/kitchen/skills/kitchen/SKILL.md": pluginSkill(repoSkill, v, integrity),
    [PIN_FILE]: json({ package: "devkitchen", version: v, integrity } satisfies Pin),
  };
}

export function currentFiles(root = ROOT): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string; repository?: { url?: string } };
  return pluginFiles(pkg, fs.readFileSync(path.join(root, "skills", "kitchen", "SKILL.md"), "utf8"), readPin(root, pkg.version));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // --pin, at release, after `npm publish`: trust the tarball the registry now serves for this version.
  if (process.argv.includes("--pin")) {
    const version = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    const integrity = execFileSync("npm", ["view", `devkitchen@${version}`, "dist.integrity", "--fetch-timeout=10000", "--fetch-retries=1"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    if (!/^sha512-[A-Za-z0-9+/=]+$/.test(integrity))
      throw new Error(`npm view devkitchen@${version} dist.integrity gave ${JSON.stringify(integrity)}: publish it first`);
    fs.writeFileSync(path.join(ROOT, PIN_FILE), json({ package: "devkitchen", version, integrity } satisfies Pin));
    console.log(`plugin: pinned devkitchen@${version} to ${integrity}`);
  }
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
