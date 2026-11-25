// `kitchen run` (ADR 0016 §1, ADR 0030): Kitchen works the queue itself. A Node scheduler (src/run/scheduler.ts) plans
// each wave and starts one headless agent session per lane (`claude -p`, or `codex exec` with agent.tool: codex),
// finishing each lane the moment its session ends. Every tool a lane needs is allowed up front (a headless session
// can't ask); the guard hooks in .claude/settings.json still run on every tool call.
//
// Agents keep a scrubbed environment: no GitHub token in it (Kitchen's merge into staging uses gh's stored login).
// One run per repo: .kitchen/run.json names it while it lives; `kitchen run --stop` ends it and every lane.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { endGroup } from "../agents/session.ts";
import { type Config, loadConfig } from "../config.ts";
import { kitchenDir, listJobs, writeAtomic } from "../engine/store.ts";
import { lockOwner, ownerAlive, processStart, sameProcess, tryFileLock, unconfirmed } from "../lock.ts";

export type Out = (l: string) => void;
/** `tool`: ADR 0032 §2, the tool and the version its preflight printed ("claude 2.1.400"), when it printed one. */
type RunInfo = { pid: number; start: string | null; at: string; log: string; command: string[]; tool?: string };

export const runFile = (repo: string) => path.join(kitchenDir(repo), "run.json");
export const runLog = (repo: string) => path.join(kitchenDir(repo), "run.log");
/** ADR 0030 §5: held by the one `kitchen run` scheduler of a repo, for its life. */
export const runLock = (repo: string) => path.join(kitchenDir(repo), "run.lock");
/** ADR 0030 §5: how long `--detach` waits for its child to take the run lock. */
const DETACH_WAIT_MS = 5_000;
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
 * ADR 0025 §3: before a run, `<bin> --version`: why not to start (the binary isn't there, or, for Claude Code, it is
 * older than MIN_CLAUDE), or null. A wrapper that prints no version is let through.
 */
export function preflight(
  bin: string[],
  o: { command?: boolean; tool?: Config["agent"]["tool"]; seen?: (version: string) => void } = { command: true },
): string | null {
  const name = bin.join(" ");
  const r = spawnSync(bin[0], [...bin.slice(1), "--version"], { encoding: "utf8", timeout: 30_000, env: scrubbedEnv() });
  if (r.error)
    return (r.error as NodeJS.ErrnoException).code === "ENOENT"
      ? o.command
        ? `agent.command ${name} not found`
        : `${o.tool === "codex" ? "Codex" : "Claude Code"} not found (${name}): install it, or name it in kitchen.yaml's agent.command`
      : `${name} --version failed: ${r.error.message}`;
  if (r.status !== 0) return `${name} --version failed (exit ${r.status ?? r.signal}): ${`${r.stderr}${r.stdout}`.trim().split("\n").pop() ?? ""}`;
  const v = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
  if (v) o.seen?.(v);
  if (o.tool === "codex") return null;
  return v && olderThan(v, MIN_CLAUDE) ? `Claude Code ${v} is older than Kitchen needs (${MIN_CLAUDE}). Update it: claude update` : null;
}

/** The live `kitchen run` (the scheduler process), or null. */
export function liveRun(repo: string): RunInfo | null {
  try {
    const r = JSON.parse(fs.readFileSync(runFile(repo), "utf8")) as RunInfo;
    return ownerAlive({ pid: r.pid, start: r.start }) ? r : null;
  } catch {
    return null;
  }
}

export function scrubbedEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const k of SCRUBBED) delete env[k];
  // A session Kitchen started: a `kitchen run` inside it refuses, and a verb inside it wakes no other run.
  return { ...env, KITCHEN_ORCHESTRATOR: "1" };
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

