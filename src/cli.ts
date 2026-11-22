#!/usr/bin/env node
// `kitchen` entry point (PLAN §4). Runs in the repo it is started in (or --repo <dir>).
//   kitchen ticket "<text>"
//   kitchen run [--once] [--detach] [<job>]
//   kitchen status
//   kitchen resume <id|n> · feedback <id> [--to <stage>] ["<text>"] · reject <id>
//   kitchen report
//   kitchen init [--answers <file>] [--tool claude|codex] [--detach] · init --status  ·  kitchen toolkit check [--feature x] [--src dir] · toolkit up · toolkit down --id <id>   (src/cli/toolkit-commands.ts)
//   kitchen mcp --job <id> --role <role> [--repo <dir>]   the engine bridge (src/bridge/mcp.ts)
import path from "node:path";
import { serveBridge } from "./bridge/mcp.ts";
import * as cmd from "./cli/commands.ts";

const USAGE =
  'usage: kitchen ticket "<text>" | run [--once] [--detach] [<job>] | status | resume <id|n> | feedback <id> [--to <stage>] ["<text>"] | reject <id> | report | init [--answers <file>] [--detach] | init --status | toolkit check [--feature x] [--src dir] | toolkit up [--rev r] | toolkit down --id <id> | mcp …';

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "toolkit" || name === "init" || name === "setup-mcp") return (await import("./cli/toolkit-commands.ts")).w2(name, rest);
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
  const pos: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--repo") repo = rest[++i] ?? repo;
    else if (rest[i] === "--to" && name === "feedback") to = rest[++i];
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
      return cmd.report(repo, out);
    default:
      console.error(USAGE);
      return 2;
  }
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
