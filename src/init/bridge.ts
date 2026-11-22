// The setup role's engine bridge: `kitchen setup-mcp --repo <repo> --worktree <setup worktree>`.
// Like `kitchen mcp` (src/bridge/mcp.ts) it is an MCP server the agent tool
// starts; it runs as the engine, outside the agent's sandbox, so the setup agent
// (no network, no Docker) can run the Toolkit it is writing:
//   toolkit        one bin/dev command (lifecycle or primitive) in the bridge's own slot
//   toolkit_check  the real `kitchen toolkit check` on the worktree
// The bin/dev it runs is the one in the setup worktree, with the untrusted env
// (no credentials), exactly as `toolkit check` will run it after the commit.
// Engine flags (id, src, out, ports) are the bridge's; the agent can't pass them.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { BridgeServer } from "../agents/adapter.ts";
import { CONTROL_PLANE } from "../agents/env.ts";
import { kitchenHome } from "../home.ts";
import { RESERVED_ARGS } from "../proof/drive-format.ts";
import { runToolkitCheck } from "../toolkit/check.ts";
import { runToolkit } from "../toolkit/run.ts";
import { acquireSlot, releaseSlot, type Slot } from "../toolkit/slots.ts";

const CLI = path.resolve(import.meta.dirname, "..", `cli${path.extname(import.meta.filename)}`);
const PROTOCOL = "2025-06-18";

export type SetupBridgeOpts = { repo: string; worktree: string };

export function setupBridgeServer(o: SetupBridgeOpts, parent: NodeJS.ProcessEnv = process.env): BridgeServer {
  const env: Record<string, string> = { KITCHEN_HOME: kitchenHome() };
  for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "TZ", ...CONTROL_PLANE, "KITCHEN_TOOLKIT_STATE"]) {
    const v = parent[k];
    if (v) env[k] = v;
  }
  return { command: process.execPath, args: [CLI, "setup-mcp", "--repo", path.resolve(o.repo), "--worktree", path.resolve(o.worktree)], env };
}

type Rpc = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: Record<string, unknown> };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (o: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(o) }], ...(isError ? { isError } : {}) });

const TOOLS = [
  {
    name: "toolkit",
    description:
      "Run one command of the Toolkit you are writing (.kitchen/toolkit/bin/dev in your worktree), as the engine runs it: outside your sandbox, with network and Docker, " +
      "the untrusted env plus .env.kitchen. Commands: prepare, up, doctor, reset, down, describe, or a primitive. The engine fills in --id, --src, --ports and --out; " +
      "pass only the primitive's own args. Returns exit code, the JSON line, and the stderr tail. Always `down` after a failed attempt.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "prepare | up | doctor | reset | down | describe | <primitive>" },
        args: { type: "object", description: 'primitive args, e.g. {"target":"body"} or {"argv":["list","--json"]}' },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "toolkit_check",
    description:
      "Run `kitchen toolkit check` on your worktree: describe, prepare, up, doctor, every check drive, reset, the drives again, a second instance at once, down, evidence. " +
      "Returns each step with its outcome and, for a failure, the stderr tail. `feature` limits it to one drive or feature file; `prepare: false` skips prepare (if you just ran it).",
    inputSchema: {
      type: "object",
      properties: { feature: { type: "string" }, prepare: { type: "boolean" } },
      additionalProperties: false,
    },
  },
];

