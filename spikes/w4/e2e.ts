// W4 exit, REAL agents (Claude: sonnet for strong roles, haiku for medium: verifier,
// reviewers, report): one ticket on a copy of fixture A, all the way to done, through
// the fake forge (PRs, labels, comments) and a real `kitchen-evidence` branch.
//   node spikes/w4/e2e.ts ui|auth <scratch>
// ui:   a medium UI feature (projects count + empty state): lenses code, ux, ui; Verify
//       takes no screenshot (no judged criterion), so the UX/UI lenses must ask for views
//       (VIEW lines the engine runs, then a second pass); report rendered and published.
// auth: a high-risk sign-in change: lenses code + security (+ ux/ui if intake says ui),
//       the PR labelled kitchen:review-required, the report opens with "what a human must check".
// Both: every evidence id in report.html resolved; a planted id in report.src.html is
// refused by the renderer; cost/time per stage from the ledger.
// Writes <scratch>/w4-<kind>.json and .log; copies report.html next to them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { renderRefusal } from "../../src/checks/report-render.ts";
import { readFakeForge } from "../../src/forge/forge.ts";
import { readLedger } from "../../src/ledger/append.ts";
import { stageCosts } from "../../src/ledger/report.ts";
import { CLAUDE_BIN, check, finish, jobDir, jobOf, kitchenContainers, ledger, makeFixtureRepo, manifest, stagesOf, stepUntil, ticket } from "../w3a/lib.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const [kind] = process.argv.slice(2);
if (kind !== "ui" && kind !== "auth") throw new Error("usage: e2e.ts ui|auth <scratch>");
const root = path.resolve(process.argv[3] ?? path.join(HERE, ".work"));
fs.mkdirSync(root, { recursive: true });
const name = `w4-${kind}`;

const TICKETS = {
  ui: 'On the Projects page, show how many projects the signed-in user has in the heading, e.g. "Projects (1)", and show the same count in the top navigation\'s Projects link on every page, e.g. "Projects · 1". When the user has no projects, the Projects page shows an empty state saying "No projects yet" with a link "Create your first project" that goes to /projects/new.',
  // Earlier attempts (results.md): a sign-in ticket intake rated a low-risk bug, and a "sign out of all devices"
  // ticket whose spec needed test proofs that can't reach the slot's app (they assumed port 3000). This one is
  // W3a's permissions ticket, which proves with the Toolkit only.
  auth: "Permissions (authorization): admins see every user's projects with the owner shown; regular users still see only their own, with no owner shown.",
};
const yaml = `concurrency: 2
round_limit: 3
agent: { tool: claude, command: [${JSON.stringify(CLAUDE_BIN)}], models: { strong: sonnet, medium: haiku }, timeout_sec: 1800, max_turns: 80 }
checks:
  - { name: syntax, run: "node --check server.js" }
test_cmd: "node --test {file}"
forge: { kind: fake }
`;

// W4_RESUME=1: carry on with the job already in <scratch>/w4-<kind> (after a person answered it with `kitchen feedback`).
const resume = !!process.env.W4_RESUME;
const r = resume
  ? (() => {
      const dir = path.join(root, name);
      const home = path.join(root, "kitchen-home");
      return {
        dir,
        home,
        env: { ...process.env, KITCHEN_HOME: home, KITCHEN_TICK_MS: "200", KITCHEN_FAKE_STATE: path.join(dir, ".kitchen", "fake-state.json") },
      };
    })()
  : makeFixtureRepo(root, name, { yaml });
