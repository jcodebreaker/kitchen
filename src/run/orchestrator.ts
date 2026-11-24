// `kitchen run` (ADR 0016 §1): a thin wrapper that starts a headless orchestrator session, for people who aren't in
// Claude Code. The session is `claude -p "/kitchen:kitchen run"` (the plugin's skill; `/kitchen run` when the repo has
// the skill installed itself), with every tool it needs allowed up front: a headless session can't ask. The guard
// hooks in .claude/settings.json still run on every tool call, the session's own and its lane agents'.
//
// Agents keep a scrubbed environment: no GitHub token in it (Kitchen's merge into staging uses gh's stored login).
// One orchestrator per repo: .kitchen/run.json names it while it lives; `kitchen run --stop` ends it.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { claudeBin } from "../agents/find-bin.ts";
import { type Config, loadConfig } from "../config.ts";
import { kitchenDir, writeAtomic } from "../engine/store.ts";
import { appendLedger } from "../ledger/append.ts";
import { ownerAlive, processStart } from "../lock.ts";

export type Out = (l: string) => void;
type RunInfo = { pid: number; start: string | null; at: string; log: string; command: string[] };

export const runFile = (repo: string) => path.join(kitchenDir(repo), "run.json");
export const runLog = (repo: string) => path.join(kitchenDir(repo), "run.log");
/** The tools the orchestrator and its lane agents use. Anything else is refused (a headless session can't ask). */
export const ALLOWED_TOOLS = ["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "Agent", "Task", "Skill", "TodoWrite", "NotebookEdit"];
/** Never handed to the session: Kitchen's own git and gh calls use the person's stored logins. */
export const SCRUBBED = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITHUB_PAT", "NPM_TOKEN"];

/** ADR 0025 §3: the oldest Claude Code Kitchen is tested with; `kitchen run` refuses an older one. */
export const MIN_CLAUDE = "2.1.331";

/** Pure: a < b, for dotted versions ("2.1.9" < "2.1.331"). */
export function olderThan(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/**
 * ADR 0025 §3: before a run, `<bin> --version`: why not to start (the binary isn't there, or it is older than
 * MIN_CLAUDE), or null. A wrapper that prints no version is let through.
 */
export function preflight(bin: string[], o: { command?: boolean } = { command: true }): string | null {
  const name = bin.join(" ");
  const r = spawnSync(bin[0], [...bin.slice(1), "--version"], { encoding: "utf8", timeout: 30_000, env: scrubbedEnv() });
  if (r.error)
    return (r.error as NodeJS.ErrnoException).code === "ENOENT"
      ? o.command
        ? `agent.command ${name} not found`
        : `Claude Code not found (${name}): install it, or name it in kitchen.yaml's agent.command`
      : `${name} --version failed: ${r.error.message}`;
  if (r.status !== 0) return `${name} --version failed (exit ${r.status ?? r.signal}): ${`${r.stderr}${r.stdout}`.trim().split("\n").pop() ?? ""}`;
  const v = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
  return v && olderThan(v, MIN_CLAUDE) ? `Claude Code ${v} is older than Kitchen needs (${MIN_CLAUDE}). Update it: claude update` : null;
}

/** The live orchestrator started by `kitchen run`, or null. */
export function liveRun(repo: string): RunInfo | null {
  try {
    const r = JSON.parse(fs.readFileSync(runFile(repo), "utf8")) as RunInfo;
    return ownerAlive({ pid: r.pid, start: r.start }) ? r : null;
  } catch {
    return null;
  }
}

/** How the session names Kitchen's skill: the repo's own copy (`/kitchen`) or the plugin's (`/kitchen:kitchen`). */
export function skillCommand(repo: string): string {
  return fs.existsSync(path.join(repo, ".claude", "skills", "kitchen", "SKILL.md")) ? "/kitchen run" : "/kitchen:kitchen run";
}

/** The agent's argv prefix: agent.command, else the claude binary. */
export const agentBin = (cfg: Config, bin?: string): string[] => cfg.agent.command ?? [bin ?? claudeBin()];

/** Pure: the headless command (argv). */
export function orchestratorCommand(repo: string, cfg: Config, o: { bin?: string; maxUsd?: number } = {}): string[] {
  const bin = agentBin(cfg, o.bin);
  const usd = o.maxUsd ?? cfg.agent.max_usd;
  return [
    ...bin,
    "-p",
    skillCommand(repo),
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ALLOWED_TOOLS.join(","),
    "--output-format",
    "stream-json",
    "--verbose",
    ...(usd ? ["--max-budget-usd", String(usd)] : []),
  ];
}

export function scrubbedEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const k of SCRUBBED) delete env[k];
  // A headless `claude -p` ends when its turn ends and, by default, kills lane agents still running in the background
  // 10 minutes later: a long Build lane was cut off mid-job. 0 = wait for them however long they take.
  return { ...env, KITCHEN_ORCHESTRATOR: "1", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" };
}

/** The session's spend, from its result line (what the dashboard's cost shows), or null. Pure. */
export function sessionCost(line: string): number | null {
  try {
    const e = JSON.parse(line) as { type?: string; total_cost_usd?: unknown };
    return e.type === "result" && typeof e.total_cost_usd === "number" ? e.total_cost_usd : null;
  } catch {
    return null;
  }
}

/** A line of the session's stream worth printing: the orchestrator's own words, and how it ended. Pure. */
export function streamLine(line: string): string | null {
  try {
    const e = JSON.parse(line) as {
      type?: string;
      parent_tool_use_id?: string | null;
      message?: { content?: { type: string; text?: string }[] };
      result?: string;
      total_cost_usd?: number;
      is_error?: boolean;
    };
    if (e.type === "assistant" && !e.parent_tool_use_id)
      return (
        e.message?.content
          ?.filter((c) => c.type === "text" && c.text?.trim())
          .map((c) => (c.text as string).trim())
          .join("\n") || null
      );
    if (e.type === "result")
      return `orchestrator ${e.is_error ? "stopped with an error" : "finished"}${e.total_cost_usd !== undefined ? ` · $${e.total_cost_usd.toFixed(2)}` : ""}${e.result ? `: ${String(e.result).slice(0, 500)}` : ""}`;
  } catch {}
  return null;
}

export async function run(repo: string, o: { detach?: boolean; stop?: boolean; print?: boolean; maxUsd?: number; cli?: string }, out: Out): Promise<number> {
  if (o.stop) return stopRun(repo, out);
  const cfg = loadConfig(repo);
  if (cfg.agent.tool !== "claude" && !cfg.agent.command) {
    out("kitchen run starts a headless Claude Code session; with Codex, open Codex in this repo and ask it to run the Kitchen queue (/kitchen run).");
    return 2;
  }
  const argv = orchestratorCommand(repo, cfg, { maxUsd: o.maxUsd });
  if (o.print) {
    out(argv.map((a) => (/^[\w./:,=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" "));
    return 0;
  }
  // Inside the session `kitchen run` started (it sets KITCHEN_ORCHESTRATOR), that session is the orchestrator:
  // starting another would find itself "already running" and the agent would stop working the queue.
  if (process.env.KITCHEN_ORCHESTRATOR) {
    out(
      "kitchen run: this session is the orchestrator already. Don't start another: work the queue with `kitchen job next --json --restart-stranded` (the /kitchen skill, Running the queue).",
    );
    return 2;
  }
  const live = liveRun(repo);
  // The session follows the repo's copy of the kitchen skill: one from an older Kitchen sends it astray.
  if (!live) {
    const files = await import("../init/files.ts");
    for (const f of files.refreshSkill(repo)) out(`updated ${f} to this Kitchen's version`);
    const ignored = files.addGitignore(repo);
    if (ignored.length) out(`added to .gitignore: ${ignored.join(", ")}`);
    // ADR 0027: kitchen.yaml gets verify.skill and verify.map when it lacks them; an ignored map moves to this machine.
    for (const l of await (await import("../verify/where.ts")).settleMap(repo)) out(l);
  }
  if (live) {
    out(`orchestrator: already running (pid ${live.pid}, log ${live.log})`);
    return 0;
  }
  if (cfg.agent.tool === "claude") {
    const no = preflight(agentBin(cfg), { command: !!cfg.agent.command });
    if (no) {
      out(`kitchen run: ${no}. Nothing started.`);
      return 2;
    }
  }
  fs.mkdirSync(kitchenDir(repo), { recursive: true });
  const log = runLog(repo);
  if (o.detach) {
    const fd = fs.openSync(log, "a");
    const child = spawn(
      process.execPath,
      [
        o.cli ?? path.resolve(import.meta.dirname, "..", `cli${path.extname(import.meta.filename)}`),
        "run",
        "--repo",
        repo,
        ...(o.maxUsd ? ["--max-usd", String(o.maxUsd)] : []),
      ],
      {
        cwd: repo,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: process.env,
      },
    );
    child.on("error", (e) => out(`orchestrator: could not start: ${e.message}`));
    child.unref();
    fs.closeSync(fd);
    out(`orchestrator detached: pid ${child.pid}, log ${log}`);
    return 0;
  }
  const child = spawn(argv[0], argv.slice(1), { cwd: repo, env: scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"] });
  // A binary that went missing after the preflight: say so, and end like a failed session.
  const failed = new Promise<number>((resolve) =>
    child.on("error", (e) => {
      out(`orchestrator: could not start ${argv[0]}: ${e.message}`);
      resolve(127);
    }),
  );
  if (child.pid === undefined) return failed;
  const info: RunInfo = { pid: child.pid as number, start: processStart(child.pid as number), at: new Date().toISOString(), log, command: argv };
  writeAtomic(runFile(repo), JSON.stringify(info));
  out(`orchestrator: ${argv.slice(0, 3).join(" ")} … (pid ${child.pid}); the dashboard shows the jobs: kitchen dashboard`);
  // The raw stream, for debugging one session: this session's, and the one before it (run.prev.jsonl). Nothing reads
  // it, so it never grows past two sessions.
  const raw = path.join(kitchenDir(repo), "run.jsonl");
  if (fs.existsSync(raw)) fs.renameSync(raw, path.join(kitchenDir(repo), "run.prev.jsonl"));
  const stream = fs.createWriteStream(raw);
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    stream.write(d);
    buf += d.toString("utf8");
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const raw = buf.slice(0, i);
      const l = streamLine(raw);
      buf = buf.slice(i + 1);
      const usd = sessionCost(raw);
      if (usd !== null) appendLedger(repo, { job: "-", stage: "run", round: 0, event: "session", key: `run/${info.pid}/${info.at}`, usd });
      if (l) out(l);
    }
  });
  child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
  const stopChild = () => child.kill("SIGTERM");
  process.once("SIGTERM", stopChild);
  process.once("SIGINT", stopChild);
  const code = await Promise.race([failed, new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)))]);
  stream.end();
  try {
    if ((JSON.parse(fs.readFileSync(runFile(repo), "utf8")) as RunInfo).pid === info.pid) fs.rmSync(runFile(repo));
  } catch {}
  return code;
}

async function stopRun(repo: string, out: Out): Promise<number> {
  const live = liveRun(repo);
  if (!live) {
    out("orchestrator: not running");
    return 0;
  }
  try {
    process.kill(live.pid, "SIGTERM");
  } catch (e) {
    out(`orchestrator: could not stop pid ${live.pid}: ${(e as Error).message}`);
    return 1;
  }
  out(`orchestrator: asked pid ${live.pid} to stop (its jobs keep their state; kitchen run picks them up again)`);
  return 0;
}