export async function run(
  repo: string,
  o: { detach?: boolean; stop?: boolean; print?: boolean; maxUsd?: number; cli?: string; graceMs?: number; pollMs?: number },
  out: Out,
): Promise<number> {
  if (o.stop) return stopRun(repo, out);
  const cfg = loadConfig(repo);
  const sched = await import("./scheduler.ts");
  if (o.print) {
    for (const l of sched.laneCommands(cfg, o.maxUsd ?? cfg.agent.max_usd)) out(l);
    return 0;
  }
  // Inside a session Kitchen started (it sets KITCHEN_ORCHESTRATOR), a second run would find itself "already running".
  if (process.env.KITCHEN_ORCHESTRATOR) {
    out(
      "kitchen run: this session was started by Kitchen. Don't start another run: a lane agent does its brief; an orchestrator session works the queue with `kitchen job next --json --restart-stranded` (the /kitchen skill, Running the queue).",
    );
    return 2;
  }
  // ADR 0030 §5: one run per repo, decided first by an exclusive lock the scheduler holds for its life (two runs
  // started together would both start the same lanes). A detaching parent only looks; its child takes the lock.
  fs.mkdirSync(kitchenDir(repo), { recursive: true });
  const already = (pid?: number) => {
    const live = liveRun(repo);
    out(`orchestrator: already running (pid ${live?.pid ?? pid ?? "?"}${live ? `, log ${live.log}` : ""})`);
    return 0;
  };
  if (o.detach) {
    const owner = lockOwner(runLock(repo));
    return owner ? already(owner.pid) : work(repo, cfg, sched, o, out);
  }
  const lock = tryFileLock(runLock(repo));
  if ("heldBy" in lock) return already(lock.heldBy.pid || undefined);
  const info: RunInfo = { pid: process.pid, start: processStart(process.pid), at: new Date().toISOString(), log: runLog(repo), command: process.argv };
  writeAtomic(runFile(repo), JSON.stringify(info));
  try {
    return await work(repo, cfg, sched, o, out);
  } finally {
    try {
      if ((JSON.parse(fs.readFileSync(runFile(repo), "utf8")) as RunInfo).pid === process.pid) fs.rmSync(runFile(repo));
    } catch {}
    lock.release();
  }
}

async function work(
  repo: string,
  cfg: Config,
  sched: typeof import("./scheduler.ts"),
  o: { detach?: boolean; maxUsd?: number; cli?: string; graceMs?: number; pollMs?: number; detachWaitMs?: number },
  out: Out,
): Promise<number> {
  // A session the person opens follows the repo's copy of the kitchen skill: keep it this Kitchen's version.
  const files = await import("../init/files.ts");
  for (const f of [...files.refreshSkill(repo), ...(await import("../init/hooks.ts")).refreshHooks(repo)]) out(`updated ${f} to this Kitchen's version`);
  const ignored = files.addGitignore(repo);
  if (ignored.length) out(`added to .gitignore: ${ignored.join(", ")}`);
  // ADR 0027: kitchen.yaml gets verify.skill and verify.map when it lacks them; an ignored map moves to this machine.
  for (const l of await (await import("../verify/where.ts")).settleMap(repo)) out(l);
  // ADR 0032 §2: the tool and the version its preflight printed go into run.json (`kitchen` reports read it).
  let toolVersion: string | undefined;
  const no = preflight(sched.toolBin(cfg), { command: !!cfg.agent.command, tool: cfg.agent.tool, seen: (v) => (toolVersion = `${cfg.agent.tool} ${v}`) });
  if (no) {
    out(`kitchen run: ${no}. Nothing started.`);
    return 2;
  }
  // ADR 0033 §3 and ADR 0029 §4: what the project declares it needs (kitchen.yaml requires:) and the browser QA
  // uses, settled before any lane finds them missing; by the session itself, never in a detaching parent (a wake):
  // its output goes to the run's log. The browser is refused only when QA here needs it.
  if (!o.detach) {
    const req = await (await import("../doctor/doctor.ts")).requiresRefusal(repo, cfg);
    if (req) {
      out(`kitchen run: ${req}. Nothing started.`);
      return 2;
    }
    const app = await import("../qa/app.ts");
    const browser = await app.ensureBrowser(out, { needed: app.browserNeeded(repo, cfg) });
    if (browser) {
      out(`kitchen run: ${browser}. Nothing started.`);
      return 2;
    }
  }
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
      { cwd: repo, detached: true, stdio: ["ignore", fd, fd], env: process.env },
    );
    const from = fs.fstatSync(fd).size;
    let exited: number | null = null;
    child.on("exit", (c) => (exited = c ?? 1));
    child.on("error", (e) => out(`orchestrator: could not start: ${e.message}`));
    child.unref();
    fs.closeSync(fd);
    // ADR 0030 §5: the child takes the run lock; wait for it (or for the child to say why it didn't), up to DETACH_WAIT_MS.
    for (let t = 0; t < (o.detachWaitMs ?? DETACH_WAIT_MS) && exited === null && lockOwner(runLock(repo))?.pid !== child.pid; t += 100)
      await new Promise((r) => setTimeout(r, 100));
    if (lockOwner(runLock(repo))?.pid === child.pid || exited === null) {
      out(`orchestrator detached: pid ${child.pid}, log ${log}`);
      return 0;
    }
    const said = fs
      .readFileSync(log, "utf8")
      .slice(from)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const busy = said.find((l) => l.startsWith("orchestrator: already running"));
    if (busy) {
      out(busy);
      return 0;
    }
    out(`orchestrator: the detached run stopped at once (exit ${exited}): ${said.at(-1) ?? "no output"} (log ${log})`);
    return exited || 1;
  }
  // ADR 0029 §5: no app left from a run before this one.
  for (const l of await (await import("../qa/app.ts")).sweepApps(repo).catch(() => [] as string[])) out(l);
  if (toolVersion) {
    const info = JSON.parse(fs.readFileSync(runFile(repo), "utf8")) as RunInfo;
    if (info.pid === process.pid) writeAtomic(runFile(repo), JSON.stringify({ ...info, tool: toolVersion }));
  }
  out(
    `orchestrator: kitchen run (pid ${process.pid}) starts one ${cfg.agent.tool === "codex" ? "codex exec" : "claude -p"} session per lane; the dashboard shows the jobs: kitchen dashboard`,
  );
  return sched.schedule(repo, { maxUsd: o.maxUsd, graceMs: o.graceMs, pollMs: o.pollMs }, out);
}