const id = resume ? fs.readdirSync(path.join(r.dir, ".kitchen", "jobs"))[0] : ticket(r, TICKETS[kind]);
const log = path.join(root, `${name}.log`);
if (!resume) fs.writeFileSync(log, "");
const t0 = Date.now();
stepUntil(r, id, ["done", "needs-human", "needs-info", "rejected", "paused"], { max: 45, log });
const wall = Math.round((Date.now() - t0) / 1000);
const j = jobOf(r, id);
const dir = jobDir(r, id);
const read = (rel: string) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), "utf8") : "");
const lines = ledger(r).filter((l) => l.job === id);
const agents = lines.filter((l) => l.event === "agent");
const usd = agents.reduce((n, a) => n + (a.usd ?? 0), 0);
const costs = stageCosts(readLedger(r.dir), id, j.startedAt);
const lastRound = fs.existsSync(path.join(dir, "rounds")) ? Math.max(...fs.readdirSync(path.join(dir, "rounds")).map(Number).filter(Number.isInteger)) : 0;
const reviewRound = [...Array(lastRound).keys()].map((n) => lastRound - n).find((n) => fs.existsSync(path.join(dir, "rounds", String(n), "review.json")));
const review = reviewRound
  ? (JSON.parse(read(`rounds/${reviewRound}/review.json`)) as {
      lenses: string[];
      findings: { id: string; blocks: boolean; lenses: string[]; title: string; downgraded?: string }[];
    })
  : null;
const views = reviewRound
  ? fs
      .readdirSync(path.join(dir, "rounds", String(reviewRound)))
      .filter((f) => f.startsWith("views-"))
      .flatMap((f) =>
        (JSON.parse(read(`rounds/${reviewRound}/${f}`)) as { view: string; ok: boolean; evidence: string[]; why?: string }[]).map((v) => ({
          lens: f.split("-")[1],
          ...v,
        })),
      )
  : [];
const html = read("report.html");
if (html) fs.writeFileSync(path.join(root, `${name}.report.html`), html);
for (const f of ["intake.md", "spec.md", "report.src.html"]) if (read(f)) fs.copyFileSync(path.join(dir, f), path.join(root, `${name}.${f}`));
const ff = readFakeForge(path.join(r.dir, ".kitchen", "fake-forge.json"));
const result = {
  kind,
  job: id,
  stage: j.stage,
  pausedReason: j.pausedReason,
  path: stagesOf(r, id),
  risk: j.risk,
  riskFloor: j.riskFloor,
  surfaces: j.surfaces,
  rounds: j.round,
  wallSecs: wall,
  usd: Math.round(usd * 10000) / 10000,
  costs,
  agents: agents.map((a) => ({ role: a.role, model: a.model, stage: a.stage, round: a.round, secs: Math.round(a.secs ?? 0), usd: a.usd, result: a.result })),
  review,
  views,
  forge: { labels: ff.labels, comments: ff.comments.map((c) => ({ key: c.key, calls: c.calls, body: c.body })), evidence: ff.evidence },
  reportRefusals: fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("report-refused-"))
    .map((f) => read(f).trim()),
};
fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(result, null, 2));
console.log(`    path: ${result.path.join(" → ")}`);
for (const c of costs) console.log(`    ${c.stage.padEnd(8)} r${c.round} ${String(c.secs).padStart(5)}s  $${c.usd.toFixed(3)}  ${c.roles}`);
console.log(`    total ${wall}s wall, $${usd.toFixed(3)}; risk ${j.risk}/${j.riskFloor}, surfaces ${j.surfaces.join(",")}`);
for (const f of review?.findings ?? [])
  console.log(`    finding ${f.id} [${f.lenses.join("+")}] ${f.blocks ? "BLOCKS" : "note"}: ${f.title}${f.downgraded ? ` (${f.downgraded})` : ""}`);
for (const v of views) console.log(`    VIEW (${v.lens}) ${v.view} → ${v.ok ? "ok" : `failed: ${v.why}`} ${v.evidence.join(" ")}`);

