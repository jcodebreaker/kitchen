// ADR 0009, third check: a steer that arrives while the agent writes its final answer (no tool call left).
// One haiku call, no tools. The steer is written 1.5 s after `init`, while the model is still writing a
// long paragraph. Is it acted on (a second turn, a second `result`), and are `total_cost_usd` and
// `num_turns` in the last result cumulative? stdin stays open until 8 s pass with no event after a result.
// Usage: node spikes/w6-steer/late.mjs [claude-bin]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bin = process.argv[2] ?? "claude";
const cwd = fs.mkdtempSync(path.join(os.homedir(), ".kitchen-steer-late-"));
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6);
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--max-turns", "4"];
args.push("--tools", "", "--setting-sources", "", "--strict-mcp-config");
const p = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "inherit"] });
const user = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
p.stdin.write(user("Write one paragraph of about 250 words on how sourdough bread rises. No headings."));
let quiet = null;
let sent = false;
let buf = "";
p.stdout.setEncoding("utf8");
p.stdout.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const c = e.message?.content;
    const text = Array.isArray(c) ? c.map((x) => (x.type === "text" ? `text(${x.text.length} chars, ends "${x.text.slice(-40)}")` : x.type)).join(" ") : "";
    console.log(
      ms(),
      e.type,
      e.subtype ?? "",
      e.message?.id ?? "",
      text,
      e.type === "result" ? JSON.stringify({ cost: e.total_cost_usd, turns: e.num_turns, result_end: String(e.result).slice(-60) }) : "",
    );
    // Once: every turn starts with its own `system init` (the first run of this spike wrote one per turn and looped).
    if (e.type === "system" && e.subtype === "init" && !sent && (sent = true))
      setTimeout(() => {
        console.log(ms(), ">>> writing steer");
        p.stdin.write(user("Operator note: end your answer with the word PINEAPPLE."));
      }, 1500);
    clearTimeout(quiet);
    if (e.type === "result")
      quiet = setTimeout(() => {
        console.log(ms(), ">>> 8 s quiet after a result: closing stdin");
        p.stdin.end();
      }, 8000);
  }
});
p.on("exit", (code) => {
  console.log(ms(), "exit", code);
  fs.rmSync(cwd, { recursive: true, force: true });
});
