// ADR 0030: `kitchen run` schedules the lanes itself, with no orchestrator model session. It plans a wave
// (`kitchen job next`), opens each lane (`kitchen job start`), and starts one agent session per lane in its own process
// group (ADR 0029 §5): `claude -p` or `codex exec`, as `agent.tool` says, on the lane's model (ADR 0023). The moment a
// session ends it runs `kitchen job finish` for that job and plans again, so a fast lane never waits for a slow one.
import fs from "node:fs";
import path from "node:path";
import { claudeBin, codexBin } from "../agents/find-bin.ts";
import { endGroup, finalLine, finalOk, runAgentSession } from "../agents/session.ts";
import { type Config, LANE_ROLES, loadConfig, modelFor } from "../config.ts";
import { git } from "../engine/git.ts";
import { finish, next, type Started, start } from "../engine/jobs.ts";
import type { Job, Lane, LaneSession } from "../engine/machine.ts";
import { findJob, jobDirOf, listJobs, roundDir, updateJob } from "../engine/store.ts";
import { appendLedger } from "../ledger/append.ts";
import { processStart, unconfirmed } from "../lock.ts";
import { type Out, scrubbedEnv, sessionCost } from "./orchestrator.ts";

/** A lane's tools: the orchestrator's, less Agent and Task (one agent per lane; it never starts another). */
export const LANE_TOOLS = ["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "Skill", "TodoWrite", "NotebookEdit"];
/** How often to look again while only lanes another orchestrator started are open. */
const POLL_MS = 5_000;
const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
/** ADR 0030 §1: lane sessions in a row that crashed (non-zero, no final line) before the run stops. */
export const MAX_CRASHES = 3;
/** Lanes that drive the job's app on localhost: their Codex sandbox gets the network. */
const APP_LANES: Lane[] = ["qa", "regress"];

/** The tool's argv prefix: agent.command, else the tool's binary. */
export const toolBin = (cfg: Config): string[] => cfg.agent.command ?? [cfg.agent.tool === "codex" ? codexBin() : claudeBin()];

/**
 * Pure: one lane session's argv. Claude: headless, every tool allowed up front (a headless session can't ask), the
 * guard hooks of the repo's .claude/settings.json on every call; it starts in the repo (`cwd` unused).
 *
 * Codex: `exec --json` in the sandbox's workspace-write mode, rooted at the lane's checkout (`-C <cwd>`), plus each
 * `writable` dir as `--add-dir` ("Additional directories that should be writable alongside the primary workspace",
 * codex-rs/utils/cli/src/shared_options.rs). Never --dangerously-bypass-approvals-and-sandbox. `network`: the lane
 * drives the app on localhost, and workspace-write has the network off unless `sandbox_workspace_write.network_access`
 * says so (the `--config sandbox_workspace_write.network_access=…` the Codex SDK passes, sdk/typescript/src/exec.ts).
 */
export function laneCommand(
  cfg: Config,
  s: Pick<Started, "model" | "prompt">,
  o: { cwd: string; writable?: string[]; network?: boolean; bin?: string[]; budget?: number },
): string[] {
  const bin = o.bin ?? toolBin(cfg);
  if (cfg.agent.tool === "codex")
    return [
      ...bin,
      "exec",
      "--json",
      "-m",
      s.model,
      "--sandbox",
      "workspace-write",
      ...(o.network ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
      "--skip-git-repo-check",
      "-C",
      o.cwd,
      ...(o.writable ?? []).flatMap((d) => ["--add-dir", d]),
      s.prompt,
    ];
  return [
    ...bin,
    "-p",
    s.prompt,
    "--model",
    s.model,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    LANE_TOOLS.join(","),
    "--output-format",
    "stream-json",
    "--verbose",
    ...(o.budget !== undefined ? ["--max-budget-usd", o.budget.toFixed(2)] : []),
  ];
}

/**
 * Pure: what a Build lane's commit writes in the repo's git dir, and nothing more (ADR 0030 §2). The checkout is a git
 * worktree: its `.git` file points at `<common>/worktrees/<name>`, which workspace-write keeps read-only under the
 * root ("worktrees/submodules (file .git with gitdir pointer)", default_read_only_subpaths_for_writable_root in
 * codex-rs/protocol/src/permissions.rs). So the commit's own paths are writable roots of their own:
 * - `<gitdir>` (`<common>/worktrees/<name>`): the worktree's index, HEAD and its reflog, MERGE_HEAD of a catch-up;
 * - `<common>/objects`: the new objects;
 * - `<common>/refs/heads/kitchen` and `<common>/logs/refs/heads/kitchen`: the job branch's ref and reflog (git
 *   writes `<ref>.lock` beside the ref and renames it, so the folder, not the file).
 * Never the rest of `<common>`: config (core.hooksPath, core.fsmonitor), hooks/, packed-refs, other refs.
 * Both sandboxes let a narrower root win: macOS allows the union of every root's own rule
 * (build_seatbelt_access_policy, codex-rs/sandboxing/src/seatbelt.rs); Linux binds roots shallow to deep, each with
 * its read-only carve-outs, so a deeper root binds over the checkout's carve-out (create_filesystem_args,
 * codex-rs/linux-sandbox/src/bwrap.rs).
 */
export function commitRoots(common: string, gitDir: string, branch: string): string[] {
  const dir = path.posix.dirname(branch);
  const refs = dir === "." ? "" : dir;
  return [gitDir, path.join(common, "objects"), path.join(common, "refs", "heads", refs), path.join(common, "logs", "refs", "heads", refs)];
}

/** The Build checkout's commit roots, made to exist (a root must be there to be bound); [] outside a worktree. */
async function commitRootsOf(cwd: string, branch: string): Promise<string[]> {
  const r = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], { allowFail: true });
  const [common, gitDir] = r.stdout.trim().split("\n");
  if (r.code || !common || !gitDir || common === gitDir) return [];
  const roots = commitRoots(common, gitDir, branch);
  for (const d of roots) fs.mkdirSync(d, { recursive: true });
  return roots;
}

