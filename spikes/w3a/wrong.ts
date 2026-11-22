// The other half of the admin proof: the spec a real run wrote must FAIL a
// deliberately wrong builder. Replays a finished `e2e.ts <tool> admin` run's
// intake.md, spec.md, feature drives and test files on a fresh copy of fixture A,
// with a scripted builder (fake-agent.ts scenario `replay`) whose server.js is the
// real builder's, mutated so the project list ignores who is asking: every
// project, with its owner, for every signed-in user. The engine's own proofs must
// then FAIL the negative criterion in Verify.
//   node spikes/w3a/wrong.ts claude|codex [leak|owner] <scratch>
// leak (default): every project, with its owner, for every signed-in user.
// owner (review round 2): regular users still see only their own projects, but every row shows its
//   owner for everyone: the criterion covering "no owner shown for regular users" must FAIL.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseCriteria, parseRequirements } from "../../src/checks/spec-lint.ts";
import { isJudged, negativeClauses, parseExpect } from "../../src/proof/assert.ts";
import { check, finish, HERE, jobDir, jobOf, kitchenContainers, makeFixtureRepo, type Repo, stagesOf, stepUntil, ticket } from "./lib.ts";

const tool = process.argv[2];
if (tool !== "claude" && tool !== "codex") throw new Error("usage: wrong.ts claude|codex [leak|owner] <scratch>");
const mode = process.argv[3] === "owner" || process.argv[3] === "leak" ? process.argv[3] : "leak";
const root = path.resolve(process.argv.slice(3).find((a) => a !== "owner" && a !== "leak") ?? path.join(HERE, ".work"));
const src = path.join(root, `e2e-${tool}-admin`);
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const jobs = fs.readdirSync(path.join(src, ".kitchen", "jobs"));
if (jobs.length !== 1) throw new Error(`expected one job in ${src}, found ${jobs.join(", ")}`);
const srcJob = path.join(src, ".kitchen", "jobs", jobs[0]);
const branch = `kitchen/${jobs[0]}`;
const base = git(src, "rev-list", "--max-parents=0", "HEAD").trim();

// The replay: the real run's contract, drives and tests; the real build, made wrong.
const replay = path.join(root, `wrong-${tool}-${mode}-replay`);
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

const ADMIN = /\b(user\??\.is_admin|user\??\.admin|isAdmin\(user\)|is_admin)\b/g;
function projectsBlock(server: string): { start: number; block: string } {
  const start = server.indexOf('if (path === "/projects" && method === "GET")');
  if (start < 0) throw new Error("no GET /projects handler in the real build");
  const end = server.indexOf("\n  if (", start + 10);
  return { start, block: server.slice(start, end < 0 ? undefined : end) };
}

/**
 * The owner-for-everyone build: the list query stays per role (a regular user gets only their own
 * projects), but the regular user's query also joins the owner, as the admin's does, and every
 * admin check outside the queries (the markup) is forced true, so every row shows its owner.
 */
