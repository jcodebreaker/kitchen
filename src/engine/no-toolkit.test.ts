// Jobs without a Toolkit (ADR 0010): intake pauses a ticket whose criteria drive the app,
// a job resumed with checks only goes on, a repo with a Toolkit is unchanged, and what
// Verify and the Report then say. Fake adapter only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { FakeAdapter } from "../agents/fake.ts";
import { prComment, type ReportFacts, renderReport } from "../checks/report-render.ts";
import { lintSpec } from "../checks/spec-lint.ts";
import { decideVerdict, renderVerdict } from "../checks/verdict.ts";
import { parseConfig } from "../config.ts";
import { mergeSetupHow } from "../init/build.ts";
import { type Job, move } from "./machine.ts";
import { baseTipThrottled, needsToolkitToGoOn, wakeWithToolkit } from "./no-toolkit.ts";
import { runKitchen } from "./runner.ts";
import { intake } from "./stages/intake.ts";
import type { StageContext } from "./stages/types.ts";
import { createJob, jobDirOf, readJobAt, updateJob } from "./store.ts";
import { ensureWorktree } from "./worktree.ts";

let root: string;
const prevHome = process.env.KITCHEN_HOME;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-no-toolkit-"));
  process.env.KITCHEN_HOME = path.join(root, "home");
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.KITCHEN_HOME;
  else process.env.KITCHEN_HOME = prevHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...a], { cwd, encoding: "utf8" }).trim();

function repo(name: string): { dir: string; base: string } {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(dir, "server.js"), "export const ok = true;\n");
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

const INTAKE = (proof: string, expect: string) => `DECISION: ACCEPT
KIND: feature
RISK: low

## Requirements
- R1: GET /books lists the books

## Criteria
- [C1] GET /books answers with the list of books
  proof: ${proof}
  expect: ${expect}
  covers: R1
`;
const APP_PROOF = INTAKE("toolkit http --method GET --path /books --save books", '$books contains "Dune"');
const CMD_PROOF = INTAKE("cmd node --check server.js", "exit 0");
/** An app criterion beside a cmd one that covers the same requirement: checks and tests can prove R1 without the app. */
const MIXED = `${APP_PROOF}- [C2] the server still parses
  proof: cmd node --check server.js
  expect: exit 0
  covers: R1
`;

async function runIntake(dir: string, base: string, text: string, over: Partial<Job> = {}) {
  const { job: created } = await createJob(dir, {
    title: "list the books",
    ticket: { source: "prompt", id: "p" },
    body: "list the books",
    roundLimit: 3,
    base,
  });
  const job = Object.keys(over).length ? await updateJob(dir, created.id, (j) => Object.assign(j, over)) : created;
  const jobDir = jobDirOf(dir, job.id);
  const agent = new FakeAdapter(() => ({ file: text, line: "intake written" }));
  const ctx: StageContext = {
    repo: dir,
    job,
    jobDir,
    config: parseConfig("agent: { tool: fake }\n"),
    agent,
    forge: {} as StageContext["forge"],
    source: { ask: async () => {} } as unknown as StageContext["source"],
    now: () => new Date(),
    log: () => {},
    refresh: () => readJobAt(jobDir),
    holdsLock: () => true,
  };
  return { proposal: await intake(ctx), job: readJobAt(jobDir) };
}

test("no Toolkit: intake pauses a ticket whose criteria drive the app (no-toolkit, with the message), before any worktree", async () => {
  const { dir, base } = repo("pause");
  const { proposal, job } = await runIntake(dir, base, APP_PROOF);
  assert.equal(proposal.to, "paused");
  assert.deepEqual(proposal.facts.noToolkit, { needsApp: ["C1"], highRisk: false, unprovable: "none of its criteria can be proven without driving the app" });
  const r = move(job, "paused", { ...proposal.facts, now: new Date().toISOString() });
  assert.ok("job" in r, "refused" in r ? r.refused : "");
  assert.equal(r.job.waitFor, "no-toolkit");
  assert.equal(r.job.pausedFrom, "intake");
  assert.equal(
    r.job.pausedReason,
    `This ticket needs Kitchen to drive the app; run \`kitchen toolkit build\` (about 3–15 min), then \`kitchen resume ${job.id}\`.`,
  );
  assert.equal(fs.existsSync(path.join(dir, ".worktrees")), false, "nothing was checked out");
});

