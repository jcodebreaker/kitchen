// QA's tools against a real (tiny) app: started from kitchen.yaml's app.start on a free port, an HTTP transcript,
// a Playwright screenshot of a page with its text, then stopped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { loadConfig } from "../config.ts";
import * as control from "../engine/control.ts";
import { qaDir, readMeta } from "../engine/lanes.ts";
import { findJob, jobDirOf } from "../engine/store.ts";
import {
  appDown,
  appEnv,
  appReset,
  appUp,
  browserNeeded,
  composeProject,
  ensureBrowser,
  http,
  page,
  reachable,
  stopApp,
  stopCommand,
  sweepApps,
} from "./app.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-qa-"));
const lines: string[] = [];
const out = (l: string) => lines.push(l);
let id = "";
beforeAll(async () => {
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", "commit", "-q", "--allow-empty", "-m", "base"]);
  fs.writeFileSync(
    path.join(root, "srv.mjs"),
    `import http from "node:http";
http.createServer((req, res) => {
  if (req.url === "/healthz") return res.end("ok");
  if (req.url === "/login") { res.setHeader("set-cookie", ["sid=abc; HttpOnly", "csrf=xyz"]); return res.end("in"); }
  if (req.url === "/api/n") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ n: Number(process.env.N || 0) + 1, who: req.headers["x-member"] ?? null })); }
  res.setHeader("content-type", "text/html"); res.end("<title>Shelf</title><h1>Books on the shelf</h1><button onclick=\\"document.body.append('borrowed!')\\">Borrow</button>");
}).listen(Number(process.env.PORT));
`,
  );
  fs.writeFileSync(path.join(root, "kitchen.yaml"), 'app: { start: "node srv.mjs", health: "/healthz", reset: "echo reset >> reset.txt" }\n');
  await control.ticket(root, "check the shelf", () => {});
  id = findJob(root, "1").id;
  const f = path.join(jobDirOf(root, id), "job.json");
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), stage: "qa", worktree: root }));
});
afterAll(async () => {
  await appDown(root, id);
  fs.rmSync(root, { recursive: true, force: true });
});

