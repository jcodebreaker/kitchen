// W2 exit gap: `/kitchen` setup from INSIDE the agent tools, end to end, with
// the skill installed the way a user has it. The outer agent (the user's
// session) follows skills/kitchen/SKILL.md: `kitchen init --detach` outside its
// sandbox, short `kitchen init --status` polls, questions relayed to the user,
// answers written, init resumed. Kitchen's own setup agent runs underneath.
//
//   node spikes/w2/inside.ts claude e [scratch]   fixture E (D + a catalog the repo can't choose):
//        turn 1 must end with the setup question to the user (init said
//        questions, exit 3); turn 2 (`--resume`) gives the answer; init resumes
//        and finishes; the answer reaches the setup build.
//   node spikes/w2/inside.ts codex b [scratch]    fixture B (no questions): one `codex exec` turn.
//
// What each tool needs the user to approve is exactly what this script grants
// (printed at the start, recorded in runs/inside-<tool>.json):
//   Claude Code (`claude -p`): --allowedTools "Bash(kitchen init:*)" "Bash(sleep:*)" Read Write
//     (Bash is unsandboxed by default in Claude Code, so `kitchen init` runs outside any sandbox).
//   Codex (`codex exec`, workspace-write sandbox, approval never): one execpolicy rule
//     prefix_rule(pattern=["kitchen", "init"], decision="allow"), which is what Codex's
//     "always allow `kitchen init`" approval writes; this script puts it in
//     ~/.codex/rules/kitchen-w2-spike.rules for the run and removes it after.
// Env: W2_MODEL (outer + setup model; default sonnet / gpt-5.6-terra), W2_CODEX_CMD.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI, check, finish, fixtureRepo, git, HERE, ourContainers, ROOT, readJson } from "./lib.ts";

const [tool = "claude", fx = tool === "claude" ? "e" : "b", scratch] = process.argv.slice(2);
if (!["claude", "codex"].includes(tool)) throw new Error("usage: inside.ts <claude|codex> <e|b|a|c|d> [scratch]");
const model = process.env.W2_MODEL ?? (tool === "claude" ? "sonnet" : "gpt-5.6-terra");
const codexCmd = (process.env.W2_CODEX_CMD ?? "npx -y @openai/codex@0.171.0").split(" ");
const root = path.resolve(scratch ?? path.join(HERE, ".work", `inside-${tool}-${fx}`));
// W2_INSIDE_REUSE=1: continue in the repo a previous run left (an init already under way), with the current skill.
const reuse = process.env.W2_INSIDE_REUSE === "1" && fs.existsSync(path.join(root, `${fx}-inside`, ".git"));
if (!reuse) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
}
const fixtures: Record<string, string> = { a: "a-web", b: "b-cli", c: "c-adopt", d: "d-api", e: "d-api" };

// ---------- the repo, as a user has it: committed code, the skill installed, kitchen.yaml ----------
const yaml =
  tool === "claude"
    ? `agent: { tool: claude, models: { medium: ${model} } }\nmodels: { setup: medium }\n`
    : `agent: { tool: codex, command: ${JSON.stringify(codexCmd)}, models: { medium: ${model} } }\nmodels: { setup: medium }\n`;
const r = reuse
  ? (() => {
      const home = path.join(root, "kitchen-home");
      return { dir: path.join(root, `${fx}-inside`), home, env: { ...process.env, KITCHEN_HOME: home } };
    })()
  : fixtureRepo(root, fixtures[fx], `${fx}-inside`, { fresh: true, yaml });
if (fx === "e" && !reuse) makeE(r.dir);
for (const d of [".claude/skills/kitchen", ".agents/skills/kitchen"]) {
  fs.mkdirSync(path.join(r.dir, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "skills", "kitchen", "SKILL.md"), path.join(r.dir, d, "SKILL.md"));
}
if (!reuse) {
  git(r.dir, "add", "-A");
  git(r.dir, "commit", "-q", "-m", "kitchen skill and config");
}
// `kitchen` on PATH, as after `npm i -g devkitchen`
const bin = path.join(root, "bin");
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, "kitchen"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
const env = { ...r.env, PATH: `${bin}:${process.env.PATH}` };
const status = () => spawnSync(process.execPath, [CLI, "init", "--status", "--repo", r.dir], { env, encoding: "utf8" });
const log = path.join(root, "outer.log");

