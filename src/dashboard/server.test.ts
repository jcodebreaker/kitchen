// The dashboard server: the page with its token, the jobs as lanes, a job's detail with its lane activity, the
// actions as CLI verbs (refused without the token), and Start Kitchen starting an orchestrator.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import * as control from "../engine/control.ts";
import { findJob, jobDirOf } from "../engine/store.ts";
import { setRunnerStarter } from "./actions.ts";
import { dashboardServer } from "./server.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-dash-"));
let s: http.Server & { token: string };
let base = "";
const started: string[] = [];
beforeAll(async () => {
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  fs.writeFileSync(path.join(root, "kitchen.yaml"), "checks: []\n");
  await control.ticket(root, "Add a renew button", () => {});
  const id = findJob(root, "1").id;
  // A lane agent's stream, as the activity hook writes it, and the job's open lane.
  const dir = jobDirOf(root, id);
  fs.mkdirSync(path.join(dir, "activity"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "activity", "m0-intake-1.jsonl"),
    `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: `${root}/server.js` } }] } })}\n`,
  );
  const j = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
  j.running = { lane: "intake", at: new Date().toISOString(), key: `${id}/m0/intake/1`, stream: "activity/m0-intake-1.jsonl" };
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(j));
  setRunnerStarter((_repo, out) => {
    started.push("x");
    out("orchestrator detached: pid 1");
    return 0;
  });
  s = dashboardServer(root);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
});
afterAll(() => {
  setRunnerStarter(null);
  s.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const post = (action: string, body: unknown, token: string | null = s.token) =>
  fetch(`${base}/api/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-kitchen-token": token } : {}) },
    body: JSON.stringify(body),
  });

test("the page carries this launch's token; no Toolkit, no Setup endpoint", async () => {
  const page = await (await fetch(base)).text();
  assert.ok(page.includes(s.token));
  assert.ok(!/toolkit-approve|approve-tk|Approve Toolkit|setup\.json/.test(page));
  assert.equal((await fetch(`${base}/setup.json`)).status, 404);
});

test("data.json: the job in its lane, the board's lanes, the agent's live line from its stream", async () => {
  const d = (await (await fetch(`${base}/data.json`)).json()) as {
    lanes: { k: string }[];
    jobs: { lane: string; stage: string; live: { vb: string; tg: string } | null; phases: { k: string }[] }[];
    runner: { running: boolean };
  };
  assert.deepEqual(
    d.lanes.map((l) => l.k),
    ["you", "intake", "build", "qa", "review", "ready", "done"],
  );
  assert.deepEqual([d.jobs[0].stage, d.jobs[0].lane], ["intake", "intake"]);
  assert.deepEqual([d.jobs[0].live?.vb, d.jobs[0].live?.tg], ["Read", "server.js"]);
  assert.deepEqual(
    d.jobs[0].phases.map((p) => p.k),
    ["intake", "build", "qa", "review", "merge"],
  );
  assert.equal(d.runner.running, false);
  const det = (await (await fetch(`${base}/jobs/${findJob(root, "1").id}/detail.json`)).json()) as { tl: { evs: unknown[] }[] };
  assert.equal(det.tl.at(-1)?.evs.length, 1);
});

test("actions are the CLI's verbs: refused without the token; a steer lands on the thread; a ticket starts an orchestrator", async () => {
  assert.equal((await post("steer", { id: "1", text: "hi" }, null)).status, 403);
  const r = (await (await post("steer", { id: "1", text: "keep it small" })).json()) as { ok: boolean; lines: string[] };
  assert.equal(r.ok, true, r.lines.join());
  assert.match(fs.readFileSync(path.join(jobDirOf(root, findJob(root, "1").id), "messages.jsonl"), "utf8"), /keep it small/);
  assert.equal((await post("toolkit-approve", { expect: "abc" })).status, 400, "the Toolkit actions are gone");
  const t = (await (await post("ticket", { text: "Another one" })).json()) as { ok: boolean; lines: string[] };
  assert.equal(t.ok, true);
  assert.deepEqual(started, ["x"], "no orchestrator was running, so one was started");
  assert.match(t.lines.join("\n"), /orchestrator detached/);
});
