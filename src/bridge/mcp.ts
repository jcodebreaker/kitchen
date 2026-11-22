// The engine bridge (PLAN §3): `kitchen mcp --job <id> --role <role>`, an MCP
// server over stdio that the agent tool starts for one role run. It runs as the
// engine, outside the agent's Bash sandbox, and exposes only job-scoped tools:
//   drive           one feature drive or one primitive, in the job's slot, stamped
//   toolkit_status  `doctor` for the job's slot
// Everything else (other jobs, other slots, raw flags, paths) is refused.
// A tiny hand-rolled JSON-RPC 2.0 server: newline-delimited messages on stdin/stdout.
import path from "node:path";
import readline from "node:readline";
import { type DriveRequest, runDrive } from "../proof/drive.ts";
import { DriveFormatError } from "../proof/drive-format.ts";
import { readJob } from "../proof/job.ts";
import { ManifestTampered } from "../proof/manifest.ts";
import { runToolkit } from "../toolkit/run.ts";

const ROLES = ["builder", "verifier", "smith", "spec", "repro", "ux", "ui", "setup"] as const;
const JOB_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const PROTOCOL = "2025-06-18";

export type BridgeOpts = { repo: string; job: string; role: string };

type Rpc = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const TOOLS = [
  {
    name: "drive",
    description:
      "Run one feature drive (by name, from this job's worktree) or one Toolkit primitive against this job's running app. " +
      "The engine runs it and stamps every step as evidence; the result lists the evidence ids (e1, e2, …). " +
      "Pass either `feature` (+ `args`) or `primitive` (+ `primitive_args`).",
    inputSchema: {
      type: "object",
      properties: {
        feature: { type: "string", description: "drive name, e.g. settings.toggle-dark" },
        args: { type: "object", additionalProperties: { type: "string" }, description: 'drive args, e.g. {"user":"alice"}' },
        primitive: { type: "string", description: "one primitive from describe, e.g. read, press, screenshot, http" },
        primitive_args: { type: "object", description: 'its args, e.g. {"target":"body"}' },
        criterion: { type: "string", description: "spec criterion this proves, e.g. C2 (default -)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "toolkit_status",
    description: "Health of this job's running app (the Toolkit's doctor): containers, app, browser driver.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const text = (o: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(o) }], ...(isError ? { isError } : {}) });

export function makeBridge(o: BridgeOpts) {
  if (!JOB_ID.test(o.job)) throw new Error(`bad job id ${JSON.stringify(o.job)}`);
  if (!(ROLES as readonly string[]).includes(o.role)) throw new Error(`role ${o.role} has no bridge (only ${ROLES.join(", ")})`);
  const jobDir = path.join(path.resolve(o.repo), ".kitchen", "jobs", o.job);
  readJob(jobDir); // fail at start, not at the first call

  async function drive(a: Record<string, unknown>): Promise<ToolResult> {
    const has = (k: string) => a[k] !== undefined && a[k] !== null && a[k] !== "";
    if (has("feature") === has("primitive")) return text({ ok: false, refused: "pass exactly one of feature or primitive" }, true);
    const extra = Object.keys(a).filter((k) => !["feature", "args", "primitive", "primitive_args", "criterion"].includes(k));
    if (extra.length) return text({ ok: false, refused: `unknown fields: ${extra.join(", ")}` }, true);
    const strMap = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
    let request: DriveRequest;
    if (has("feature")) {
      const args = Object.fromEntries(Object.entries(strMap(a.args)).map(([k, v]) => [k, String(v)]));
      request = { feature: String(a.feature), args };
    } else request = { primitive: String(a.primitive), args: strMap(a.primitive_args) as never };
    try {
      const r = await runDrive({ jobDir, request, criterion: String(a.criterion ?? "-"), role: o.role, log: (m) => console.error(`[kitchen mcp] ${m}`) });
      return text(
        {
          ok: r.ok,
          drive: r.drive,
          ...(r.gap ? { gap: r.gap } : {}),
          ...(r.failedAt ? { failedAt: r.failedAt } : {}),
          vars: r.vars,
          evidence: r.steps.flatMap((s) => s.evidence),
          source: r.source,
          secs: r.secs,
        },
        !r.ok,
      );
    } catch (e) {
      if (e instanceof DriveFormatError || e instanceof ManifestTampered) return text({ ok: false, refused: e.message }, true);
      return text({ ok: false, error: (e as Error).message }, true);
    }
  }

  async function status(): Promise<ToolResult> {
    const job = readJob(jobDir);
    const r = await runToolkit(job.toolkitBin, ["doctor", `--id=${job.slotId}`], { src: job.worktree });
    return text(r.json ?? { status: "fail", why: r.stderr.slice(-400) }, r.json?.status !== "ok");
  }

  return async function handle(msg: Rpc): Promise<Rpc | null> {
    const reply = (result: unknown): Rpc => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    const fail = (code: number, message: string): Rpc => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined) return null; // a notification
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "kitchen", version: "0.0.0" },
          instructions: `Kitchen engine bridge for job ${o.job} (role ${o.role}). Drive the running app only through these tools.`,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = msg.params?.name;
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        if (name === "drive") return reply(await drive(args));
        if (name === "toolkit_status") return reply(await status());
        return fail(-32602, `unknown tool ${String(name)}`);
      }
      default:
        return fail(-32601, `method not found: ${String(msg.method)}`);
    }
  };
}

export async function serveBridge(o: BridgeOpts): Promise<void> {
  const handle = makeBridge(o);
  console.error(`[kitchen mcp] job ${o.job} role ${o.role} pid ${process.pid}`);
  const rl = readline.createInterface({ input: process.stdin });
  const send = (m: Rpc) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const pending: Promise<void>[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    // Calls may overlap; drives on one job still run one at a time (withJobLock).
    pending.push(
      handle(msg)
        .then((r) => {
          if (r) send(r);
        })
        .catch((e) => {
          send({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } });
        }),
    );
  }
  await Promise.all(pending);
}
