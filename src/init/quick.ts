// `kitchen init` (ADR 0010): quick init, seconds when the checks are obvious.
// It writes kitchen.yaml and the /kitchen skill, adds Kitchen's .gitignore
// entries, finds the project's checks (detect-checks.ts; one short read-only
// agent call on the cheap tier only when nothing obvious is there), runs them
// once on the person's own checkout (HEAD plus whatever they have changed)
// under the proof sandbox Gate uses, and records the result in
// .kitchen/init/checks.json. No Toolkit, no worktree, no app start, no Docker:
// `kitchen toolkit build` is that step (build.ts).
//
// Checks an agent proposed never run without the person's OK (a README can
// carry an injection): in a terminal they are shown and asked about; without
// one they go into kitchen.yaml commented out. Dependencies are installed only
// with a frozen install from a lockfile, announced first, with the network for
// that step alone.
import fs from "node:fs";
import path from "node:path";
import type { AgentAdapter } from "../agents/adapter.ts";
import { buildAgentEnv } from "../agents/env.ts";
import { checksPrepareOf, OFFLINE_REBUILD_NOTE, type PrepareStep, sameDepsAsBase } from "../checks/run-checks.ts";
import { type Config, loadConfig, tierModel } from "../config.ts";
import { toolkitAt } from "../engine/base.ts";
import { openGit, plainCheckout } from "../engine/git.ts";
import { writeAtomic } from "../engine/store.ts";
import { kitchenHome } from "../home.ts";
import { appendLedger } from "../ledger/append.ts";
import { runSandboxed } from "../proof/run-sandboxed.ts";
import { type Detected, detectChecks } from "./detect-checks.ts";
import { addGitignore, hasOwnChecks, installSkill, toolFor, writeConfig } from "./files.ts";
import { markStep } from "./resume.ts";
import { dur, phaseLine, usd } from "./say.ts";
import { skillsReport } from "./skills-report.ts";

export type QuickOpts = {
  repo: string;
  tool?: "claude" | "codex";
  /** The adapter for the one agent call (tests pass a fake); default: the configured tool. */
  agent?: () => Promise<AgentAdapter>;
  /** Asks the person a yes/no question (a terminal). Absent: no one to ask, so proposed checks are written commented out. */
  confirm?: (question: string) => Promise<boolean>;
  /** The command that resumes this init, printed at every halt (ADR 0011). */
  resume?: string;
};

/** What `kitchen init` is doing at each step it records (answers.json), as said when it resumes there. */
export const INIT_STEPS: Record<string, string> = {
  agent: "choosing the agent",
  checks: "finding the checks",
  files: "writing kitchen.yaml",
  run: "running the checks",
};

