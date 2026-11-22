// The Setup run on the dashboard: its questions read from init's files, and answered the way `kitchen init --answers` is.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { answerSetup } from "../cli/toolkit-commands.ts";
import { processStart } from "../lock.ts";
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

test("answers from the page: written to setup-answers.json, then kitchen init --answers <file> --detach", async () => {
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
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, "utf8")), ["init", "--answers", file]);
  assert.match(lines.join("\n"), /init detached/);
});
