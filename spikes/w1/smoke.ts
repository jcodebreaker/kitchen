// W1 real smoke: one role (intake, read tier) through the runner on a real
// tool with its real adapter. One agent call: the role writes intake.md via its
// outbox, the engine copies it into the job folder and the job moves one stage.
//   node spikes/w1/smoke.ts claude|codex <scratch dir> [a-web]
// Claude: haiku (KITCHEN_CLAUDE_BIN or /opt/homebrew/bin/claude). Codex: via npx @openai/codex@0.171.0,
// gpt-6-luna on the throwaway repo; with `a-web` (PLAN §7, the wave-end Codex smoke) on a copy of
// fixtures/a-web with the default tier map's `cheap` model and a ticket about that app.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, finish, jobDir, jobOf, kitchen, makeRepo, ROOT, stagesOf, ticket } from "./lib.ts";

const tool = process.argv[2];
if (tool !== "claude" && tool !== "codex") throw new Error("usage: smoke.ts claude|codex <scratch dir> [a-web]");
const root = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, ".work"));
const fixture = process.argv[4] === "a-web";
fs.mkdirSync(root, { recursive: true });
const r = makeRepo(root, `smoke-${tool}${fixture ? "-a-web" : ""}`);
if (fixture) {
  // The fixture's files instead of the throwaway repo's (no node_modules: intake only reads).
  for (const f of fs.readdirSync(r.dir)) if (f !== ".git") fs.rmSync(path.join(r.dir, f), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "fixtures", "a-web"), r.dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  execFileSync("git", ["-C", r.dir, "add", "-A"]);
  execFileSync("git", ["-C", r.dir, "-c", "user.name=spike", "-c", "user.email=s@example.invalid", "commit", "-q", "-m", "fixture a-web"]);
}
const codexModel = fixture ? "" : `, models: { cheap: ${process.env.W1_CODEX_MODEL ?? "gpt-6-luna"} }`;
const agent =
  tool === "claude"
    ? `{ tool: claude, command: [${JSON.stringify(process.env.KITCHEN_CLAUDE_BIN ?? "/opt/homebrew/bin/claude")}], models: { cheap: haiku }, timeout_sec: 240, max_turns: 8 }`
    : `{ tool: codex, command: ["npx", "-y", "@openai/codex@0.171.0"]${codexModel}, timeout_sec: 300, max_turns: 8 }`;
fs.writeFileSync(path.join(r.dir, "kitchen.yaml"), `agent: ${agent}\nmodels: { intake: cheap }\n`);
const id = ticket(
  r,
  fixture
    ? "Show the signed-in user's email in the settings page heading, so people can tell which account they are changing."
    : "Add a CONTRIBUTING.md that tells contributors to run `npm test` before they open a pull request.",
);
const out = kitchen(r, "run", "--once", id).out;
fs.writeFileSync(path.join(root, `smoke-${tool}${fixture ? "-a-web" : ""}.log`), out);
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
const status = execFileSync("git", ["-C", r.dir, "status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).kitchen", ":(exclude)kitchen.yaml"], {
  encoding: "utf8",
}).trim();
check(`${tool}: the repo is untouched (read tier)`, status === "", status);
const procs = path.join(jobDir(r, id), "procs");
check(`${tool}: the agent's process group record is gone after the call`, !fs.existsSync(procs) || fs.readdirSync(procs).length === 0);
finish(`w1 smoke ${tool}${fixture ? " a-web" : ""}`);
