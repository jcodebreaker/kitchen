// One dashboard, many repos (ADR 0019): the list file, the routes under /r/<key>/, and a second `kitchen dashboard`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import * as control from "../engine/control.ts";
import { findJob, jobDirOf } from "../engine/store.ts";
import { addRepo, forgetRepo, kitchenHome, readRepos } from "./repos.ts";
import { dashboardServer, serveDashboard } from "./server.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-repos-")));
const file = path.join(root, "home", "repos.json");
const repoAt = async (rel: string) => {
  const r = path.join(root, rel);
  fs.mkdirSync(r, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", r]);
  fs.writeFileSync(path.join(r, "kitchen.yaml"), "checks: []\n");
  await control.ticket(r, `A ticket in ${rel}`, () => {});
  return r;
};
let a = "";
let b = "";
let s: http.Server & { token: string };
let base = "";
beforeAll(async () => {
  a = await repoAt("one/app");
  b = await repoAt("two/app");
  s = dashboardServer(null, { list: () => readRepos(file) });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
});
afterAll(() => {
  s.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the list: a key per repo (a path hash when names clash), the last added, forget, and gone repos dropped on read", async () => {
  assert.deepEqual(addRepo(a, file), { key: "app", path: a });
  const kb = addRepo(b, file).key;
  assert.match(kb, /^app-[0-9a-f]{6}$/);
  assert.equal(addRepo(a, file).key, "app", "adding again finds it");
  assert.deepEqual(readRepos(file), {
    repos: [
      { key: "app", path: a },
      { key: kb, path: b },
    ],
    last: "app",
  });
  const c = await repoAt("three");
  addRepo(c, file);
  assert.equal(forgetRepo(c, file), true);
  assert.equal(forgetRepo(c, file), false);
  assert.equal(readRepos(file).last, kb, "forgetting the last one points the page at another");
  const d = await repoAt("four");
  addRepo(d, file);
  fs.rmSync(path.join(d, ".kitchen"), { recursive: true });
  assert.deepEqual(
    readRepos(file).repos.map((r) => r.key),
    ["app", kb],
    "a repo without .kitchen/ is left out",
  );
  assert.deepEqual(readRepos(path.join(root, "nowhere.json")), { repos: [], last: null });
});

test("routes carry the repo: each key its own jobs; a key not on the list is a 404; a POST for one repo never touches another", async () => {
  const { repos } = readRepos(file);
  const kb = repos[1].key;
  const list = (await (await fetch(`${base}/repos.json`)).json()) as { repos: { key: string; name: string; jobs: number }[] };
  assert.deepEqual(
    list.repos.map((r) => [r.key, r.name, r.jobs]),
    [
      ["app", "app", 1],
      [kb, "app", 1],
    ],
  );
  const title = async (k: string) => ((await (await fetch(`${base}/r/${k}/data.json`)).json()) as { jobs: { title: string }[] }).jobs[0].title;
  assert.equal(await title("app"), "A ticket in one/app");
  assert.equal(await title(kb), "A ticket in two/app");
  assert.equal((await fetch(`${base}/r/nope/data.json`)).status, 404);
  assert.equal((await fetch(`${base}/data.json`)).status, 404, "no repo-less routes on the shared server");
  assert.deepEqual(await (await fetch(`${base}/kitchen.json`)).json(), {
    kitchen: true,
    version: JSON.parse(fs.readFileSync("package.json", "utf8")).version,
    private: false,
    pid: process.pid,
    home: path.resolve(kitchenHome()),
  });
  const post = (k: string, token = s.token) =>
    fetch(`${base}/r/${k}/api/steer`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kitchen-token": token },
      body: JSON.stringify({ id: "1", text: "only here" }),
    });
  assert.equal((await post("nope")).status, 404);
  assert.equal((await post(kb, "wrong")).status, 403);
  assert.equal((await post(kb)).status, 200);
  const thread = (r: string) => path.join(jobDirOf(r, findJob(r, "1").id), "messages.jsonl");
  assert.match(fs.readFileSync(thread(b), "utf8"), /only here/);
  assert.ok(!fs.existsSync(thread(a)) || !/only here/.test(fs.readFileSync(thread(a), "utf8")), "repo A's job was not steered");
});

test("a second kitchen dashboard: a Kitchen dashboard on the port gets the repo and the address; anything else is an error", async () => {
  const port = (s.address() as { port: number }).port;
  const c = await repoAt("five");
  const printed: string[] = [];
  assert.equal(await serveDashboard(c, port, (l) => printed.push(l), { file }), null);
  assert.deepEqual(printed, [`already open: http://127.0.0.1:${port}/#five`]);
  assert.ok(readRepos(file).repos.some((r) => r.path === c));
  assert.equal((await fetch(`${base}/r/five/data.json`)).status, 200, "the running server sees it without a restart");

  const other = http.createServer((_q, r) => r.end("hi"));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      serveDashboard(c, (other.address() as { port: number }).port, () => {}, { file }),
      /isn't a Kitchen dashboard/,
    );
  } finally {
    other.close();
  }
});
