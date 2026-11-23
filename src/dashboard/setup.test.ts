// The Setup run on the dashboard: its questions read from the Toolkit build's files, and answered the way
// `kitchen toolkit build --answers` is; a repo only quick init ran in shows the Toolkit as not built (ADR 0010).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { answerSetup } from "../cli/toolkit-commands.ts";
import type { Job } from "../engine/machine.ts";
import { processStart } from "../lock.ts";
import { noToolkitWords } from "../toolkit/approve.ts";
import { questionOf, stateOf } from "./data.ts";
import { setupView } from "./setup.ts";

let repo = "";
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-setup-"));
  fs.mkdirSync(path.join(repo, ".kitchen", "init"), { recursive: true });
  const questions = [{ id: "q1", question: "Which host image?", why: "disk", default: "engine only" }];
  fs.writeFileSync(
    path.join(repo, ".kitchen", "init", "status.json"),
    JSON.stringify({
      state: "questions",
      pid: process.pid,
      pidStart: processStart(process.pid),
      startedAt: new Date().toISOString(),
      at: new Date().toISOString(),
      last: [],
      questions,
    }),
  );
  fs.writeFileSync(
    path.join(repo, ".kitchen", "init", "state.json"),
    JSON.stringify({
      version: 1,
      startedAt: new Date().toISOString(),
      steps: { config: {}, skills: {}, gitignore: {}, worktree: { path: ".worktrees/_setup" }, template: {}, survey: { questions } },
      fixes: 0,
      runs: [{ usd: 0.2 }],
    }),
  );
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

test("a setup waiting on questions shows them, at the Your answers step", () => {
  const v = setupView(repo);
  assert.equal(v.state, "questions");
  assert.equal(v.steps[v.idx].k, "answers");
  assert.equal(v.steps[v.idx].st, "you");
  assert.deepEqual(
    v.steps.slice(0, v.idx).map((s) => s.st),
    ["ok", "ok", "ok"],
  );
  assert.equal(v.questions[0].id, "q1");
  assert.equal(v.usd, 0.2);
});

test("answers from the page: written to setup-answers.json, then kitchen toolkit build --answers <file> --detach", async () => {
  const stub = path.join(repo, "stub-cli.mjs");
  const seen = path.join(repo, "argv.json");
  fs.writeFileSync(stub, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));`);
  const lines: string[] = [];
  assert.throws(() => answerSetup(repo, { q9: "x" }, (l) => lines.push(l), stub), /no setup question q9/);
  assert.equal(
    answerSetup(repo, { q1: " Full host image " }, (l) => lines.push(l), stub),
    0,
  );
  const file = path.join(repo, ".kitchen", "setup-answers.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { answers: { q1: "Full host image" } });
  for (let i = 0; i < 100 && !fs.existsSync(seen); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, "utf8")), ["toolkit", "build", "--answers", file]);
  assert.match(lines.join("\n"), /toolkit build detached/);
});

test("after quick init only: Setup says the Toolkit is not built, with its first step done (ADR 0010)", () => {
  fs.rmSync(path.join(repo, ".kitchen", "init", "status.json"));
  fs.rmSync(path.join(repo, ".kitchen", "init", "state.json"));
  const empty = setupView(repo);
  assert.equal(empty.state, "none", "kitchen init never ran");
  fs.writeFileSync(path.join(repo, ".kitchen", "init", "checks.json"), JSON.stringify({ at: "", sha: null, from: [], found: "files", results: [] }));
  const v = setupView(repo);
  assert.equal(v.state, "quick");
  assert.equal(v.steps[0].nm, "Config and skill");
  assert.equal(v.steps[0].st, "ok", "quick init did that step");
  assert.deepEqual(new Set(v.steps.slice(1).map((s) => s.st)), new Set(["wait"]));
  assert.equal(v.steps[v.idx].k, "branch");
});

test("answering with no questions waiting says so in the build's words", () => {
  fs.rmSync(path.join(repo, ".kitchen", "init", "status.json"));
  const lines: string[] = [];
  assert.equal(
    answerSetup(repo, { q1: "x" }, (l) => lines.push(l)),
    1,
  );
  assert.match(lines.join("\n"), /^toolkit build: no questions are waiting/);
});

test("a job paused no-toolkit needs you, with what to do now (not the reason it stored); a job you paused stays paused", () => {
  const j = { stage: "paused", waitFor: "no-toolkit", pausedReason: "an old stored reason: merge kitchen/setup" } as Job;
  assert.equal(stateOf(j), "you");
  assert.equal(questionOf(j, repo, { state: "waiting", sha: "a".repeat(40) }), noToolkitWords({ state: "waiting", sha: "a".repeat(40) }));
  assert.match(questionOf(j, repo, { state: "none" }) ?? "", /run `kitchen toolkit build`/);
  assert.equal(stateOf({ stage: "paused", waitFor: "backoff" } as Job), "paused");
});