test("no Toolkit: a ticket proven by cmd/test goes straight on; checks only goes on only when checks can prove every requirement", async () => {
  const { dir, base } = repo("checks");
  const a = await runIntake(dir, base, CMD_PROOF);
  assert.equal(a.proposal.to, "build");
  assert.deepEqual(a.proposal.facts.noToolkit, { needsApp: [], highRisk: false });
  const b = await runIntake(dir, base, MIXED, { checksOnly: true });
  assert.equal(b.proposal.to, "build", "the person chose checks and tests only, and C2 proves R1");
  assert.deepEqual(b.proposal.facts.noToolkit?.needsApp, ["C1"]);
  assert.ok("job" in move(b.job, "build", { ...b.proposal.facts, now: new Date().toISOString() }));
  // Without checksOnly the same ticket waits, and the machine refuses to build it (review L3).
  const c = await runIntake(dir, base, MIXED);
  assert.equal(c.proposal.to, "paused");
  const r = move(c.job, "build", { ...c.proposal.facts, now: new Date().toISOString() });
  assert.ok("refused" in r && /C1 drive the app: it waits for one/.test(r.refused), JSON.stringify(r).slice(0, 200));
  // Only the app can prove R1: checks only is not enough, it waits whatever the person chose.
  const d = await runIntake(dir, base, APP_PROOF, { checksOnly: true });
  assert.equal(d.proposal.to, "paused");
});

