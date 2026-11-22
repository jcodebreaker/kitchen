// The one way the engine runs a Toolkit command. bin/dev gets the untrusted env
// (env.ts) plus Docker for its control plane, never the engine's own env.
// It runs in its own process group; a call made for a job (`jobDir`) is
// recorded in the job's procs/ so a restart after kill -9 kills it (src/procs.ts).
import { execa } from "execa";
import { toolkitEnv } from "../agents/env.ts";
import { procsDirOf, trackGroup } from "../procs.ts";

export type ToolkitCall = { exit: number; stdout: string; stderr: string; json: Record<string, unknown> | null; argv: string[] };

export async function runToolkit(bin: string, argv: string[], o: { src: string; timeoutMs?: number; jobDir?: string }): Promise<ToolkitCall> {
  const sub = execa(bin, argv, {
    env: toolkitEnv(o.src),
    extendEnv: false,
    reject: false,
    timeout: o.timeoutMs ?? 120_000,
    stdin: "ignore",
    detached: true,
  });
  const untrack = trackGroup(o.jobDir ? procsDirOf(o.jobDir) : undefined, sub.pid, `toolkit ${argv[0] ?? ""}`, { keepLeftovers: true });
  let r: Awaited<typeof sub>;
  try {
    r = await sub;
  } finally {
    untrack();
  }
  let json: ToolkitCall["json"] = null;
  try {
    json = JSON.parse(String(r.stdout).trim().split("\n").pop() || "");
  } catch {}
  return { exit: r.exitCode ?? 1, stdout: String(r.stdout), stderr: String(r.stderr), json, argv };
}
