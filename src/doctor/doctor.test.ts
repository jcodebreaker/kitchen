// ADR 0033 against a real (tiny) app: kitchen doctor's requires and app lifecycle rows on a throwaway checkout, the
// run preflight's refusal, and `kitchen qa scenario` / `whoami` saving their evidence.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { loadConfig, parseConfig } from "../config.ts";
import * as control from "../engine/control.ts";
import { setupLine } from "../engine/jobs.ts";
import { qaDir } from "../engine/lanes.ts";
import { findJob, jobDirOf } from "../engine/store.ts";
import { processStart } from "../lock.ts";
import { appDown, appUp, doctorAppFile } from "../qa/app.ts";
import { jsonOut, scenario, whoami } from "../qa/scenario.ts";
import { appRows, doctorLines, doctorReport, requiresRefusal } from "./doctor.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-doctor-"));
const lines: string[] = [];
const out = (l: string) => lines.push(l);
let id = "";
const g = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...a]);

const SRV = `import http from "node:http";
import fs from "node:fs";
const db = () => { try { return JSON.parse(fs.readFileSync("data.json", "utf8")); } catch { return { offers: [] }; } };
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return res.end("{}");
  if (req.url === "/api/me") return res.end(JSON.stringify({ user: req.headers["x-member"] ?? "guest", role: req.headers["x-member"] === "ana" ? "member" : "guest" }));
  if (req.url?.startsWith("/api/offers")) return res.end(JSON.stringify(db().offers));
  res.end("{}");
}).listen(Number(process.env.PORT));
`;
const SCENARIO = `const o = { offers: [{ id: 41, state: "pending", to: "ana" }] };
require("node:fs").writeFileSync("data.json", JSON.stringify(o));
console.error("seeded through the data file");
console.log(JSON.stringify({ offer: 41, as: "ana", url: process.env.BASE_URL }));
`;

beforeAll(async () => {
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "srv.mjs"), SRV);
  fs.writeFileSync(path.join(root, "scenario.cjs"), SCENARIO);
  fs.writeFileSync(path.join(root, ".gitignore"), ".kitchen/\ndata.json\n");
  fs.writeFileSync(
    path.join(root, "kitchen.yaml"),
    [
      'app: { start: "node srv.mjs", health: "/health", reset: "rm -f data.json", whoami: /api/me, scenarios: { offer-pending: "node scenario.cjs", broken: "echo not json" } }',
      "requires:",
      '  - { name: node, check: "node --version" }',
      '  - { name: proxy, check: "test -e proxy.sock", fix: "start the proxy: ./proxy.sh" }',
      "",
    ].join("\n"),
  );
  g("add", "-A");
  g("commit", "-qm", "base");
  await control.ticket(root, "accept an offer", () => {});
  id = findJob(root, "1").id;
  const f = path.join(jobDirOf(root, id), "job.json");
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), stage: "qa", worktree: root }));
});
afterAll(async () => {
  await appDown(root, id);
  fs.rmSync(root, { recursive: true, force: true });
});

