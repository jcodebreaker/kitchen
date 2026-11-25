// ADR 0029 §5: an agent session in its own process group, ended after its final line, whatever it left running.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { finalLine, runAgentSession } from "./session.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-session-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const agent = (name: string, body: string) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the final line: claude's result, codex exec's turn events; nothing else", () => {
  assert.ok(finalLine('{"type":"result","result":"done"}'));
  assert.ok(finalLine('{"type":"turn.completed"}'));
  assert.ok(finalLine('{"type":"turn.failed"}'));
  assert.ok(!finalLine('{"type":"assistant"}'));
  assert.ok(!finalLine("result"));
});

test("a session that sends its result and doesn't exit is ended after the grace, with what it left running", async () => {
  // A lane agent's `npm run dev &` (the sleep in the background), then the result, and the session hangs on.
  const a = agent("hangs", `sleep 600 &\necho $! > "${root}/left.pid"\necho '{"type":"result","result":"done"}'\nsleep 600`);
  const lines: string[] = [];
  let pid = 0;
  const t0 = Date.now();
  const r = await runAgentSession([a], { cwd: root, graceMs: 300, onStart: (p) => (pid = p), onLine: (l) => lines.push(l) });
  assert.ok(Date.now() - t0 < 5000, "ended after the grace, not after the sleep");
  assert.deepEqual(lines, ['{"type":"result","result":"done"}']);
  assert.equal(r.code, 0, "it had finished: ending it is no failure");
  const left = Number(fs.readFileSync(path.join(root, "left.pid"), "utf8"));
  assert.ok(!alive(pid), "the session is gone");
  assert.ok(!alive(left), "and what it left running");
});

test("a session that exits leaves nothing behind; one that crashes keeps its exit code; a missing binary is an error", async () => {
  const a = agent("exits", `sleep 600 > /dev/null 2>&1 &\necho $! > "${root}/left2.pid"\nexit 3`);
  const r = await runAgentSession([a], { cwd: root, graceMs: 300 });
  assert.equal(r.code, 3);
  assert.ok(!alive(Number(fs.readFileSync(path.join(root, "left2.pid"), "utf8"))), "its background process went with it");
  const no = await runAgentSession([path.join(root, "nowhere")], { cwd: root });
  assert.equal(no.code, 127);
  assert.match(String(no.error), /ENOENT/);
});

test("a final result that says it failed stays a failure when the session is ended after the grace", async () => {
  const a = agent("fails", `echo '{"type":"result","is_error":true,"subtype":"error_max_turns"}'\nsleep 600`);
  const r = await runAgentSession([a], { cwd: root, graceMs: 200 });
  assert.notEqual(r.code, 0);
});

test("a closed terminal (SIGHUP) ends the session's group, then Kitchen itself", async () => {
  const { spawn } = await import("node:child_process");
  const a = agent("long", `sleep 600 &\necho $! > "${root}/hup.pid"\necho started\nsleep 600`);
  const driver = path.join(root, "driver.mts");
  fs.writeFileSync(
    driver,
    `import { runAgentSession } from ${JSON.stringify(path.resolve(import.meta.dirname, "session.ts"))};\nawait runAgentSession([${JSON.stringify(a)}], { cwd: ${JSON.stringify(root)}, onStart: (p) => console.log("agent " + p) });\nconsole.log("returned");\n`,
  );
  const tsx = path.resolve(import.meta.dirname, "..", "..", "node_modules", "tsx", "dist", "loader.mjs");
  const k = spawn(process.execPath, ["--import", tsx, driver], { stdio: ["ignore", "pipe", "inherit"] });
  let said = "";
  k.stdout.on("data", (d: Buffer) => {
    said += d.toString();
  });
  const pidFile = path.join(root, "hup.pid");
  for (let i = 0; i < 100 && !(fs.existsSync(pidFile) && /agent \d+/.test(said)); i++) await new Promise((r) => setTimeout(r, 100));
  const agentPid = Number(/agent (\d+)/.exec(said)?.[1]);
  const left = Number(fs.readFileSync(pidFile, "utf8"));
  k.kill("SIGHUP");
  const [code, sig] = await new Promise<[number | null, string | null]>((res) => k.on("exit", (c, s) => res([c, s])));
  assert.deepEqual([code, sig], [null, "SIGHUP"], "Kitchen exits on the signal, after the group");
  assert.ok(!said.includes("returned"), "it didn't carry on");
  assert.ok(!alive(agentPid) && !alive(left), "the session and what it left are gone");
});