function ownerForAll(server: string): { text: string; how: string } {
  const { start, block } = projectsBlock(server);
  const queries = [...block.matchAll(/pool\.query\(\s*"([^"]*)"/g)].map((m) => m[1]);
  const adminQ = queries.find((q) => /\bJOIN\b/i.test(q) && /owner/i.test(q));
  const ownQ = queries.find((q) => q !== adminQ && /owner_id\s*=\s*\$1/.test(q));
  if (!adminQ || !ownQ) throw new Error(`can't find the admin (JOIN … owner) and own (owner_id = $1) queries in the real /projects handler:\n${block}`);
  const alias = /FROM\s+projects\s+(?:AS\s+)?(\w+)/i.exec(adminQ)?.[1] ?? "projects";
  const ownWithOwner = adminQ.replace(/\s+ORDER BY/i, ` WHERE ${alias}.owner_id = $1 ORDER BY`);
  let out = block.replace(ownQ, ownWithOwner);
  // Only the lines that render (not the query choice): the admin check there becomes true.
  out = out
    .split("\n")
    .map((l) => (/pool\.query|\?\s*$/.test(l) || /^\s*const \{ rows \} = /.test(l) ? l : l.replace(ADMIN, "true")))
    .join("\n");
  if (out === block.replace(ownQ, ownWithOwner)) throw new Error(`no admin check in the markup of the real /projects handler:\n${block}`);
  return {
    text: server.slice(0, start) + out + server.slice(start + block.length),
    how: `the owner joined into the regular user's query and the markup's admin check → true (regular users still get only their own projects)`,
  };
}

/** The wrong build: in the GET /projects handler, whatever decides "admin or not" is forced to admin. */
function leak(server: string): { text: string; how: string } {
  const { start, block } = projectsBlock(server);
  const admin = ADMIN;
  const hits = block.match(admin) ?? [];
  if (!hits.length) throw new Error(`can't find the admin check in the real /projects handler:\n${block}`);
  return {
    text: server.slice(0, start) + block.replace(admin, "true") + server.slice(start + block.length),
    how: `${hits.join(", ")} → true in GET /projects`,
  };
}
const serverFile = path.join(replay, "files", "server.js");
const wrong = (mode === "owner" ? ownerForAll : leak)(fs.readFileSync(serverFile, "utf8"));
fs.writeFileSync(serverFile, wrong.text);
console.log(`    wrong builder: the real ${tool} build with ${wrong.how}`);

const yaml = `concurrency: 1
round_limit: 1
agent: { tool: fake, script: ${JSON.stringify(path.join(HERE, "fake-agent.ts"))} }
checks:
  - { name: syntax, run: "node --check server.js" }
test_cmd: "node --test {file}"
`;
const r: Repo = makeFixtureRepo(root, `wrong-${tool}-${mode}`, { yaml });
r.env.W3A_REPLAY = replay;
const id = ticket(r, `${fs.readFileSync(path.join(srcJob, "ticket.md"), "utf8").trim()}\n\nscenario: replay`);
const log = path.join(root, `wrong-${tool}-${mode}.log`);
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
const row = (id: string) => v.split("\n").find((l) => l.startsWith(`| ${id} |`)) ?? "";
const failedIds = (cs: { id: string }[]) => cs.filter((c) => new RegExp(`^\\| ${c.id} \\| engine \\| FAIL`, "m").test(v));
if (mode === "leak") {
  const failed = failedIds(negatives);
  check(
    `wrong ${tool}: the engine FAILs the negative criterion (a regular user sees another user's project)`,
    failed.length > 0,
    failed.map((c) => row(c.id)).join(" ") || negatives.map((c) => c.id).join(", "),
  );
} else {
  // The criterion covering intake's "no owner shown" requirement FAILs; the one covering "only their own" still PASSes.
  const reqs = parseRequirements(fs.readFileSync(path.join(replay, "intake.md"), "utf8"));
  const owner = reqs.filter((x) => x.negative && /owner/i.test(x.text)).map((x) => x.id);
  const own = reqs.filter((x) => x.negative && !/owner/i.test(x.text)).map((x) => x.id);
  const all = parseCriteria(spec);
  const ownerCrit = all.filter((c) => c.covers.some((x) => owner.includes(x)));
  const ownCrit = all.filter((c) => c.covers.some((x) => own.includes(x)) && !ownerCrit.includes(c));
  const failed = failedIds(ownerCrit);
  check(
    `wrong ${tool} owner: the engine FAILs the criterion covering "no owner shown" (${owner.join(", ")}) for alice`,
    failed.length > 0,
    failed.map((c) => row(c.id)).join(" ") || ownerCrit.map((c) => row(c.id) || c.id).join(" "),
  );
  check(
    `wrong ${tool} owner: the "only their own" criterion still PASSes (this builder keeps the per-user list)`,
    ownCrit.length > 0 && ownCrit.every((c) => /\| engine \| PASS/.test(row(c.id))),
    ownCrit.map((c) => row(c.id)).join(" "),
  );
}
check(
  `wrong ${tool}: no container of this job left running`,
  kitchenContainers(jobOf(r, id).slotId).length === 0,
  kitchenContainers(jobOf(r, id).slotId).join(" "),
);
finish(`w3a wrong ${tool} ${mode}`);
