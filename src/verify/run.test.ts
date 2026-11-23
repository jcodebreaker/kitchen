// `kitchen verify sweep|maintain|finish` on a real git repo with a tiny real app, and a stand-in agent writing what
// the run's agent would: the sweep drives against staging and changes nothing; maintain lands map fixes through the
// merge gate, and is refused for product code or a removal without a reason.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { loadConfig } from "../config.ts";
import { ensureStaging } from "../engine/staging.ts";
import { http } from "../qa/app.ts";
import { runEvidence } from "./paths.ts";
import { finishRun, prepare, readRun } from "./run.ts";
import { writeVerifySkill } from "./skill.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-vrun-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();
let n = 0;
const SK = ".claude/skills/verify-demo";
const FEATURE = (id: string, gotcha = "None yet.") => `# ${id}

What ${id} does.

## Sub-features

- \`${id}-up\` answers.

## How to get to it (user POV)

- GET /healthz.

## Driving it with kitchen qa

Preconditions:

- The app is up.

- **Health.** Ask it. Run \`kitchen qa http <id> GET /healthz --name ${id}-health\`. 200 and ok.

## Gotchas

- ${gotcha}

Code: \`server.js\`
`;

async function repo(): Promise<string> {
  const r = path.join(root, `r${++n}`);
  fs.mkdirSync(r);
  g(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "package.json"), JSON.stringify({ name: "demo" }));
  fs.writeFileSync(
    path.join(r, "server.js"),
    `require("node:http").createServer((q, s) => s.end(JSON.stringify({ ok: true, url: q.url }))).listen(Number(process.env.PORT), "127.0.0.1");\n`,
  );
  fs.writeFileSync(path.join(r, "kitchen.yaml"), `checks: [{ name: guard, run: "test ! -e BROKEN" }]\napp: { start: "node server.js", health: "/healthz" }\n`);
  fs.writeFileSync(path.join(r, ".gitignore"), ".kitchen/\n.worktrees/\n");
  writeVerifySkill(r, loadConfig(r));
  for (const root of [".claude", ".agents"]) {
    fs.writeFileSync(path.join(r, root, "skills/verify-demo/features/health.md"), FEATURE("health"));
    fs.writeFileSync(path.join(r, root, "skills/verify-demo/features/zeta.md"), FEATURE("zeta"));
    fs.appendFileSync(path.join(r, root, "skills/verify-demo/features/README.md"), "\n- [Zeta](./zeta.md)\n- [Health](./health.md)\n");
  }
  g(r, "add", "-A");
  g(r, "commit", "-qm", "base");
  await ensureStaging(r, loadConfig(r), () => {});
  return r;
}