export function makeSetupBridge(o: SetupBridgeOpts) {
  const repo = path.resolve(o.repo);
  const wt = fs.realpathSync(o.worktree);
  const bin = path.join(wt, ".kitchen", "toolkit", "bin", "dev");
  const scratch = path.join(repo, ".kitchen", "init", "bridge");
  let slot: Slot | null = null;
  let up = false;
  let n = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  async function toolkit(a: Record<string, unknown>): Promise<ToolResult> {
    const extra = Object.keys(a).filter((k) => k !== "command" && k !== "args");
    if (extra.length) return text({ ok: false, refused: `unknown fields: ${extra.join(", ")}` }, true);
    const command = String(a.command ?? "");
    if (!/^[a-z][a-z0-9_-]*$/.test(command)) return text({ ok: false, refused: `bad command ${JSON.stringify(command)}` }, true);
    const args = a.args && typeof a.args === "object" && !Array.isArray(a.args) ? (a.args as Record<string, unknown>) : {};
    for (const k of Object.keys(args)) {
      if ((RESERVED_ARGS as readonly string[]).includes(k)) return text({ ok: false, refused: `${k} is set by the engine` }, true);
      if (!/^[a-z][a-z0-9_]*$/.test(k)) return text({ ok: false, refused: `bad arg name ${k}` }, true);
    }
    if (!fs.existsSync(bin)) return text({ ok: false, refused: `${path.relative(wt, bin)} doesn't exist yet` }, true);
    if (!slot) slot = (await acquireSlot({ id: `setup-${randomBytes(3).toString("hex")}`, toolkitBin: bin, src: wt })).slot;
    const flags = Object.entries(args).map(([k, v]) => `--${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    let argv: string[];
    if (command === "prepare" || command === "describe") argv = [command, `--src=${wt}`];
    else if (command === "up") argv = [command, `--id=${slot.id}`, `--src=${wt}`, `--ports=${slot.ports.join(",")}`];
    else if (["doctor", "reset", "down"].includes(command)) argv = [command, `--id=${slot.id}`];
    else {
      const outDir = path.join(scratch, `p${++n}`);
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      argv = [command, `--id=${slot.id}`, `--src=${wt}`, `--out=${outDir}`, ...flags];
    }
    if (command === "up") up = true;
    if (command === "down") up = false;
    const r = await runToolkit(bin, argv, { src: wt, timeoutMs: command === "prepare" ? 30 * 60_000 : 5 * 60_000 });
    return text(
      {
        exit: r.exit,
        json: r.json,
        ...(r.json ? {} : { stdout: r.stdout.slice(-1500) }),
        stderr: r.stderr.slice(-3000),
        ports: command === "up" ? slot.ports.slice(0, 5) : undefined,
      },
      r.exit !== 0,
    );
  }

  async function check(a: Record<string, unknown>): Promise<ToolResult> {
    const extra = Object.keys(a).filter((k) => k !== "feature" && k !== "prepare");
    if (extra.length) return text({ ok: false, refused: `unknown fields: ${extra.join(", ")}` }, true);
    if (!fs.existsSync(bin)) return text({ ok: false, refused: "bin/dev doesn't exist yet" }, true);
    const lines: string[] = [];
    const r = await runToolkitCheck({
      repo,
      toolkitBin: bin,
      src: wt,
      feature: a.feature ? String(a.feature) : undefined,
      prepare: a.prepare !== false,
      print: (l) => {
        lines.push(l);
        console.error(`[setup-mcp] ${l}`);
      },
    });
    return text({ ok: r.ok, failed: r.failed, steps: r.steps, entries: r.entries, secs: r.secs, evidence: path.relative(repo, r.jobDir) }, !r.ok);
  }

  async function close() {
    if (!slot) return;
    if (up) await runToolkit(bin, ["down", `--id=${slot.id}`], { src: wt, timeoutMs: 120_000 }).catch(() => {});
    await releaseSlot(slot.id);
  }

  async function handle(msg: Rpc): Promise<unknown> {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined) return null;
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "kitchen", version: "0.0.0" },
          instructions: "Kitchen engine bridge for the setup role: run the Toolkit you are writing, and its check.",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = msg.params?.name;
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          if (name === "toolkit") return reply(await serial(() => toolkit(args)));
          if (name === "toolkit_check") return reply(await serial(() => check(args)));
        } catch (e) {
          return reply(text({ ok: false, error: (e as Error).message }, true));
        }
        return fail(-32602, `unknown tool ${String(name)}`);
      }
      default:
        return fail(-32601, `method not found: ${String(msg.method)}`);
    }
  }
  return { handle, close };
}

export async function serveSetupBridge(o: SetupBridgeOpts): Promise<void> {
  const b = makeSetupBridge(o);
  console.error(`[setup-mcp] worktree ${o.worktree} pid ${process.pid}`);
  const rl = readline.createInterface({ input: process.stdin });
  const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const pending: Promise<unknown>[] = [];
  const onSignal = () => {
    void b.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    pending.push(
      b.handle(msg).then(
        (r) => {
          if (r) send(r);
        },
        (e) => send({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } }),
      ),
    );
  }
  await Promise.all(pending);
  await b.close();
}