/** The process group `pid` is in, or null. */
function groupOf(pid: number): number | null {
  try {
    const g = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    return Number.isInteger(g) && g > 0 ? g : null;
  } catch {
    return null;
  }
}

/**
 * ADR 0030 §5: the run first (it ends its lanes' groups and marks nothing finished), then any lane group still alive,
 * read from each job's open lane, so the lanes of a run that is gone end too. A run that leads its own group (a
 * detached one, or an orchestrator session from before ADR 0030) is ended with its group.
 */
async function stopRun(repo: string, out: Out, waitMs = 10_000): Promise<number> {
  const live = liveRun(repo);
  const open = () => listJobs(repo).flatMap((j) => (j.running?.session && !j.running.session.ended && ownerAlive(j.running.session) ? [j] : []));
  const lanes = open().map((j) => `${j.id} ${j.running?.lane}`);
  if (live) {
    // ADR 0030: killed only when positively that run (a start an earlier Kitchen stored may not be judged).
    if (!sameProcess(live)) {
      out(`orchestrator: ${unconfirmed(live.pid, "Kitchen's run")}`);
      return 1;
    }
    try {
      process.kill(groupOf(live.pid) === live.pid ? -live.pid : live.pid, "SIGTERM");
    } catch (e) {
      out(`orchestrator: could not stop pid ${live.pid}: ${(e as Error).message}`);
      return 1;
    }
    for (let t = 0; t < waitMs && ownerAlive(live); t += 100) await new Promise((r) => setTimeout(r, 100));
  }
  const ends = await Promise.all(open().map(async (j) => [j, j.running?.session ? await endGroup(j.running.session) : "gone"] as const));
  for (const [j, e] of ends)
    if (e === "unconfirmed" && j.running?.session) out(`${j.id}  ${unconfirmed(j.running.session.pid, `its ${j.running.lane} agent`)}`);
  if (!live && !lanes.length) {
    out("orchestrator: not running");
    return 0;
  }
  const ended = lanes.length ? `; ended ${lanes.length} lane${lanes.length === 1 ? "" : "s"} (${lanes.join(", ")})` : "";
  out(`orchestrator: ${live ? `asked pid ${live.pid} to stop` : "not running"}${ended} (their jobs keep their state; kitchen run starts them again)`);
  return 0;
}
