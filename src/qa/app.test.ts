// QA's tools against a real (tiny) app: started from kitchen.yaml's app.start on a free port, an HTTP transcript,
// a Playwright screenshot of a page with its text, then stopped. And `kitchen run`'s headless command.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { loadConfig, parseConfig } from "../config.ts";
import * as control from "../engine/control.ts";
import { qaDir } from "../engine/lanes.ts";
import { findJob, jobDirOf } from "../engine/store.ts";
import { orchestratorCommand, scrubbedEnv, streamLine } from "../run/orchestrator.ts";
import { appDown, appEnv, appReset, appUp, composeProject, http, page, reachable, stopApp, stopCommand } from "./app.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-qa-"));
const lines: string[] = [];
const out = (l: string) => lines.push(l);
let id = "";
beforeAll(async () => {
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  fs.writeFileSync(
    path.join(root, "srv.mjs"),
    `import http from "node:http";
http.createServer((req, res) => {
  if (req.url === "/healthz") return res.end("ok");
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

test("kitchen run: a headless claude -p running the /kitchen skill, its tools allowed up front, no GitHub token handed over", () => {
  const cfg = parseConfig("agent: { max_usd: 12 }\n");
  const argv = orchestratorCommand(root, cfg, { bin: "/opt/claude" });
  assert.deepEqual(argv.slice(0, 3), ["/opt/claude", "-p", "/kitchen:kitchen run"]);
  assert.ok(argv.includes("--allowedTools") && argv[argv.indexOf("--allowedTools") + 1].includes("Agent"));
  assert.deepEqual(argv.slice(-2), ["--max-budget-usd", "12"]);
  fs.mkdirSync(path.join(root, ".claude", "skills", "kitchen"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "skills", "kitchen", "SKILL.md"), "x");
  assert.equal(orchestratorCommand(root, cfg, { bin: "c" })[2], "/kitchen run", "the repo's own copy of the skill");
  const env = scrubbedEnv({ GH_TOKEN: "g", GITHUB_TOKEN: "h", PATH: "/bin", ANTHROPIC_API_KEY: "k" });
  assert.deepEqual([env.GH_TOKEN, env.GITHUB_TOKEN, env.PATH, env.ANTHROPIC_API_KEY, env.KITCHEN_ORCHESTRATOR], [undefined, undefined, "/bin", "k", "1"]);
  assert.equal(
    streamLine(JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Wave 1: 001 intake" }] } })),
    "Wave 1: 001 intake",
  );
  assert.equal(
    streamLine(JSON.stringify({ type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "text", text: "a lane agent" }] } })),
    null,
  );
  assert.match(String(streamLine(JSON.stringify({ type: "result", total_cost_usd: 1.5, result: "done" }))), /finished · \$1\.50: done/);
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
