#!/usr/bin/env node
// `kitchen` entry point (PLAN §4). Runs in the repo it is started in (or --repo <dir>).
//   kitchen ticket "<text>"
//   kitchen run [--once] [--detach] [<job>]
//   kitchen status
//   kitchen resume <id|n> · feedback <id> [--to <stage>] ["<text>"] · reject <id>
//   kitchen report [--bench]
//   kitchen bench smoke|full|tuned|heldout [--tool claude|codex] [--runs n] [--only a,b] [--concurrency n] [--max-usd x] [--out dir]   (src/bench/run.ts)
//   kitchen init [--answers <file>] [--tool claude|codex] [--detach] · init --status  ·  kitchen toolkit check [--feature x] [--src dir] · toolkit up · toolkit down --id <id>   (src/cli/toolkit-commands.ts)
//   kitchen drive <job> <C> [--repro] [--arg k=v]… [--role r]   one criterion's proof (src/proof/prove.ts)
//   kitchen drive <job> --view "<view>" [--role reviewer-ux]     one extra view for a UX/UI lens (src/engine/views.ts)
//   kitchen dismiss <job> <finding-id> [--reason "<why>"]        a review finding was not useful (ledger, per lens)
//   kitchen toolkit maintain [--force]                           pstack's maintain pass (src/toolkit/maintain.ts)
//   kitchen mcp --job <id> --role <role> [--repo <dir>]   the engine bridge (src/bridge/mcp.ts)
import path from "node:path";
import { serveBridge } from "./bridge/mcp.ts";
import * as cmd from "./cli/commands.ts";

const USAGE =
  'usage: kitchen ticket "<text>" | run [--once] [--detach] [<job>] | status | resume <id|n> | feedback <id> [--to <stage>] ["<text>"] | reject <id> | report [--bench] | bench smoke|full|tuned|heldout […] | init [--answers <file>] [--detach] | init --status [--wait <s>] | toolkit check [--feature x] [--src dir] | toolkit up | toolkit down --id <id> | drive <job> <C> [--repro] [--arg k=v]… | drive <job> --view "<view>" | dismiss <job> <finding> [--reason "<why>"] | toolkit maintain [--force] | mcp …';

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "toolkit" || name === "init" || name === "setup-mcp") return (await import("./cli/toolkit-commands.ts")).w2(name, rest);
  if (name === "bench") return bench(rest);
  if (name === "mcp") {
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i]?.replace(/^--/, "");
      if (!k || rest[i + 1] === undefined || k in flags) throw new Error("usage: kitchen mcp --job <id> --role <role> [--repo <dir>]");
      flags[k] = rest[i + 1];
    }
    if (!flags.job || !flags.role) throw new Error("kitchen mcp needs --job and --role");
    await serveBridge({ job: flags.job, role: flags.role, repo: flags.repo ?? process.cwd() });
    return 0;
  }
  let repo = process.cwd();
  let to: string | undefined;
  const driveArgs: Record<string, string> = {};
  let role = "operator";
  let viewArg: string | undefined;
  let reason: string | undefined;
  const pos: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--repo") repo = rest[++i] ?? repo;
    else if (rest[i] === "--to" && name === "feedback") to = rest[++i];
    else if (rest[i] === "--arg" && name === "drive") {
      const kv = rest[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq < 1) throw new Error(`--arg takes name=value, got ${kv}`);
      driveArgs[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (rest[i] === "--role" && name === "drive") role = rest[++i] ?? role;
    else if (rest[i] === "--view" && name === "drive") viewArg = rest[++i];
    else if (rest[i] === "--reason" && name === "dismiss") reason = rest[++i];
    else if (rest[i].startsWith("--")) flags.add(rest[i]);
    else pos.push(rest[i]);
  }
  repo = path.resolve(repo);
  const out = (l: string) => console.log(l);
  const need = (what: string) => {
    if (!pos[0]) throw new Error(`kitchen ${name} needs ${what}`);
    return pos[0];
  };
  switch (name) {
    case "ticket":
      return cmd.ticket(repo, need('"<text>"'), out);
    case "run":
      for (const f of flags) if (f !== "--once" && f !== "--detach") throw new Error(`kitchen run: unknown flag ${f}`);
      return cmd.run(repo, { once: flags.has("--once"), detach: flags.has("--detach"), job: pos[0], cli: import.meta.filename, argv }, out);
    case "status":
      return cmd.status(repo, out);
    case "resume":
      return cmd.resume(repo, need("<id|n>"), out);
    case "feedback":
      return cmd.feedback(repo, need("<id>"), pos.slice(1).join(" "), out, { to });
    case "reject":
      return cmd.reject(repo, need("<id>"), out);
    case "report":
      if (flags.has("--bench")) {
        for (const l of (await import("./bench/run.ts")).benchReport(repo)) out(l);
        return 0;
      }
      return cmd.report(repo, out);
    case "dismiss":
      if (!pos[1]) throw new Error('kitchen dismiss needs <job> <finding-id> [--reason "<why>"]');
      return cmd.dismiss(repo, need("<job>"), pos[1], reason, out);
    case "drive":
      if (viewArg !== undefined) {
        if (!viewArg.trim()) throw new Error('kitchen drive --view needs a view: "/path [--as user]", a feature drive, or toolkit segments');
        return cmd.view(repo, need("<job>"), viewArg, role === "operator" ? "reviewer-operator" : role, out);
      }
      for (const f of flags) if (f !== "--repro") throw new Error(`kitchen drive: unknown flag ${f}`);
      if (!pos[1]) throw new Error("kitchen drive needs <job> <criterion>");
      return cmd.drive(repo, need("<job>"), pos[1], { repro: flags.has("--repro"), args: driveArgs, role }, out);
    default:
      console.error(USAGE);
      return 2;
  }
}

async function bench(rest: string[]): Promise<number> {
  const tier = rest[0];
  if (!["smoke", "full", "tuned", "heldout"].includes(tier ?? ""))
    throw new Error("usage: kitchen bench smoke|full|tuned|heldout [--tool claude|codex] [--runs n] [--only a,b] [--concurrency n] [--max-usd x] [--out dir]");
  const f: Record<string, string> = {};
  for (let i = 1; i < rest.length; i += 2) {
    const k = rest[i]?.replace(/^--/, "");
    if (!k || rest[i + 1] === undefined || !["tool", "runs", "only", "concurrency", "max-usd", "out"].includes(k))
      throw new Error(`kitchen bench: bad flag ${rest[i]}`);
    f[k] = rest[i + 1];
  }
  const tool = (f.tool ?? "claude") as "claude" | "codex";
  if (tool !== "claude" && tool !== "codex") throw new Error("--tool is claude or codex");
  const { runBench } = await import("./bench/run.ts");
  const kitchenRoot = path.resolve(import.meta.dirname, "..");
  const r = await runBench({
    kitchenRoot,
    tier: tier as "smoke" | "full" | "tuned" | "heldout",
    tool,
    runs: Number(f.runs ?? (tier === "smoke" ? 1 : 3)),
    only: f.only?.split(",").filter(Boolean),
    concurrency: Number(f.concurrency ?? 2),
    maxUsd: Number(f["max-usd"] ?? 25),
    out: path.resolve(f.out ?? path.join(kitchenRoot, "bench", ".work", `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${tier}`)),
    ledgerRepo: process.cwd(),
    print: (l) => console.log(l),
  });
  return r.results.every((x) => x.correct) ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`kitchen: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
