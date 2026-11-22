// ADR 0009, second check: Kitchen's own ClaudeAdapter (stream-json both ways) on a real `claude -p`,
// with the scrubbed env, the sandbox settings and a steer inbox. One haiku call. The steer is queued
// once the agent's first tool call shows in the stream; the run must answer it, mark it read, write
// its out file, and return cost and turns from the result line.
//   npx tsx spikes/w6-steer/adapter.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../../src/agents/claude.ts";
import { buildAgentEnv } from "../../src/agents/env.ts";
import { claudeBin } from "../../src/agents/find-bin.ts";
import { kitchenHome } from "../../src/home.ts";

const cwd = fs.mkdtempSync(path.join(os.homedir(), ".kitchen-steer-adapter-"));
const streamFile = path.join(cwd, "..", `${path.basename(cwd)}.jsonl`);
const queue: { id: string; text: string }[] = [];
const read: string[] = [];
const t0 = Date.now();
const watch = setInterval(() => {
  if (queue.length || !fs.existsSync(streamFile)) return;
  if (fs.readFileSync(streamFile, "utf8").includes('"tool_use"')) {
    console.log(`${Date.now() - t0}ms  queue steer m1`);
    queue.push({ id: "m1", text: "Operator note: also put the word PINEAPPLE on the second line of the file." });
  }
}, 100);
const r = await new ClaudeAdapter(claudeBin()).run({
  role: "builder",
  prompt: "Run the Bash command `sleep 6 && echo slept`. Then write the out file with the single line: done.",
  cwd,
  model: "haiku",
  tier: "write",
  timeoutSec: 120,
  maxTurns: 8,
  outFile: "spike.md",
  env: buildAgentEnv(path.join(kitchenHome(), "agent-scrub")),
  streamFile,
  steer: {
    take: () => queue.filter((m) => !read.includes(m.id)),
    read: (ids) => {
      console.log(`${Date.now() - t0}ms  read ${ids.join(",")}`);
      read.push(...ids);
    },
  },
});
clearInterval(watch);
const out = r.outPath ? fs.readFileSync(r.outPath, "utf8") : "(none)";
console.log(JSON.stringify({ ok: r.ok, line: r.line, usage: r.usage, sessionId: r.sessionId, error: r.error, read, out }, null, 2));
console.log(`${fs.readFileSync(streamFile, "utf8").trim().split("\n").length} stream events`);
fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(streamFile, { force: true });
