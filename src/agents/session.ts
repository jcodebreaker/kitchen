// ADR 0029 §5: every agent session Kitchen starts (the `kitchen run` orchestrator, collect's triage, `kitchen models
// check`) runs here: in its own process group, its stdout read line by line. Once the stream sends its final line
// (claude's `{"type":"result"}`, codex exec's `turn.completed`/`turn.failed`), the session gets a grace to exit, then
// the group ends: SIGTERM, then SIGKILL. On close whatever is left of the group ends too, and so it does when Kitchen
// itself is stopped (SIGTERM, SIGINT, SIGHUP: a closed terminal); then Kitchen re-raises the signal and exits too, so
// Ctrl-C ends the whole command. Anything a lane agent started by hand (`npm run dev &`) goes with the group.
import { spawn } from "node:child_process";
import { type Owner, ownerAlive, sameProcess } from "../lock.ts";

/** How long a session may live after its final line. */
export const SESSION_GRACE_MS = 10_000;
/** After SIGTERM, how long the group has before SIGKILL. */
export const KILL_AFTER_MS = 3_000;

/** Pure: a final line that says the session finished well (claude's result without is_error, subtype success). */
export function finalOk(line: string): boolean {
  try {
    const e = JSON.parse(line) as { type?: unknown; is_error?: unknown; subtype?: unknown };
    if (e.type === "turn.completed") return true;
    return e.type === "result" && e.is_error !== true && (e.subtype ?? "success") === "success";
  } catch {
    return false;
  }
}

const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/** Pure: the stream's final line (claude's result; codex exec --json's last turn event). */
export function finalLine(line: string): boolean {
  try {
    const t = (JSON.parse(line) as { type?: unknown }).type;
    return t === "result" || t === "turn.completed" || t === "turn.failed";
  } catch {
    return false;
  }
}

export type Session = { code: number; error?: string; pid?: number };

export async function runAgentSession(
  argv: string[],
  o: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /** Each stdout line, as it arrives. */
    onLine?: (line: string) => void;
    /** The raw stdout and stderr chunks (a stream log). */
    onStdout?: (d: Buffer) => void;
    onStderr?: (d: Buffer) => void;
    /** The session's pid, once it runs (before any output). */
    onStart?: (pid: number) => void;
    graceMs?: number;
    /** End the group this long after the start, final line or not (a one-shot request). */
    timeoutMs?: number;
  },
): Promise<Session> {
  const grace = o.graceMs ?? SESSION_GRACE_MS;
  const child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const group = (sig: NodeJS.Signals | 0) => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  let ending: Promise<void> | null = null;
  let ended = false;
  const end = () => {
    ending ??= (async () => {
      if (!group("SIGTERM")) return;
      ended = true;
      for (let t = 0; t < KILL_AFTER_MS && group(0); t += 100) await new Promise((r) => setTimeout(r, 100));
      group("SIGKILL");
    })();
    return ending;
  };
  let timer: NodeJS.Timeout | undefined;
  let final = false;
  let ok = false;
  const after = (ms: number) => {
    timer ??= setTimeout(end, ms);
  };
  const limit = o.timeoutMs ? setTimeout(end, o.timeoutMs) : undefined;
  if (child.pid) o.onStart?.(child.pid);
  let buf = "";
  const line = (l: string) => {
    o.onLine?.(l);
    if (finalLine(l)) {
      final = true;
      ok = finalOk(l);
      after(grace);
    }
  };
  child.stdout.on("data", (d: Buffer) => {
    o.onStdout?.(d);
    buf += d.toString("utf8");
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      line(l);
    }
  });
  child.stderr.on("data", (d: Buffer) => o.onStderr?.(d));
  // Exited (or crashed) while something it started still holds the pipes: the same grace, then the group.
  child.on("exit", () => after(grace));
  // Kitchen stopped: the group first, then Kitchen itself (the signal again, with the default handler).
  const stop = (sig: NodeJS.Signals) => {
    void end().then(() => {
      for (const x of SIGNALS) process.off(x, stop);
      process.kill(process.pid, sig);
    });
  };
  for (const x of SIGNALS) process.on(x, stop);
  const r = await new Promise<Session>((resolve) => {
    child.on("error", (e) => resolve({ code: 127, error: e.message }));
    child.on("close", (c) => resolve({ code: c ?? 1 }));
  });
  const killed = ended;
  if (buf) line(buf);
  clearTimeout(timer);
  clearTimeout(limit);
  for (const x of SIGNALS) process.off(x, stop);
  await end();
  // Ended by Kitchen after a final line that said it finished well: no failure. An error result stays non-zero.
  return { ...r, ...(final && ok && killed && r.code !== 0 && r.error === undefined ? { code: 0 } : {}), ...(child.pid ? { pid: child.pid } : {}) };
}

/**
 * ADR 0030: end a session's group from outside it (`kitchen run --stop`, `kitchen stop`, a gone run's lane) only while
 * the pid is positively that session (sameProcess: its stored start matches; never a bare pid, which may be reused).
 * SIGTERM now; the caller waits while the group lives, up to KILL_AFTER_MS, then SIGKILL. `ended`; `gone` (nothing to
 * end); `unconfirmed`: a live pid that may be it but can't be confirmed (a start an earlier Kitchen stored): left alone.
 */
export async function endGroup(s: Owner): Promise<"ended" | "gone" | "unconfirmed"> {
  if (!ownerAlive(s)) return "gone";
  if (!sameProcess(s)) return "unconfirmed";
  const group = (sig: NodeJS.Signals | 0) => {
    try {
      process.kill(-s.pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (!group("SIGTERM")) return "gone";
  for (let t = 0; t < KILL_AFTER_MS && group(0); t += 100) await new Promise((r) => setTimeout(r, 100));
  group("SIGKILL");
  return "ended";
}