type Turn = { code: number; secs: number; result: string; sessionId?: string; usd?: number; inTok?: number; outTok?: number; commands: string[] };

function run(argv: string[], cwd: string, prompt: string | null): Promise<{ code: number; out: string; secs: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { cwd, env, stdio: [prompt === null ? "ignore" : "pipe", "pipe", "pipe"] });
    if (prompt !== null) p.stdin?.end(prompt);
    let out = "";
    const on = (b: Buffer) => {
      out += b;
      fs.appendFileSync(log, b);
    };
    p.stdout?.on("data", on);
    p.stderr?.on("data", on);
    p.on("close", (code) => resolve({ code: code ?? -1, out, secs: (Date.now() - t0) / 1000 }));
  });
}

const CLAUDE_TOOLS = ["Bash(kitchen init:*)", "Read", "Write"];
async function claudeTurn(prompt: string, resume?: string): Promise<Turn> {
  const argv = [
    "claude",
    "-p",
    prompt,
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "project",
    "--allowedTools",
    ...CLAUDE_TOOLS,
    ...(resume ? ["--resume", resume] : []),
  ];
  const x = await run(argv, r.dir, null);
  const events = x.out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
  const res = events.find((e) => e.type === "result") as
    | {
        result?: string;
        session_id?: string;
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      }
    | undefined;
  const commands = events.flatMap((e) =>
    e.type === "assistant"
      ? (((e.message as { content?: { type: string; name?: string; input?: { command?: string } }[] })?.content ?? [])
          .filter((c) => c.type === "tool_use" && c.name === "Bash")
          .map((c) => c.input?.command ?? "") as string[])
      : [],
  );
  const u = res?.usage;
  return {
    code: x.code,
    secs: x.secs,
    result: res?.result ?? x.out.slice(-800),
    sessionId: res?.session_id,
    usd: res?.total_cost_usd,
    inTok: u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined,
    outTok: u?.output_tokens,
    commands,
  };
}

const RULES = path.join(os.homedir(), ".codex", "rules", "kitchen-w2-spike.rules");
async function codexTurn(prompt: string): Promise<Turn> {
  fs.mkdirSync(path.dirname(RULES), { recursive: true });
  fs.writeFileSync(
    RULES,
    '# Written by kitchen spikes/w2/inside.ts for one run; removed after it.\nprefix_rule(pattern=["kitchen", "init"], decision="allow")\n',
  );
  const last = path.join(root, "codex-last.txt");
  try {
    const argv = [
      ...codexCmd,
      "exec",
      "--json",
      "-C",
      r.dir,
      "-m",
      model,
      "-c",
      'model_reasoning_effort="medium"',
      "-s",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "-o",
      last,
      "-",
    ];
    const x = await run(argv, r.dir, prompt);
    const events = x.out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return {};
        }
      });
    const commands = events.flatMap((e) => {
      const item = e.item as { type?: string; command?: string } | undefined;
      return e.type === "item.completed" && item?.type === "command_execution" ? [item.command ?? ""] : [];
    });
    const usage = events.filter((e) => e.type === "turn.completed").map((e) => e.usage as { input_tokens?: number; output_tokens?: number });
    const thread = events.find((e) => e.type === "thread.started") as { thread_id?: string } | undefined;
    return {
      code: x.code,
      secs: x.secs,
      result: fs.existsSync(last) ? fs.readFileSync(last, "utf8") : x.out.slice(-800),
      sessionId: thread?.thread_id,
      inTok: usage.reduce((s, u) => s + (u.input_tokens ?? 0), 0),
      outTok: usage.reduce((s, u) => s + (u.output_tokens ?? 0), 0),
      commands,
    };
  } finally {
    fs.rmSync(RULES, { force: true });
  }
}

