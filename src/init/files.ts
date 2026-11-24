// The few files `kitchen init` adds to a repo: kitchen.yaml (checks, how to start the app, staging), the /kitchen
// skill (the same file for Claude Code and Codex) and Kitchen's .gitignore entries. Each step is idempotent.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.ts";
import type { DetectedApp } from "./detect-app.ts";
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

/** The installed copies that differ from this Kitchen's skill, brought up to date (`kitchen run` before a session). */
export function refreshSkill(repo: string): string[] {
  const want = fs.readFileSync(SKILL, "utf8");
  const stale = SKILL_FILES.filter((f) => {
    try {
      return fs.readFileSync(path.join(repo, f), "utf8") !== want;
    } catch {
      return true;
    }
  });
  for (const f of stale) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), want);
  }
  return stale;
}

export const GITIGNORE = [
  ".kitchen/jobs/",
  ".kitchen/init/",
  ".kitchen/agents/",
  ".kitchen/merge/",
  ".kitchen/verify/",
  ".kitchen/ledger.jsonl",
  ".kitchen/run.json",
  ".kitchen/run.log",
  ".kitchen/run*.jsonl",
  ".kitchen/orchestrator.json",
  ".kitchen/*.lock",
  ".kitchen/inbox/",
  ".kitchen/sources/*.state.json",
  ".kitchen/collect.log",
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

const KITCHEN_YAML = (tool: string, base: string) => `# Kitchen (npm package devkitchen). Every key has a default; unknown keys are refused.
# The full list with defaults: src/config.ts in the package (ConfigSchema).
version: 1
agent: { tool: ${tool} }
round_limit: 3   # Build → QA → Review rounds before a person is asked
parallel: 4      # lane agents at once (intake lanes are never held for room)
# Passing jobs merge into staging (never ${base}); high risk or over max_lines stops at Ready for you.
# merge: kitchen (Kitchen merges) or pr (Kitchen opens a PR with the Report, a person merges it; needs forge github).
# A ticket can name another target: kitchen ticket --into <branch>.
staging: { branch: staging, base: ${JSON.stringify(base)}, max_lines: 400 }
`;

/** A YAML scalar on one line, whatever its length (JSON is YAML; `stringify` folds long strings, review R1). */
const scalar = (v: string) => JSON.stringify(v);

const INSTALL_LINES = (pm: string) => ["# A frozen install from the lockfile, run once in each fresh job worktree before the checks", `checks_install: ${pm}`];

/**
 * Pure: the YAML lines for the detected checks (Kitchen runs them in every job). `proposed`: checks an agent
 * proposed that the person hasn't accepted: written commented out, so nothing runs them until they do.
 */
export function checksYaml(d: Detected, o: { proposed?: boolean } = {}): string {
  const one = (c: Detected["checks"][number]) => {
    const extra = c.when ? `, when: ${c.when}, needs_app: ${!!c.needsApp}${c.timeoutSec ? `, timeout_sec: ${c.timeoutSec}` : ""}` : "";
    return `  - { name: ${scalar(c.name)}, run: ${scalar(c.run)}${extra} }`;
  };
  const merge = d.checks.find((c) => c.when === "merge");
  const lines = [
    "checks:",
    ...d.checks.filter((c) => !c.when).map(one),
    ...(merge
      ? [
          `  # Your end-to-end suite: only on the trial merge into staging, never after Build (when: merge)${merge.needsApp ? ", with the app started from the merged result and its URL in $BASE_URL (needs_app)" : ""}`,
          one(merge),
        ]
      : []),
    ...(d.install ? INSTALL_LINES(d.install) : []),
  ];
  return [
    o.proposed
      ? "# Checks an agent proposed from reading the repo. NOT used and never run until you uncomment them (review them first):"
      : `# What Kitchen runs in every job's worktree after Build, and on staging before a merge (found in ${d.from.join(", ")}; edit freely)`,
    ...(o.proposed ? lines.map((l) => (l.startsWith("#") ? l : `# ${l}`)) : lines),
    "",
  ].join("\n");
}

/** Pure: the `app:` block for kitchen.yaml: how QA starts the app ($PORT / {port} is a free port). */
export function appYaml(a: DetectedApp | null, o: { asked?: boolean } = {}): string {
  if (!a) return '# How QA starts the app (none found): app: { start: "npm start", health: "/" }\n';
  const fields = [`start: ${scalar(a.start)}`, `health: ${scalar(a.health)}`, ...(a.reset ? [`reset: ${scalar(a.reset)}`] : [])];
  const noReset = a.reset
    ? ""
    : '# No reset found. So QA can restart on fresh data (kitchen qa reset), add to app: reset: "<a command that puts the data back to its seed>"\n';
  return `# How QA starts the app (${o.asked ? "your answer" : `found in ${a.from}`}); it gets a free port in $PORT\n${noReset}app: { ${fields.join(", ")} }\n`;
}

/** The config the person already has decides: a kitchen.yaml that names checks keeps them, whoever runs (quick init or the build). */
export const hasOwnChecks = (repo: string): boolean => {
  const f = path.join(repo, "kitchen.yaml");
  return fs.existsSync(f) && /^checks\s*:/m.test(fs.readFileSync(f, "utf8"));
};

/**
 * kitchen.yaml: written when missing; an existing one is kept, and only gets the detected checks when it names
 * none (no `checks:` key yet), and the detected `app:` when it has none. One that names checks but has no install gets
 * just `checks_install` when the repo now has a lockfile to install from.
 */
export function writeConfig(
  repo: string,
  tool: string,
  d: Detected | null,
  o: { proposed?: boolean; app?: DetectedApp | null; appAsked?: boolean; base?: string } = {},
): { written: boolean; checksAdded: boolean; installAdded: boolean; appAdded: boolean } {
  const f = path.join(repo, "kitchen.yaml");
  const checks = !!d?.checks.length;
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, `${KITCHEN_YAML(tool, o.base ?? "main")}${appYaml(o.app ?? null, { asked: o.appAsked })}${d && checks ? checksYaml(d, o) : ""}`);
    return { written: true, checksAdded: checks && !o.proposed, installAdded: false, appAdded: !!o.app };
  }
  let appAdded = false;
  if (o.app && !/^app\s*:/m.test(fs.readFileSync(f, "utf8"))) {
    const t = fs.readFileSync(f, "utf8");
    fs.writeFileSync(f, `${t}${t.endsWith("\n") ? "" : "\n"}${appYaml(o.app, { asked: o.appAsked })}`);
    appAdded = true;
  }
  const r = writeChecks(f, d, o);
  return { ...r, appAdded };
}

function writeChecks(f: string, d: Detected | null, o: { proposed?: boolean }): { written: boolean; checksAdded: boolean; installAdded: boolean } {
  const repo = path.dirname(f);
  const checks = !!d?.checks.length;
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
      },
      o,
    ),
  );
  return { written: false, checksAdded: !o.proposed, installAdded: false };
}
