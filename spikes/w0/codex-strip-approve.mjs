#!/usr/bin/env node
// Control for the Codex MCP approval setting: runs Codex with the adapter's args
// minus `mcp_servers.kitchen.default_tools_approval_mode="approve"`.
//   node codex-strip-approve.mjs <codex args…>
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const kept = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-c" && args[i + 1]?.startsWith("mcp_servers.kitchen.default_tools_approval_mode")) {
    i++;
    continue;
  }
  kept.push(args[i]);
}
const p = spawn("npx", ["-y", "@openai/codex@0.171.0", ...kept], { stdio: "inherit" });
p.on("close", (code) => process.exit(code ?? 1));