/** Pure: a stream line stamped with when it arrived (`_t`, what the Activity tab times calls by). Not JSON: as is. */
export function stamp(line: string, at = new Date().toISOString()): string {
  try {
    const e = JSON.parse(line) as unknown;
    if (e && typeof e === "object" && !Array.isArray(e)) return JSON.stringify({ _t: at, ...e });
  } catch {}
  return line;
}

/** A lane's last words: claude's result text, codex's last agent message or failure. Pure. */
export function laneWords(line: string): string | null {
  try {
    const e = JSON.parse(line) as { type?: string; result?: unknown; item?: { type?: string; text?: string }; error?: { message?: string } };
    if (e.type === "result" && typeof e.result === "string") return e.result;
    if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) return e.item.text;
    if (e.type === "turn.failed" && e.error?.message) return e.error.message;
  } catch {}
  return null;
}

/** Pure: the agent did something (a message or a tool call): claude's assistant/user turns, codex's items. */
export function workLine(line: string): boolean {
  try {
    const t = (JSON.parse(line) as { type?: unknown }).type;
    return t === "assistant" || t === "user" || t === "item.started" || t === "item.completed";
  } catch {
    return false;
  }
}

/** Pure: codex exec's token usage on a `turn.completed` line (it reports tokens, not dollars), or null. */
export function codexUsage(line: string): Record<string, number> | null {
  try {
    const e = JSON.parse(line) as { type?: string; usage?: Record<string, unknown> };
    if (e.type !== "turn.completed" || !e.usage) return null;
    const u = Object.fromEntries(Object.entries(e.usage).filter((x): x is [string, number] => typeof x[1] === "number"));
    return Object.keys(u).length ? u : null;
  } catch {
    return null;
  }
}

const lastOf = (s: string) =>
  s
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? "";
const errLine = (e: unknown) => lastOf(e instanceof Error ? e.message : String(e));

