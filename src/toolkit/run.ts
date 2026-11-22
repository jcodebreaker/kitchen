// The one way the engine runs a Toolkit command. bin/dev gets the untrusted env
// (env.ts) plus Docker for its control plane, never the engine's own env.
// It runs in its own process group (src/procs.ts conventions); a call made for a
// job (`jobDir`) is recorded in the job's procs/ so a restart after kill -9 kills it.
//
// Timeouts never wait on pipes: a bin/dev can leave a child behind that holds
// stdout open (a backgrounded server without a log file). On timeout, or when
// output stalls for `stallMs`, the whole group is killed (TERM, KILL after a
// grace) and the call returns at once with `timedOut`. After a normal exit the
// pipes get a short grace to drain, then they are dropped: leftovers in the
// group keep running (`up` leaves the app up; the slot's `down` owns it).
import { spawn } from "node:child_process";
import { toolkitEnv } from "../agents/env.ts";
import { killGroup, procsDirOf, trackGroup } from "../procs.ts";

export type ToolkitCall = {
  exit: number;
  stdout: string;
  stderr: string;
  /** The last stdout line, parsed (null if it isn't JSON). `toolkit check` holds stdout to exactly one line (contract.ts `oneJsonLine`). */
  json: Record<string, unknown> | null;
  argv: string[];
  /** Set when the engine killed the call's process group: the deadline passed, or no output for `stallMs`. */
  timedOut?: "timeout" | "stall";
};

export type ToolkitRunOpts = {
  src: string;
  timeoutMs?: number;
  jobDir?: string;
  /** Kill the call when it prints nothing (stdout or stderr) for this long (prepare: a hung download). */
  stallMs?: number;
  /** Run bin/dev under this macOS sandbox-exec profile (the setup bridge: agent-written code). */
  sandboxProfile?: string;
};

const MAX_BUF = 16 << 20;
const DRAIN_MS = 1000;
const KILL_GRACE_MS = 2000;
export const TIMEOUT_EXIT = 124;

export async function runToolkit(bin: string, argv: string[], o: ToolkitRunOpts): Promise<ToolkitCall> {
  const timeoutMs = o.timeoutMs ?? 120_000;
  const [cmd, args] = o.sandboxProfile ? ["/usr/bin/sandbox-exec", ["-f", o.sandboxProfile, bin, ...argv]] : [bin, argv];
  const child = spawn(cmd, args, { env: toolkitEnv(o.src), stdio: ["ignore", "pipe", "pipe"], detached: true });
  const untrack = trackGroup(o.jobDir ? procsDirOf(o.jobDir) : undefined, child.pid, `toolkit ${argv[0] ?? ""}`, { keepLeftovers: true });
  let stdout = "";
  let stderr = "";
  let lastOutput = Date.now();
  const take = (which: "out" | "err") => (b: Buffer) => {
    lastOutput = Date.now();
    if (which === "out") stdout = (stdout + b.toString()).slice(-MAX_BUF);
    else stderr = (stderr + b.toString()).slice(-MAX_BUF);
  };
  child.stdout?.on("data", take("out"));
  child.stderr?.on("data", take("err"));

  const result = await new Promise<{ exit: number; timedOut?: "timeout" | "stall" }>((resolve) => {
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (r: { exit: number; timedOut?: "timeout" | "stall" }) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      clearInterval(stall);
      resolve(r);
    };
    const kill = (why: "timeout" | "stall") => {
      if (settled || !child.pid) return;
      killGroup(child.pid, "SIGTERM");
      const pid = child.pid;
      setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS).unref();
      const secs = Math.round((why === "timeout" ? timeoutMs : (o.stallMs ?? 0)) / 1000);
      stderr += `\n[kitchen] bin/dev ${argv[0] ?? ""} ${why === "timeout" ? `timed out after ${secs}s` : `printed nothing for ${secs}s (stalled)`}: its process group was killed`;
      finish({ exit: TIMEOUT_EXIT, timedOut: why });
    };
    timers.push(setTimeout(() => kill("timeout"), timeoutMs));
    const stall = setInterval(() => {
      if (o.stallMs && Date.now() - lastOutput > o.stallMs) kill("stall");
    }, Math.min(1000, o.stallMs ?? 1000));
    child.once("error", (e) => {
      stderr += `\n[kitchen] could not start ${bin}: ${e.message}`;
      finish({ exit: 127 });
    });
    // `exit`, not `close`: close waits for every holder of the pipes, which a
    // backgrounded child can keep open forever.
    child.once("exit", (code, signal) => {
      const exit = code ?? (signal ? 128 : 1);
      let ended = 0;
      const ends = () => {
        if (++ended === 2) finish({ exit });
      };
      if (child.stdout?.readableEnded) ended++;
      if (child.stderr?.readableEnded) ended++;
      if (ended === 2) return finish({ exit });
      child.stdout?.once("end", ends);
      child.stderr?.once("end", ends);
      timers.push(setTimeout(() => finish({ exit }), DRAIN_MS));
    });
  });
  untrack();
  child.stdout?.destroy();
  child.stderr?.destroy();
  let json: ToolkitCall["json"] = null;
  try {
    json = JSON.parse(stdout.trim().split("\n").pop() || "");
  } catch {}
  return { exit: result.exit, stdout, stderr, json, argv, ...(result.timedOut ? { timedOut: result.timedOut } : {}) };
}
