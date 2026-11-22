// ADR 0009 spike: how does `claude -p --input-format stream-json` take a user message sent mid-run?
// One haiku call. The first message asks for a slow Bash call; a second message is written to stdin
// while that call runs. Every stdout event is printed with the ms since start. stdin stays open
// until a `result` arrives with no further activity within 4s, then closes.
// Usage: node spikes/w6-steer/spike.mjs [claude-bin]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bin = process.argv[2] ?? "claude";
const cwd = fs.mkdtempSync(path.join(os.homedir(), ".kitchen-steer-spike-"));
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6);
const args = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--model",
  "haiku",
  "--max-turns",
  "6",
  "--tools",
  "Bash",
  "--permission-mode",
  "acceptEdits",
  "--allowedTools",
  "Bash",
  "--setting-sources",
  "",
  "--strict-mcp-config",
];
const p = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "inherit"] });
const user = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
p.stdin.write(user("Run exactly this Bash command: `sleep 8; echo first-done`. Then reply with one short line."));
let sent = false;
let results = 0;
let closeT = null;
let buf = "";
const brief = (c) =>
  Array.isArray(c)
    ? c
        .map((x) =>
          x.type === "text"
            ? `text:${x.text.slice(0, 120)}`
            : x.type === "tool_use"
              ? `tool_use:${JSON.stringify(x.input).slice(0, 80)}`
              : x.type === "tool_result"
                ? `tool_result:${String(typeof x.content === "string" ? x.content : JSON.stringify(x.content)).slice(0, 80)}`
                : x.type,
        )
        .join(" | ")
    : typeof c === "string"
      ? `str:${c.slice(0, 120)}`
      : "";
p.stdout.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      console.log(ms(), "RAW", line.slice(0, 200));
      continue;
    }
    const c = e.message?.content;
    const extra =
      e.type === "result" ? JSON.stringify({ cost: e.total_cost_usd, turns: e.num_turns, sub: e.subtype, result: e.result, session: e.session_id }) : "";
    console.log(ms(), e.type, e.subtype ?? "", brief(c), extra);
    if (!sent && Array.isArray(c) && c.some((x) => x.type === "tool_use")) {
      sent = true;
      setTimeout(() => {
        console.log(ms(), ">>> writing steer message");
        p.stdin.write(user("Operator note: also include the word PINEAPPLE in your final reply."));
      }, 1500);
    }
    if (e.type === "result") {
      results++;
      clearTimeout(closeT);
      closeT = setTimeout(() => {
        console.log(ms(), `>>> closing stdin after ${results} result(s)`);
        p.stdin.end();
      }, 4000);
    } else if (closeT) {
      clearTimeout(closeT);
      closeT = null;
      console.log(ms(), ">>> new activity after a result: stdin kept open");
    }
  }
});
p.on("exit", (code, sig) => {
  console.log(ms(), "exit", code, sig);
  fs.rmSync(cwd, { recursive: true, force: true });
});