type State = {
  stopping: boolean;
  /** Why nothing more starts (an error, a dead tool, crashes in a row), once said. */
  failed: boolean;
  spent: number;
  /** ADR 0030 §5: what the lanes at work may still spend (each one's reserve until its result line). */
  reserved: number;
  maxUsd?: number;
  /** A lane reached its share of the budget (claude's error_max_budget_usd): nothing new starts. */
  budgetOut: boolean;
  crashes: number;
};

/** ADR 0030 §5: the least a lane may start with; below it, nothing new starts. */
export const MIN_RESERVE_USD = 0.25;
/** ADR 0030 §5: what is left of the budget once what was spent and what the lanes at work hold are taken out. */
const left = (st: State) => (st.maxUsd === undefined ? Number.POSITIVE_INFINITY : st.maxUsd - st.spent - st.reserved);
/** ADR 0030 §5: nothing new starts (too little left for a lane, or a lane hit its share). */
const broke = (st: State) => st.budgetOut || left(st) < floorOf(st);
/** ADR 0030 §5: the least a lane needs, never more than the whole budget (a $0.10 run still starts lanes). */
const floorOf = (st: State) => Math.min(MIN_RESERVE_USD, st.maxUsd ?? MIN_RESERVE_USD);

/** One lane: its session, its log and cost, then `kitchen job finish`. `reserve`: its share of the budget. */
async function lane(repo: string, cfg: Config, s: Started, st: State, o: { graceMs?: number; reserve?: number }, out: Out): Promise<void> {
  const job = findJob(repo, s.id);
  const key = s.key;
  const dir = jobDirOf(repo, job.id);
  fs.mkdirSync(roundDir(dir, job.round), { recursive: true });
  // The raw stream, appended (a lane that runs again in the round adds to it), and the Activity tab's copy.
  const log = fs.createWriteStream(path.join(roundDir(dir, job.round), `${s.lane}.jsonl`), { flags: "a" });
  const act = job.running?.stream ? fs.createWriteStream(path.join(dir, job.running.stream), { flags: "a" }) : null;
  // ADR 0030 §2: Codex runs in the lane's checkout; it writes the job folder, and a Build its commit's git paths.
  const codex = cfg.agent.tool === "codex";
  const writable = codex ? [dir, ...(s.lane === "build" ? await commitRootsOf(s.cwd, job.branch) : [])] : [];
  const argv = laneCommand(cfg, s, { cwd: s.cwd, writable, network: APP_LANES.includes(s.lane), budget: o.reserve });
  const env = scrubbedEnv();
  const setSession = (f: (x: LaneSession | undefined) => LaneSession) =>
    updateJob(repo, job.id, (j) => {
      if (j.running && j.running.key === key) j.running.session = f(j.running.session);
      return j;
    });
  let opened: Promise<unknown> = Promise.resolve();
  let paid = false;
  try {
    return await session();
  } finally {
    // ADR 0030 §5: the reserve is given back whatever happened; a session cut off before its result (stopped,
    // crashed) spent all of it, as far as anyone knows.
    st.reserved -= o.reserve ?? 0;
    if (!paid) st.spent += o.reserve ?? 0;
  }
  async function session(): Promise<void> {
    let words: string | null = null;
    let subtype = "";
    let final = false;
    let ok = false;
    let worked = false;
    let stderr = "";
    const tokens: Record<string, number> = {};
    const r = await runAgentSession(argv, {
      cwd: codex ? s.cwd : repo,
      // ADR 0030 §2: the hooks bind a top-level lane session to its job from here.
      env: { ...env, KITCHEN_JOB: job.id },
      graceMs: o.graceMs,
      onStart: (pid) => {
        // The person stopped or removed the job between its lane opening and this start: the session ends at once.
        opened = setSession(() => ({ pid, start: processStart(pid) })).then((j) => {
          if (j.running?.key !== key)
            try {
              process.kill(-pid, "SIGTERM");
            } catch {}
        });
        out(`${job.id}  ${s.lane} agent started (${s.model}, pid ${pid})`);
      },
      onStderr: (d) => {
        process.stderr.write(d);
        stderr = (stderr + d.toString()).slice(-4000);
      },
      onLine: (l) => {
        if (!l.trim()) return;
        log.write(`${l}\n`);
        act?.write(`${stamp(l)}\n`);
        words = laneWords(l) ?? words;
        worked ||= workLine(l);
        if (finalLine(l)) {
          final = true;
          ok = finalOk(l);
          subtype = String((JSON.parse(l) as { subtype?: unknown }).subtype ?? "");
        }
        for (const [k, v] of Object.entries(codexUsage(l) ?? {})) tokens[k] = (tokens[k] ?? 0) + v;
        const usd = sessionCost(l);
        if (usd !== null && !paid) {
          paid = true;
          st.spent += usd;
          appendLedger(repo, { job: job.id, stage: s.lane, round: job.round, event: "session", key: `${key}/session`, usd });
        }
      },
    });
    // ADR 0030 §6: Codex's cost is tokens; the ledger keeps them (no dollars, so no budget).
    if (Object.keys(tokens).length)
      appendLedger(repo, { job: job.id, stage: s.lane, round: job.round, event: "session", key: `${key}/session`, detail: { tokens } });
    await opened;
    await Promise.all([new Promise((res) => log.end(res)), act ? new Promise((res) => act.end(res)) : null]);
    // ADR 0030 §3: the person stopped or removed the job (kitchen stop, remove): that ended the session, not the agent.
    if (findJob(repo, job.id).running?.key !== key) {
      out(`${job.id}  ${s.lane} agent stopped by the person`);
      return;
    }
    if (r.error) {
      st.failed = true;
      out(`${job.id}  ${s.lane}: could not start ${argv[0]}: ${r.error}. The lane stays open; the next run starts it again. Nothing more started.`);
      return;
    }
    // Stopped: a session that had finished its work is finished by the next run; one cut off starts again.
    if (st.stopping && !final) {
      out(`${job.id}  ${s.lane} agent stopped (kitchen run --stop): the lane stays open, the next run starts it again`);
      return;
    }
    // ADR 0030 §5: the lane spent its reserve (claude's error_max_budget_usd): cut off, not failed. It stays open, no
    // try is spent, and nothing new starts.
    if (subtype === "error_max_budget_usd") {
      st.budgetOut = true;
      out(`${job.id}  ${s.lane} agent reached its share of the budget: the lane stays open (a run with more budget starts it again); nothing new starts`);
      return;
    }
    // ADR 0030 §1: the tool itself failed (not logged in, a rate limit, a model it doesn't know, no network): the
    // agent did nothing, so the lane isn't the agent's to fail. It stays open, and the run stops before every other
    // job's lane burns its tries the same way.
    if (!worked && (r.code !== 0 || (final && !ok))) {
      st.failed = true;
      const why = lastOf(words ?? "") || lastOf(stderr) || `exit ${r.code}`;
      out(
        `kitchen run: ${job.id} ${s.lane}: ${argv[0].split("/").pop()} ended before doing anything: ${why.slice(0, 300)}. Nothing more started; ${job.id} stays in ${s.lane}.`,
      );
      return;
    }
    await setSession((x) => ({ ...(x ?? { pid: r.pid ?? 0, start: null }), ended: new Date().toISOString() }));
    if (st.stopping) {
      out(`${job.id}  ${s.lane} agent had finished: the next run finishes its lane`);
      return;
    }
    // ADR 0029 §5: an error result keeps its non-zero code; finish still decides from the lane's files.
    if (words) out(`${job.id}  ${s.lane} agent${r.code !== 0 ? ` (exit ${r.code})` : ""}: ${lastOf(words).slice(0, 300)}`);
    else if (r.code !== 0) out(`${job.id}  ${s.lane} agent exited ${r.code} without a final line`);
    st.crashes = r.code !== 0 && !final ? st.crashes + 1 : 0;
    await finishLane(repo, job.id, st, out, key);
    if (st.crashes >= MAX_CRASHES && !st.failed) {
      st.failed = true;
      out(`kitchen run: ${st.crashes} lane sessions in a row crashed (the last: ${lastOf(stderr) || `exit ${r.code}`}). Nothing more started.`);
    }
  }
}

