// ADR 0014 in a job: the role prompt carries the skills, the run pins them, a missing required
// skill halts before any agent runs, a changed skill on a rerun is logged, the Report says what was used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { FakeAdapter } from "../../agents/fake.ts";
import { type ReportFacts, renderReport, skillsSection } from "../../checks/report-render.ts";
import { parseConfig } from "../../config.ts";
import { readLedger } from "../../ledger/append.ts";
import { steer } from "../control.ts";
import { type Job, move } from "../machine.ts";
import { readMessages } from "../messages.ts";
import { createJob, jobDirOf, readJobAt, updateJob } from "../store.ts";
import { runRole } from "./role.ts";
import { changedSince, jobRoles, skillsUsed } from "./skills.ts";
import { SkillMissing, type StageContext } from "./types.ts";

let root = "";
let repo = "";
let home = "";
const saved = { HOME: process.env.HOME, KITCHEN_HOME: process.env.KITCHEN_HOME };
const logs: string[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-role-skills-"));
  repo = path.join(root, "repo");
  home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true });
  process.env.HOME = home;
  process.env.KITCHEN_HOME = path.join(root, ".kitchen-home");
  logs.length = 0;
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.KITCHEN_HOME = saved.KITCHEN_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

const skill = (name: string, body: string, dir = path.join(home, ".claude", "skills")) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n${body}\n`);
  return path.join(dir, name, "SKILL.md");
};

async function job(o: Partial<Pick<Job, "kind" | "risk" | "surfaces">> = {}, body = "Show the open count.") {
  const { job } = await createJob(repo, { title: "Show the open count", ticket: { source: "prompt", id: "p1" }, body, roundLimit: 3, base: "" });
  return updateJob(repo, job.id, (j) => ({ ...j, stage: "build", kind: "feature", risk: "medium", ...o }));
}

function ctxOf(j: Job, agent: FakeAdapter, yaml = "version: 1"): StageContext {
  const jobDir = jobDirOf(repo, j.id);
  return {
    repo,
    job: j,
    jobDir,
    config: parseConfig(yaml),
    agent,
    forge: {} as StageContext["forge"],
    source: {} as StageContext["source"],
    now: () => new Date(),
    log: (l) => logs.push(l),
    refresh: () => readJobAt(jobDir),
    holdsLock: () => true,
  };
}

const build = (ctx: StageContext) =>
  runRole(ctx, { role: "builder", file: "build.md", tier: "read", prompt: "Build it.", dest: path.join(ctx.jobDir, `build-${Date.now()}.md`) });

test("the builder's prompt ends with its skills, quoted; the run pins name, path, host and sha256 in job.json and the ledger", async () => {
  const tdd = skill("tdd", "# TDD\nWrite the failing test first.");
  const j = await job();
  const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
  await build(ctxOf(j, agent));
  const prompt = agent.calls[0].prompt;
  const at = prompt.indexOf("# Skills");
  assert.ok(prompt.startsWith("Build it.") && at > 0, "after the role's own prompt");
  assert.match(prompt.slice(at), /## Skill: tdd \(sha256 [0-9a-f]{12}\)\n<<<SKILL-[0-9a-f]+\n# TDD\nWrite the failing test first.\nSKILL-[0-9a-f]+>>>/);
  assert.ok(!prompt.includes("name: tdd"), "frontmatter stripped");
  const [run] = readJobAt(jobDirOf(repo, j.id)).agentRuns;
  const sha = run.skills?.[0].sha256 ?? "";
  assert.deepEqual(run.skills, [{ name: "tdd", path: tdd, host: "claude", sha256: sha, chars: 35, truncated: false }]);
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.deepEqual(run.skillsSkipped, ["implement", "codebase-design"], "the optional ones not installed are skipped");
  const line = readLedger(repo).find((l) => l.event === "agent");
  assert.deepEqual(line?.detail?.skills, [{ name: "tdd", path: tdd, host: "claude", sha256: sha }]);
  assert.ok(logs.some((l) => l === "builder: skill implement skipped (kind feature/ui): not installed for claude"));
});

test("skills off (kitchen.yaml, the bench's --no-skills) or a fake tool with no skills.host: the prompt alone", async () => {
  skill("tdd", "# TDD");
  const j = await job();
  for (const yaml of ["version: 1\nskills: { enabled: false }", "version: 1\nagent: { tool: fake }"]) {
    const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
    await build(ctxOf(readJobAt(jobDirOf(repo, j.id)), agent, yaml));
    assert.equal(agent.calls[0].prompt, "Build it.", yaml);
  }
  const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
  await updateJob(repo, j.id, (x) => ({ ...x, moves: x.moves + 1 }));
  await build(ctxOf(readJobAt(jobDirOf(repo, j.id)), agent, "version: 1\nagent: { tool: fake }\nskills: { host: claude }"));
  assert.match(agent.calls[0].prompt, /## Skill: tdd/);
});

test("a required skill missing anywhere on the job's path halts before any agent runs, naming skill, host and install", async () => {
  const j = await job({ risk: "high" });
  await steer(repo, j.id, "keep it small", () => {});
  const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
  await assert.rejects(build(ctxOf(j, agent)), (e: Error) => {
    assert.ok(e instanceof SkillMissing);
    assert.match(e.message, /reviewer-security needs the skill `security-review` \(high risk\) on claude; install it: put the security-review skill folder/);
    return true;
  });
  assert.equal(agent.calls.length, 0, "no agent ran");
  assert.equal(readMessages(jobDirOf(repo, j.id))[0].status, "sent", "the steer waits for the next role");
  // The machine takes it to needs-human at once (no retry), with the reason as what the person reads.
  const r = move(j, "needs-human", { now: new Date().toISOString(), escalate: "skill-missing", why: "x needs y" });
  assert.ok("job" in r);
  assert.deepEqual([r.job.stage, r.job.pausedReason, r.job.escalatedFrom], ["needs-human", "skill-missing: x needs y", "build"]);
  // Installed in the repo: the job goes on.
  skill("security-review", "# Review", path.join(repo, ".claude", "skills"));
  await build(ctxOf(j, agent));
  assert.equal(agent.calls.length, 1);
});

test("a ticket's Skills: line is required for the builder; an interactive one is refused and logged", async () => {
  skill("prototype", "# Prototype");
  const j = await job({}, "Add a count.\n\nSkills: prototype, wizard");
  const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
  await build(ctxOf(j, agent));
  assert.match(agent.calls[0].prompt, /## Skill: prototype/);
  assert.ok(!agent.calls[0].prompt.includes("Skill: wizard"));
  assert.ok(logs.some((l) => l.startsWith("builder: skill wizard refused (interactive")));
  const k = await job({}, "Add a count.\n\nSkills: not-installed");
  await assert.rejects(build(ctxOf(k, agent)), /builder needs the skill `not-installed` \(the ticket's Skills: line\)/);
});

test("a rerun of a role whose skill changed since an earlier round logs a warning and a ledger line", async () => {
  const f = skill("tdd", "# TDD v1");
  const j = await job();
  const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
  await build(ctxOf(j, agent));
  fs.writeFileSync(f, "---\nname: tdd\n---\n# TDD v2\n");
  const next = await updateJob(repo, j.id, (x) => ({ ...x, moves: x.moves + 1, round: 2 }));
  await build(ctxOf(next, agent));
  assert.ok(logs.some((l) => /^warning: builder: skill tdd changed since round 1 \(sha256 [0-9a-f]{12} → [0-9a-f]{12}\)$/.test(l)));
  const w = readLedger(repo).filter((l) => l.event === "skill-changed");
  assert.equal(w.length, 1);
  assert.equal(w[0].detail?.skill, "tdd");
  // Unchanged: no warning.
  assert.deepEqual(changedSince(readJobAt(jobDirOf(repo, j.id)).agentRuns, "builder", readJobAt(jobDirOf(repo, j.id)).agentRuns[1].skills ?? []), []);
});

test("the job's roles: reviewer lenses only on the job's path", () => {
  const cfg = parseConfig("version: 1");
  const roles = ["intake", "builder", "reviewer-code", "reviewer-security", "reviewer-ui", "reviewer-ux"];
  assert.deepEqual(jobRoles(cfg, { risk: "low", riskFloor: null, surfaces: [] }, roles), ["intake", "builder", "reviewer-code"]);
  assert.deepEqual(jobRoles(cfg, { risk: "high", riskFloor: null, surfaces: [] }, roles), ["intake", "builder", "reviewer-code", "reviewer-security"]);
  assert.deepEqual(jobRoles(cfg, { risk: "low", riskFloor: "high", surfaces: ["ui"] }, roles), roles);
});

test("the Report's Skills used: one row per role in run order, hashes, skipped ones, and a degraded UI review", () => {
  const sha = (c: string) => c.repeat(64);
  const run = (role: string, skills: [string, string][], skipped: string[] = [], ok = true) => ({
    role,
    ok,
    skills: skills.map(([name, s]) => ({ name, path: "/x", host: "claude" as const, sha256: s, chars: 1, truncated: false })),
    skillsSkipped: skipped,
  });
  const lines = skillsUsed(
    [
      run("intake", [["mattpocock-skills:domain-modeling", sha("a")]]),
      run("builder", [["mattpocock-skills:tdd", sha("b")]], ["implement"]),
      run("builder", [["mattpocock-skills:tdd", sha("c")]], ["implement"]),
      run("reviewer-ui", [], ["impeccable"]),
      run("verifier", [], [], false),
    ],
    ["reviewer-ui"],
  );
  assert.deepEqual(lines, [
    { role: "intake", used: [{ name: "mattpocock-skills:domain-modeling", sha256: sha("a") }], skipped: [], degraded: false },
    { role: "builder", used: [{ name: "mattpocock-skills:tdd", sha256: sha("c") }], skipped: ["implement"], degraded: false },
    { role: "reviewer-ui", used: [], skipped: ["impeccable"], degraded: true },
  ]);
  const html = skillsSection({ skills: lines });
  assert.match(html, /<h2>Skills used<\/h2>/);
  assert.match(
    html,
    /<td>builder<\/td><td><code>mattpocock-skills:tdd<\/code> <span class="muted">cccccccccccc<\/span><br><span class="muted">not installed, skipped: implement<\/span><\/td>/,
  );
  assert.match(html, /<td>reviewer-ui<\/td><td><span class="muted">none<\/span>.*DEGRADED/);
  assert.equal(skillsSection({ skills: [] }), "");
  const facts: ReportFacts = {
    job: { id: "001-x", title: "X", kind: "feature", risk: "low", round: 1, pr: null, branch: "kitchen/001-x" },
    head: "a".repeat(40),
    verdict: "PASS",
    humanMustCheck: false,
    requirements: [],
    criteria: [],
    review: { lenses: [], findings: [], blockingRounds: 0 },
    seeds: null,
    costs: [],
    argsDeltas: [],
    skills: lines,
  };
  const out = renderReport({ src: '<section id="summary">Done.</section>', facts, entries: [], file: () => null });
  assert.ok("html" in out && out.html.indexOf('id="skills"') < out.html.indexOf('id="cost"'), "above Cost and time");
});
