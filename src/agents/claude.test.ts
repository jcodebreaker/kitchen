// The Claude adapter in stream-json (ADR 0009): a stand-in `claude` that behaves like the spike
// (spikes/w6-steer): it waits on stdin, takes a user message written while its "tool call" runs,
// answers it in the same turn, prints one result, and exits when stdin closes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { AgentRequest } from "./adapter.ts";
import { ANSWER_GRACE_MS, ClaudeAdapter, ClaudeStream, claudeArgs, userLine } from "./claude.ts";

const FAKE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "", msgs = [];
process.stdin.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 20));
const said = () => msgs.map((m) => m.message.content[0].text);
setTimeout(() => {
  if (process.env.FAKE_MODE === "junk") { console.log("Error: not logged in"); process.exit(1); }
  out({ type: "system", subtype: "init" });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 1" } }] } });
  setTimeout(() => {
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "heard: " + said().slice(1).join(" | ") }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "done\\nheard " + (said().length - 1), session_id: "s-1", total_cost_usd: 0.0123, num_turns: 2, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } });
  }, 900);
}, 50);
`;

let dir = "";
let bin = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-claude-"));
  bin = path.join(dir, "claude");
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const req = (o: Partial<AgentRequest> = {}): AgentRequest => ({
  role: "builder",
  prompt: "Build it.",
  cwd: dir,
  model: "haiku",
  tier: "write",
  timeoutSec: 30,
  maxTurns: 10,
  outFile: "build.md",
  env: { PATH: process.env.PATH ?? "", HOME: dir },
  ...o,
});

test("claude runs in stream-json both ways", () => {
  const a = claudeArgs(req(), "sid");
  assert.ok(a.join(" ").includes("--input-format stream-json --output-format stream-json --verbose"));
});

test("a message written while the agent runs is taken in the same turn; cost, turns and session still read from the result", async () => {
  const queue = [{ id: "m1", text: "keep the diff small" }];
  const read: string[] = [];
  const streamFile = path.join(dir, "activity", "run.jsonl");
  let taken = false;
  const r = await new ClaudeAdapter(bin).run(
    req({
      streamFile,
      steer: {
        take: () => (taken ? [] : queue),
        read: (ids) => {
          taken = true;
          read.push(...ids);
        },
      },
    }),
  );
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(read, ["m1"], "answered after it was written");
  assert.equal(r.line, "heard 1");
  assert.equal(r.sessionId, "s-1");
  assert.deepEqual(r.usage, { usd: 0.0123, inTok: 110, outTok: 5 });
  const events = fs
    .readFileSync(streamFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(
    events.every((e) => typeof e._t === "string"),
    "every event is stamped",
  );
  assert.equal(events.at(-1).type, "result");
  assert.match(JSON.stringify(events), /heard: .*keep the diff small/, "the stand-in saw the message");
});

test("without a result, the error is the agent's own line (rate limits still read from it)", async () => {
  const r = await new ClaudeAdapter(bin).run(req({ env: { PATH: process.env.PATH ?? "", HOME: dir, FAKE_MODE: "junk" } }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "Error: not logged in");
});

const ev = (o: object) => JSON.stringify(o);
const asst = (id: string) => ev({ type: "assistant", message: { id, content: [{ type: "text", text: "…" }] } });

test("a message written during a tool call is answered by the first assistant event after the tool result", () => {
  const s = new ClaudeStream();
  s.line(asst("A"), 0); // tool_use
  s.wrote("m1");
  assert.deepEqual(s.line(asst("A"), 10), [], "another block of the message it arrived during: not answered");
  s.line(ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }), 20);
  assert.deepEqual(s.line(asst("B"), 30), ["m1"]);
  s.line(ev({ type: "result", subtype: "success", num_turns: 2, total_cost_usd: 0.01 }), 40);
  assert.equal(s.canClose(41), true);
});

test("a message written during the final answer gets its own turn: stdin stays open for it, turns and tokens add up (spikes/w6-steer/late.mjs)", () => {
  const s = new ClaudeStream();
  s.line(ev({ type: "system", subtype: "init" }), 0);
  s.wrote("m1"); // the model is writing its answer
  assert.deepEqual(s.line(asst("A"), 10), [], "the answer it arrived during never saw it");
  s.line(ev({ type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0.0009, usage: { input_tokens: 10, output_tokens: 300 } }), 20);
  assert.equal(s.canClose(30), false, "m1 waits for its turn");
  s.line(ev({ type: "system", subtype: "init" }), 330); // Claude Code starts a turn for the queued message
  assert.equal(s.canClose(6000), false, "that turn is running: the grace no longer applies");
  assert.deepEqual(s.line(asst("B"), 1000), ["m1"]);
  s.line(ev({ type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0.0014, usage: { input_tokens: 12, output_tokens: 310 } }), 1300);
  assert.equal(s.canClose(1301), true);
  assert.equal(s.final?.num_turns, 2, "num_turns is per turn: summed");
  assert.equal(s.final?.total_cost_usd, 0.0014, "total_cost_usd is already cumulative: the last one");
  assert.deepEqual([s.final?.usage?.input_tokens, s.final?.usage?.output_tokens], [22, 610]);
});

test("a written message no turn takes: stdin closes after the grace, the message stays unread", () => {
  const s = new ClaudeStream();
  s.line(asst("A"), 0);
  s.line(ev({ type: "result", subtype: "success" }), 10);
  s.wrote("m2");
  assert.equal(s.canClose(100), false);
  assert.equal(s.canClose(ANSWER_GRACE_MS + 11), true);
  assert.equal(userLine("hi").trim(), JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }));
});
