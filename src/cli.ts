#!/usr/bin/env node
// `kitchen` entry point (ADR 0016). Runs in the repo it is started in (or --repo <dir>).
import fs from "node:fs";
import path from "node:path";
import * as cmd from "./cli/commands.ts";
import { quietOnEpipe } from "./cli/epipe.ts";
import * as control from "./engine/control.ts";

const HELP = `kitchen: tickets in, reviewed changes merged into staging out (Claude Code orchestrates)

Setup
  kitchen init [--tool claude|codex] [--yes]   seconds: checks what Kitchen needs, then kitchen.yaml (checks, how to start
                                         the app, staging), the /kitchen skill, the guard hooks, .gitignore, the
                                         staging branch; runs the checks once
  kitchen init --skill                   only the /kitchen skill (then: /kitchen set up Kitchen in Claude Code)
  kitchen skills                         which role skills are found for the agent tool

Work
  kitchen ticket "<what you want>"       a ticket; intake writes its criteria
  kitchen run [--detach] [--max-usd n]   a headless orchestrator session works the queue (or /kitchen run in Claude Code)
  kitchen run --stop | --print           end it | print the exact command it runs
  kitchen status [--json]                one row per job
  kitchen dashboard [--port 7357]        the jobs in a browser, on 127.0.0.1: lanes, live activity, steering
  kitchen feedback <id> ["<text>"] [--to <stage>]   answer a job that needs you, or send a ready/done one back
  kitchen steer <id> "<text>"            a message the job's next agent reads
  kitchen pause <id> · stop <id> · resume <id> · reject <id>
  kitchen report [--json]                what the queue did

The orchestrator's verbs (the only way a job moves)
  kitchen job next [--json] [--restart-stranded]   the next wave: lanes to start, what waits and why
  kitchen job start <id> <lane> [--json] [--restart]   open a lane: worktree, brief, the agent's prompt and model
  kitchen job finish <id> [--json]       read the lane's files, run the checks / the merge, move the job (or refuse)
  kitchen job show <id> [--json]

QA's tools (evidence lands in the job's QA folder)
  kitchen qa up <id> · qa down <id>      start / stop the app from the job's worktree
  kitchen qa page <id> <path> --name <n> [--script f.mjs]   Playwright: screenshot + page text
  kitchen qa http <id> <METHOD> <path> --name <n> [--header 'K: v']… [--data '<json>']   an HTTP transcript

kitchen --version · kitchen <command> --help · docs: README.md in the package`;

const COMMAND_HELP: Record<string, string> = {
  ticket: 'kitchen ticket "<what you want>"\n\nFiles a ticket; the next orchestrator wave takes it to intake.',
  run: "kitchen run [--detach] [--max-usd n] | run --stop | run --print\n\nStarts a headless Claude Code session that runs /kitchen run: it plans waves and spawns one agent per lane (intake, build, QA, review), moving jobs only through kitchen job verbs. One per repo.\n  --detach   in the background; the log is .kitchen/run.log\n  --max-usd  the session's spend cap (claude --max-budget-usd); default agent.max_usd in kitchen.yaml\n  --stop     end it (jobs keep their state)\n  --print    print the command and run nothing",
  status:
    "kitchen status [--json]\n\nThe orchestrator, then one row per job: id, title, stage (* while an agent works on it), round, when it last moved, the merge, the Report.",
  resume: "kitchen resume <id>\n\nWakes a paused job: back to the stage it paused in. On a job whose pause wasn't made yet, cancels it.",
  steer:
    'kitchen steer <id> "<text>"\n\nA message for a job: the orchestrator hands it to the job\'s next lane agent, quoted as operator notes. The thread is .kitchen/jobs/<id>/messages.jsonl.',
  pause: "kitchen pause <id>\n\nParks the job (paused, by-you) once its current lane finishes, or now when none works on it.",
  stop: "kitchen stop <id>\n\nParks the job now. A lane agent still working on it finds its result dropped.",
  feedback:
    'kitchen feedback <id> ["<text>"] [--to <stage>]\n\nAnswers a job that needs you, or sends a ready or done job back to Build with your text.\n  --to <stage>   for a needs-human job: intake, build, qa or review',
  reject: "kitchen reject <id>\n\nCloses a job without merging it.",
  report: "kitchen report [--json]\n\nWhat the queue did: merged, ready, sent back, rounds, time.",
  dashboard:
    "kitchen dashboard [--port 7357]\n\nThe jobs in a browser, on 127.0.0.1 only: a list or a board by lane, each job's live activity, criteria and changes. From it you answer, steer, pause, resume, stop, reject, follow up and start the orchestrator.",
  skills: "kitchen skills\n\nEvery skill in Kitchen's role registry (skills/registry.json): found or not for the agent tool, and how to install a missing one.",
  init: "kitchen init [--tool claude|codex] [--yes] | init --skill\n\nChecks what Kitchen needs (node, git and a commit, python3 for the hooks, claude or codex signed in, gh optional), then writes kitchen.yaml with the checks and how to start the app it finds (one question at most when none is obvious; --yes asks nothing), installs the /kitchen skill and the guard hooks (merged into .claude/settings.json, with a backup), adds .gitignore entries, creates the staging branch from your branch, and runs the checks once.",
  job: "kitchen job next|start|finish|show …\n\nThe orchestrator's verbs: the single writer of job state. See kitchen --help.",
  qa: "kitchen qa up|down|page|http <id> …\n\nThe QA lane's tools: the app from the job's worktree, Playwright screenshots, HTTP transcripts. See kitchen --help.",
};