test("kitchen.yaml: scenarios, whoami and requires; a bad scenario name is refused", () => {
  const c = parseConfig('app: { start: "x", scenarios: { a-1: "echo {}" }, whoami: "/me" }\nrequires: [{ name: venv, check: "true" }]\n');
  assert.deepEqual([c.app.scenarios, c.app.whoami, c.requires], [{ "a-1": "echo {}" }, "/me", [{ name: "venv", check: "true", fix: "" }]]);
  assert.throws(() => parseConfig('app: { scenarios: { "../x": "y" } }\n'), /scenario's name/);
  assert.deepEqual([parseConfig("").app.scenarios, parseConfig("").requires], [{}, []]);
  assert.equal(setupLine(parseConfig("")), "");
  assert.match(setupLine(c), /scenarios .*: `a-1`; who you are: `kitchen qa whoami <id>/);
  assert.deepEqual(jsonOut('noise\n{"a":1}\n'), { a: 1 });
  assert.equal(jsonOut("not json"), null);
});

/** A reset that reaches data outside the worktree: the sentinel stands for the person's local database. */
const sentinel = path.join(path.dirname(root), `${path.basename(root)}-local-db.txt`);
const withReset = (cfg: ReturnType<typeof loadConfig>) => ({ ...cfg, app: { ...cfg.app, reset: `echo wiped > ${sentinel}` } });
afterAll(() => fs.rmSync(sentinel, { force: true }));
const states = (r: { rows: { what: string; state: string }[] }) => Object.fromEntries(r.rows.map((x) => [x.what, x.state]));

test("doctor: by default nothing of the app runs; --app tries prepare/start/health/stop; only --reset runs the reset", async () => {
  fs.writeFileSync(sentinel, "my local data\n");
  const cfg = withReset(loadConfig(root));
  const plain = await doctorReport(root, cfg);
  const p = states(plain);
  assert.deepEqual(
    [p["requires node"], p["requires proxy"], p.reset, p.start, p.health, p.stop],
    ["ok", "failing", "not tried", "not tried", "not tried", "not tried"],
  );
  const text = doctorLines(plain).join("\n");
  assert.match(text, /not tried\s+start\s+node srv\.mjs \(kitchen doctor --app tries prepare\/start\/health\/stop\)/);
  assert.match(text, /not tried\s+reset\s+echo wiped .* \(kitchen doctor --reset runs it: it may wipe the data your local app uses\)/);
  assert.match(text, /failing\s+requires proxy\s+`test -e proxy.sock` exit 1\n\s+fix: start the proxy: \.\/proxy\.sh/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "my local data\n");
  const app = await doctorReport(root, cfg, { app: true });
  const a = states(app);
  assert.deepEqual([a.reset, a.start, a.health, a.stop], ["not tried", "ok", "ok", "ok"], doctorLines(app).join("\n"));
  assert.equal(fs.readFileSync(sentinel, "utf8"), "my local data\n", "--app never resets");
  assert.ok(!fs.existsSync(path.join(root, ".kitchen", "doctor", "wt")), "the throwaway checkout is gone");
  assert.ok(!fs.existsSync(doctorAppFile(root)), "nothing left running");
  assert.ok(!fs.existsSync(path.join(root, "data.json")), "the person's checkout untouched");
  const y = await doctorReport(root, cfg, { reset: true });
  assert.deepEqual([states(y).reset, states(y).start], ["ok", "ok"]);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "wiped\n");
  // init: requires and what kitchen.yaml says, as "set".
  fs.writeFileSync(sentinel, "my local data\n");
  const i = await doctorReport(root, cfg, { init: true });
  assert.deepEqual(
    i.rows.filter((x) => !x.what.startsWith("requires") && x.what !== "browser").map((x) => `${x.what} ${x.state}`),
    ["reset set", "start set", "health set", "stop set", "scenarios set", "whoami set"],
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "my local data\n");
  assert.equal(await requiresRefusal(root, cfg), "proxy isn't ready (`test -e proxy.sock` exit 1): start the proxy: ./proxy.sh");
});

test("doctor --app: failing start, failing health, failing reset; a fixed port answering on :: is left alone (doctor and qa up)", async () => {
  const cfg = loadConfig(root);
  const log = path.join(root, ".kitchen", "doctor", "t.log");
  const rows = async (a: object, o: { reset?: boolean } = {}) =>
    Object.fromEntries((await appRows(root, { ...cfg, app: { ...cfg.app, ...a } }, log, o)).map((x) => [x.what, x]));
  const a = await rows({ reset: undefined, start: "exit 3" });
  assert.deepEqual([a.reset.state, a.start.state, a.health.state, a.stop.state], ["missing", "failing", "not tried", "not tried"]);
  assert.match(a.start.detail, /app.start exited \(exit 3\)/);
  const b = await rows({ health: "/nope", ready_timeout_sec: 1, url: "http://127.0.0.2:{port}" });
  assert.equal(b.health.state, "failing");
  assert.match(b.health.detail, /not healthy at http:\/\/127\.0\.0\.2:\d+\/nope/);
  const c = await rows({ reset: "exit 2" }, { reset: true });
  assert.deepEqual([c.reset.state, c.start.state], ["failing", "not tried"]);
  // The person's own server on `::` (the default listen(port)): a bind test on 127.0.0.1 wouldn't see it.
  const theirs = http.createServer((_q, s) => s.end("theirs")).listen(0);
  await new Promise((x) => theirs.once("listening", x));
  const port = (theirs.address() as AddressInfo).port;
  try {
    for (const fixed of [{ port }, { url: `http://localhost:${port}` }]) {
      const d = await rows(fixed, { reset: true });
      assert.deepEqual([d.reset.state, d.start.state, d.stop.state], ["not tried", "not tried", "not tried"], JSON.stringify(fixed));
      assert.match(d.start.detail, new RegExp(`port ${port} is in use \\(another job's app or yours\\)`));
    }
    // qa up: refused, said in app.log, and a stale state of its own is not stopped (its stop could hit their server).
    const marker = path.join(path.dirname(root), `${path.basename(root)}-stopped.txt`);
    const state = path.join(jobDirOf(root, id), "app.json");
    fs.writeFileSync(state, JSON.stringify({ pid: 999999, port, url: "http://127.0.0.1:9", at: "", wt: root, stop: `touch ${marker}` }));
    const said: string[] = [];
    assert.equal(await appUp(root, id, (l) => said.push(l), { ...cfg, app: { ...cfg.app, port } }), 1);
    assert.match(said.join("\n"), new RegExp(`port ${port} is in use \\(another job's app or yours\\)`));
    assert.match(fs.readFileSync(path.join(qaDir(jobDirOf(root, id), 1), "app.log"), "utf8"), new RegExp(`kitchen: port ${port} is in use`));
    assert.ok(!fs.existsSync(marker), "no stop ran");
    fs.rmSync(state, { force: true });
    assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), "theirs", "their app still answers");
  } finally {
    theirs.close();
  }
});

