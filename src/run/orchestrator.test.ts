// ADR 0025 §2-3: `kitchen run`'s preflight on stand-in binaries (never the real claude), and the wake after a verb.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { loadConfig } from "../config.ts";
import { browserNeeded } from "../qa/app.ts";
import { MIN_CLAUDE, olderThan, preflight, run } from "./orchestrator.ts";
import { wake } from "./wake.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-run-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const standIn = (name: string, body: string) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
};

test("versions compare by number", () => {
  assert.ok(olderThan("2.0.1", MIN_CLAUDE));
  assert.ok(olderThan("2.1.99", "2.1.331"));
  assert.ok(!olderThan("2.1.331", "2.1.331"));
  assert.ok(!olderThan("2.2.0", "2.1.331"));
});

test("preflight: an old claude, a missing binary and a failing one are refused; a new one or a wrapper without a version passes", () => {
  assert.equal(
    preflight([standIn("old", 'echo "2.0.1 (Claude Code)"')]),
    `Claude Code 2.0.1 is older than Kitchen needs (${MIN_CLAUDE}). Update it: claude update`,
  );
  assert.equal(preflight([standIn("new", 'echo "9.0.0 (Claude Code)"')]), null);
  assert.equal(preflight([standIn("plain", "echo hello")]), null);
  assert.match(String(preflight([standIn("bad", "echo nope >&2; exit 3")])), /--version failed \(exit 3\): nope/);
  assert.equal(preflight([path.join(root, "nowhere", "claude")]), `agent.command ${path.join(root, "nowhere", "claude")} not found`);
});

test("kitchen run refuses before starting anything when the tool is too old", async () => {
  const r = path.join(root, "repo");
  fs.mkdirSync(r);
  execFileSync("git", ["-C", r, "init", "-q"]);
  fs.writeFileSync(path.join(r, "kitchen.yaml"), `agent: { command: ["${standIn("old2", 'echo "2.0.1 (Claude Code)"')}"] }\n`);
  const lines: string[] = [];
  const was = process.env.KITCHEN_ORCHESTRATOR;
  delete process.env.KITCHEN_ORCHESTRATOR;
  try {
    assert.equal(await run(r, { detach: true }, (l) => lines.push(l)), 2);
  } finally {
    if (was !== undefined) process.env.KITCHEN_ORCHESTRATOR = was;
  }
  assert.match(lines.join("\n"), /kitchen run: Claude Code 2\.0\.1 is older than Kitchen needs .* Nothing started\./);
  assert.ok(!fs.existsSync(path.join(r, ".kitchen", "run.json")));
});

test("wake: starts one when none works the queue; says so on the verb's line; --no-run and an orchestrator session start nothing", async () => {
  const r = path.join(root, "w");
  fs.mkdirSync(r);
  const was = process.env.KITCHEN_ORCHESTRATOR;
  delete process.env.KITCHEN_ORCHESTRATOR;
  try {
    let started = 0;
    const start = (_r: string, out: (l: string) => void) => {
      started++;
      out("orchestrator detached: pid 1, log x");
      return 0;
    };
    const lines = ['ticket 004  "t"  → intake'];
    await wake(r, lines, { start });
    assert.deepEqual(lines, ['ticket 004  "t"  → intake · Kitchen started']);
    const no = ["x"];
    await wake(r, no, { start, noRun: true });
    assert.match(no[0], /^x · Kitchen not started \(--no-run\)/);
    process.env.KITCHEN_ORCHESTRATOR = "1";
    const inside = ["y"];
    await wake(r, inside, { start });
    assert.deepEqual(inside, ["y · Kitchen is already working the queue"]);
    assert.equal(started, 1);
  } finally {
    if (was === undefined) delete process.env.KITCHEN_ORCHESTRATOR;
    else process.env.KITCHEN_ORCHESTRATOR = was;
  }
});

test("ADR 0029 §5: the session runs in its own group; after its result line, what its agents left running ends with it", async () => {
  const r = path.join(root, "group");
  fs.mkdirSync(r);
  execFileSync("git", ["-C", r, "init", "-q"]);
  // A stand-in session: a lane agent's `npm run dev &` (a sleep), the final result line, then it exits.
  const agent = standIn(
    "session",
    `[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }\nsleep 600 &\necho $! > left.pid\necho '{"type":"result","total_cost_usd":0,"result":"drained"}'`,
  );
  fs.writeFileSync(path.join(r, "kitchen.yaml"), `agent: { command: ["${agent}"] }\n`);
  const lines: string[] = [];
  const was = process.env.KITCHEN_ORCHESTRATOR;
  delete process.env.KITCHEN_ORCHESTRATOR;
  try {
    assert.equal(await run(r, { graceMs: 200 }, (l) => lines.push(l)), 0, lines.join("\n"));
  } finally {
    if (was !== undefined) process.env.KITCHEN_ORCHESTRATOR = was;
  }
  assert.match(lines.join("\n"), /orchestrator finished · \$0\.00: drained/);
  // ADR 0029 §4: no app and no page criterion: the browser isn't needed, so this run never depends on it.
  assert.equal(browserNeeded(r, loadConfig(r)), false);
  const left = Number(fs.readFileSync(path.join(r, "left.pid"), "utf8"));
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(left, 0), "the agent's leftover process is gone");
});
