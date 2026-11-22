// The few files Kitchen adds to a repo, shared by quick init and the Toolkit
// build: kitchen.yaml, the /kitchen skill (the same file for Claude Code and
// Codex) and Kitchen's .gitignore entries. Each step is idempotent.
import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../config.ts";
import type { Detected } from "./detect-checks.ts";

const PKG = path.resolve(import.meta.dirname, "..", "..");
const SKILL = path.join(PKG, "skills", "kitchen", "SKILL.md");
export const SKILL_FILES = [".claude/skills/kitchen/SKILL.md", ".agents/skills/kitchen/SKILL.md"];

/** The /kitchen skill, the same file for both tools: .claude/skills (Claude Code) and .agents/skills (Codex). */
export function installSkill(repo: string): string[] {
  for (const f of SKILL_FILES) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.copyFileSync(SKILL, path.join(repo, f));
  }
  return SKILL_FILES;
}

export const GITIGNORE = [
  ".kitchen/jobs/",
  ".kitchen/checks/",
  ".kitchen/scratch/",
  ".kitchen/init/",
  ".kitchen/ledger.jsonl",
  ".kitchen/run.lock",
  ".kitchen/run.log",
  ".kitchen/toolkit.proven",
  ".kitchen/toolkit-checkouts/",
  ".kitchen/queue.json",
  ".kitchen/tickets.jsonl",
  ".kitchen/setup-questions.json",
  ".kitchen/setup-answers.json",
  ".kitchen-out/",
  ".kitchen/retro/",
  ".kitchen/local-forge.jsonl",
  ".kitchen/evidence.lock",
  ".worktrees/",
];

/** Kitchen's state never gets committed. Returns the entries it added. */
export function addGitignore(repo: string): string[] {
  const f = path.join(repo, ".gitignore");
  const have = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  const lines = new Set(have.split("\n").map((l) => l.trim()));
  const added = GITIGNORE.filter((l) => !lines.has(l));
  if (added.length) fs.writeFileSync(f, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${have ? "\n" : ""}# Kitchen\n${added.join("\n")}\n`);
  return added;
}

/** The tool a new kitchen.yaml names: the flag, the file's own, or the agent that started us. */
export function toolFor(repo: string, flag?: "claude" | "codex"): string {
  if (flag) return flag;
  if (fs.existsSync(path.join(repo, "kitchen.yaml"))) return loadConfig(repo).agent.tool;
  return process.env.CODEX_SANDBOX || process.env.CODEX_HOME ? "codex" : "claude";
}

const KITCHEN_YAML = (tool: string) => `# Kitchen (npm package devkitchen). Every key has a default; unknown keys are refused.
# The full list with defaults: src/config.ts in the package (ConfigSchema).
version: 1       # the schema version; kitchen migrate raises it
agent: { tool: ${tool} }
concurrency: 2   # a Toolkit proven parallel:false runs one job at a time regardless
round_limit: 3
# models: { builder: strong, verifier: medium, setup: medium }   # tiers map to models per tool
`;

/** Pure: the YAML lines for the detected checks (Gate runs them in every job). */
export function checksYaml(d: Detected): string {
  const q = (s: string) => stringify(s).trimEnd();
  return [
    `# What Gate runs in every job's worktree (found in ${d.from.join(", ")}; edit freely)`,
    "checks:",
    ...d.checks.map((c) => `  - { name: ${c.name}, run: ${q(c.run)} }`),
    ...(d.prepare
      ? ["# Readies a fresh job worktree before the checks; downloading packages needs the network", `checks_prepare: ${q(d.prepare)}`, "checks_network: true"]
      : []),
    ...(d.testCmd ? ["# How a `test <file>` proof runs", `test_cmd: ${q(d.testCmd)}`] : []),
    "",
  ].join("\n");
}

/**
 * kitchen.yaml: written when missing; an existing one is kept, and only gets the
 * detected checks when it names none (no `checks:` key yet).
 */
export function writeConfig(repo: string, tool: string, d: Detected | null): { written: boolean; checksAdded: boolean } {
  const f = path.join(repo, "kitchen.yaml");
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, `${KITCHEN_YAML(tool)}${d?.checks.length ? checksYaml(d) : ""}`);
    return { written: true, checksAdded: !!d?.checks.length };
  }
  const have = fs.readFileSync(f, "utf8");
  if (!d?.checks.length || /^checks\s*:/m.test(have)) return { written: false, checksAdded: false };
  const extra = checksYaml({
    ...d,
    prepare: /^checks_(prepare|network)\s*:/m.test(have) ? undefined : d.prepare,
    testCmd: /^test_cmd\s*:/m.test(have) ? undefined : d.testCmd,
  });
  fs.writeFileSync(f, `${have}${have.endsWith("\n") ? "" : "\n"}${extra}`);
  return { written: false, checksAdded: true };
}