check(`${kind}: reached done`, j.stage === "done", `${j.stage}${j.pausedReason ? ` (${j.pausedReason})` : ""}`);
check(`${kind}: report.html rendered, every evidence id resolved`, !!html && !/\{\{/.test(html) && /id="evidence"/.test(html));
const src = read("report.src.html");
const head = execFileSync("git", ["-C", r.dir, "rev-parse", j.branch], { encoding: "utf8" }).trim();
const entries = manifest(r, id);
check(
  `${kind}: the report role's own source renders for the final HEAD`,
  !!src && renderRefusal(src, entries, head, j.risk === "high" || j.riskFloor === "high") === null,
);
check(
  `${kind}: a planted made-up id in report.src.html is refused`,
  /unknown evidence id e999999/.test(renderRefusal(`${src}<p>{{e999999}}</p>`, entries, head, false) ?? ""),
  renderRefusal(`${src}<p>{{e999999}}</p>`, entries, head, false) ?? "accepted",
);
const stale = entries.find((e) => e.sha !== head);
if (stale)
  check(
    `${kind}: an id stamped for an older HEAD is refused`,
    /not stamped for the final HEAD/.test(renderRefusal(`${src}{{${stale.id}}}`, entries, head, false) ?? ""),
    stale.id,
  );
let branchFiles = "";
try {
  branchFiles = execFileSync("git", ["-C", r.dir, "ls-tree", "-r", "--name-only", "kitchen-evidence"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {} // no evidence branch: nothing was published
check(
  `${kind}: published to the kitchen-evidence branch (report.html + evidence)`,
  branchFiles.includes(`${id}/report.html`) && branchFiles.includes(`${id}/evidence/manifest.jsonl`),
);
const comment = ff.comments.find((c) => c.key.startsWith(`${id}/report-comment/`));
check(
  `${kind}: PR comment with the per-criterion table and the report link (fake forge)`,
  !!comment && /\| criterion \| covers \|/.test(comment.body) && /report\.html/.test(comment.body),
  comment?.body.split("\n")[0],
);
if (kind === "ui") {
  check(
    "ui: lenses include ux and ui (and code: medium)",
    ["code", "ux", "ui"].every((l) => review?.lenses.includes(l)),
    review?.lenses.join(", "),
  );
  check("ui: risk medium", (j.riskFloor ?? j.risk) === "medium" || j.risk === "medium", `${j.risk}/${j.riskFloor}`);
  check(
    "ui: at least one VIEW request ran through the engine and the lens was re-run with it",
    views.some((v) => v.ok && v.evidence.length > 0) &&
      fs.readdirSync(path.join(dir, "rounds", String(reviewRound))).some((f) => /^review-u[xi]-views\.md$/.test(f)),
    views.map((v) => `${v.lens}: ${v.view}`).join("; "),
  );
  const viewIds = views.flatMap((v) => v.evidence);
  check(
    "ui: the view evidence is stamped with the lens's role",
    entries.filter((e) => viewIds.includes(e.id)).every((e) => String(e.role).startsWith("reviewer-") && String(e.criterion).startsWith("view:")),
  );
}
if (kind === "auth") {
  check("auth: risk high (intake or floor)", j.risk === "high" || j.riskFloor === "high", `${j.risk}/${j.riskFloor}`);
  check(
    "auth: code and security lenses ran",
    ["code", "security"].every((l) => review?.lenses.includes(l)),
    review?.lenses.join(", "),
  );
  check(
    "auth: PR labelled kitchen:review-required (fake forge)",
    ff.labels.some((l) => l.label === "kitchen:review-required" && l.pr === j.pr),
    JSON.stringify(ff.labels),
  );
  check(
    "auth: the report opens with what a human must check",
    html.indexOf('id="human-check"') > 0 && html.indexOf('id="human-check"') < html.indexOf('id="summary"') && /HUMAN REVIEW REQUIRED/.test(html),
  );
}
const left = kitchenContainers(j.slotId);
check(`${kind}: no container of this job left running`, left.length === 0, left.join(" "));
finish(`w4 e2e ${kind}`);
