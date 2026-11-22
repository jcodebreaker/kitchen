// `kitchen init` (ADR 0010): quick init, seconds when the checks are obvious.
// It writes kitchen.yaml and the /kitchen skill, adds Kitchen's .gitignore
// entries, finds the project's checks (detect-checks.ts; one short read-only
// agent call on the cheap tier only when nothing obvious is there), runs them
// once on the checkout and records the result in .kitchen/init/checks.json.
// No Toolkit, no worktree, no app start, no Docker: `kitchen toolkit build` is
// that step (build.ts).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentAdapter } from "../agents/adapter.ts";
import { buildAgentEnv, untrustedEnv } from "../agents/env.ts";
import { type Config, loadConfig, tierModel } from "../config.ts";
import { openGit, plainCheckout } from "../engine/git.ts";
import { writeAtomic } from "../engine/store.ts";
import { kitchenHome } from "../home.ts";
import { appendLedger } from "../ledger/append.ts";
import { type Detected, detectChecks } from "./detect-checks.ts";
import { addGitignore, installSkill, toolFor, writeConfig } from "./files.ts";
import { dur, phaseLine, usd } from "./say.ts";

export type QuickOpts = {
  repo: string;
  tool?: "claude" | "codex";
  /** The adapter for the one agent call (tests pass a fake); default: the configured tool. */
  agent?: () => Promise<AgentAdapter>;
};

export type CheckRun = { name: string; run: string; ok: boolean; exit: number | null; secs: number; tail: string };
export type QuickRecord = {
  at: string;
  sha: string | null;
  from: string[];
  /** How the checks were found: from the repo's files, by an agent, or already in kitchen.yaml. */
  found: "files" | "agent" | "config" | "none";
  agent?: { model: string; secs: number; usd?: number };
  prepare?: CheckRun;
  results: CheckRun[];
};

export const checksRecord = (repo: string) => path.join(repo, ".kitchen", "init", "checks.json");

export function readQuickRecord(repo: string): QuickRecord | null {
  try {
    return JSON.parse(fs.readFileSync(checksRecord(repo), "utf8")) as QuickRecord;
  } catch {
    return null;
  }
}

export async function quickInit(o: QuickOpts, out: (l: string) => void): Promise<number> {
  const t0 = Date.now();
  const repo = plainCheckout(o.repo).workTree;
  const git = await openGit(plainCheckout(repo));
  let sha: string | null = null;
  try {
    sha = (await git.run(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  } catch {}
  let branch = "";
  try {
    branch = (await git.run(["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  } catch {}
  out(`Setting up Kitchen in ${path.basename(repo)}…`);

  // 1. checks: kitchen.yaml's own, else the repo's files, else one short agent call
  const tool = toolFor(repo, o.tool);
  const had = fs.existsSync(path.join(repo, "kitchen.yaml")) ? loadConfig(repo) : null;
  let found: QuickRecord["found"] = "none";
  let detected: Detected | null = null;
  let agentRun: QuickRecord["agent"];
  if (had?.checkList.length) found = "config";
  else {
    detected = detectChecks(repo);
    if (detected) found = "files";
    else {
      const base = had ?? loadConfig(repo);
      const a = await proposeChecks(repo, { ...base, agent: { ...base.agent, tool: tool as Config["agent"]["tool"] } }, o.agent);
      agentRun = a.run;
      detected = a.detected;
      if (detected) found = "agent";
    }
  }

  // 2. the files
  const cfgW = writeConfig(repo, tool, detected);
  const cfg = loadConfig(repo);
  const n = cfg.checkList.length;
  const from =
    found === "config" ? "kept from kitchen.yaml" : found === "files" ? `from ${detected?.from.join(", ")}` : found === "agent" ? "proposed by an agent" : "";
  out(
    phaseLine(
      true,
      cfgW.written ? "Wrote kitchen.yaml" : "Kept kitchen.yaml",
      `agent ${cfg.agent.tool} · ${n ? `${n} check${n === 1 ? "" : "s"} ${from}` : "no checks found"}${cfgW.checksAdded && !cfgW.written ? " (added)" : ""}`,
      agentRun?.secs,
      agentRun?.usd,
    ),
  );
  installSkill(repo);
  out(phaseLine(true, "Installed the skill", "/kitchen for Claude Code (.claude/skills) and Codex (.agents/skills)"));
  const added = addGitignore(repo);
  out(phaseLine(true, "Updated .gitignore", added.length ? `${added.length} Kitchen entries` : "already has Kitchen's entries"));

  // 3. run them once on the checkout
  const record: QuickRecord = { at: new Date().toISOString(), sha, from: detected?.from ?? [], found, ...(agentRun ? { agent: agentRun } : {}), results: [] };
  let failed: CheckRun | undefined;
  if (n) {
    const c0 = Date.now();
    const env = untrustedEnv(repo);
    if (cfg.checks_prepare && !fs.existsSync(path.join(repo, "node_modules")) && /^(npm|pnpm|yarn|bun)\b/.test(cfg.checks_prepare)) {
      record.prepare = await runCheck(repo, { name: "prepare", run: cfg.checks_prepare, timeoutSec: 1800 }, env);
      if (!record.prepare.ok) failed = record.prepare;
    }
    for (const c of failed ? [] : cfg.checkList) {
      const r = await runCheck(repo, c, env);
      record.results.push(r);
      if (!r.ok) failed ??= r;
    }
    const where = `on ${branch || "HEAD"}${sha ? ` (${sha.slice(0, 7)})` : ""}`;
    const names = record.results.map((r) => r.name).join(", ");
    const verdict = failed ? `${failed.name} FAILED (${failed.exit === null ? "timed out" : `exit ${failed.exit}`})` : `${names} passed`;
    out(phaseLine(!failed, "Ran the checks", `${verdict} ${where}`, (Date.now() - c0) / 1000));
  }
  fs.mkdirSync(path.dirname(checksRecord(repo)), { recursive: true });
  writeAtomic(checksRecord(repo), `${JSON.stringify(record, null, 2)}\n`);
  appendLedger(repo, {
    job: "-",
    stage: "init",
    round: 0,
    event: "checks",
    key: `init/checks/${record.at}`,
    result: !n ? "none" : failed ? "fail" : "pass",
    detail: { found, sha, checks: record.results.map((r) => ({ name: r.name, ok: r.ok, secs: r.secs })) },
  });

  if (failed) {
    out("");
    out(`${failed.name} failed on your checkout: ${failed.run}`);
    out(failed.tail.replace(/^/gm, "  | "));
    out("Gate runs these checks on every job, so every job would fail them. Fix them (or edit checks: in kitchen.yaml), then run kitchen init again.");
    out("");
  } else if (!n) {
    out("");
    out('No checks found: Gate will have nothing to run. Add them to kitchen.yaml (checks: ["npm test"]) when you can.');
    out("");
  }
  const cost = agentRun?.usd;
  out(`Done in ${dur((Date.now() - t0) / 1000)} · ${agentRun ? `one agent call${cost ? ` (${usd(cost)})` : ""}` : "no agent"}`);
  out('Next: kitchen ticket "<what you want>"  then  kitchen run --detach');
  out("      commit kitchen.yaml, .gitignore and the skill folders when you like");
  out("      to have Kitchen drive your app as well: kitchen toolkit build (about 3–15 min)");
  return 0;
}

/** One check in the checkout, with the untrusted env (no credentials), its own process group, killed at its timeout. */
function runCheck(repo: string, c: { name: string; run: string; timeoutSec: number }, env: Record<string, string>): Promise<CheckRun> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", c.run], { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    const keep = (b: Buffer) => {
      text = (text + b.toString("utf8")).slice(-8000);
    };
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (p.pid) process.kill(-p.pid, "SIGKILL");
      } catch {}
    }, c.timeoutSec * 1000);
    const done = (code: number | null) => {
      clearTimeout(timer);
      const tail = text.trimEnd().split("\n").slice(-40).join("\n");
      resolve({ name: c.name, run: c.run, ok: !timedOut && code === 0, exit: timedOut ? null : code, secs: (Date.now() - t0) / 1000, tail });
    };
    p.on("error", (e) => {
      text += String(e.message);
      done(127);
    });
    p.on("close", done);
  });
}

