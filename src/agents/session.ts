// ADR 0029 §5: every agent session Kitchen starts (the `kitchen run` orchestrator, collect's triage, `kitchen models
// check`) runs here: in its own process group, its stdout read line by line. Once the stream sends its final line
// (claude's `{"type":"result"}`, codex exec's `turn.completed`/`turn.failed`), the session gets a grace to exit, then
// the group ends: SIGTERM, then SIGKILL. On close whatever is left of the group ends too, and so it does when Kitchen
// itself is stopped (SIGTERM, SIGINT). Anything a lane agent started by hand (`npm run dev &`) goes with the group.
import { spawn } from "node:child_process";

/** How long a session may live after its final line. */
export const SESSION_GRACE_MS = 10_000;
/** After SIGTERM, how long the group has before SIGKILL. */
export const KILL_AFTER_MS = 3_000;

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
  const stop = () => void end();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const r = await new Promise<Session>((resolve) => {
    child.on("error", (e) => resolve({ code: 127, error: e.message }));
    child.on("close", (c) => resolve({ code: c ?? 1 }));
  });
  const killed = ended;
  if (buf) line(buf);
  clearTimeout(timer);
  clearTimeout(limit);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  await end();
  // Ended by Kitchen after its final line: the session itself had finished.
  return { ...r, ...(final && killed && r.code !== 0 && r.error === undefined ? { code: 0 } : {}), ...(child.pid ? { pid: child.pid } : {}) };
}