async function finishLane(repo: string, id: string, st: State, out: Out, key?: string): Promise<void> {
  try {
    const f = await finish(repo, id, { key });
    out("refused" in f ? `${id}  refused: ${f.refused}` : f.line);
  } catch (e) {
    st.failed = true;
    out(`kitchen run: kitchen job finish ${id} failed: ${errLine(e)}`);
  }
}

/**
 * ADR 0030 §3: what a run that is gone left (the run lock says none other lives): a lane whose session ended before
 * its finish is finished now; a lane session still alive is ended (its lane restarts with --restart-stranded).
 */
async function settleLeftovers(repo: string, st: State, out: Out): Promise<void> {
  for (const j of listJobs(repo)) {
    const ses = j.running?.session;
    if (!j.running || !ses) continue;
    if (ses.ended) {
      out(`${j.id}  ${j.running.lane}: its session ended before Kitchen finished it; finishing now`);
      await finishLane(repo, j.id, st, out, j.running.key);
    } else {
      const e = await endGroup(ses);
      if (e === "ended") out(`${j.id}  ${j.running.lane}: ended the session a run before this one left (pid ${ses.pid}); it starts again`);
      if (e === "unconfirmed") out(`${j.id}  ${j.running.lane}: ${unconfirmed(ses.pid, "the session a run before this one left")}`);
    }
  }
}

