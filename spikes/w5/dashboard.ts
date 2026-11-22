// W5 dashboard spike: real fixture jobs from a quick scripted run, the dashboard served
// by the real `kitchen dashboard`, screenshots in light and dark.
//   node spikes/w5/dashboard.ts [scratch]
// A copy of fixture A with its planted dark-mode bug, its real Toolkit (Docker, Postgres),
// the W4 scripted agent (no model), the fake forge, concurrency 2. Three tickets:
//   - the W4 dark-mode ticket (honest roles; review blocks once, round 2, report, done)
//   - the same bug with `scenario: backoff` (the builder is rate limited once: paused, then on)
//   - `scenario: inconclusive` (Verify INCONCLUSIVE twice: a Toolkit ticket, paused until the
//     spike closes it, as a person would)
// `kitchen run --detach` drains them while `kitchen dashboard` serves the board; the spike
// screenshots it mid-run and at the end (headless Chrome, ?theme=light|dark) into
// spikes/w5/screens/, and checks the server: read-only, localhost only, reports served.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Snapshot } from "../../src/dashboard/data.ts";
import { readFakeForge } from "../../src/forge/forge.ts";
import { CLI, check, finish, makeFixtureRepo, sleep, ticket } from "../w3a/lib.ts";

const HERE = import.meta.dirname;
const root = path.resolve(process.argv[2] ?? path.join(HERE, ".work"));
fs.mkdirSync(root, { recursive: true });
const SCREENS = path.join(HERE, "screens");
fs.mkdirSync(SCREENS, { recursive: true });
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 7393;
const yaml = `concurrency: 2
round_limit: 4
agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "..", "w4", "fake-agent.ts"))} }
checks:
  - { name: syntax, run: "node --check server.js" }
forge: { kind: fake }
backoff: { base_sec: 3, max_sec: 6 }
feedback: { trusted: [maintainer-alice], trust_associations: [] }
`;
const r = makeFixtureRepo(root, "w5-dashboard", { yaml, bug: true });
const BUG = "Dark mode doesn't persist. I switch it on in Settings and it says Saved, but when I reload the page the app is light again.";
ticket(r, BUG);
ticket(r, `Theme choice is lost after a reload on the settings page. ${BUG}\nscenario: backoff`);
ticket(r, `Dark mode flips back to light after a full page load. ${BUG}\nscenario: inconclusive`);

const server = spawn(process.execPath, [CLI, "dashboard", "--port", String(PORT), "--repo", r.dir], { env: r.env, stdio: "ignore" });
const runner = spawn(process.execPath, [CLI, "run", "--repo", r.dir], {
  env: r.env,
  stdio: ["ignore", fs.openSync(path.join(root, "w5-dashboard.log"), "w"), "inherit"],
});
let running = true;
runner.on("exit", () => {
  running = false;
});
const base = `http://127.0.0.1:${PORT}`;
const data = async (): Promise<Snapshot> => (await (await fetch(`${base}/data.json`)).json()) as Snapshot;
const shot = (name: string, theme: string) => {
  const f = path.join(SCREENS, `${name}-${theme}.png`);
  spawnSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1600,1000", `--screenshot=${f}`, `${base}/?theme=${theme}`], {
    stdio: "ignore",
    timeout: 60_000,
  });
  return fs.existsSync(f);
};

try {
  await sleep(1500);
  // Mid-run: wait until something is past intake and something is paused or in Verify.
  let mid = false;
  const t0 = Date.now();
  while (running && Date.now() - t0 < 15 * 60_000) {
    const d = await data().catch(() => null);
    if (d?.jobs.some((j) => j.criteria.length) && d.jobs.some((j) => j.active && j.column !== "done")) {
      if (!mid) {
        mid = shot("running", "light") && shot("running", "dark");
        check("mid-run screenshots (light, dark)", mid, d.jobs.map((j) => `${j.id.slice(0, 3)} ${j.stage}`).join(", "));
      }
    }
    // The person's part: close a Toolkit ticket the inconclusive job filed.
    const f = path.join(r.dir, ".kitchen", "fake-forge.json");
    const s = readFakeForge(f);
    if (s.tickets.some((t) => !t.closed)) {
      for (const t of s.tickets) t.closed = true;
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    }
    await sleep(2000);
  }
  const d = await data();
  check("the run ended", !running, d.jobs.map((j) => `${j.id.slice(0, 3)} ${j.stage}`).join(", "));
  check(
    "every board column is one of the dashboard's",
    d.jobs.every((j) => d.columns.some((c) => c.id === j.column)),
  );
  const done = d.jobs.filter((j) => j.stage === "done");
  check(
    "done jobs carry verdict chips, a review result, cost and a report link",
    done.length >= 1 && done.every((j) => j.criteria.length && j.review && j.report),
    done.map((j) => `${j.id.slice(0, 3)} ${j.criteria.map((c) => `${c.id}:${c.result}`).join(" ")} ${j.review?.result} ${j.report}`).join("; "),
  );
  check(
    "the summary has the §0 numbers",
    d.summary.takenIn >= 3 && d.summary.proofRuns > 0,
    JSON.stringify({ ...d.summary, escalations: d.summary.escalations.length }),
  );
  check("final screenshots (light, dark)", shot("done", "light") && shot("done", "dark"));
  if (done[0]?.report) {
    const rep = await fetch(`${base}/${done[0].report}`);
    const body = await rep.text();
    check(
      "a report link serves the job's report.html",
      rep.status === 200 && body.includes("<html") && /default-src 'none'/.test(rep.headers.get("content-security-policy") ?? ""),
      `${rep.status}`,
    );
  }
  const post = await fetch(`${base}/data.json`, { method: "POST" });
  check("read-only: POST is refused", post.status === 405);
  const host = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-H", "Host: attacker.example", `${base}/data.json`], {
    encoding: "utf8",
  }).stdout;
  check("localhost only: a foreign Host header is refused (DNS rebinding)", host === "403", host);
  const trav = await fetch(`${base}/jobs/..%2F..%2Fkitchen.yaml/report.html`);
  check("no path outside a job's report", trav.status === 404, String(trav.status));
  const bound = spawnSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout;
  check("it listens on 127.0.0.1 only", bound.includes(`127.0.0.1:${PORT}`) && !bound.includes(`*:${PORT}`), bound.trim().split("\n").slice(1).join(" | "));
} finally {
  server.kill();
  if (running) runner.kill("SIGTERM");
  await sleep(1000);
}
finish("w5 dashboard");
