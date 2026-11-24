// ADR 0021 §1 end to end, no agent: a `when: merge`, `needs_app` check (a stand-in e2e suite: a node script that
// reads the page at $BASE_URL) is skipped after Build, runs on the trial merge against the app started from the
// merged result, and the app is always stopped. Green merges; a change that breaks the page goes back to Build with
// the suite's output in the next builder's brief.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { loadConfig } from "../config.ts";
import * as control from "./control.ts";
import { finish, start } from "./jobs.ts";
import { intakeFile, qaDir, reviewFile } from "./lanes.ts";
import { ensureStaging } from "./staging.ts";
import { findJob, jobDirOf, roundDir } from "./store.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-mergecheck-"));
const seen = path.join(root, "e2e-seen.txt");
process.env.KITCHEN_TEST_E2E_SEEN = seen;
afterAll(() => {
  delete process.env.KITCHEN_TEST_E2E_SEEN;
  fs.rmSync(root, { recursive: true, force: true });
});
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();

const SERVER = `const fs = require("node:fs");
require("node:http").createServer((q, s) => {
  if (q.url === "/healthz") return s.end("ok");
  const items = JSON.parse(fs.readFileSync("data.json", "utf8")).items;
  s.setHeader("content-type", "text/html");
  s.end(\`<h1>\${fs.readFileSync("title.txt", "utf8").trim()}</h1><p id="count">\${items.length} items</p>\`);
}).listen(Number(process.env.PORT), "127.0.0.1");
`;
// The stand-in suite: what a Playwright run would assert, against the URL Kitchen passes.
const E2E = `import fs from "node:fs";
const url = process.env.BASE_URL;
fs.appendFileSync(process.env.KITCHEN_TEST_E2E_SEEN, \`\${url} \${process.env.PLAYWRIGHT_BASE_URL} \${process.env.CYPRESS_BASE_URL}\\n\`);
const html = await (await fetch(url + "/")).text();
console.log("e2e against", url);
if (!html.includes("<h1>Shop</h1>")) { console.error("expected the heading Shop, got:", html); process.exit(1); }
if (!html.includes("0 items")) { console.error("expected an empty cart on the seed data, got:", html); process.exit(1); }
console.log("1 passed");
`;

async function repo(): Promise<string> {
  const r = path.join(root, "shop");
  fs.mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "server.js"), SERVER);
  fs.writeFileSync(path.join(r, "e2e.mjs"), E2E);
  fs.writeFileSync(path.join(r, "title.txt"), "Shop\n");
  fs.writeFileSync(path.join(r, "data.json"), '{"items":["left over"]}\n');
  fs.writeFileSync(
    path.join(r, "kitchen.yaml"),
    [
      "checks:",
      '  - { name: guard, run: "test ! -e BROKEN" }',
      '  - { name: e2e, run: "node e2e.mjs", when: merge, needs_app: true, timeout_sec: 60 }',
      `app: { start: "node server.js", health: "/healthz", reset: "echo '{\\"items\\":[]}' > data.json", ready_timeout_sec: 20 }`,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(r, ".gitignore"), ".kitchen/\n.worktrees/\n");
  g(r, "add", "-A");
  g(r, "commit", "-qm", "base");
  await ensureStaging(r, loadConfig(r), () => {});
  return r;
}

const INTAKE = "DECISION: ACCEPT\nTITLE: Retitle\nKIND: feature\nRISK: low\nSURFACES: none\nFILES: title.txt\n\n## Criteria\n- C1 (cmd): title.txt says it\n";
async function fin(r: string, id: string) {
  const f = await finish(r, id);
  assert.ok("line" in f, JSON.stringify(f));
  return f;
}
async function throughReview(r: string, id: string, title: string): Promise<string> {
  const b = await start(r, id, "build");
  assert.ok("cwd" in b, JSON.stringify(b));
  fs.writeFileSync(path.join(b.cwd, "title.txt"), title);
  g(b.cwd, "commit", "-qam", "retitle");
  const built = await fin(r, id);
  assert.match(built.line, /checks pass → qa/);
  await start(r, id, "qa");
  const j = findJob(r, id);
  const d = qaDir(jobDirOf(r, j.id), j.round);
  fs.writeFileSync(path.join(d, "c1.txt"), "ok\n");
  fs.writeFileSync(
    path.join(d, "verdict.json"),
    JSON.stringify({ verdict: "PASS", criteria: [{ id: "C1", result: "PASS", evidence: ["c1.txt"], note: "ok" }] }),
  );
  await fin(r, id);
  await start(r, id, "review");
  fs.writeFileSync(reviewFile(jobDirOf(r, j.id), findJob(r, id).round), JSON.stringify({ summary: "ok", findings: [] }));
  return (await fin(r, id)).line;
}
const urls = () => (fs.existsSync(seen) ? fs.readFileSync(seen, "utf8").trim().split("\n").filter(Boolean) : []);
const down = async (url: string) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return false;
  } catch {
    return true;
  }
};

test("a when: merge needs_app check: skipped after Build, run on the trial merge against its app (stopped after); red goes back to Build", async () => {
  const r = await repo();
  // Green: a change that keeps the page working merges, with the suite run once, on the merge, on reset data.
  await control.ticket(r, "say Shop", () => {});
  const a = findJob(r, "1").id;
  await start(r, a, "intake");
  fs.writeFileSync(intakeFile(jobDirOf(r, a)), INTAKE);
  await fin(r, a);
  const merged = await throughReview(r, a, "Shop \n");
  assert.match(merged, /merged into staging/, merged);
  const checksAfterBuild = JSON.parse(fs.readFileSync(path.join(roundDir(jobDirOf(r, a), 1), "checks.json"), "utf8")) as { name: string }[];
  assert.deepEqual(
    checksAfterBuild.map((c) => c.name),
    ["guard"],
    "the e2e check never runs after Build",
  );
  assert.equal(urls().length, 1, "the suite ran once, on the trial merge");
  const [url, pw, cy] = urls()[0].split(" ");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual([pw, cy], [url, url], "PLAYWRIGHT_BASE_URL and CYPRESS_BASE_URL are the same URL");
  assert.ok(await down(url), "the app is stopped after the check");
  assert.match(fs.readFileSync(path.join(roundDir(jobDirOf(r, a), 1), "merge.log"), "utf8"), /e2e against http:\/\/127\.0\.0\.1:\d+[\s\S]*1 passed/);

  // Red: the page loses its heading; the unit-level checks still pass, the suite on the merge doesn't.
  await control.ticket(r, "retitle", () => {});
  const b = findJob(r, "2").id;
  await start(r, b, "intake");
  fs.writeFileSync(intakeFile(jobDirOf(r, b)), INTAKE);
  await fin(r, b);
  const red = await throughReview(r, b, "Store\n");
  assert.match(red, /the checks fail on staging with this change merged \(e2e: exit 1\) → build \(round 2\)/, red);
  assert.equal(findJob(r, b).stage, "build");
  assert.equal(g(r, "show", "staging:title.txt"), "Shop", "nothing landed");
  assert.equal(urls().length, 2);
  assert.ok(await down(urls()[1].split(" ")[0]), "the app is stopped after a red check too");
  const s = await start(r, b, "build");
  assert.ok("brief" in s);
  assert.match(
    fs.readFileSync(s.brief, "utf8"),
    /the merge into staging failed: the checks fail[\s\S]*expected the heading Shop/,
    "the next builder reads the suite's output",
  );
  assert.match(fs.readFileSync(s.brief, "utf8"), /on the trial merge into staging only: `node e2e\.mjs` \(with the app running/);
});
