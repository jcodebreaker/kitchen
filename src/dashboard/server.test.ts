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
  assert.doesNotMatch(
    r.body,
    /@font-face|url\((?!"data:image\/svg\+xml;base64,)/,
    "system fonts only: nothing for the page to fetch (the logo is inline data)",
  );
  // Logo B, the cook: the app icon and the favicon are inline data: URLs (CSP img-src data:), and the K tile is gone.
  assert.match(r.body, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+">/);
  assert.match(r.body, /:root\{--logo:url\("data:image\/svg\+xml;base64,/);
  assert.match(r.body, /:root\[data-theme="dark"\]\{--logo:url\("data:/, "a dark icon for the dark theme");
  assert.doesNotMatch(r.body, /<span class="logo[^"]*">K<\/span>/);
  assert.equal((await req({ method: "GET", path: "/fonts/Geist-Variable.woff2", headers: { host: `127.0.0.1:${port}` } })).code, 404);
});

test("hygiene: a prototype key is no action, a malformed % in a path is a 400, an announced oversize body is refused unread", async () => {
  for (const name of ["constructor", "hasownproperty", "to-string"])
    assert.equal((await req({ path: `/api/${name}`, headers: good(), body: steerBody() })).code, 400, name);
  assert.equal((await req({ method: "GET", path: "/jobs/%E0%A4/detail.json", headers: { host: `127.0.0.1:${port}` } })).code, 400);
  assert.equal((await req({ method: "GET", path: "/jobs/..%2F..%2Fetc/detail.json", headers: { host: `127.0.0.1:${port}` } })).code, 404);
  const big = await req({ headers: { ...good(), "content-length": "999999" }, body: "" });
  assert.equal(big.code, 413);
});

test("a restart is seen by an old tab: /data.json and the page carry a launch id (never the token), and it changes per launch", async () => {
  const page = await req({ method: "GET", path: "/", headers: { host: `127.0.0.1:${port}` } });
  const launch = /name="kitchen-launch" content="([0-9a-f]{16})"/.exec(page.body)?.[1];
  assert.ok(launch, "the page names its launch");
  const data = await req({ method: "GET", path: "/data.json", headers: { host: `127.0.0.1:${port}` } });
  assert.equal(JSON.parse(data.body).launch, launch);
  assert.ok(!data.body.includes(TOKEN), "the token stays out of /data.json");
  // Another launch, same repo: another id, so the old tab knows to reload.
  const again = dashboardServer(repo, { token: TOKEN });
  assert.notEqual(again.launch, launch);
  assert.notEqual(again.token, again.launch);
});

test("the page reloads once on a restart and never loops: the second restart in a row says so and stops", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "dashboard", "dashboard.html"), "utf8");
  const block = /\/\* reconnect:start[^*]*\*\/([\s\S]*?)\/\* reconnect:end \*\//.exec(html)?.[1];
  assert.ok(block, "the reconnect block is in the page");
  const { onRestart, onConnected } = new Function(`${block}\nreturn { onRestart, onConnected };`)() as {
    onRestart: (s: Storage, reload: () => void, say: (m: string, stuck: boolean) => void) => string;
    onConnected: (s: Storage) => void;
  };
  const mem = new Map<string, string>();
  const store = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  } as unknown as Storage;
  const said: string[] = [];
  const say = (m: string) => said.push(m);
  const timers = setTimeout;
  let reloads = 0;
  globalThis.setTimeout = ((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    assert.equal(
      onRestart(store, () => reloads++, say),
      "reloading",
    );
    assert.equal(reloads, 1);
    // The reloaded page is refused again (the restart didn't fix it): no second reload.
    assert.equal(
      onRestart(store, () => reloads++, say),
      "stuck",
    );
    assert.equal(reloads, 1);
    assert.deepEqual(said, ["The dashboard restarted — reloading…", "Couldn't reconnect; reload the page"]);
    // Back in touch: a later restart may reload once again.
    onConnected(store);
    assert.equal(
      onRestart(store, () => reloads++, say),
      "reloading",
    );
    // No storage (private mode): no automatic reload at all, only the message.
    const none = {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    } as unknown as Storage;
    assert.equal(
      onRestart(none, () => reloads++, say),
      "stuck",
    );
    assert.equal(reloads, 2);
  } finally {
    globalThis.setTimeout = timers;
  }
});

test("refusePost, pure: the order of the checks", () => {
  const h = { origin: "http://localhost:7357", "x-kitchen-token": TOKEN, "content-type": "application/json; charset=utf-8" };
  assert.equal(refusePost(h, TOKEN, 7357), null);
  assert.equal(refusePost({ ...h, origin: undefined }, TOKEN, 7357), null, "no Origin (curl, the CLI): the token decides");
  assert.equal(refusePost({ ...h, origin: "http://localhost:7358" }, TOKEN, 7357)?.code, 403);
});

test("with no runner, jobs in an active stage are waiting (Queued), not running; a Toolkit build counts as running; header and sidebar agree", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "dashboard", "dashboard.html"), "utf8");
  const block = /\/\* queue-words:start[^*]*\*\/([\s\S]*?)\/\* queue-words:end \*\//.exec(html)?.[1];
  assert.ok(block, "the queue-words block is in the page");
  type J = { kind: string; state: string };
  const queueWords = new Function(`${block}\nreturn queueWords;`)() as (r: boolean, run: J[]) => { count: string; group: string; busy: boolean };
  const job = { kind: "feature", state: "run" };
  const setup = { kind: "setup", state: "run" };
  const plain = (q: { count: string; group: string; busy: boolean }) => [q.count.replace(/<\/?b>/g, ""), q.group, q.busy];
  assert.deepEqual(plain(queueWords(false, [job])), ["1 waiting", "Queued", false]);
  assert.deepEqual(plain(queueWords(true, [job, job])), ["2 running", "Running", true]);
  // A Toolkit build runs without kitchen run: never counted as waiting.
  assert.deepEqual(plain(queueWords(false, [setup])), ["1 running", "Running", true]);
  assert.deepEqual(plain(queueWords(false, [setup, job])), ["1 waiting · 1 running", "Queued", true]);
  assert.deepEqual(plain(queueWords(false, [])), ["0 waiting", "Queued", false]);
  // Every place that counts them takes its words from queueWords: the header (#sum), the sidebar (#sRunN), the list group.
  assert.match(html, /\$\("#sRunN"\)\.textContent=queueWords\(!!snap\.runner\.running,run\)\.group/);
  assert.match(html, /<span class="qn">\$\{queueWords\(!!snap\.runner\.running,run\)\.count\}<\/span>/);
  assert.match(html, /const q=queueWords\(!!\(snap&&snap\.runner\.running\),run\)/);
  assert.doesNotMatch(html, /<b>\$\{run\.length\}<\/b> running<\/span>/, "no fixed 'running' left in the header");
});

test("the header's counts never clip: view labels at 620px, 'ready' at 520px, title at 480px, queue count at 420px, '0 need you' at 380px; never a ready card", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "dashboard", "dashboard.html"), "utf8");
  // Checked in headless Chromium with the panel open at 1280, 1100 and 900 px: #sum's scrollWidth fits its box.
  assert.match(html, /@container main \(max-width:620px\)\{ \.segc span\{display:none\} \}/);
  assert.match(html, /@container main \(max-width:520px\)\{ #sum \.rdy\{display:none\} \}/);
  assert.match(html, /@container main \(max-width:420px\)\{ #sum \.qn\{display:none\} \}/);
  // Then the title and New ticket's label, then the words: by the main column's width, never the window's (the panel takes room).
  assert.match(html, /@container main \(max-width:480px\)\{ \.top\{[^}]*\} \.top h2,\.top \.pri \.lg\{display:none\} \}/);
  assert.match(html, /@container main \(max-width:380px\)\{ #sum \.none\{display:none\} #sum \.zero\{display:inline\} \}/);
  assert.match(html, /<span class="none">Nothing needs you<\/span><span class="zero">0 need you<\/span>/);
  for (const m of html.matchAll(/@media \(max-width:\d+px\)\{[\s\S]*?\n\}/g))
    assert.doesNotMatch(m[0], /\.top h2|\.segc span|\.sumline \.rdy/, "no window-width rule hides the header's parts");
  assert.doesNotMatch(html, /[{}]\s*\.rdy\{display:none\}/, "`.rdy` is also a ready card's class: only the header's is hidden");
});