/** A refused start is asked again once its job changed (it moved, or its lane opened or closed). */
const sigOf = (j: Job | undefined) => (j ? `${j.moves}|${j.running?.key ?? ""}` : "");

export async function schedule(repo: string, o: { maxUsd?: number; graceMs?: number; pollMs?: number }, out: Out): Promise<number> {
  const cfg = loadConfig(repo);
  const codex = cfg.agent.tool === "codex";
  const max = o.maxUsd ?? cfg.agent.max_usd;
  if (codex && max !== undefined)
    out(`kitchen run: Codex reports tokens, not dollars: no budget cap applies ($${max} ignored; the ledger keeps each lane's tokens)`);
  const st: State = { stopping: false, failed: false, spent: 0, reserved: 0, maxUsd: codex ? undefined : max, budgetOut: false, crashes: 0 };
  const stop = () => {
    if (!st.stopping) out("kitchen run: stopping every lane (their jobs keep their state)");
    st.stopping = true;
  };
  // ADR 0029 §5: a closed terminal (SIGHUP) stops the run as Ctrl-C does; each session ends its own group on it.
  for (const x of SIGNALS) process.on(x, stop);
  const inflight = new Map<string, Promise<void>>();
  /** Starts refused in this run, with the job as it was: not asked again until it changes (it would loop). */
  const refused = new Map<string, string>();
  let spentSaid = false;
  try {
    await settleLeftovers(repo, st, out);
    let first = true;
    for (;;) {
      if (!st.stopping && !st.failed) {
        const plan = await next(repo, { restartStranded: first, by: "run" });
        first = false;
        for (const p of plan.prs) out(`pr  ${p}`);
        // ADR 0029 §6: a check's findings proposed again (under the proposals lock) on this plan.
        for (const p of plan.proposals) out(`inbox  ${p}`);
        // ADR 0033: checks filed again once their tooling merged, and merge checks tried again once their port freed.
        for (const l of plan.refiled) out(`check  ${l}`);
        for (const l of plan.merges) out(`merge  ${l}`);
        const jobs = new Map(listJobs(repo).map((j) => [j.id, j]));
        const todo = plan.start.filter((x) => !inflight.has(x.id) && refused.get(`${x.id}/${x.lane}`) !== sigOf(jobs.get(x.id)));
        // ADR 0030 §5: said once while the budget holds lanes back, and again once it held them back after freeing.
        const sayBroke = () => {
          if (spentSaid) return;
          spentSaid = true;
          out(
            st.budgetOut
              ? "kitchen run: a lane reached its share of the budget: nothing new starts; the lanes at work finish"
              : `kitchen run: budget left $${Math.max(0, left(st)).toFixed(2)} (of $${st.maxUsd?.toFixed(2)}) is below what a lane needs ($${floorOf(st).toFixed(2)}): nothing new starts; the lanes at work finish`,
          );
        };
        if (!broke(st)) spentSaid = false;
        else if (todo.length) sayBroke();
        let opened = 0;
        let fresh = 0;
        if (!broke(st) && todo.length) out(`wave: ${todo.map((x) => `${x.id} ${x.lane}${x.restart ? " (restart)" : ""}`).join(", ")}`);
        for (const [i, x] of (broke(st) ? [] : todo).entries()) {
          if (st.stopping || st.failed) break;
          if (broke(st)) {
            sayBroke();
            break;
          }
          let r: Awaited<ReturnType<typeof start>>;
          try {
            r = await start(repo, x.id, x.lane, { restart: x.restart, by: "run" });
          } catch (e) {
            st.failed = true;
            out(`kitchen run: kitchen job start ${x.id} ${x.lane} failed: ${errLine(e)}`);
            break;
          }
          if ("refused" in r || "parked" in r) {
            refused.set(`${x.id}/${x.lane}`, sigOf(findJob(repo, x.id)));
            fresh++;
            out("refused" in r ? `${x.id}  ${x.lane} not started: ${r.refused}` : r.parked);
            continue;
          }
          // Stopped while the lane opened: it stays open, and the next run restarts it.
          if (st.stopping) break;
          // ADR 0030 §5: the lane's share of what is left, split over the lanes still to start in this wave (intakes
          // too), held until its result; at least MIN_RESERVE_USD (the check above).
          const reserve = st.maxUsd !== undefined ? Math.max(floorOf(st), left(st) / Math.max(1, todo.length - i)) : undefined;
          st.reserved += reserve ?? 0;
          const started = r;
          inflight.set(
            x.id,
            lane(repo, cfg, started, st, { graceMs: o.graceMs, reserve }, out)
              .catch((e) => {
                st.failed = true;
                out(`kitchen run: ${x.id} ${x.lane}: ${errLine(e)}`);
              })
              .finally(() => inflight.delete(x.id)),
          );
          opened++;
        }
        if (!inflight.size) {
          if (st.failed) break;
          // ADR 0033: a merge check waiting for the app's fixed port: `kitchen job next` tries it again once the port is
          // free, so the run keeps planning while one waits.
          const portWait = [...jobs.values()].some((j) => j.stage === "ready" && j.mergeWait && !j.archived);
          if (plan.drained && !portWait) {
            for (const y of plan.you) out(`you  ${y.id}  ${y.stage}: ${y.why}`);
            out(plan.you.length ? "drained: what is left waits on you (kitchen status)" : "drained: nothing to do");
            break;
          }
          if (fresh && !opened) continue; // a refusal may have moved a job: plan again at once
          if (broke(st) || (!plan.running.length && !opened && !portWait)) {
            out("kitchen run: nothing more can start in this run (kitchen status says why)");
            break;
          }
          // Only lanes another orchestrator (an in-session /kitchen run) works on: look again shortly.
          await new Promise((res) => setTimeout(res, o.pollMs ?? POLL_MS));
          continue;
        }
      } else if (!inflight.size) break;
      // ADR 0030 §1: the first lane to end is finished, then the wave is planned again.
      await Promise.race(inflight.values());
    }
  } finally {
    for (const x of SIGNALS) process.off(x, stop);
  }
  if (st.spent) out(`kitchen run: $${st.spent.toFixed(2)} spent in this run`);
  return st.failed ? 1 : 0;
}

/** For `--print`: each lane's command, the prompt left out. */
export function laneCommands(cfg: Config, maxUsd?: number): string[] {
  return LANE_ROLES.map(
    (r) =>
      `${r}: ${laneCommand(
        cfg,
        { model: modelFor(cfg, r), prompt: "<prompt>" },
        { cwd: "<checkout>", writable: ["<job folder>", ...(r === "builder" ? ["<commit's git paths>"] : [])], network: r === "qa", budget: maxUsd },
      ).join(" ")}`,
  );
}