export type CheckRun = { name: string; run: string; ok: boolean; exit: number | null; secs: number; tail: string; sandboxed?: boolean };
export type QuickRecord = {
  at: string;
  sha: string | null;
  from: string[];
  /**
   * How the checks were found: from the repo's files, by an agent (accepted), already in kitchen.yaml; `proposed`:
   * an agent proposed some the person hasn't accepted (commented out in kitchen.yaml); `none`: nothing;
   * `agent-failed`: the agent call failed (`agent.error`). A re-run with `proposed` or `none` does not ask the agent
   * again; one after `agent-failed` does.
   */
  found: "files" | "agent" | "config" | "proposed" | "none" | "agent-failed";
  agent?: { model: string; secs: number; usd?: number; error?: string };
  prepare?: CheckRun;
  /** Why the checks did not run (no commit, dependencies that can't be installed). */
  skipped?: string;
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

/** The project has dependencies and they aren't installed in the checkout (Node: no node_modules). */
function depsMissing(repo: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { dependencies?: object; devDependencies?: object };
    const n = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    return n > 0 && !fs.existsSync(path.join(repo, "node_modules"));
  } catch {
    return false;
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
  const resume = o.resume ?? "kitchen init";
  markStep(repo, "init", "checks");

  // 1. checks: kitchen.yaml's own, else the repo's files, else (once) one short agent call
  const tool = toolFor(repo, o.tool);
  const prior = readQuickRecord(repo);
  let found: QuickRecord["found"] = "none";
  let detected: Detected | null = null;
  let proposed = false;
  let agentRun: QuickRecord["agent"];
  const notes: string[] = [];
  const own = hasOwnChecks(repo);
  // Detection runs even with the person's own checks: a lockfile committed since adds just the install (review R3).
  const det = detectChecks(repo);
  if (!own) for (const x of det?.skipped ?? []) out(`  skipped ${x.name} (\`${x.body}\` ${x.why})`);
  if (own) {
    found = "config";
    detected = det?.install ? { checks: [], install: det.install, from: det.from } : null;
  } else if (det?.checks.length) {
    detected = det;
    found = "files";
  } else if (prior?.found === "proposed" || prior?.found === "none") {
    found = prior.found;
    notes.push(
      prior.found === "proposed"
        ? "The checks an agent proposed last time are in kitchen.yaml, commented out: review and uncomment them to use them."
        : 'No checks found last time either; not asking the agent again. Add them to kitchen.yaml (checks: ["npm test"]), or delete .kitchen/init/checks.json to look again.',
    );
  } else {
    const base = loadConfig(repo);
    const a = await proposeChecks(repo, { ...base, agent: { ...base.agent, tool: tool as Config["agent"]["tool"] } }, o.agent);
    agentRun = a.run;
    if (a.run.error) {
      found = "agent-failed";
      notes.push(`The agent call to find the checks failed: ${a.run.error}. kitchen init asks it again next time.`);
    }
    if (a.detected) {
      detected = { ...a.detected, ...(det?.install ? { install: det.install } : {}) };
      out("An agent read the repo and proposes these checks (it found none in the usual files):");
      for (const c of a.detected.checks) out(`    ${c.name}: ${c.run}`);
      // No means no: the default is not to use them (review R8).
      const yes = o.confirm ? await o.confirm("Use these checks? [y/N] ") : false;
      proposed = !yes;
      found = yes ? "agent" : "proposed";
      if (!yes)
        notes.push(
          o.confirm
            ? "Not used: they are in kitchen.yaml, commented out."
            : "Not run: no one to ask here, so they are in kitchen.yaml commented out. Review them and uncomment the ones you want.",
        );
    }
  }

  // 2. the files
  markStep(repo, "init", "files");
  const cfgW = writeConfig(repo, tool, detected, { proposed });
  const cfg = loadConfig(repo);
  const n = cfg.checkList.length;
  const from =
    found === "config"
      ? "kept from kitchen.yaml"
      : found === "files"
        ? `from ${detected?.from.join(", ")}`
        : found === "agent"
          ? "proposed by an agent, accepted"
          : "";
  out(
    phaseLine(
      !agentRun?.error,
      cfgW.written ? "Wrote kitchen.yaml" : "Kept kitchen.yaml",
      `agent ${cfg.agent.tool} · ${n ? `${n} check${n === 1 ? "" : "s"} ${from}` : found === "proposed" ? "proposed checks commented out" : "no checks found"}${cfgW.checksAdded && !cfgW.written ? " (added)" : ""}${cfgW.installAdded ? ` · checks_install: ${cfg.checks_install} added` : ""}`,
      agentRun?.secs,
      agentRun?.usd,
    ),
  );
  installSkill(repo);
  // Role skills (ADR 0014) ride on this line to keep init quiet: a report only, never a failure; `kitchen skills` lists them.
  let roleSkills = "?";
  try {
    roleSkills = skillsReport(repo).short;
  } catch {} // a report only: init never fails over it
  out(phaseLine(true, "Installed the skill", `/kitchen for Claude Code and Codex · role skills: ${roleSkills} (kitchen skills)`));
  const added = addGitignore(repo);
  out(phaseLine(true, "Updated .gitignore", added.length ? `${added.length} Kitchen entries` : "already has Kitchen's entries"));

  // 3. run them once on the checkout, sandboxed like Gate
  const record: QuickRecord = { at: new Date().toISOString(), sha, from: detected?.from ?? [], found, ...(agentRun ? { agent: agentRun } : {}), results: [] };
  let failed: CheckRun | undefined;
  const run = async (name: string, cmd: string, timeoutSec: number, network: boolean): Promise<CheckRun> => {
    const r = await runSandboxed({ cwd: repo, cmd, timeoutSec, network, what: `init check ${name}`, killOnSignal: true });
    const tail = r.all.trimEnd().split("\n").slice(-40).join("\n");
    return { name, run: cmd, ok: r.exit === 0, exit: r.timedOut ? null : r.exit, secs: r.secs, tail, sandboxed: r.sandboxed };
  };
  // The same steps a job worktree gets (run-checks.ts): the frozen download online with no scripts, the rest offline.
  const prepare = checksPrepareOf(cfg);
  markStep(repo, "init", "run");
  if (n && !sha) record.skipped = "no commit yet";
  else if (n && depsMissing(repo) && !prepare) record.skipped = "dependencies not installed, and no lockfile to install them from";
  else if (n) {
    const c0 = Date.now();
    if (prepare && depsMissing(repo)) {
      // The person's own checkout against its HEAD: dependency files they haven't changed are as trusted as HEAD (review N1).
      const same = await sameDepsAsBase(plainCheckout(repo), "HEAD").catch(() => false);
      const net = (s: PrepareStep) => (s.network === "base-deps" ? same : s.network);
      out(`  … Installing dependencies (${prepare.steps.map((s) => `${s.cmd}${net(s) ? "" : ", offline"}`).join(", then ")})…`);
      for (const s of prepare.steps) {
        record.prepare = await run(s.name, s.cmd, 600, net(s));
        if (!record.prepare.ok) {
          if (s.network === "base-deps" && !same)
            record.prepare.tail = `${OFFLINE_REBUILD_NOTE.replace("this job changed", "you changed")}\n${record.prepare.tail}`;
          failed = record.prepare;
          break;
        }
      }
    }
    for (const c of failed ? [] : cfg.checkList) {
      out(`  … Running ${c.name} (${c.run})…`);
      const r = await run(c.name, c.run, c.timeoutSec, cfg.checks_network);
      record.results.push(r);
      if (!r.ok) failed ??= r;
    }
    const where = `on ${branch || "HEAD"}${sha ? ` (${sha.slice(0, 7)})` : ""}`;
    const names = record.results.map((r) => r.name).join(", ");
    const verdict = failed ? `${failed.name} FAILED (${failed.exit === null ? "timed out" : `exit ${failed.exit}`})` : `${names} passed`;
    out(phaseLine(!failed, "Ran the checks", `${verdict} ${where}`, (Date.now() - c0) / 1000));
  }
  if (record.skipped) out(phaseLine(false, "Ran the checks", `skipped: ${record.skipped}`));
  fs.mkdirSync(path.dirname(checksRecord(repo)), { recursive: true });
  writeAtomic(checksRecord(repo), `${JSON.stringify(record, null, 2)}\n`);
  appendLedger(repo, {
    job: "-",
    stage: "init",
    round: 0,
    event: "checks",
    key: `init/checks/${record.at}`,
    result: record.skipped ? "skipped" : !n ? "none" : failed ? "fail" : "pass",
    detail: { found, sha, skipped: record.skipped, checks: record.results.map((r) => ({ name: r.name, ok: r.ok, secs: r.secs })) },
  });

  // 4. what to do next follows from what happened
  for (const l of notes) out(l);
  if (failed) {
    out("");
    out(`${failed.name} failed on your checkout: ${failed.run}`);
    out(failed.tail.replace(/^/gm, "  | "));
    out("Gate runs these checks on every job, so every job would fail them.");
    out(`Done in ${dur((Date.now() - t0) / 1000)}, with failing checks.`);
    out(`Next: fix them (or edit checks: in kitchen.yaml). Resume: ${resume}`);
    return 1;
  }
  const cost = agentRun?.usd;
  if (!record.skipped) markStep(repo, "init", "done");
  out(`Done in ${dur((Date.now() - t0) / 1000)} · ${agentRun ? `one agent call${cost ? ` (${usd(cost)})` : ""}` : "no agent"}`);
  if (record.skipped === "no commit yet") {
    out(`Next: make a first commit (git add -A && git commit -m init), then run the checks. Resume: ${resume}`);
    return 0;
  }
  if (record.skipped) {
    out(`Next: install the dependencies (or commit a lockfile), then run the checks. Resume: ${resume}`);
    return 0;
  }
  if (!n && found !== "proposed") out('No checks: Gate will have nothing to run. Add them to kitchen.yaml (checks: ["npm test"]) when you can.');
  out('Next: kitchen ticket "<what you want>"  then  kitchen run --detach');
  out("      commit kitchen.yaml, .gitignore and the skill folders when you like");
  if (sha && (await toolkitAt(repo, sha))) out(`      Kitchen drives your app with the Toolkit already on ${branch || "HEAD"}`);
  else out("      to have Kitchen drive your app as well: kitchen toolkit build (about 3–15 min)");
  return 0;
}

const PROPOSE = `You are helping Kitchen find this repository's checks: the commands a developer runs
before pushing (lint, typecheck, tests, build). Read only what you need (the README,
the build files, CI config such as .github/workflows, AGENTS.md or CONTRIBUTING.md);
don't run anything and don't change any file.

Write checks.md with these lines and nothing else:
CHECK: <name> | <shell command, run from the repo root>      (one line per check, at most 4)
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
  // No install command from an agent: Kitchen installs only frozen, from a lockfile it finds itself.
  const testCmd = val("TEST_CMD");
  return { checks, ...(testCmd?.includes("{file}") ? { testCmd } : {}), from: ["an agent's read of the repo"] };
}

/** One short read-only agent call on the cheap tier, no bridge: the checks it proposes, or null. */
async function proposeChecks(
  repo: string,
  cfg: Config,
  agent?: () => Promise<AgentAdapter>,
): Promise<{ detected: Detected | null; run: NonNullable<QuickRecord["agent"]> }> {
  const model = tierModel(cfg, "cheap");
  const outDir = path.join(repo, ".kitchen", "init", "agent");
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  let a: AgentAdapter;
  try {
    a = agent ? await agent() : await (await import("../engine/runner.ts")).adapterFor(repo, cfg);
  } catch (e) {
    return { detected: null, run: { model, secs: (Date.now() - t0) / 1000, error: (e as Error).message } };
  }
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
  const error = !r.ok ? (r.error ?? r.line ?? "the agent failed") : !text ? "it wrote no checks.md" : undefined;
  return {
    detected: text ? parseProposal(text) : null,
    run: { model, secs, ...(r.usage?.usd !== undefined ? { usd: r.usage.usd } : {}), ...(error ? { error } : {}) },
  };
}