const PROPOSE = `You are helping Kitchen find this repository's checks: the commands a developer runs
before pushing (lint, typecheck, tests, build). Read only what you need (the README,
the build files, CI config such as .github/workflows, AGENTS.md or CONTRIBUTING.md);
don't run anything and don't change any file.

Write checks.md with these lines and nothing else:
CHECK: <name> | <shell command, run from the repo root>      (one line per check, at most 4)
PREPARE: <command that installs dependencies in a fresh clone, or none>
TEST_CMD: <command that runs one test file, with {file} for its path, or none>

Name only commands the repo itself shows. When it shows none, write no CHECK line.`;

/** Pure: checks.md → Detected (null when it names no check). */
export function parseProposal(text: string): Detected | null {
  const val = (k: string) => {
    const v = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(text)?.[1].trim();
    return v && !/^(none|-|n\/a)$/i.test(v) ? v : undefined;
  };
  const checks = [...text.matchAll(/^CHECK:\s*([\w.-]+)\s*\|\s*(.+)$/gm)].slice(0, 4).map((m) => ({ name: m[1], run: m[2].trim() }));
  if (!checks.length) return null;
  const prepare = val("PREPARE");
  const testCmd = val("TEST_CMD");
  return { checks, ...(prepare ? { prepare } : {}), ...(testCmd?.includes("{file}") ? { testCmd } : {}), from: ["an agent's read of the repo"] };
}

/** One short read-only agent call on the cheap tier, no bridge: the checks it proposes, or null. */
async function proposeChecks(
  repo: string,
  cfg: Config,
  agent?: () => Promise<AgentAdapter>,
): Promise<{ detected: Detected | null; run: NonNullable<QuickRecord["agent"]> }> {
  const a = agent ? await agent() : await (await import("../engine/runner.ts")).adapterFor(repo, cfg);
  const model = tierModel(cfg, "cheap");
  const outDir = path.join(repo, ".kitchen", "init", "agent");
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const r = await a.run({
    role: "setup",
    prompt: PROPOSE,
    cwd: repo,
    outDir,
    model,
    tier: "read",
    timeoutSec: 180,
    maxTurns: 15,
    outFile: "checks.md",
    env: buildAgentEnv(path.join(kitchenHome(), "agent-scrub")),
  });
  const secs = (Date.now() - t0) / 1000;
  const text = r.outPath && fs.existsSync(r.outPath) ? fs.readFileSync(r.outPath, "utf8") : "";
  appendLedger(repo, {
    job: "-",
    stage: "init",
    round: 0,
    event: "agent",
    key: `init/checks-agent/${new Date().toISOString()}`,
    result: r.ok ? "ok" : "error",
    role: "setup",
    agent: a.name,
    model,
    secs,
    usd: r.usage?.usd,
    detail: { line: r.line, error: r.error },
  });
  return { detected: text ? parseProposal(text) : null, run: { model, secs, ...(r.usage?.usd !== undefined ? { usd: r.usage.usd } : {}) } };
}
