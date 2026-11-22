// A stand-in for the `claude` binary (KITCHEN_CLAUDE_BIN) for the kill spike: a
// real subprocess that the Claude adapter starts like the real one. It reads
// the prompt on stdin, finds its out file in the contract footer, and does what
// the scripted fake agent (fake-script.ts) would do for that role, including
// hanging until killed. It prints Claude's JSON result line.
//
// Each run logs `start <pid> <file> overlap=<pids>` and `done <pid> <file>` to
// <repo>/.kitchen/stub-agents.log; `overlap` lists earlier runs still alive when
// this one started (there must never be one for the same job).
import fs from "node:fs";
import path from "node:path";
import type { AgentRequest } from "../../src/agents/adapter.ts";
import script from "./fake-script.ts";

const keep = setInterval(() => {}, 1 << 30); // a hung step must keep this process alive
const prompt = fs.readFileSync(0, "utf8");
const out = /Write your output file to (\S+) \(create/.exec(prompt)?.[1];
const role = /You are Kitchen's (\S+) role/.exec(prompt)?.[1] ?? "?";
if (!out) throw new Error("no out file in the prompt");
const cwd = process.cwd();
const sep = `${path.sep}.worktrees${path.sep}`;
const repo = cwd.includes(sep) ? cwd.slice(0, cwd.indexOf(sep)) : cwd;
process.env.KITCHEN_FAKE_STATE = path.join(repo, ".kitchen", "fake-state.json");
const log = path.join(repo, ".kitchen", "stub-agents.log");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const prior = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
const open = [...prior.matchAll(/^start (\d+) /gm)].map((m) => Number(m[1])).filter((p) => !new RegExp(`^done ${p} `, "m").test(prior));
const file = path.basename(out);
fs.appendFileSync(log, `start ${process.pid} ${file} overlap=${open.filter(alive).join(",")}\n`);

const req = { role, prompt, cwd, outFile: file, outDir: path.dirname(out), tier: "write", model: "stub", env: {}, timeoutSec: 0, maxTurns: 0 } as AgentRequest;
const step = await script(req);
if (step.file !== undefined) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, step.file);
}
fs.appendFileSync(log, `done ${process.pid} ${file}\n`);
const ok = step.ok !== false;
process.stdout.write(
  `${JSON.stringify({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: step.line, session_id: `stub-${process.pid}`, total_cost_usd: 0, usage: {} })}\n`,
);
clearInterval(keep);
