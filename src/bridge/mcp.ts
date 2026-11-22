// The engine bridge (PLAN §3): `kitchen mcp --job <id> --role <role>`, an MCP
// server over stdio that the agent tool starts for one role run. It runs as the
// engine, outside the agent's Bash sandbox, and exposes only job-scoped tools:
//   drive           one feature drive or one primitive, in the job's slot, stamped
//   toolkit_status  `doctor` for the job's slot
//   checks          (builder only) the kitchen.yaml checks in the job worktree, stamped
//   restart_app     (builder only) down + up of the job's app from the worktree as it is now
// `drive` with only `criterion` runs that spec criterion's whole proof (prove.ts) and
// reports whether its mechanical expect holds: the same path as `kitchen drive <job> <C>`.
// A verifier's feature drive run for a criterion with args other than the spec's
// is logged against the spec (rounds/<N>/args-deltas.jsonl) and listed in the Verdict.
// Everything else (other jobs, other slots, raw flags, paths) is refused. Every
// result passes through the redactor (proof/redact.ts) before the agent sees it.
// A tiny hand-rolled JSON-RPC 2.0 server: newline-delimited messages on stdin/stdout.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { BridgeServer } from "../agents/adapter.ts";
import { CONTROL_PLANE } from "../agents/env.ts";
import { runChecks } from "../checks/run-checks.ts";
import { loadConfig } from "../config.ts";
import { contractOf, specArgsOf } from "../engine/contract.ts";
import { freshUp, type InstanceJob } from "../engine/instance.ts";
import { kitchenHome } from "../home.ts";
import { type DriveRequest, runDrive } from "../proof/drive.ts";
import { DriveFormatError } from "../proof/drive-format.ts";
import { readJob } from "../proof/job.ts";
import { ManifestTampered } from "../proof/manifest.ts";
import { prove } from "../proof/prove.ts";
import { redact } from "../proof/redact.ts";
import { runToolkit } from "../toolkit/run.ts";

const ROLES = ["builder", "verifier", "smith", "spec", "repro", "ux", "ui", "setup"] as const;
const JOB_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const PROTOCOL = "2025-06-18";

export type BridgeOpts = { repo: string; job: string; role: string };

/** What the engine runs this file with: `node src/cli.ts` today, `dist/cli.js` once built. */
const CLI = path.resolve(import.meta.dirname, "..", `cli${path.extname(import.meta.filename)}`);

/**
 * How an adapter starts the bridge (AgentRequest.bridge). The env is built here,
 * explicitly, from the engine's own env: the agent tool would otherwise hand the
 * server its scrubbed env (Claude) or a handful of variables (Codex), and the
 * bridge needs Docker (DOCKER_HOST/DOCKER_CONTEXT, or the default context under
 * HOME) and KITCHEN_HOME (engine key, slots). None of it reaches the agent:
 * the agent only sees the tools' results.
 */
