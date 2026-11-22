// One real setup run: `kitchen init` on a fresh copy of a fixture (its hand-made
// Toolkit removed, for A), then merge kitchen/setup and `kitchen toolkit check`
// on the base, the way a developer would. Records agent time, cost and tokens.
//   node spikes/w2/init-fixture.ts <fixture> <claude|codex> [scratch dir]
// Env: W2_MODEL (default sonnet / gpt-6-luna), W2_EFFORT (default medium),
//      W2_CODEX_CMD (default "npx -y @openai/codex@0.171.0").
// If init stops with questions (exit 3), the spike answers with the defaults and
// resumes, and says so. Writes spikes/w2/runs/<fixture>-<tool>.json.
import fs from "node:fs";
import path from "node:path";
import { check, finish, fixtureRepo, git, HERE, kitchenLive, ourContainers, readJson } from "./lib.ts";

const [fixture, tool = "claude", scratch] = process.argv.slice(2);
if (!fixture || !["claude", "codex"].includes(tool)) throw new Error("usage: init-fixture.ts <a-web|b-cli|c-adopt|d-api> <claude|codex> [scratch]");
const model = process.env.W2_MODEL ?? (tool === "claude" ? "sonnet" : "gpt-6-luna");
const effort = process.env.W2_EFFORT ?? "medium";
const codexCmd = (process.env.W2_CODEX_CMD ?? "npx -y @openai/codex@0.171.0").split(" ");
const root = path.resolve(scratch ?? path.join(HERE, ".work", `${fixture}-${tool}`));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const yaml = tool === "codex" ? `agent: { tool: codex, command: ${JSON.stringify(codexCmd)} }\n` : "agent: { tool: claude }\n";
const r = fixtureRepo(root, fixture, fixture, { fresh: true, yaml });
const log = path.join(root, "init.log");
console.log(`${fixture} on ${tool} (${model}, effort ${effort}) in ${r.dir}`);

const t0 = Date.now();
let x = await kitchenLive(r, ["init", "--toolkit", "--verbose", "--model", model, "--effort", effort], { logFile: log });
let questions: unknown = null;
if (x.code === 3) {
  const qf = path.join(r.dir, ".kitchen", "setup-questions.json");
  questions = readJson<{ questions: unknown[] }>(qf).questions;
  console.log(`init asked: ${JSON.stringify(questions)}; answering with the defaults`);
  const af = path.join(root, "answers.json");
  fs.writeFileSync(af, JSON.stringify({ answers: {} }));
  x = await kitchenLive(r, ["toolkit", "build", "--verbose", "--answers", af, "--model", model, "--effort", effort], { logFile: log });
}
const initSecs = (Date.now() - t0) / 1000;
check(`${fixture}/${tool}: kitchen init passes`, x.code === 0, `exit ${x.code} after ${Math.round(initSecs)}s`);

const state = fs.existsSync(path.join(r.dir, ".kitchen/init/state.json"))
  ? readJson<{
      runs: { mode: string; ok: boolean; secs: number; usd?: number; inTok?: number; outTok?: number }[];
      fixes: number;
      steps: Record<string, unknown>;
    }>(path.join(r.dir, ".kitchen/init/state.json"))
  : null;
const runs = state?.runs ?? [];
const agentSecs = runs.reduce((s, y) => s + y.secs, 0);
const usd = runs.reduce((s, y) => s + (y.usd ?? 0), 0);

let baseCheck: { code: number; secs: number } | null = null;
if (x.code === 0) {
  git(r.dir, "merge", "--ff-only", "-q", "kitchen/setup");
  const c = await kitchenLive(r, ["toolkit", "check"], { logFile: log });
  baseCheck = { code: c.code, secs: c.secs };
  check(`${fixture}/${tool}: toolkit check on the merged base passes`, c.code === 0, `exit ${c.code} in ${Math.round(c.secs)}s`);
}
check(`${fixture}/${tool}: agent time under 20 minutes`, agentSecs < 20 * 60, `${Math.round(agentSecs)}s`);
const left = ourContainers();
check(`${fixture}/${tool}: no Kitchen containers left`, left.length === 0, left.join(", "));

const toolkitFiles = fs.existsSync(path.join(r.dir, ".kitchen/toolkit"))
  ? fs.readdirSync(path.join(r.dir, ".kitchen/toolkit"), { recursive: true }).filter((f) => !String(f).includes("node_modules"))
  : [];
const describe = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(r.dir, ".kitchen/toolkit.proven"), "utf8"));
  } catch {
    return null;
  }
})();
const result = {
  fixture,
  tool,
  model,
  effort,
  at: new Date().toISOString(),
  init: { exit: x.code, secs: initSecs, questions },
  agent: {
    runs,
    secs: agentSecs,
    usd: tool === "claude" ? usd : null,
    inTok: runs.reduce((s, y) => s + (y.inTok ?? 0), 0),
    outTok: runs.reduce((s, y) => s + (y.outTok ?? 0), 0),
  },
  fixes: state?.fixes ?? null,
  baseCheck,
  proven: describe,
  commits: x.code === 0 ? git(r.dir, "log", "--format=%h %s", "-5").split("\n") : [],
  toolkitFiles,
  log,
};
fs.mkdirSync(path.join(HERE, "runs"), { recursive: true });
fs.writeFileSync(path.join(HERE, "runs", `${fixture}-${tool}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(
  `\n${fixture}/${tool}: init ${x.code === 0 ? "PASS" : "FAIL"}, agent ${Math.round(agentSecs)}s${tool === "claude" ? `, $${usd.toFixed(2)}` : ""}, ${result.agent.inTok} in / ${result.agent.outTok} out tokens, ${runs.length} runs`,
);
finish(`w2 init ${fixture} ${tool}`);