test("up on a free port after the reset, an HTTP transcript, a Playwright screenshot after a script, down", async () => {
  assert.equal(await appUp(root, id, out), 0, lines.join("\n"));
  assert.match(lines.at(-1) ?? "", /app: up at http:\/\/127\.0\.0\.1:\d+/);
  assert.ok(fs.existsSync(path.join(root, "reset.txt")), "app.reset ran first");
  const dir = qaDir(jobDirOf(root, id), 1);
  assert.equal(await http(root, id, "GET", "/api/n", { name: "c1-n", headers: ["X-Member: ana"] }, out), 0);
  // ADR 0033: request secrets masked; the response as sent, every Set-Cookie kept (QA goes on with the session).
  assert.equal(await http(root, id, "POST", "/login", { name: "c0-login", headers: ["Authorization: Bearer s3cret-token"] }, out), 0);
  const login = fs.readFileSync(path.join(dir, "c0-login.http.txt"), "utf8");
  assert.match(login, /Authorization: Bear…/);
  assert.doesNotMatch(login, /s3cret/);
  assert.match(login, /set-cookie: sid=abc; HttpOnly\nset-cookie: csrf=xyz/);
  const t = fs.readFileSync(path.join(dir, "c1-n.http.txt"), "utf8");
  assert.match(t, /# request\nGET http:\/\/127\.0\.0\.1:\d+\/api\/n\nX-Member: ana/);
  assert.match(t, /# response\nHTTP 200 OK[\s\S]*\{"n":1,"who":"ana"\}/);
  const script = path.join(root, "click.mjs");
  fs.writeFileSync(script, 'export default async (page) => { await page.click("text=Borrow"); };\n');
  assert.equal(await page(root, id, "/", { name: "c2-shelf", script }, out), 0, lines.join("\n"));
  assert.ok(fs.statSync(path.join(dir, "c2-shelf.png")).size > 1000);
  const txt = fs.readFileSync(path.join(dir, "c2-shelf.txt"), "utf8");
  assert.match(txt, /title: Shelf/);
  assert.match(txt, /Books on the shelf[\s\S]*borrowed!/, "the script ran before the screenshot");
  assert.match(txt, /console errors: none/);
  // ADR 0031 §2: each capture is stamped with where it came from.
  const app = JSON.parse(fs.readFileSync(path.join(jobDirOf(root, id), "app.json"), "utf8"));
  const meta = readMeta(dir, "c1-n.http.txt");
  assert.ok(meta, "the http transcript has a stamp");
  assert.deepEqual([meta.job, meta.round, meta.lane, meta.dirty, meta.app?.pid, meta.app?.at], [id, 1, "qa", false, app.pid, app.at]);
  assert.match(meta.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/n$/);
  assert.equal(meta.sha, execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  for (const f of ["c2-shelf.png", "c2-shelf.txt"]) assert.equal(readMeta(dir, f)?.url.endsWith("/"), true, `${f} is stamped`);
  await assert.rejects(page(root, id, "https://example.com/", { name: "x" }, out), /not this machine/);
  await assert.rejects(http(root, id, "GET", "/", { name: "../escape", headers: [] }, out), /--name/);
  assert.equal(await appDown(root, id, out), 0);
  assert.equal(lines.at(-1), "app: stopped");
});

test("qa reset: down, app.reset, up again on a fresh process; without app.reset it says the data is not fresh", async () => {
  assert.equal(await appUp(root, id, out), 0, lines.join("\n"));
  const state = path.join(jobDirOf(root, id), "app.json");
  const pid = (JSON.parse(fs.readFileSync(state, "utf8")) as { pid: number }).pid;
  const resets = () => fs.readFileSync(path.join(root, "reset.txt"), "utf8").trim().split("\n").length;
  const before = resets();
  assert.equal(await appReset(root, id, out), 0, lines.join("\n"));
  assert.equal(resets(), before + 1, "app.reset ran again");
  assert.notEqual((JSON.parse(fs.readFileSync(state, "utf8")) as { pid: number }).pid, pid, "a new app process");
  assert.match(lines.at(-1) ?? "", /reset \(echo reset >> reset\.txt\) and restarted on fresh data/);
  const cfg = loadConfig(root);
  assert.equal(await appReset(root, id, out, { ...cfg, app: { ...cfg.app, reset: undefined } }), 0);
  assert.match(lines.at(-1) ?? "", /no app\.reset: the data is what earlier checks left/);
  assert.equal(resets(), before + 1, "nothing to reset with");
  await appDown(root, id);
});

test("ADR 0021 §4: a compose app runs in its job's own project; qa down brings it down (env and commands only, no Docker)", async () => {
  const compose = { start: "docker compose up --build", stop: undefined };
  assert.equal(composeProject(compose, "007-add-cart"), "kq007");
  assert.equal(composeProject({ start: "docker-compose up" }, "012-x"), "kq012");
  assert.equal(composeProject(compose, "sweep-20261124-101500"), "kq-sweep-20261124-101500");
  assert.equal(composeProject({ start: "npm start" }, "007-add-cart"), null, "not compose: no project");
  assert.equal(composeProject({ start: "./docker-composer" }, "007-x"), null);
  assert.deepEqual(appEnv({ port: 4100, project: "kq007" }), { PORT: "4100", COMPOSE_PROJECT_NAME: "kq007" });
  assert.deepEqual(appEnv({ port: 4100, project: null }), { PORT: "4100" });
  assert.equal(stopCommand(compose, "kq007"), "docker compose -p kq007 down -v");
  assert.equal(stopCommand({ stop: "make down" }, "kq007"), "make down", "app.stop wins");
  assert.equal(stopCommand({}, null), null);
  // The stop command runs in the app's folder with the env it started with.
  const wt = fs.mkdtempSync(path.join(root, "stop-"));
  await stopApp({ wt, stop: 'echo "$COMPOSE_PROJECT_NAME $PORT" > stopped.txt', env: appEnv({ port: 4100, project: "kq007" }) });
  assert.equal(fs.readFileSync(path.join(wt, "stopped.txt"), "utf8"), "kq007 4100\n");
});

test("ADR 0021 §3: only this machine, or the deployed URL a --url sweep drives", () => {
  assert.ok(reachable("http://127.0.0.1:4100/x", null));
  assert.ok(!reachable("https://staging.example.com/cart", null));
  assert.ok(reachable("https://staging.example.com/cart", "https://staging.example.com"));
  assert.ok(!reachable("https://evil.example.com/", "https://staging.example.com"));
});

test("ADR 0029 §4: qa up records each setup step in the job's checking, and clears it when the app is up or fails", async () => {
  const job = path.join(jobDirOf(root, id), "job.json");
  const seen = path.join(root, "seen");
  fs.mkdirSync(seen, { recursive: true });
  const cfg = loadConfig(root);
  // app.reset runs after its step is written, so it sees it on disk; every value `checking` takes is recorded as written.
  const app = { ...cfg.app, reset: `cp '${job}' '${path.join(seen, "reset.json")}'`, ready_timeout_sec: 20 };
  const steps: unknown[] = [];
  const record = (c: { cmd: string; setup?: true; of?: number } | null | undefined) => steps.push(c ? [c.cmd, c.setup, c.of] : null);
  assert.equal(await appUp(root, id, out, { ...cfg, app }, { seen: record }), 0, lines.join("\n"));
  const disk = (JSON.parse(fs.readFileSync(path.join(seen, "reset.json"), "utf8")) as { checking?: Record<string, unknown> }).checking;
  assert.deepEqual([disk?.cmd, disk?.setup, disk?.log], ["Resetting data", true, path.join("rounds", "1", "qa", "app.log")]);
  assert.deepEqual(steps, [["Resetting data", true, undefined], ["Starting the app", true, undefined], ["Waiting for /healthz", true, 20], null]);
  assert.equal(findJob(root, id).checking, undefined, "cleared once up");
  await appDown(root, id);
  steps.length = 0;
  assert.equal(await appUp(root, id, out, { ...cfg, app: { ...app, reset: "exit 3" } }, { seen: record }), 1);
  assert.deepEqual(steps, [["Resetting data", true, undefined], null], "cleared when a step fails");
  assert.equal(findJob(root, id).checking, undefined);
});

test("ADR 0029 §4: the browser is installed once when it is missing; a failed install is the one line to refuse with", async () => {
  const said: string[] = [];
  let installs = 0;
  assert.equal(await ensureBrowser((l) => said.push(l), { ready: () => true, install: async () => !!++installs }), null);
  assert.equal(installs, 0, "there already: nothing installed");
  let there = false;
  const install = async () => {
    installs++;
    there = true;
    return true;
  };
  assert.equal(await ensureBrowser((l) => said.push(l), { ready: () => there, install }), null);
  assert.deepEqual([installs, said], [1, ["Installing the browser QA uses, once (~150 MB)…"]]);
  const no = await ensureBrowser(() => {}, { ready: () => false, install: async () => false });
  assert.match(String(no), /^the browser QA uses \(Playwright's Chromium\) isn't installed: run npx playwright install chromium in \//);
  // Not needed yet (no app, no page criterion): a note, no install, no refusal.
  const notes: string[] = [];
  assert.equal(await ensureBrowser((l) => notes.push(l), { needed: false, ready: () => false, install: async () => !!++installs }), null);
  assert.equal(installs, 1, "nothing installed");
  assert.match(notes.join(""), /^note: the browser QA uses .* \(nothing queued needs it yet\)$/);
  // The installer's own output goes through out (the run's log when detached), never straight to the terminal.
  const lines: string[] = [];
  const prev = process.env.KITCHEN_BROWSER_INSTALL;
  process.env.KITCHEN_BROWSER_INSTALL = "printf 'Downloading 10%%\\rDownloading 100%%\\n'; exit 1";
  try {
    assert.ok(await ensureBrowser((l) => lines.push(l), { ready: () => false }));
  } finally {
    process.env.KITCHEN_BROWSER_INSTALL = prev;
  }
  assert.deepEqual(lines, ["Installing the browser QA uses, once (~150 MB)…", "  Downloading 100%"]);
  assert.ok(browserNeeded(root, loadConfig(root)), "an app to drive needs it");
});

test("ADR 0029 §5: stopping or rejecting a job stops its app; a sweep stops any app no lane works on", async () => {
  const state = path.join(jobDirOf(root, id), "app.json");
  const up = async () => {
    assert.equal(await appUp(root, id, out), 0, lines.join("\n"));
    return (JSON.parse(fs.readFileSync(state, "utf8")) as { pid: number }).pid;
  };
  const gone = async (pid: number) => {
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(!alive(pid), `app ${pid} still runs`);
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let pid = await up();
  await control.stop(root, id, () => {});
  assert.ok(!fs.existsSync(state));
  await gone(pid);
  await control.resume(root, id, () => {});
  pid = await up();
  assert.deepEqual(await sweepApps(root), [`${id}  app stopped (no lane works on it)`]);
  await gone(pid);
  pid = await up();
  await control.reject(root, id, () => {});
  assert.ok(!fs.existsSync(state));
  await gone(pid);
});
