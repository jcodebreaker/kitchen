// The few files Kitchen adds to a repo, shared by quick init and the Toolkit
// build: kitchen.yaml, the /kitchen skill (the same file for Claude Code and
// Codex) and Kitchen's .gitignore entries. Each step is idempotent.
import fs from "node:fs";
import path from "node:path";
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
  ".kitchen/toolkit.approved",
  ".kitchen/toolkit.passed",
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

/** A YAML scalar on one line, whatever its length (JSON is YAML; `stringify` folds long strings, review R1). */
const scalar = (v: string) => JSON.stringify(v);

const INSTALL_LINES = (pm: string) => [
  "# A frozen install from the lockfile: downloads with the network, runs no package scripts; they run after (online only while the dependency files are the base's)",
  `checks_install: ${pm}`,
];

/**
 * Pure: the YAML lines for the detected checks (Gate runs them in every job). `proposed`: checks an agent
 * proposed that the person hasn't accepted: written commented out, so nothing runs them until they do.
 */
export function checksYaml(d: Detected, o: { proposed?: boolean } = {}): string {
  const lines = [
    "checks:",
    ...d.checks.map((c) => `  - { name: ${scalar(c.name)}, run: ${scalar(c.run)} }`),
    ...(d.install ? INSTALL_LINES(d.install) : []),
    ...(d.testCmd ? ["# How a `test <file>` proof runs", `test_cmd: ${scalar(d.testCmd)}`] : []),
  ];
  return [
    o.proposed
      ? "# Checks an agent proposed from reading the repo. NOT used and never run until you uncomment them (review them first):"
      : `# What Gate runs in every job's worktree (found in ${d.from.join(", ")}; edit freely)`,
    ...(o.proposed ? lines.map((l) => (l.startsWith("#") ? l : `# ${l}`)) : lines),
    "",
  ].join("\n");
}

/** The config the person already has decides: a kitchen.yaml that names checks keeps them, whoever runs (quick init or the build). */
export const hasOwnChecks = (repo: string): boolean => {
  const f = path.join(repo, "kitchen.yaml");
  return fs.existsSync(f) && /^checks\s*:/m.test(fs.readFileSync(f, "utf8"));
};

/**
 * kitchen.yaml: written when missing; an existing one is kept, and only gets the detected checks when it names
 * none (no `checks:` key yet). One that names checks but has no install gets just `checks_install` when the repo now
 * has a lockfile to install from (review R3). The one rule for quick init and the build.
 */
export function writeConfig(
  repo: string,
  tool: string,
  d: Detected | null,
  o: { proposed?: boolean } = {},
): { written: boolean; checksAdded: boolean; installAdded: boolean } {
  const f = path.join(repo, "kitchen.yaml");
  const checks = !!d?.checks.length;
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, `${KITCHEN_YAML(tool)}${d && checks ? checksYaml(d, o) : ""}`);
    return { written: true, checksAdded: checks && !o.proposed, installAdded: false };
  }
  const have = fs.readFileSync(f, "utf8");
  const append = (text: string) => fs.writeFileSync(f, `${have}${have.endsWith("\n") ? "" : "\n"}${text}`);
  if (hasOwnChecks(repo)) {
    if (!d?.install || /^checks_(install|prepare)\s*:/m.test(have)) return { written: false, checksAdded: false, installAdded: false };
    append(`${INSTALL_LINES(d.install).join("\n")}\n`);
    return { written: false, checksAdded: false, installAdded: true };
  }
  if (!d || !checks) return { written: false, checksAdded: false, installAdded: false };
  append(
    checksYaml(
      {
        ...d,
        install: /^checks_(install|prepare)\s*:/m.test(have) ? undefined : d.install,
        testCmd: /^test_cmd\s*:/m.test(have) ? undefined : d.testCmd,
      },
      o,
    ),
  );
  return { written: false, checksAdded: !o.proposed, installAdded: false };
}
