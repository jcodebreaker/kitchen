// ADR 0009: the dashboard can change state, so a POST that does not come from the page it served is refused.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { readMessages } from "../engine/messages.ts";
import { createJob, jobDirOf, updateJob } from "../engine/store.ts";
import { dashboardServer, PAGE_CSP, refusePost } from "./server.ts";

const TOKEN = "t".repeat(64);
let repo = "";
let port = 0;
let server: http.Server;
let id = "";
const saved = process.env.KITCHEN_HOME;

beforeAll(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-dash-"));
  process.env.KITCHEN_HOME = path.join(repo, ".home");
  const { job } = await createJob(repo, { title: "Show the open count", ticket: { source: "prompt", id: "p1" }, body: "x", roundLimit: 3, base: "" });
  id = job.id;
  await updateJob(repo, id, (j) => ({ ...j, stage: "build" }));
  server = dashboardServer(repo, { token: TOKEN });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  server.close();
  process.env.KITCHEN_HOME = saved;
  fs.rmSync(repo, { recursive: true, force: true });
});

function req(o: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ code: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method: o.method ?? "POST", path: o.path ?? "/api/steer", headers: o.headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ code: res.statusCode ?? 0, body, headers: res.headers }));
    });
    r.on("error", reject);
    r.end(o.body);
  });
}
const good = () => ({ host: `127.0.0.1:${port}`, "content-type": "application/json", "x-kitchen-token": TOKEN });
const steerBody = () => JSON.stringify({ id, text: "keep the diff small" });

test("must refuse: no token, a wrong token, or a token of another length", async () => {
  for (const t of [undefined, "x".repeat(64), "short"]) {
    const h: Record<string, string> = { ...good() };
    if (t === undefined) delete h["x-kitchen-token"];
    else h["x-kitchen-token"] = t;
    assert.equal((await req({ headers: h, body: steerBody() })).code, 403, String(t));
  }
  assert.equal(readMessages(jobDirOf(repo, id)).length, 0, "nothing was written");
});

test("must refuse: another origin, even with the token", async () => {
  for (const origin of ["https://evil.example", `http://127.0.0.1:${port + 1}`, "null"])
    assert.equal((await req({ headers: { ...good(), origin }, body: steerBody() })).code, 403, origin);
  assert.equal(readMessages(jobDirOf(repo, id)).length, 0);
});

test("must refuse: a Host that is not this machine (DNS rebinding), for GET and POST", async () => {
  assert.equal((await req({ headers: { ...good(), host: "evil.example" }, body: steerBody() })).code, 403);
  assert.equal((await req({ method: "GET", path: "/data.json", headers: { host: `attacker.test:${port}` } })).code, 403);
});

test("must refuse: a simple request's content type (a cross-site form can't send JSON)", async () => {
  for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp"])
    assert.equal((await req({ headers: { ...good(), "content-type": ct }, body: steerBody() })).code, 415, ct);
});

test("must refuse: a body over the cap, not JSON, a text over the message cap, an unknown action", async () => {
  assert.equal((await req({ headers: good(), body: JSON.stringify({ id, text: "x".repeat(20_000) }) })).code, 413);
  assert.equal((await req({ headers: good(), body: "not json" })).code, 400);
  assert.equal((await req({ headers: good(), body: JSON.stringify({ id, text: "x".repeat(4001) }) })).code, 400);
  assert.equal((await req({ path: "/api/merge", headers: good(), body: steerBody() })).code, 400);
  assert.equal(readMessages(jobDirOf(repo, id)).length, 0);
});

test("the page's own request goes through, to the same engine verb as kitchen steer", async () => {
  const r = await req({ headers: { ...good(), origin: `http://127.0.0.1:${port}` }, body: steerBody() });
  assert.equal(r.code, 200, r.body);
  const [m] = readMessages(jobDirOf(repo, id));
  assert.deepEqual([m.kind, m.text, m.status], ["steer", "keep the diff small", "sent"]);
  const p = await req({ headers: good(), path: "/api/pause", body: JSON.stringify({ id }) });
  assert.equal(p.code, 200, p.body);
  assert.match(fs.readFileSync(path.join(jobDirOf(repo, id), "job.json"), "utf8"), /"pausedReason": "by-you"/);
});

test("the page carries this launch's token, under a CSP that loads nothing from elsewhere", async () => {
  const r = await req({ method: "GET", path: "/", headers: { host: `localhost:${port}` } });
  assert.equal(r.code, 200);
  assert.ok(r.body.includes(`content="${TOKEN}"`));
  assert.equal(r.headers["content-security-policy"], PAGE_CSP);
  assert.doesNotMatch(r.body, /https?:\/\/(?!127\.0\.0\.1)[a-z]/i, "no URL to another host in the page");
  const f = await req({ method: "GET", path: "/fonts/Geist-Variable.woff2", headers: { host: `127.0.0.1:${port}` } });
  assert.equal(f.code, 200);
  assert.equal(f.headers["content-type"], "font/woff2");
  assert.equal((await req({ method: "GET", path: "/fonts/../../package.json", headers: { host: `127.0.0.1:${port}` } })).code, 404);
});

test("refusePost, pure: the order of the checks", () => {
  const h = { origin: "http://localhost:7357", "x-kitchen-token": TOKEN, "content-type": "application/json; charset=utf-8" };
  assert.equal(refusePost(h, TOKEN, 7357), null);
  assert.equal(refusePost({ ...h, origin: undefined }, TOKEN, 7357), null, "no Origin (curl, the CLI): the token decides");
  assert.equal(refusePost({ ...h, origin: "http://localhost:7358" }, TOKEN, 7357)?.code, 403);
});
