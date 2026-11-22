// The one way the engine runs a Toolkit command. bin/dev gets the untrusted env
// (env.ts) plus Docker for its control plane, never the engine's own env.
import { execa } from "execa";
import { toolkitEnv } from "../agents/env.ts";

export type ToolkitCall = { exit: number; stdout: string; stderr: string; json: Record<string, unknown> | null; argv: string[] };

export async function runToolkit(bin: string, argv: string[], o: { src: string; timeoutMs?: number }): Promise<ToolkitCall> {
  const r = await execa(bin, argv, {
    env: toolkitEnv(o.src),
    extendEnv: false,
    reject: false,
    timeout: o.timeoutMs ?? 120_000,
    stdin: "ignore",
  });
  let json: ToolkitCall["json"] = null;
  try {
    json = JSON.parse(String(r.stdout).trim().split("\n").pop() || "");
  } catch {}
  return { exit: r.exitCode ?? 1, stdout: String(r.stdout), stderr: String(r.stderr), json, argv };
}
