// W1 real smoke: one role (intake, read tier) through the runner on a real
// tool with its real adapter. One agent call: the role writes intake.md via its
// outbox, the engine copies it into the job folder and the job moves one stage.
//   node spikes/w1/smoke.ts claude|codex <scratch dir>
// Claude: haiku (KITCHEN_CLAUDE_BIN or /opt/homebrew/bin/claude). Codex: gpt-6-luna via npx @openai/codex@0.171.0.
import fs from "node:fs";
import path from "node:path";
import { check, finish, jobDir, jobOf, kitchen, makeRepo, stagesOf, ticket } from "./lib.ts";

const tool = process.argv[2];
if (tool !== "claude" && tool !== "codex") throw new Error("usage: smoke.ts claude|codex <scratch dir>");
const root = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, ".work"));
fs.mkdirSync(root, { recursive: true });
const r = makeRepo(root, `smoke-${tool}`);
const agent =
  tool === "claude"
    ? `{ tool: claude, command: [${JSON.stringify(process.env.KITCHEN_CLAUDE_BIN ?? "/opt/homebrew/bin/claude")}], models: { cheap: haiku }, timeout_sec: 240, max_turns: 8 }`
    : `{ tool: codex, command: ["npx", "-y", "@openai/codex@0.171.0"], models: { cheap: ${process.env.W1_CODEX_MODEL ?? "gpt-6-luna"} }, timeout_sec: 300, max_turns: 8 }`;
fs.writeFileSync(path.join(r.dir, "kitchen.yaml"), `agent: ${agent}\nmodels: { intake: cheap }\n`);
const id = ticket(r, "Add a CONTRIBUTING.md that tells contributors to run `npm test` before they open a pull request.");
const out = kitchen(r, "run", "--once", id).out;
fs.writeFileSync(path.join(root, `smoke-${tool}.log`), out);
console.log(out.trim().replace(/^/gm, "    "));
const j = jobOf(r, id);
const run = j.agentRuns[0];
const intakeMd = path.join(jobDir(r, id), "intake.md");
check(
  `${tool}: one agent call, ok, with a session id`,
  j.agentRuns.length === 1 && !!run?.ok && !!run.sessionId,
  `${run?.adapter} ${run?.model} session ${run?.sessionId} ${run?.secs?.toFixed(1)}s${run?.usd ? ` $${run.usd.toFixed(4)}` : ""}`,
);
check(
  `${tool}: intake.md copied into the job folder`,
  fs.existsSync(intakeMd),
  fs.existsSync(intakeMd) ? fs.readFileSync(intakeMd, "utf8").split("\n").slice(0, 3).join(" | ") : "",
);
const scratch = path.join(r.dir, ".kitchen", "scratch", id);
const left = fs.existsSync(scratch) ? fs.readdirSync(scratch, { recursive: true }).filter((f) => String(f).endsWith(".md")) : [];
check(`${tool}: the outbox file was removed after the copy`, left.length === 0, left.join(", "));
check(
  `${tool}: the job moved one stage`,
  j.stage !== "intake" && stagesOf(r, id).length === 2,
  `${stagesOf(r, id).join(" → ")}${j.pausedReason ? ` (${j.pausedReason})` : ""}`,
);
check(`${tool}: the repo is untouched (read tier)`, !fs.existsSync(path.join(r.dir, "CONTRIBUTING.md")));
finish(`w1 smoke ${tool}`);