test("a repo with a Toolkit is unchanged: the same app criterion lints against describe and goes to build, no noToolkit facts", async () => {
  const { dir, base } = repo("toolkit");
  const bin = path.join(root, "fake-toolkit", "bin", "dev");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\necho '{"status":"ok","primitives":["http","read"],"features":[],"seed_users":[]}'\n`, { mode: 0o755 });
  const { proposal } = await runIntake(dir, base, APP_PROOF, { toolkitRef: base, toolkitBin: bin });
  assert.equal(proposal.to, "build");
  assert.equal(proposal.facts.noToolkit, undefined);
  assert.equal(proposal.facts.intake?.criteria?.ok, true, String(proposal.facts.intake?.criteria?.reason));
  // And without the primitive it is a gap for the smith, as before: never a no-toolkit pause.
  const lint = lintSpec(APP_PROOF.replace("http --method GET --path /books", "sql --query x"), {
    kind: "feature",
    toolkit: { primitives: ["http"], drives: {} },
  });
  assert.equal(lint.missingPrimitive, "sql");
  assert.equal(lint.needsApp, undefined);
});

test("no Toolkit: spec-lint skips resolving a toolkit proof and lists it in needsApp; its negatives get no base check", () => {
  const md = INTAKE("toolkit http --method GET --path /books --save books", '$books not contains "Bob"');
  const l = lintSpec(md, { kind: "feature", toolkit: { primitives: [], drives: {} }, noToolkit: true });
  assert.equal(l.ok, true, String(l.reason));
  assert.deepEqual(l.needsApp, ["C1"]);
  assert.deepEqual(l.baseNegatives, []);
  const withToolkit = lintSpec(md, { kind: "feature", toolkit: { primitives: [], drives: {} } });
  assert.equal(withToolkit.missingPrimitive, "http", "with a Toolkit lacking it, it is a smith gap");
});

test("Verify without a Toolkit: an app criterion is NO-TOOLKIT, never PASS; the job's verdict is decided by the rest", () => {
  const v = decideVerdict({
    criteria: [
      { id: "C1", expect: "ok" },
      { id: "C2", expect: "exit 0" },
    ],
    proofs: [
      { criterion: "C1", result: "NO-TOOLKIT", why: "not proven (no Toolkit): it needs Kitchen to drive the app", evidence: [] },
      { criterion: "C2", result: "PASS", evidence: ["e1"] },
    ],
    judgedText: null,
    entries: [],
    head: "h",
    round: 1,
  });
  assert.equal(v.verdict, "PASS");
  assert.deepEqual(
    v.criteria.map((c) => [c.id, c.result]),
    [
      ["C1", "NO-TOOLKIT"],
      ["C2", "PASS"],
    ],
  );
  assert.match(renderVerdict(v, "h", 1), /\| C1 \| engine \| NO-TOOLKIT \| {2}\| not proven \(no Toolkit\)/);
  const fail = decideVerdict({
    ...{
      criteria: [
        { id: "C1", expect: "ok" },
        { id: "C2", expect: "exit 0" },
      ],
      judgedText: null,
      entries: [],
      head: "h",
      round: 1,
    },
    proofs: [
      { criterion: "C1", result: "NO-TOOLKIT", evidence: [] },
      { criterion: "C2", result: "FAIL", evidence: [] },
    ],
  });
  assert.equal(fail.verdict, "FAIL");
});

const facts = (noToolkit: boolean): ReportFacts => ({
  job: { id: "001-x", title: "list the books", kind: "feature", risk: "low", round: 1, pr: null, branch: "kitchen/001-x" },
  head: "a".repeat(40),
  verdict: "PASS",
  humanMustCheck: false,
  ...(noToolkit ? { noToolkit: true } : {}),
  requirements: [{ id: "R1", text: "GET /books lists the books", negative: false, outOfScope: false }],
  criteria: [
    { id: "C1", text: "GET /books lists them", covers: ["R1"], decidedBy: "engine", result: "NO-TOOLKIT", evidence: [], nonDiscriminating: false },
    { id: "C2", text: "the server parses", covers: ["R1"], decidedBy: "engine", result: "PASS", evidence: [], nonDiscriminating: false },
  ],
  review: { lenses: [], findings: [], blockingRounds: 0 },
  seeds: null,
  costs: [],
  argsDeltas: [],
});

const SRC = '<section id="summary"><p>Done.</p></section><section id="changes"><p>server.js</p></section>';
const html = (noToolkit: boolean) => {
  const r = renderReport({ src: SRC, facts: facts(noToolkit), entries: [], file: () => null });
  if ("refusal" in r) throw new Error(r.refusal);
  return r.html;
};

test("the Report without a Toolkit says plainly it was proven by checks and tests only, and the app criterion is not proven", () => {
  const page = html(true);
  assert.match(page, /CHECKS AND TESTS ONLY/);
  assert.match(page, /Proven by checks and tests only: no app was driven/);
  assert.match(page, /<span class="badge warn">NOT PROVEN \(NO TOOLKIT\)<\/span>/);
  assert.doesNotMatch(page, /badge ok">NO-TOOLKIT/);
  const md = prComment(facts(true), { url: "https://x/", entries: [] });
  assert.match(md, /\*\*Proven by checks and tests only:\*\* no app was driven/);
  assert.match(md, /\| C1 GET \/books lists them \| R1 \| engine \| not proven \(no Toolkit\) \|/);
  // With a Toolkit, none of it.
  assert.doesNotMatch(html(false), /CHECKS AND TESTS ONLY/);
  assert.doesNotMatch(prComment(facts(false), { url: "https://x/", entries: [] }), /checks and tests only/);
});

test("who can go on without a Toolkit: not high risk, not a bug whose repro drives the app, not a requirement only the app proves", () => {
  const jobDir = path.join(root, "jobdir");
  fs.mkdirSync(jobDir, { recursive: true });
  const j = (o: Partial<Job>) => ({ risk: "low", riskFloor: null, kind: "feature", ...o }) as Job;
  assert.equal(needsToolkitToGoOn(jobDir, j({})), null, "no contract yet");
  assert.match(needsToolkitToGoOn(jobDir, j({ risk: "medium", riskFloor: "high" })) ?? "", /high risk/);
  const write = (t: string) => fs.writeFileSync(path.join(jobDir, "intake.md"), t);
  const app = (id: string, covers: string, repro = false) =>
    `- [${id}] via the app\n  proof: toolkit http --method GET --path /x\n  expect: ok\n${repro ? "  repro: true\n" : ""}  covers: ${covers}\n`;
  const cmd = (id: string, covers: string) => `- [${id}] via a test\n  proof: cmd node --check server.js\n  expect: exit 0\n  covers: ${covers}\n`;
  write(`## Criteria\n${app("C1", "R1", true)}${cmd("C2", "R1")}`);
  assert.match(needsToolkitToGoOn(jobDir, j({ kind: "bug" })) ?? "", /bug whose reproduction \(C1\) drives the app/);
  write(`## Criteria\n${app("C1", "R1")}`);
  assert.match(needsToolkitToGoOn(jobDir, j({})) ?? "", /none of its criteria can be proven without driving the app/);
  write(`## Criteria\n${app("C1", "R1")}${cmd("C2", "R2")}`);
  assert.match(needsToolkitToGoOn(jobDir, j({})) ?? "", /R1 is proven only by driving the app/);
  write(`## Criteria\n${app("C1", "R1")}${cmd("C2", "R1")}`);
  assert.equal(needsToolkitToGoOn(jobDir, j({})), null);
});