test("sweep: staging checked out, the app up, every feature in README order; the report written and nothing changed", async () => {
  const r = await repo();
  const tip = g(r, "rev-parse", "staging");
  const lines: string[] = [];
  const p = await prepare(r, "sweep", (l) => lines.push(l), new Date("2026-11-23T10:00:00Z"));
  assert.equal(p.id, "sweep-20261123-100000");
  assert.match(lines[0], /sweep sweep-20261123-100000: 2 features \(zeta, health\) on staging [0-9a-f]{7} · app: up at http/);
  const brief = fs.readFileSync(p.brief, "utf8");
  assert.match(brief, /## The map, in sweep order \(zeta, health\)[\s\S]*### zeta[\s\S]*### health/);
  assert.match(brief, /# Role: release sweep/);
  assert.match(p.prompt, /Change nothing/);
  // The agent drives it with the run id in place of a job.
  assert.equal(await http(r, p.id, "GET", "/healthz", { name: "health-health", headers: [] }, () => {}), 0);
  const ev = runEvidence(r, p.id);
  assert.match(fs.readFileSync(path.join(ev, "health-health.http.txt"), "utf8"), /HTTP 200/);
  fs.writeFileSync(
    path.join(ev, "verdict.json"),
    JSON.stringify({ features: [{ id: "health", result: "PASS", evidence: ["health-health.http.txt"], note: "200" }] }),
  );
  const out: string[] = [];
  assert.equal(await finishRun(r, p.id, (l) => out.push(l)), 1, "a feature without a row is refused");
  assert.match(out[0], /no row for feature zeta/);
  fs.writeFileSync(
    path.join(ev, "verdict.json"),
    JSON.stringify({
      features: [
        { id: "zeta", result: "FAIL", evidence: ["health-health.http.txt"], note: "Health: 404" },
        { id: "health", result: "PASS", evidence: ["health-health.http.txt"], note: "200" },
      ],
    }),
  );
  out.length = 0;
  assert.equal(await finishRun(r, p.id, (l) => out.push(l)), 0);
  assert.match(out.at(-1) as string, /sweep sweep-20261123-100000: FAIL \(1 of 2 features\) · report \.kitchen\/verify\/sweep-20261123-100000\/report\.html/);
  assert.ok(!fs.existsSync(path.join(r, ".kitchen/verify", p.id, "wt")), "the checkout is gone, the evidence stays");
  assert.ok(fs.existsSync(path.join(ev, "health-health.http.txt")));
  assert.equal(g(r, "rev-parse", "staging"), tip, "a sweep changes nothing");
  assert.equal(readRun(r, p.id).kind, "sweep");
});

test("maintain: map fixes on its branch land in staging for both tools; product code or an unexplained removal is refused", async () => {
  const r = await repo();
  const p = await prepare(r, "maintain", () => {}, new Date("2026-11-23T11:00:00Z"));
  assert.match(fs.readFileSync(p.brief, "utf8"), /# Role: map upkeep \(maintain\)/);
  const wt = p.cwd;
  const ev = runEvidence(r, p.id);
  // The agent fixes a gotcha, prunes zeta, and (wrongly) touches product code.
  fs.writeFileSync(path.join(wt, SK, "features/health.md"), FEATURE("health", "It answers any path."));
  fs.rmSync(path.join(wt, SK, "features/zeta.md"));
  fs.writeFileSync(path.join(wt, "server.js"), "// oops\n");
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "map fixes");
  const report = {
    outcome: "changed",
    features: [
      { id: "zeta", result: "PASS", note: "x" },
      { id: "health", result: "PASS", note: "x" },
    ],
    removals: [] as unknown[],
  };
  fs.writeFileSync(path.join(ev, "report.json"), JSON.stringify(report));
  const out: string[] = [];
  assert.equal(await finishRun(r, p.id, (l) => out.push(l)), 1);
  assert.match(out[0], /changed files outside the verify skill \(server\.js\)/);
  g(wt, "checkout", "-q", "HEAD~1", "--", "server.js");
  g(wt, "commit", "-qm", "put server.js back");
  out.length = 0;
  assert.equal(await finishRun(r, p.id, (l) => out.push(l)), 1);
  assert.match(out[0], /these removals have no reason in report\.json's removals: zeta\/zeta-up; zeta: Health/);
  report.removals = [{ item: "zeta", why: "the zeta page is gone" }];
  fs.writeFileSync(path.join(ev, "report.json"), JSON.stringify({ ...report, tickets: ["004"] }));
  out.length = 0;
  assert.equal(await finishRun(r, p.id, (l) => out.push(l)), 0, out.join("\n"));
  assert.match(out[0], /maintain maintain-20261123-110000: changed · 2 files merged into staging \([0-9a-f]{7}\) · tickets 004/);
  assert.match(g(r, "show", `staging:${SK}/features/health.md`), /It answers any path\./);
  assert.match(g(r, "show", "staging:.agents/skills/verify-demo/features/health.md"), /It answers any path\./, "the Codex copy mirrors it");
  assert.throws(() => g(r, "show", "staging:.agents/skills/verify-demo/features/zeta.md"));
  assert.equal(g(r, "show", "staging:server.js").includes("createServer"), true);
  assert.equal(g(r, "show", "main:server.js").includes("createServer"), true);
  assert.match(fs.readFileSync(path.join(r, ".kitchen/verify", p.id, "report.html"), "utf8"), /zeta: the zeta page is gone/);
});
