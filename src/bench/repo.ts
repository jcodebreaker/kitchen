// A benchmark repo: a fresh git repo holding one fixture (no node_modules), its
// Toolkit (fixture A ships its own; B–D get the Toolkit `kitchen init` generated
// for them on Claude in W2, kept in bench/toolkits/), the ticket's plants, and a
// kitchen.yaml for the run. The bench acts as the developer here: it makes the
// repo and, later, merges Toolkit PRs as a human would.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyPlant, type BenchTicket, benchDir } from "./set.ts";

export type FixtureSpec = { docker: boolean; checks: string[]; testCmd: string };

export const FIXTURES: Record<BenchTicket["fixture"], FixtureSpec> = {
  "a-web": { docker: true, checks: ["node --check server.js"], testCmd: "node --test {file}" },
  "b-cli": { docker: false, checks: ["python3 -m compileall -q tasks"], testCmd: "python3 -m unittest {file}" },
  "c-adopt": { docker: true, checks: ["node --check server.js"], testCmd: "node --test {file}" },
  "d-api": { docker: false, checks: ["node --check server.js"], testCmd: "node --test {file}" },
  "e-library": { docker: false, checks: ["node --check server.js"], testCmd: "node --test {file}" },
};

const IGNORE = [
  ".kitchen/jobs/",
  ".kitchen/scratch/",
  ".kitchen/init/",
  ".kitchen/checks/",
  ".kitchen/toolkit-checkouts/",
  ".kitchen/toolkit-prs/",
  ".kitchen/bench-oracle/",
  ".kitchen/*.json",
  ".kitchen/*.jsonl",
  ".kitchen/*.lock",
  ".kitchen/*.log",
  ".kitchen/toolkit.proven",
  ".worktrees/",
  "node_modules/",
  "__pycache__/",
  "data/",
];

export const gitIn = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "-c", "commit.gpgSign=false", ...a], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });

export function agentYaml(tool: "claude" | "codex", claudeBin: string): string {
  return tool === "claude"
    ? `{ tool: claude, command: [${JSON.stringify(claudeBin)}], models: { strong: sonnet, medium: haiku }, timeout_sec: 1800, max_turns: 80 }`
    : `{ tool: codex, timeout_sec: 1800, max_turns: 80 }`;
}

/** Make the repo at `dir` (replaced if it exists). Returns its path. */
export function makeBenchRepo(kitchenRoot: string, t: BenchTicket, dir: string, agent: string): string {
  fs.rmSync(dir, { recursive: true, force: true });
  const src = path.join(kitchenRoot, "fixtures", t.fixture);
  fs.cpSync(src, dir, { recursive: true, filter: (p) => !/[/\\](node_modules|__pycache__|\.worktrees|data)([/\\]|$)/.test(p.slice(src.length)) });
  const tk = path.join(benchDir(kitchenRoot), "toolkits", t.fixture);
  if (fs.existsSync(tk)) {
    fs.cpSync(path.join(tk, "toolkit"), path.join(dir, ".kitchen", "toolkit"), { recursive: true, filter: (p) => !p.includes("node_modules") });
    fs.copyFileSync(path.join(tk, "env.kitchen"), path.join(dir, ".env.kitchen"));
  }
  for (const p of t.plant) {
    const f = path.join(dir, p.file);
    fs.writeFileSync(f, applyPlant(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "", p));
  }
  const gi = path.join(dir, ".gitignore");
  fs.writeFileSync(gi, `${fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : ""}\n${IGNORE.join("\n")}\n`);
  const fx = FIXTURES[t.fixture];
  fs.writeFileSync(
    path.join(dir, "kitchen.yaml"),
    [
      "concurrency: 1",
      "round_limit: 3",
      `agent: ${agent}`,
      "checks:",
      ...fx.checks.map((c, i) => `  - { name: check${i + 1}, run: ${JSON.stringify(c)} }`),
      `test_cmd: ${JSON.stringify(fx.testCmd)}`,
      "",
    ].join("\n"),
  );
  gitIn(path.dirname(dir), "init", "-q", "-b", "main", dir);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", `fixture ${t.fixture}${t.plant.length ? " (planted)" : ""}`);
  return dir;
}

/** The human merges a Toolkit PR (a local forge's branch) into main. Returns the new main sha. */
export function mergeToolkitBranch(repo: string, branch: string): string {
  gitIn(repo, "merge", "--no-ff", "-q", "-m", `Merge Toolkit PR ${branch}`, branch);
  return gitIn(repo, "rev-parse", "HEAD").trim();
}