type Flags = { pos: string[]; flags: Set<string>; vals: Record<string, string[]> };
/** --name value pairs for the names in `valued`; other --x are flags; the rest are positionals. */
function parse(rest: string[], valued: string[]): Flags {
  const f: Flags = { pos: [], flags: new Set(), vals: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--") && valued.includes(a.slice(2))) {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      const k = a.slice(2);
      f.vals[k] = [...(f.vals[k] ?? []), v];
    } else if (a.startsWith("--")) f.flags.add(a);
    else f.pos.push(a);
  }
  return f;
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const out = (l: string) => console.log(l);
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    if (name === undefined) console.log(`${(await import("./cli/here.ts")).hereLine(process.cwd())}\n`);
    console.log(HELP);
    return name === undefined ? 2 : 0;
  }
  if (name === "--version" || name === "-v") {
    console.log((JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version);
    return 0;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    const h = COMMAND_HELP[name];
    if (!h) {
      console.error(`kitchen: unknown command ${name}\n\nkitchen --help for the list`);
      return 2;
    }
    console.log(`usage: ${h}`);
    return 0;
  }
  const f = parse(rest, ["repo", "to", "port", "tool", "max-usd", "name", "script", "header", "data"]);
  const repo = path.resolve(f.vals.repo?.[0] ?? process.cwd());
  const v = (k: string) => f.vals[k]?.[0];
  const need = (i: number, what: string) => {
    if (!f.pos[i]) throw new Error(`kitchen ${name} needs ${what}`);
    return f.pos[i];
  };
  const json = f.flags.has("--json");
  switch (name) {
    case "init": {
      if (f.flags.has("--skill")) {
        const { installSkill } = await import("./init/files.ts");
        for (const p of installSkill(repo)) out(`installed ${p}`);
        return 0;
      }
      const tool = v("tool");
      if (tool && tool !== "claude" && tool !== "codex") throw new Error("--tool is claude or codex");
      const tty = process.stdin.isTTY && process.stdout.isTTY && !f.flags.has("--yes");
      const ask = tty
        ? async (q: string) => {
            const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
            try {
              return await rl.question(q);
            } finally {
              rl.close();
            }
          }
        : undefined;
      return (await import("./init/quick.ts")).init({ repo, tool: tool as "claude" | "codex" | undefined, ask }, out);
    }
    case "skills": {
      const r = (await import("./init/skills-report.ts")).skillsReport(repo);
      for (const l of [`role skills: ${r.summary}`, ...r.lines]) out(l);
      return 0;
    }
    case "dashboard": {
      const p = v("port");
      await (await import("./dashboard/server.ts")).serveDashboard(repo, p ? Number(p) : 7357, out);
      return await new Promise<number>(() => {});
    }
    case "ticket":
      return control.ticket(repo, f.pos.join(" ") || need(0, '"<text>"'), out);
    case "run":
      return (await import("./run/orchestrator.ts")).run(
        repo,
        {
          detach: f.flags.has("--detach"),
          stop: f.flags.has("--stop"),
          print: f.flags.has("--print"),
          maxUsd: v("max-usd") ? Number(v("max-usd")) : undefined,
          cli: import.meta.filename,
        },
        out,
      );
    case "status":
      return cmd.status(repo, out, { json });
    case "report":
      return cmd.report(repo, out, { json });
    case "resume":
      return control.resume(repo, need(0, "<id>"), out);
    case "feedback":
      return control.feedback(repo, need(0, "<id>"), f.pos.slice(1).join(" "), out, { to: v("to") });
    case "reject":
      return control.reject(repo, need(0, "<id>"), out);
    case "steer":
      return (await control.steer(repo, need(0, "<id>"), f.pos.slice(1).join(" "), out)).code;
    case "pause":
      return control.pause(repo, need(0, "<id>"), out);
    case "stop":
      return control.stop(repo, need(0, "<id>"), out);
    case "job":
      return jobVerb(repo, f, json, out);
    case "qa":
      return qaVerb(repo, f, out);
    default:
      console.error(`kitchen: unknown command ${name}\n\nkitchen --help for the list`);
      return 2;
  }
}