const PROMPT =
  tool === "claude"
    ? "/kitchen set up Kitchen for this repo"
    : "Use the kitchen skill ($kitchen, .agents/skills/kitchen/SKILL.md) to set up Kitchen for this repo.";
console.log(`${tool} (${model}) inside ${r.dir}; outer log ${log}`);
console.log(
  tool === "claude"
    ? `approvals granted: --allowedTools ${CLAUDE_TOOLS.map((t) => JSON.stringify(t)).join(" ")} (claude -p, project settings only)`
    : `approvals granted: codex exec -s workspace-write, approval_policy=never, rule prefix_rule(["kitchen","init"], allow)`,
);

const turns: Turn[] = [];
const t1 = tool === "claude" ? await claudeTurn(PROMPT) : await codexTurn(PROMPT);
turns.push(t1);
console.log(`turn 1: exit ${t1.code} in ${Math.round(t1.secs)}s; commands: ${t1.commands.join(" ⏎ ")}\n  says: ${t1.result.slice(0, 600)}`);
if (reuse) console.log("(reused the repo of an earlier run: its init was already under way)");
let s = status();
if (fx === "e") {
  check("the real setup survey asked a question: init stopped with questions (exit 3)", s.status === 3, s.stdout.split("\n")[0]);
  const qs = fs.existsSync(path.join(r.dir, ".kitchen", "setup-questions.json"))
    ? readJson<{ questions: { question: string }[] }>(path.join(r.dir, ".kitchen", "setup-questions.json")).questions
    : [];
  check(
    "the question is about the catalog",
    qs.some((q) => /catalog/i.test(q.question)),
    JSON.stringify(qs),
  );
  check(
    "the outer agent relayed it to the user and stopped (no answer of its own)",
    /catalog/i.test(t1.result) && !fs.existsSync(path.join(r.dir, ".kitchen", "setup-answers.json")),
  );
  if (s.status !== 3 || t1.code !== 0) {
    finish(`w2 inside ${tool} ${fx} (stopped after turn 1: no question to answer; not looping)`);
    process.exit(1);
  }
  const t2 = await claudeTurn("Use the EU catalog (eu).", t1.sessionId);
  turns.push(t2);
  console.log(`turn 2: exit ${t2.code} in ${Math.round(t2.secs)}s; commands: ${t2.commands.join(" ⏎ ")}\n  says: ${t2.result.slice(0, 600)}`);
  check(
    "turn 2: the agent resumed init with --answers, detached",
    t2.commands.some((c) => /kitchen init .*--answers.*--detach|kitchen init --detach.*--answers/.test(c)),
  );
  s = status();
  const state = readJson<{ steps: { answers?: Record<string, string> } }>(path.join(r.dir, ".kitchen", "init", "state.json"));
  check(
    "the answers file the agent wrote holds the user's answer",
    /\beu\b/i.test(fs.readFileSync(path.join(r.dir, ".kitchen", "setup-answers.json"), "utf8")),
  );
  check(
    "the answer reached the setup build",
    Object.values(state.steps.answers ?? {}).some((a) => /\beu\b/i.test(a)),
    JSON.stringify(state.steps.answers),
  );
}
check(
  `${tool}: init done (status exit 0), the Toolkit proven`,
  s.status === 0 && fs.existsSync(path.join(r.dir, ".kitchen", "toolkit.proven")),
  s.stdout.split("\n")[0],
);
const all = turns.flatMap((t) => t.commands);
check(
  `${tool}: the agent started init detached`,
  all.some((c) => /kitchen init (?:.*)?--detach/.test(c)),
  all.filter((c) => /--detach/.test(c)).join(" | "),
);
const polls = all.filter((c) => /kitchen init --status/.test(c));
check(
  `${tool}: it polled with kitchen init --status --wait (each call at most 110 s)`,
  polls.some((c) => /--wait/.test(c)),
  `${polls.length} polls`,
);
const longest = Math.max(
  0,
  ...all.map((c) => Number(/sleep (\d+)/.exec(c)?.[1] ?? 0)),
  ...all.map((c) => Math.min(110, Number(/--wait[ =](\d+)/.exec(c)?.[1] ?? 0))),
);
check(`${tool}: no Bash call waited over 2 minutes`, longest <= 120, `longest wait ${longest}s`);
const left = ourContainers();
check("no Kitchen containers left", left.length === 0, left.join(", "));

