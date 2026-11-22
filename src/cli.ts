#!/usr/bin/env node
// `kitchen` entry point. W1 brings the rest of PLAN §4; for now:
//   kitchen mcp --job <id> --role <role> [--repo <dir>]   the engine bridge (src/bridge/mcp.ts)
import { serveBridge } from "./bridge/mcp.ts";

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd === "mcp") {
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i]?.replace(/^--/, "");
      if (!k || rest[i + 1] === undefined || k in flags) throw new Error("usage: kitchen mcp --job <id> --role <role> [--repo <dir>]");
      flags[k] = rest[i + 1];
    }
    if (!flags.job || !flags.role) throw new Error("kitchen mcp needs --job and --role");
    return serveBridge({ job: flags.job, role: flags.role, repo: flags.repo ?? process.cwd() });
  }
  console.error("kitchen 0.0.0: only `kitchen mcp` exists so far (W1 adds the rest)");
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`kitchen: ${(e as Error).message}`);
  process.exitCode = 1;
});
