// `kitchen toolkit build --detach` and `--status` (PLAN §5, ADR 0010): the
// Toolkit build takes minutes (an agent survey and build, a Docker check),
// longer than an agent tool should hold one Bash call. So, like `kitchen run
// --detach`, it can run detached, and it keeps .kitchen/init/status.json current
// (the folder keeps its old name: the dashboard reads it):
//   { state: running|done|questions|failed, pid, pidStart, startedAt, at, exit?, last: [lines], log, questions? }
// `--status` reads it (a running state whose process is gone reads as failed:
// "died"). One build per repo at a time: a second is refused while one runs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "../engine/store.ts";
import { ownerAlive, processStart } from "../lock.ts";

export type InitStatus = {
  state: "running" | "done" | "questions" | "failed";
  pid: number;
  pidStart: string | null;
  startedAt: string;
  at: string;
  exit?: number;
  error?: string;
  last: string[];
  log?: string;
  questions?: { id: string; question: string; why?: string; default?: string }[];
};

const LAST = 12;
export const statusFile = (repo: string) => path.join(repo, ".kitchen", "init", "status.json");
export const initLog = (repo: string) => path.join(repo, ".kitchen", "init", "init.log");

export function readStatus(repo: string): InitStatus | null {
  try {
    return JSON.parse(fs.readFileSync(statusFile(repo), "utf8")) as InitStatus;
  } catch {
    return null;
  }
}

function write(repo: string, s: InitStatus) {
  fs.mkdirSync(path.dirname(statusFile(repo)), { recursive: true });
  writeAtomic(statusFile(repo), `${JSON.stringify(s, null, 2)}\n`);
}

/** The Toolkit build running for this repo, if its process lives. */
export function runningInit(repo: string): InitStatus | null {
  const s = readStatus(repo);
  return s?.state === "running" && s.pid !== process.pid && ownerAlive({ pid: s.pid, start: s.pidStart }) ? s : null;
}

/**
 * Run `fn` (toolkitBuild) with the status file kept current: running with the last
 * lines while it runs, then done (exit 0), questions (exit 3) or failed.
 */
export async function tracked(repo: string, fn: (out: (l: string) => void) => Promise<number>, out: (l: string) => void, log?: string): Promise<number> {
  const other = runningInit(repo);
  if (other) {
    out(`toolkit build: already running (pid ${other.pid}, since ${other.startedAt}); see kitchen toolkit build --status`);
    return 1;
  }
  const s: InitStatus = {
    state: "running",
    pid: process.pid,
    pidStart: processStart(process.pid),
    startedAt: new Date().toISOString(),
    at: new Date().toISOString(),
    last: [],
    ...(log ? { log } : {}),
  };
  write(repo, s);
  let pending: NodeJS.Timeout | null = null;
  const tee = (l: string) => {
    out(l);
    s.last = [...s.last, l].slice(-LAST);
    s.at = new Date().toISOString();
    pending ??= setTimeout(() => {
      pending = null;
      if (s.state === "running") write(repo, s);
    }, 500);
  };
  let code = 1;
  try {
    code = await fn(tee);
    return code;
  } catch (e) {
    s.error = (e as Error).message;
    throw e;
  } finally {
    if (pending) clearTimeout(pending);
    s.exit = s.error ? 1 : code;
    s.state = s.error ? "failed" : code === 0 ? "done" : code === 3 ? "questions" : "failed";
    s.at = new Date().toISOString();
    if (s.state === "questions") {
      try {
        s.questions = (
          JSON.parse(fs.readFileSync(path.join(repo, ".kitchen", "setup-questions.json"), "utf8")) as { questions: InitStatus["questions"] }
        ).questions;
      } catch {}
    }
    write(repo, s);
  }
}

/** `kitchen toolkit build --detach …`: the same build in its own session, its whole log (verbose) to .kitchen/init/init.log. */
export function detachInit(repo: string, cli: string, argv: string[], out: (l: string) => void): number {
  const other = runningInit(repo);
  if (other) {
    out(`toolkit build: already running (pid ${other.pid}, since ${other.startedAt}); see kitchen toolkit build --status`);
    return 1;
  }
  const log = initLog(repo);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "a");
  const child = spawn(process.execPath, [cli, "toolkit", "build", ...argv.filter((a) => a !== "--detach")], {
    cwd: repo,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, KITCHEN_INIT_LOG: log },
  });
  child.unref();
  fs.closeSync(fd);
  if (!child.pid) throw new Error("could not start the detached Toolkit build");
  write(repo, {
    state: "running",
    pid: child.pid,
    pidStart: processStart(child.pid),
    startedAt: new Date().toISOString(),
    at: new Date().toISOString(),
    last: [],
    log,
  });
  out(`toolkit build detached: pid ${child.pid}, log ${log}`);
  out("toolkit build: check on it with  kitchen toolkit build --status --wait 90  (it takes minutes; it ends in done, questions or failed)");
  return 0;
}

/**
 * Pure: what `--status` prints for a status (and whether its process lives).
 * The exit code is 0 for every state: the state is the first word after
 * `toolkit build:` (`init:` for `kitchen init --status`, which skills written before ADR 0010 poll). (A non-zero code for "questions" made agents chain `|| <fallback>`.)
 */
export function statusReport(s: InitStatus | null, alive: boolean, now = Date.now(), who = "toolkit build"): { lines: string[]; code: number } {
  if (!s) return { lines: [`${who}: not started here (kitchen toolkit build --detach)`], code: 0 };
  const mins = (iso: string) => `${Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))}m`;
  if (s.state === "running" && !alive)
    return {
      lines: [
        `${who}: failed: its process (pid ${s.pid}) is gone without a result (killed?); run kitchen toolkit build --detach again (it resumes)`,
        ...tail(s),
      ],
      code: 0,
    };
  const head =
    s.state === "running"
      ? `${who}: running for ${mins(s.startedAt)} (pid ${s.pid}); last line ${mins(s.at)} ago`
      : s.state === "done"
        ? `${who}: done`
        : s.state === "questions"
          ? `${who}: questions: ${s.questions?.length ?? "?"} question(s) in .kitchen/setup-questions.json; answer them, then kitchen toolkit build --answers <file> --detach`
          : `${who}: failed (exit ${s.exit ?? "?"})${s.error ? `: ${s.error.split("\n")[0]}` : ""}`;
  return { lines: [head, ...tail(s)], code: 0 };
}
const tail = (s: InitStatus) => s.last.map((l) => `  | ${l}`);