const initState = fs.existsSync(path.join(r.dir, ".kitchen", "init", "state.json"))
  ? readJson<{ runs: { mode: string; secs: number; usd?: number; inTok?: number; outTok?: number }[] }>(path.join(r.dir, ".kitchen", "init", "state.json"))
  : { runs: [] };
const record = {
  tool,
  fixture: fx,
  model,
  at: new Date().toISOString(),
  approvals:
    tool === "claude"
      ? { allowedTools: CLAUDE_TOOLS, settingSources: "project" }
      : { sandbox: "workspace-write", approval_policy: "never", rule: 'prefix_rule(pattern=["kitchen", "init"], decision="allow")' },
  outer: turns.map((t) => ({
    code: t.code,
    secs: t.secs,
    usd: t.usd,
    inTok: t.inTok,
    outTok: t.outTok,
    commands: t.commands,
    result: t.result.slice(0, 2000),
  })),
  setup: initState.runs,
  status: s.stdout,
  log,
};
fs.mkdirSync(path.join(HERE, "runs"), { recursive: true });
fs.writeFileSync(path.join(HERE, "runs", `inside-${tool}-${fx}.json`), `${JSON.stringify(record, null, 2)}\n`);
finish(`w2 inside ${tool} ${fx}`);

/** Fixture E: fixture D whose catalog is chosen by CATALOG=eu|us with no default, and the repo says the team decides. */
function makeE(dir: string) {
  const schema = path.join(dir, "db", "schema.sql");
  const s = fs.readFileSync(schema, "utf8");
  const at = s.indexOf("INSERT OR IGNORE INTO catalog");
  fs.writeFileSync(schema, s.slice(0, at));
  fs.writeFileSync(path.join(dir, "db", "catalog-us.sql"), `-- US catalog (USD cents)\n${s.slice(at)}`);
  fs.writeFileSync(
    path.join(dir, "db", "catalog-eu.sql"),
    "-- EU catalog (EUR cents)\nINSERT OR IGNORE INTO catalog (sku, name, price_cents) VALUES\n  ('MUG-EU', 'Enamel mug (EU)', 1300),\n  ('TEE-EU', 'Logo t-shirt (EU)', 2700),\n  ('BAG-EU', 'Canvas bag (EU)', 1900);\n",
  );
  const server = path.join(dir, "server.js");
  fs.writeFileSync(
    server,
    fs.readFileSync(server, "utf8").replace(
      'db.exec(readFileSync(new URL("./db/schema.sql", import.meta.url), "utf8"));',
      `db.exec(readFileSync(new URL("./db/schema.sql", import.meta.url), "utf8"));
const CATALOG = env.CATALOG;
if (CATALOG !== "eu" && CATALOG !== "us") {
  console.error("CATALOG must be set to eu or us; there is no default (see README, Catalogs)");
  process.exit(1);
}
db.exec(readFileSync(new URL(\`./db/catalog-\${CATALOG}.sql\`, import.meta.url), "utf8"));`,
    ),
  );
  const readme = path.join(dir, "README.md");
  fs.writeFileSync(
    readme,
    fs
      .readFileSync(readme, "utf8")
      .replace(
        "| `PORT`                  |",
        "| `CATALOG`               | none (required)           | `eu` or `us`: which catalog is seeded (see Catalogs)           |\n| `PORT`                  |",
      )
      .replace(
        "## Development setup",
        "## Catalogs\n\nThe service runs with exactly one catalog, `db/catalog-eu.sql` (EUR) or `db/catalog-us.sql` (USD), chosen by `CATALOG`. There is deliberately no default. Which catalog the team develops and demos against changes from release to release; the orders team decides it and it is not recorded in this repository. Ask before setting up a dev or test environment.\n\n## Development setup",
      ),
  );
}
