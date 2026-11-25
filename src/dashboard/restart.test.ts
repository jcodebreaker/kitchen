// ADR 0032 §1: `kitchen dashboard --restart` with nothing on the port starts one, and a shared dashboard restarted from
// a folder that isn't a Kitchen repo comes back serving the same list (no repo added, the same KITCHEN_HOME).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { restartDashboard } from "./server.ts";

const CLI = path.resolve(import.meta.dirname, "..", "cli.ts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-restart-"));
const home = path.join(root, "home");
const pids: number[] = [];
afterAll(() => {
  for (const p of pids)
    try {
      process.kill(p, "SIGTERM");
    } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const holder = async (port: number) => {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/kitchen.json`)).json()) as { pid: number; private: boolean; home: string };
  } catch {
    return null;
  }
};

test("nothing on the port: --restart starts a shared dashboard there", async () => {
  const port = await freePort();
  const said: string[] = [];
  const env = process.env.KITCHEN_HOME;
  process.env.KITCHEN_HOME = home;
  try {
    assert.equal(await restartDashboard(root, port, (l) => said.push(l), { cli: CLI, execArgv: [], wait: 15_000 }), 0, said.join("\n"));
  } finally {
    if (env === undefined) delete process.env.KITCHEN_HOME;
    else process.env.KITCHEN_HOME = env;
  }
  const h = await holder(port);
  assert.ok(h, "something answers /kitchen.json");
  pids.push(h.pid);
  assert.equal(h.private, false);
  assert.equal(h.home, home);
  assert.match(said.join("\n"), /^started: http:\/\/127\.0\.0\.1:\d+\//);
}, 30_000);

test("a shared dashboard restarted from a folder with no .kitchen/ comes back on its own list", async () => {
  const port = await freePort();
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, ".kitchen"), { recursive: true });
  const list = path.join(home, "repos.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(list, JSON.stringify({ repos: [{ key: "repo", path: repo }], last: "repo" }));
  const before = fs.readFileSync(list, "utf8");
  const old = spawn(process.execPath, [CLI, "dashboard", "--list-only", "--port", String(port)], {
    cwd: home,
    env: { ...process.env, KITCHEN_HOME: home },
    detached: true,
    stdio: "ignore",
  });
  old.unref();
  pids.push(old.pid as number);
  for (let i = 0; i < 100 && (await holder(port))?.pid !== old.pid; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await holder(port))?.pid, old.pid);
  // Run from elsewhere, and with another KITCHEN_HOME in this process: the holder's home is the one kept.
  const elsewhere = path.join(root, "not-kitchen");
  fs.mkdirSync(elsewhere);
  const said: string[] = [];
  // --private asked of a shared one: it says the running one's mode is kept.
  assert.equal(await restartDashboard(elsewhere, port, (l) => said.push(l), { private: true, cli: CLI, execArgv: [], wait: 15_000 }), 0, said.join("\n"));
  assert.match(said[0], /has a shared dashboard: restarting it as it is \(--private picks the mode only when nothing runs there\)/);
  said.shift();
  const h = await holder(port);
  assert.ok(h && h.pid !== old.pid, "a new process holds the port");
  pids.push(h.pid);
  assert.equal(h.private, false);
  assert.equal(h.home, home);
  assert.equal(fs.readFileSync(list, "utf8"), before, "no repo added to the list");
  assert.match(said.join("\n"), /^restarted: /);
  const repos = (await (await fetch(`http://127.0.0.1:${port}/repos.json`)).json()) as { repos: { key: string }[] };
  assert.deepEqual(
    repos.repos.map((r) => r.key),
    ["repo"],
  );
}, 30_000);

/** A shared dashboard on its own port, from the real CLI (a separate process, as a person's would be). */
async function oldDashboard(port: number) {
  const old = spawn(process.execPath, [CLI, "dashboard", "--list-only", "--port", String(port)], {
    cwd: home,
    env: { ...process.env, KITCHEN_HOME: home },
    detached: true,
    stdio: "ignore",
  });
  old.unref();
  pids.push(old.pid as number);
  for (let i = 0; i < 100 && (await holder(port))?.pid !== old.pid; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await holder(port))?.pid, old.pid);
  return old.pid as number;
}

test("a build whose dashboard doesn't load: the running dashboard is left alone", async () => {
  const port = await freePort();
  const old = await oldDashboard(port);
  // Answers --version like a Kitchen, but its dashboard can't start.
  const broken = path.join(root, "broken-cli.mjs");
  fs.writeFileSync(
    broken,
    'if (process.argv.includes("--version")) { console.log("0.1.0"); } else { console.error("Cannot find module dist/dashboard/server.js"); process.exit(1); }\n',
  );
  const said: string[] = [];
  assert.equal(await restartDashboard(root, port, (l) => said.push(l), { cli: broken, execArgv: [], wait: 5000 }), 1);
  assert.match(said.join("\n"), /dashboard doesn't start \(Cannot find module dist\/dashboard\/server\.js\): nothing was stopped/);
  assert.equal((await holder(port))?.pid, old, "the old dashboard still serves the port");
}, 30_000);

test("a pid that isn't the one listening on the port is never stopped", async () => {
  const sleeper = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  sleeper.unref();
  pids.push(sleeper.pid as number);
  // Something on the port says it is a Kitchen dashboard run by another process.
  const fake = http.createServer((_q, s) => s.end(JSON.stringify({ kitchen: true, private: false, pid: sleeper.pid, home })));
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const port = (fake.address() as net.AddressInfo).port;
  try {
    const said: string[] = [];
    assert.equal(await restartDashboard(root, port, (l) => said.push(l), { cli: CLI, execArgv: [], wait: 3000 }), 1);
    assert.match(said.join("\n"), new RegExp(`says pid ${sleeper.pid} serves it, but pid ${process.pid} listens there.*nothing was stopped`));
    process.kill(sleeper.pid as number, 0); // still alive: throws otherwise
  } finally {
    fake.close();
  }
}, 30_000);
