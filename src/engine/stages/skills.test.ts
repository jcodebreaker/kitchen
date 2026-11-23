// ADR 0014 in a job: the role prompt carries the skills, the run pins them, a missing required
// skill halts before the role runs, a changed skill on a rerun is logged, the Report says what was used.
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

const PROMPT = "# Role: builder\nBuild it.\n\n# This job\nJob: 001\n\n# The ticket\nquoted";
const build = (ctx: StageContext, role = "builder") =>
  runRole(ctx, { role, file: "build.md", tier: "read", prompt: PROMPT, dest: path.join(ctx.jobDir, `build-${Date.now()}-${Math.random()}.md`) });

test("the builder's skills sit before the job's context, the engine's line ends the prompt; the run pins source, sha256 and chars", async () => {
  const tdd = skill("tdd", "# TDD\nWrite the failing test first.");
  const j = await job();
  const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
  await build(ctxOf(j, agent));
  const prompt = agent.calls[0].prompt;
  const at = prompt.indexOf("# Skills");
  assert.ok(prompt.indexOf("Build it.") < at && at < prompt.indexOf("# This job"), "after the role's instructions, before the job");
  assert.match(
    prompt.slice(at),
    /## Skill: tdd \(from user, sha256 [0-9a-f]{12}\)\n<<<SKILL-[0-9a-f]+\n# TDD\nWrite the failing test first.\nSKILL-[0-9a-f]+>>>/,
  );
  assert.match(prompt, /\n\nKitchen: your one output is build\.md, .*Kitchen's code does\.$/);
  assert.ok(!prompt.includes("name: tdd"), "frontmatter stripped");
  const [run] = readJobAt(jobDirOf(repo, j.id)).agentRuns;
  const sha = run.skills?.[0].sha256 ?? "";
  assert.deepEqual(run.skills, [{ name: "tdd", source: "user", path: tdd, host: "claude", sha256: sha, chars: 35, of: 35, truncated: false }]);
  assert.match(sha, /^[0-9a-f]{64}$/);
  const line = readLedger(repo).find((l) => l.event === "agent");
  assert.deepEqual(line?.detail?.skills, [{ name: "tdd", source: "user", path: tdd, host: "claude", sha256: sha, chars: 35, of: 35, truncated: false }]);
});

test("skills off (kitchen.yaml, the bench's --no-skills) or a fake tool with no skills.host: no Skills section", async () => {
  skill("tdd", "# TDD");
  const j = await job();
  for (const yaml of ["version: 1\nskills: { enabled: false }", "version: 1\nagent: { tool: fake }"]) {
    const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
    await build(ctxOf(readJobAt(jobDirOf(repo, j.id)), agent, yaml));
    assert.ok(!agent.calls[0].prompt.includes("# Skills"), yaml);
  }
  const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
  await updateJob(repo, j.id, (x) => ({ ...x, moves: x.moves + 1 }));
  await build(ctxOf(readJobAt(jobDirOf(repo, j.id)), agent, "version: 1\nagent: { tool: fake }\nskills: { host: claude }"));
  assert.match(agent.calls[0].prompt, /## Skill: tdd/);
});

test("a high-risk job gets Kitchen's vendored security-review: the shipped registry never halts", async () => {
  const j = await job({ risk: "high", surfaces: ["security"] });
  const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
  await build(ctxOf(j, agent), "reviewer-security");
  assert.match(agent.calls[0].prompt, /## Skill: security-review \(from kitchen \(vendored\), sha256/);
  assert.match(agent.calls[0].prompt, /HARD EXCLUSIONS/);
});

test("a ticket-required skill that is missing halts before the role runs; feedback resumes without a new round", async () => {
  const j = await job({}, "Add a count.\n\nKitchen-Skills: humanizer, made-up-skill");
  await steer(repo, j.id, "keep it small", () => {});
  const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
  await assert.rejects(build(ctxOf(j, agent)), (e: Error) => {
    assert.ok(e instanceof SkillMissing);
    assert.match(e.message, /builder needs the skill `humanizer` \(the ticket's Kitchen-Skills: line\) on claude; install it: put the humanizer skill folder/);
    assert.doesNotMatch(e.message, /made-up-skill/, "a name outside the registry never halts");
    return true;
  });
  assert.equal(agent.calls.length, 0, "no agent ran");
  assert.equal(readMessages(jobDirOf(repo, j.id))[0].status, "sent", "the steer waits for the next role");
  // The machine takes it to needs-human at once (no retry), with the reason as what the person reads.
  const now = new Date().toISOString();
  const r = move(j, "needs-human", { now, escalate: "skill-missing", why: "x needs y" });
  assert.ok("job" in r);
  assert.deepEqual([r.job.stage, r.job.pausedReason, r.job.escalatedFrom], ["needs-human", "skill-missing: x needs y", "build"]);
  const back = move(r.job, "build", { now, operator: "feedback" });
  assert.ok("job" in back);
  assert.deepEqual([back.job.round, back.job.roundStart, back.job.pausedReason], [j.round, j.roundStart, undefined], "no round spent, none given");
  const other = move({ ...r.job, pausedReason: "round-limit: 3 of 3" }, "build", { now, operator: "feedback" });
  assert.ok("job" in other && other.job.round === j.round + 1, "any other escalation still resets the budget");
  // Installed: the job goes on; the unknown name is logged, not halted on.
  skill("humanizer", "# Plain words");
  await build(ctxOf(j, agent));
  assert.equal(agent.calls.length, 1);
  assert.ok(logs.some((l) => l.startsWith("builder: skill made-up-skill refused (not in Kitchen's skills registry")));
});

test("only roles still ahead are checked: a role already past isn't a reason to halt", () => {
  const cfg = parseConfig("version: 1");
  const roles = ["intake", "spec", "builder", "verifier", "reviewer-code", "reviewer-security", "reviewer-ui", "report"];
  const high = { risk: "high" as const, riskFloor: null, surfaces: [] };
  assert.deepEqual(jobRoles(cfg, high, roles), ["intake", "spec", "builder", "verifier", "reviewer-code", "reviewer-security", "report"]);
  assert.deepEqual(jobRoles(cfg, high, roles, "builder"), ["builder", "verifier", "reviewer-code", "reviewer-security", "report"]);
  assert.deepEqual(jobRoles(cfg, high, roles, "report"), ["report"]);
  assert.deepEqual(jobRoles(cfg, { risk: "low", riskFloor: null, surfaces: [] }, roles, "intake"), [
    "intake",
    "spec",
    "builder",
    "verifier",
    "reviewer-code",
    "report",
  ]);
  assert.deepEqual(jobRoles(cfg, { risk: "low", riskFloor: "high", surfaces: ["ui"] }, roles, "smith"), roles, "a role outside the order checks all");
});

test("a rerun of a role whose skill changed (content or source) logs a warning and a ledger line", async () => {
  const f = skill("tdd", "# TDD v1");
  const j = await job();
  const agent = new FakeAdapter(() => ({ file: "done", line: "ok" }));
  await build(ctxOf(j, agent));
  fs.writeFileSync(f, "---\nname: tdd\n---\n# TDD v2\n");
  const next = await updateJob(repo, j.id, (x) => ({ ...x, moves: x.moves + 1, round: 2 }));
  await build(ctxOf(next, agent));
  assert.ok(logs.some((l) => /^warning: builder: skill tdd changed since round 1 \(user sha256 [0-9a-f]{12} → user sha256 [0-9a-f]{12}\)$/.test(l)));
  assert.equal(readLedger(repo).filter((l) => l.event === "skill-changed").length, 1);
  const runs = readJobAt(jobDirOf(repo, j.id)).agentRuns;
  const now = runs[1].skills ?? [];
  assert.deepEqual(changedSince(runs, "builder", now), [], "unchanged: no warning");
  const moved = now.map((s) => ({ ...s, name: "mattpocock-skills:tdd", source: "plugin mattpocock-skills@claude-plugins-official" }));
  assert.equal(changedSince(runs, "builder", moved)[0]?.now.startsWith("plugin mattpocock-skills"), true, "same bytes, another source");
});

test("the Report's Skills used: one row per role, hashes, cut and left-out skills, skipped ones, a degraded UI review", () => {
  const sha = (c: string) => c.repeat(64);
  const use = (name: string, s: string, chars = 10, of = 10) => ({ name, path: "/x", host: "claude" as const, sha256: s, chars, of, truncated: chars < of });
  const run = (role: string, skills: ReturnType<typeof use>[], skipped: string[] = [], ok = true) => ({ role, ok, skills, skillsSkipped: skipped });
  const lines = skillsUsed(
    [
      run("intake", [use("mattpocock-skills:domain-modeling", sha("a"))]),
      run("builder", [use("mattpocock-skills:tdd", sha("b"))], ["implement"]),
      run("builder", [use("mattpocock-skills:tdd", sha("c"), 12000, 15000), use("humanizer", sha("d"), 0, 900)]),
      run("reviewer-ui", [], ["impeccable"]),
      run("verifier", [], [], false),
    ],
    ["reviewer-ui"],
  );
  assert.deepEqual(lines, [
    {
      role: "intake",
      used: [{ name: "mattpocock-skills:domain-modeling", sha256: sha("a"), chars: 10, of: 10, truncated: false }],
      leftOut: [],
      skipped: [],
      degraded: false,
    },
    {
      role: "builder",
      used: [{ name: "mattpocock-skills:tdd", sha256: sha("c"), chars: 12000, of: 15000, truncated: true }],
      leftOut: ["humanizer"],
      skipped: ["implement"],
      degraded: false,
    },
    { role: "reviewer-ui", used: [], leftOut: [], skipped: ["impeccable"], degraded: true },
  ]);
  const html = skillsSection({ skills: lines });
  assert.match(html, /<h2>Skills used<\/h2>/);
  assert.match(html, /<td>builder<\/td><td><code>mattpocock-skills:tdd<\/code> <span class="muted">cccccccccccc, cut at 12000 of 15000 characters<\/span>/);
  assert.match(html, /left out \(cap\): humanizer/);
  assert.doesNotMatch(html, /<code>humanizer<\/code>/, "a skill with no characters delivered is not listed as used");
  assert.match(html, /<td>reviewer-ui<\/td><td><span class="muted">none<\/span>.*not found, skipped: impeccable.*DEGRADED/);
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