async function jobVerb(repo: string, f: Flags, json: boolean, out: (l: string) => void): Promise<number> {
  const jobs = await import("./engine/jobs.ts");
  const [verb, id, lane] = f.pos;
  if (verb === "next") {
    const p = jobs.next(repo, { restartStranded: f.flags.has("--restart-stranded") });
    if (json) out(JSON.stringify(p, null, 2));
    else {
      for (const s of p.start) out(`start  ${s.id}  ${s.lane}${s.restart ? " (restart: its last agent is gone)" : ""}`);
      for (const r of p.running) out(`busy   ${r.id}  ${r.lane} since ${r.since}`);
      for (const h of p.held) out(`held   ${h.id}  ${h.lane}: ${h.why}`);
      for (const y of p.you) out(`you    ${y.id}  ${y.stage}: ${y.why}`);
      if (p.drained) out(p.you.length ? "drained: what is left waits on the person" : "drained: nothing to do");
    }
    return 0;
  }
  if (!id) throw new Error(`kitchen job ${verb ?? ""} needs <id>`);
  if (verb === "start") {
    if (!lane) throw new Error("kitchen job start needs <id> <lane>");
    const r = await jobs.start(repo, id, lane, { restart: f.flags.has("--restart") });
    if (json) out(JSON.stringify(r, null, 2));
    else if ("refused" in r) out(`refused: ${r.refused}`);
    else if ("parked" in r) out(r.parked);
    else for (const l of [`lane ${r.lane} open for ${r.id}`, `model: ${r.model}`, `cwd: ${r.cwd}`, `brief: ${r.brief}`, `prompt: ${r.prompt}`]) out(l);
    return "refused" in r ? 1 : 0;
  }
  if (verb === "finish") {
    const r = await jobs.finish(repo, id);
    if (json) out(JSON.stringify(r, null, 2));
    else out("refused" in r ? `refused: ${r.refused}` : r.line);
    return "refused" in r ? 1 : 0;
  }
  if (verb === "show") {
    const r = jobs.show(repo, id);
    if (json) out(JSON.stringify(r, null, 2));
    else for (const [k, x] of Object.entries(r)) out(`${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`);
    return 0;
  }
  throw new Error(`kitchen job: next, start, finish or show (got ${verb ?? "nothing"})`);
}

async function qaVerb(repo: string, f: Flags, out: (l: string) => void): Promise<number> {
  const qa = await import("./qa/app.ts");
  const [verb, id, a, b] = f.pos;
  if (!id) throw new Error(`kitchen qa ${verb ?? ""} needs <id>`);
  const name = f.vals.name?.[0];
  if (verb === "up") return qa.appUp(repo, id, out);
  if (verb === "down") return qa.appDown(repo, id, out);
  if (verb === "page") {
    if (!a || !name) throw new Error("kitchen qa page <id> <path> --name <name> [--script f.mjs]");
    return qa.page(repo, id, a, { name, script: f.vals.script?.[0] }, out);
  }
  if (verb === "http") {
    if (!a || !b || !name) throw new Error("kitchen qa http <id> <METHOD> <path> --name <name> [--header 'K: v']… [--data '<json>']");
    return qa.http(repo, id, a, b, { name, headers: f.vals.header ?? [], data: f.vals.data?.[0] }, out);
  }
  throw new Error(`kitchen qa: up, down, page or http (got ${verb ?? "nothing"})`);
}

quietOnEpipe(process.stdout);
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`kitchen: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