export function bridgeServer(o: BridgeOpts, parent: NodeJS.ProcessEnv = process.env): BridgeServer {
  const env: Record<string, string> = { KITCHEN_HOME: kitchenHome() };
  for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "TZ", ...CONTROL_PLANE, "KITCHEN_TOOLKIT_STATE"]) {
    const v = parent[k];
    if (v) env[k] = v;
  }
  return { command: process.execPath, args: [CLI, "mcp", "--job", o.job, "--role", o.role, "--repo", path.resolve(o.repo)], env };
}

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
      "Pass either `feature` (+ `args`) or `primitive` (+ `primitive_args`), or only `criterion` to run that spec criterion's proof and see whether its expect holds.",
    inputSchema: {
      type: "object",
      properties: {
        feature: { type: "string", description: "drive name, e.g. settings.toggle-dark" },
        args: { type: "object", additionalProperties: { type: "string" }, description: 'drive args, e.g. {"user":"alice"}' },
        primitive: { type: "string", description: "one primitive from describe, e.g. read, press, screenshot, http" },
        primitive_args: { type: "object", description: 'its args, e.g. {"target":"body"}' },
        criterion: {
          type: "string",
          description:
            "spec criterion this is about, e.g. C2 (default -). Alone (no feature or primitive): run that criterion's whole proof and check its expect",
        },
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

const CHECKS_TOOL = {
  name: "checks",
  description:
    "Run this project's checks (kitchen.yaml `checks`: tests, lint, typecheck…) in your worktree, the way Gate will. " +
    "The engine runs them with the app's env in a sandbox (no network unless kitchen.yaml sets checks_network; writes only in your worktree and TMPDIR; $HOME unreadable) " +
    "and stamps each one as evidence; the result lists each check's exit code and output tail.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const RESTART_TOOL = {
  name: "restart_app",
  description:
    "Restart this job's app from your worktree as it is now (down, then up; runs the Toolkit's prepare first when dependencies or migrations changed). " +
    "Do it after changing server code or migrations, before you drive the app.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const toolsFor = (role: string) => (role === "builder" ? [...TOOLS, CHECKS_TOOL, RESTART_TOOL] : TOOLS);

/** Every tool result goes through the redactor: evidence text (a proof's output, a check's tail) can carry secrets. */
const text = (o: unknown, isError = false): ToolResult => ({ content: [{ type: "text", text: redact(JSON.stringify(o)) }], ...(isError ? { isError } : {}) });

export function makeBridge(o: BridgeOpts) {
  if (!JOB_ID.test(o.job)) throw new Error(`bad job id ${JSON.stringify(o.job)}`);
  if (!(ROLES as readonly string[]).includes(o.role)) throw new Error(`role ${o.role} has no bridge (only ${ROLES.join(", ")})`);
  const jobDir = path.join(path.resolve(o.repo), ".kitchen", "jobs", o.job);
  readJob(jobDir); // fail at start, not at the first call

  async function drive(a: Record<string, unknown>): Promise<ToolResult> {
    const has = (k: string) => a[k] !== undefined && a[k] !== null && a[k] !== "";
    const extra = Object.keys(a).filter((k) => !["feature", "args", "primitive", "primitive_args", "criterion"].includes(k));
    if (extra.length) return text({ ok: false, refused: `unknown fields: ${extra.join(", ")}` }, true);
    if (!has("feature") && !has("primitive") && has("criterion") && !has("args") && !has("primitive_args")) return proveCriterion(String(a.criterion));
    if (has("feature") === has("primitive")) return text({ ok: false, refused: "pass exactly one of feature or primitive (or only criterion)" }, true);
    const strMap = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
    let request: DriveRequest;
    if (has("feature")) {
      const args = Object.fromEntries(Object.entries(strMap(a.args)).map(([k, v]) => [k, String(v)]));
      request = { feature: String(a.feature), args };
    } else request = { primitive: String(a.primitive), args: strMap(a.primitive_args) as never };
    if ("feature" in request && o.role === "verifier" && has("criterion")) logArgsDelta(String(a.criterion), request.feature, request.args ?? {});
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

  /** The spec criterion's whole proof, stamped with the caller's role; reports the expect. */
  async function proveCriterion(id: string): Promise<ToolResult> {
    const c = contractOf(jobDir)?.criteria.find((x) => x.id === id);
    if (!c) return text({ ok: false, refused: `no criterion ${id} in the contract` }, true);
    try {
      const cfg = loadConfig(path.resolve(o.repo));
      const r = await prove({ jobDir, criterion: c, role: o.role, testCmd: cfg.test_cmd, log: (m) => console.error(`[kitchen mcp] ${m}`) });
      const pass = r.status === "pass";
      return text(
        {
          ok: pass,
          criterion: id,
          status: r.status,
          ...(r.judged ? { note: "judged: the proof ran; the verifier decides" } : { expect: c.expect ?? "ok", holds: pass }),
          ...(r.why ? { why: r.why } : {}),
          ...(r.assert ? { clauses: r.assert.results } : {}),
          vars: r.outcome.vars,
          evidence: r.evidence,
        },
        !pass,
      );
    } catch (e) {
      return text({ ok: false, error: (e as Error).message }, true);
    }
  }

  /** A verifier's drive args that differ from the spec's for that criterion: logged against the spec. */
  function logArgsDelta(criterion: string, drive: string, used: Record<string, string>) {
    const c = contractOf(jobDir)?.criteria.find((x) => x.id === criterion);
    const spec = c ? specArgsOf(c, drive) : undefined;
    if (spec && JSON.stringify(Object.entries(spec).sort()) === JSON.stringify(Object.entries(used).sort())) return;
    const job = readJob(jobDir);
    const f = path.join(jobDir, "rounds", String(job.round), "args-deltas.jsonl");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${JSON.stringify({ criterion, drive, spec: spec ?? {}, used, by: o.role, at: new Date().toISOString() })}\n`);
  }

  async function restart(a: Record<string, unknown>): Promise<ToolResult> {
    if (o.role !== "builder") return text({ ok: false, refused: "restart_app is for the builder" }, true);
    if (Object.keys(a).length) return text({ ok: false, refused: `unknown fields: ${Object.keys(a).join(", ")}` }, true);
    try {
      const job = readJob(jobDir) as unknown as InstanceJob;
      const r = await freshUp(job, jobDir, (m) => console.error(`[kitchen mcp] ${m}`));
      return text({ ok: true, secs: r.secs, prepared: r.prepared });
    } catch (e) {
      return text({ ok: false, error: (e as Error).message }, true);
    }
  }

  async function status(): Promise<ToolResult> {
    const job = readJob(jobDir);
    const r = await runToolkit(job.toolkitBin, ["doctor", `--id=${job.slotId}`], { src: job.worktree });
    return text(r.json ?? { status: "fail", why: r.stderr.slice(-400) }, r.json?.status !== "ok");
  }

  async function checks(a: Record<string, unknown>): Promise<ToolResult> {
    if (o.role !== "builder") return text({ ok: false, refused: "checks is for the builder" }, true);
    if (Object.keys(a).length) return text({ ok: false, refused: `unknown fields: ${Object.keys(a).join(", ")}` }, true);
    try {
      const cfg = loadConfig(path.resolve(o.repo));
      if (!cfg.checkList.length) return text({ ok: true, checks: [], note: "kitchen.yaml has no checks" });
      const r = await runChecks({ jobDir, checks: cfg.checkList, role: o.role, criterion: "-", network: cfg.checks_network });
      return text(
        {
          ok: r.ok,
          sha: r.sha,
          checks: r.results.map((c) => ({ name: c.name, exit: c.exit, ok: c.ok, evidence: c.id, secs: c.secs, sandboxed: c.sandboxed, tail: c.tail })),
        },
        !r.ok,
      );
    } catch (e) {
      if (e instanceof ManifestTampered) return text({ ok: false, refused: e.message }, true);
      return text({ ok: false, error: (e as Error).message }, true);
    }
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
        return reply({ tools: toolsFor(o.role) });
      case "tools/call": {
        const name = msg.params?.name;
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        if (name === "drive") return reply(await drive(args));
        if (name === "toolkit_status") return reply(await status());
        if (name === "checks" && o.role === "builder") return reply(await checks(args));
        if (name === "restart_app" && o.role === "builder") return reply(await restart(args));
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