test("doctor: an app a crashed doctor left is stopped, a pid since reused is not; a second doctor is refused at once", async () => {
  const cfg = loadConfig(root);
  fs.mkdirSync(path.join(root, ".kitchen", "doctor"), { recursive: true });
  const left = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  left.unref();
  const pid = left.pid as number;
  const write = (appStart: string | null) =>
    fs.writeFileSync(doctorAppFile(root), JSON.stringify({ pid, port: 1, url: "x", at: "", wt: root, owner: 999999, ownerStart: "x", appStart }));
  write("not its start time");
  await doctorReport(root, cfg, { init: true });
  assert.ok(!fs.existsSync(doctorAppFile(root)));
  assert.doesNotThrow(() => process.kill(pid, 0), "a reused pid is never killed");
  write(processStart(pid));
  await doctorReport(root, cfg, { init: true });
  assert.throws(() => process.kill(pid, 0), "its own leftover is stopped");
  // The lock held by a live process: refused at once, naming it.
  const lock = path.join(root, ".kitchen", "doctor", ".lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, start: processStart(process.ppid) }));
  try {
    const t0 = Date.now();
    await assert.rejects(doctorReport(root, cfg), new RegExp(`a kitchen doctor is already running \\(pid ${process.ppid}\\)`));
    assert.ok(Date.now() - t0 < 2000, "without waiting");
  } finally {
    fs.rmSync(lock, { force: true });
  }
});

test("qa scenario and whoami: the state's JSON and who QA is, saved as evidence; secrets masked; names kept to their files", async () => {
  assert.equal(await scenario(root, id, "offer-pending", out), 1, "the app isn't up yet");
  assert.match(lines.at(-1) ?? "", /kitchen qa up .* first/);
  assert.equal(await appUp(root, id, out), 0, lines.join("\n"));
  const dir = qaDir(jobDirOf(root, id), 1);
  assert.equal(await scenario(root, id, "offer-pending", out), 0, lines.join("\n"));
  const made = JSON.parse(fs.readFileSync(path.join(dir, "scenario-offer-pending.json"), "utf8"));
  assert.deepEqual([made.offer, made.as], [41, "ana"]);
  assert.match(made.url, /^http:\/\/127\.0\.0\.1:\d+$/, "it got the app's URL");
  assert.match(fs.readFileSync(path.join(dir, "scenario-offer-pending.log"), "utf8"), /seeded through the data file[\s\S]*\[exit 0\]/);
  assert.equal(await scenario(root, id, "broken", out), 1);
  assert.match(lines.at(-1) ?? "", /printed no JSON/);
  assert.ok(!fs.existsSync(path.join(dir, "scenario-broken.json")));
  for (const n of ["nope", "constructor", "../x"]) {
    assert.equal(await scenario(root, id, n, out), 1);
    assert.match(lines.at(-1) ?? "", /no scenario .* in kitchen\.yaml \(it has offer-pending, broken\)/);
  }
  assert.equal(await whoami(root, id, { headers: ["X-Member: ana", "Authorization: Bearer s3cret-value"], as: "ana" }, out), 0, lines.join("\n"));
  const w = JSON.parse(fs.readFileSync(path.join(dir, "whoami-ana.json"), "utf8"));
  assert.deepEqual(w, {
    identity: { user: "ana", role: "member" },
    asked: { via: "GET /api/me", as: "ana", headers: { "X-Member": "ana", Authorization: "Bear…" } },
  });
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "whoami-ana.log"), "utf8"), /s3cret/, "the log is masked too");
  await assert.rejects(whoami(root, id, { headers: [], as: "ana" }, out), /--as only names the file; pass the header/);
  assert.equal(await whoami(root, id, { headers: ["X-Member: bo"], name: "verdict" }, out), 0);
  assert.ok(fs.existsSync(path.join(dir, "whoami-verdict.json")) && !fs.existsSync(path.join(dir, "verdict.json")), "never verdict.json");
  assert.equal(await whoami(root, id, { headers: ["X-Member: cy"], as: "cy@example.com" }, out), 0, "an email as --as");
  assert.ok(fs.existsSync(path.join(dir, "whoami-cy_example.com.json")));
  const cfg = loadConfig(root);
  const cmd = { ...cfg, app: { ...cfg.app, whoami: 'echo "{\\"user\\": \\"$KITCHEN_AS\\"}"' } };
  assert.equal(await whoami(root, id, { headers: [], as: "cy" }, out, cmd), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "whoami-cy.json"), "utf8")), { identity: { user: "cy" }, asked: { via: "command", as: "cy" } });
  await assert.rejects(whoami(root, id, { headers: ["X-Member: cy"] }, out, cmd), /a command: --header is for a path whoami/);
  await appDown(root, id);
});

test("qa up: its own detached stack (no live pid, a compose project) still answering is reused, never refused or taken down", async () => {
  const cfg = loadConfig(root);
  const own = http.createServer((q, s) => s.end(q.url === "/health" ? "{}" : "own")).listen(0);
  await new Promise((x) => own.once("listening", x));
  const port = (own.address() as AddressInfo).port;
  const marker = path.join(path.dirname(root), `${path.basename(root)}-down.txt`);
  const state = path.join(jobDirOf(root, id), "app.json");
  fs.writeFileSync(state, JSON.stringify({ pid: 999999, port, url: `http://127.0.0.1:${port}`, at: "", wt: root, project: "kq1", stop: `touch ${marker}` }));
  try {
    const said: string[] = [];
    assert.equal(await appUp(root, id, (l) => said.push(l), { ...cfg, app: { ...cfg.app, port } }), 0, said.join("\n"));
    assert.deepEqual(said, [`app: up at http://127.0.0.1:${port}`]);
    assert.ok(!fs.existsSync(marker), "no down -v");
  } finally {
    fs.rmSync(state, { force: true });
    fs.rmSync(marker, { force: true });
    own.close();
  }
});
