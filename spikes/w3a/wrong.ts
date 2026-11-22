// The other half of the admin proof: the spec a real run wrote must FAIL a
// deliberately wrong builder. Replays a finished `e2e.ts <tool> admin` run's
// intake.md, spec.md, feature drives and test files on a fresh copy of fixture A,
// with a scripted builder (fake-agent.ts scenario `replay`) whose server.js is the
// real builder's, mutated so the project list ignores who is asking: every
// project, with its owner, for every signed-in user. The engine's own proofs must
// then FAIL the negative criterion in Verify.
//   node spikes/w3a/wrong.ts claude|codex <scratch>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseCriteria } from "../../src/checks/spec-lint.ts";
import { isJudged, negativeClauses, parseExpect } from "../../src/proof/assert.ts";
import { check, finish, HERE, jobDir, jobOf, kitchenContainers, makeFixtureRepo, type Repo, stagesOf, stepUntil, ticket } from "./lib.ts";

const tool = process.argv[2];
if (tool !== "claude" && tool !== "codex") throw new Error("usage: wrong.ts claude|codex <scratch>");
const root = path.resolve(process.argv[3] ?? path.join(HERE, ".work"));
const src = path.join(root, `e2e-${tool}-admin`);
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const jobs = fs.readdirSync(path.join(src, ".kitchen", "jobs"));
if (jobs.length !== 1) throw new Error(`expected one job in ${src}, found ${jobs.join(", ")}`);
const srcJob = path.join(src, ".kitchen", "jobs", jobs[0]);
const branch = `kitchen/${jobs[0]}`;
const base = git(src, "rev-list", "--max-parents=0", "HEAD").trim();

// The replay: the real run's contract, drives and tests; the real build, made wrong.
const replay = path.join(root, `wrong-${tool}-replay`);
fs.rmSync(replay, { recursive: true, force: true });
fs.mkdirSync(replay, { recursive: true });
for (const f of ["intake.md", "spec.md"]) fs.copyFileSync(path.join(srcJob, f), path.join(replay, f));
const spec = fs.readFileSync(path.join(replay, "spec.md"), "utf8");
const changed = git(src, "diff", "--name-only", base, branch).trim().split("\n").filter(Boolean);
const testFiles = parseCriteria(spec).flatMap((c) => (/^test\s+(\S+)/.exec(c.proof ?? "")?.[1] ? [/^test\s+(\S+)/.exec(c.proof ?? "")?.[1] as string] : []));
for (const f of changed) {
  const text = git(src, "show", `${branch}:${f}`);
  const dest = f.startsWith(".kitchen/toolkit/features/")
    ? path.join(replay, "features", path.basename(f))
    : testFiles.includes(f)
      ? path.join(replay, "tests", f)
      : path.join(replay, "files", f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
}

/** The wrong build: in the GET /projects handler, whatever decides "admin or not" is forced to admin. */
function leak(server: string): { text: string; how: string } {
  const start = server.indexOf('if (path === "/projects" && method === "GET")');
  if (start < 0) throw new Error("no GET /projects handler in the real build");
  const end = server.indexOf("\n  if (", start + 10);
  const block = server.slice(start, end < 0 ? undefined : end);
  const admin = /\b(user\??\.is_admin|user\??\.admin|isAdmin\(user\)|is_admin)\b/g;
  const hits = block.match(admin) ?? [];
  if (!hits.length) throw new Error(`can't find the admin check in the real /projects handler:\n${block}`);
  return {
    text: server.slice(0, start) + block.replace(admin, "true") + server.slice(start + block.length),
    how: `${hits.join(", ")} → true in GET /projects`,
  };
}
const serverFile = path.join(replay, "files", "server.js");
const wrong = leak(fs.readFileSync(serverFile, "utf8"));
fs.writeFileSync(serverFile, wrong.text);
console.log(`    wrong builder: the real ${tool} build with ${wrong.how}`);

const yaml = `concurrency: 1
round_limit: 1
agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-agent.ts"))} }
checks:
  - { name: syntax, run: "node --check server.js" }
test_cmd: "node --test {file}"
`;
const r: Repo = makeFixtureRepo(root, `wrong-${tool}`, { yaml });
r.env.W3A_REPLAY = replay;
const id = ticket(r, `${fs.readFileSync(path.join(srcJob, "ticket.md"), "utf8").trim()}\n\nscenario: replay`);
const log = path.join(root, `wrong-${tool}.log`);
fs.writeFileSync(log, "");
stepUntil(r, id, ["review", "needs-human", "needs-info", "rejected", "done", "paused", "build"], { max: 30, log });
// The first build runs the wrong builder; step on until Verify has decided once.
const verdictOf = () => {
  const d = path.join(jobDir(r, id), "rounds", "1");
  const f = fs.existsSync(d) ? fs.readdirSync(d).filter((x) => /^verdict-m\d+\.md$/.test(x)) : [];
  return f.length ? fs.readFileSync(path.join(d, f.sort().at(-1) as string), "utf8") : "";
};
for (let i = 0; i < 30 && !verdictOf() && !["needs-human", "rejected", "needs-info"].includes(jobOf(r, id).stage); i++)
  stepUntil(r, id, ["review", "needs-human", "needs-info", "rejected", "done", "paused"], { max: 1, log });
const v = verdictOf();
console.log(`    path: ${stagesOf(r, id).join(" → ")}`);
console.log(v.replace(/^/gm, "    | "));
const negatives = parseCriteria(spec).filter((c) => {
  try {
    return !!c.expect && !isJudged(c.expect) && negativeClauses(parseExpect(c.expect)).length > 0;
  } catch {
    return false;
  }
});
check(`wrong ${tool}: Verify decided`, /^VERDICT: /m.test(v), v.split("\n")[0] ?? "no verdict");
check(`wrong ${tool}: the verdict is FAIL`, /^VERDICT: FAIL/m.test(v));
const failed = negatives.filter((c) => new RegExp(`^\\| ${c.id} \\| engine \\| FAIL`, "m").test(v));
check(
  `wrong ${tool}: the engine FAILs the negative criterion (a regular user sees another user's project)`,
  failed.length > 0,
  failed.map((c) => v.split("\n").find((l) => l.startsWith(`| ${c.id} |`))).join(" ") || negatives.map((c) => c.id).join(", "),
);
check(
  `wrong ${tool}: no container of this job left running`,
  kitchenContainers(jobOf(r, id).slotId).length === 0,
  kitchenContainers(jobOf(r, id).slotId).join(" "),
);
finish(`w3a wrong ${tool}`);