test("Verify never says PASS with nothing proven: every criterion NO-TOOLKIT, or a requirement only NO-TOOLKIT covers (review M5)", () => {
  const run = (results: [string, "PASS" | "NO-TOOLKIT", string[]][]) =>
    decideVerdict({
      criteria: results.map(([id, , covers]) => ({ id, expect: "ok", covers })),
      proofs: results.map(([criterion, result]) => ({ criterion, result, evidence: [] })),
      judgedText: null,
      entries: [],
      head: "h",
      round: 1,
    });
  const all = run([
    ["C1", "NO-TOOLKIT", ["R1"]],
    ["C2", "NO-TOOLKIT", ["R2"]],
  ]);
  assert.equal(all.verdict, "NO-TOOLKIT");
  assert.equal(all.unproven, "no criterion was proven");
  assert.match(renderVerdict(all, "h", 1), /^VERDICT: NO-TOOLKIT$/m);
  const half = run([
    ["C1", "NO-TOOLKIT", ["R1"]],
    ["C2", "PASS", ["R2"]],
  ]);
  assert.equal(half.verdict, "NO-TOOLKIT");
  assert.equal(half.unproven, "R1 is covered only by criteria that need the app");
  const covered = run([
    ["C1", "NO-TOOLKIT", ["R1"]],
    ["C2", "PASS", ["R1"]],
  ]);
  assert.equal(covered.verdict, "PASS");
  assert.equal(covered.unproven, undefined);
});

test("the runner reads the base for no-toolkit waits at most once a minute, and repeats a read's error, not a new read (review M4)", async () => {
  const { dir, base } = repo("throttle");
  const cfg = parseConfig("");
  const t0 = 1_000_000_000_000;
  assert.equal(await baseTipThrottled(dir, cfg, t0), base);
  fs.writeFileSync(path.join(dir, "b.txt"), "b");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "next");
  const next = git(dir, "rev-parse", "HEAD");
  assert.equal(await baseTipThrottled(dir, cfg, t0 + 30_000), base, "within the minute: the cached tip");
  assert.equal(await baseTipThrottled(dir, cfg, t0 + 60_000), next, "after it: read again");
  fs.renameSync(path.join(dir, ".git"), path.join(dir, ".git-away"));
  await assert.rejects(baseTipThrottled(dir, cfg, t0 + 120_000));
  fs.renameSync(path.join(dir, ".git-away"), path.join(dir, ".git"));
  await assert.rejects(baseTipThrottled(dir, cfg, t0 + 130_000), "the error is kept until the next read is due");
  assert.equal(await baseTipThrottled(dir, cfg, t0 + 180_000), next);
});

test("a job waiting for a Toolkit doesn't keep `kitchen run` alive (review M4)", async () => {
  const { dir, base } = repo("idle");
  fs.writeFileSync(path.join(root, "noop.mjs"), "export default () => ({ line: 'noop', ok: false });\n");
  fs.writeFileSync(path.join(dir, "kitchen.yaml"), `agent: { tool: fake, script: ${path.join(root, "noop.mjs")} }\n`);
  const { job } = await createJob(dir, { title: "waits", ticket: { source: "prompt", id: "w" }, body: "waits", roundLimit: 3, base });
  await updateJob(dir, job.id, (j) => Object.assign(j, { stage: "paused", pausedFrom: "intake", waitFor: "no-toolkit", pausedReason: "x" }));
  const lines: string[] = [];
  const t = Date.now();
  await runKitchen({ repo: dir, tickMs: 50, print: (l) => lines.push(l) });
  assert.ok(Date.now() - t < 20_000, lines.join("\n"));
  assert.equal(readJobAt(jobDirOf(dir, job.id)).stage, "paused");
});

test("waking is idempotent: a worktree already at the Toolkit commit still moves the job's base (review L2)", async () => {
  const { dir, base } = repo("wake");
  const { job: created } = await createJob(dir, { title: "w", ticket: { source: "prompt", id: "k" }, body: "w", roundLimit: 3, base });
  const job = await ensureWorktree(dir, created);
  fs.mkdirSync(path.join(dir, ".kitchen", "toolkit", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".kitchen", "toolkit", "bin", "dev"), "#!/bin/sh\n");
  git(dir, "add", "-f", ".kitchen/toolkit/bin/dev");
  git(dir, "commit", "-q", "-m", "toolkit");
  const tip = git(dir, "rev-parse", "HEAD");
  const cfg = parseConfig("");
  const first = await wakeWithToolkit(dir, cfg, job);
  assert.deepEqual(first, { toolkit: true, facts: { base: tip, toolkitRef: tip } });
  assert.equal(git(job.worktree, "rev-parse", "HEAD"), tip, "fast-forwarded");
  // The move was refused or raced: the job still names the old base, its worktree is at the tip.
  const second = await wakeWithToolkit(dir, cfg, job);
  assert.deepEqual(second, { toolkit: true, facts: { base: tip, toolkitRef: tip } });
});

test("with GitHub, getting the Toolkit onto the base means merge into the base branch and push (review M8)", () => {
  assert.equal(mergeSetupHow(parseConfig("")), "git merge kitchen/setup");
  assert.equal(mergeSetupHow(parseConfig("forge: { kind: github, repo: a/b, base: develop }\n")), "merge kitchen/setup into develop and push");
});
