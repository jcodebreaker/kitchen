#!/usr/bin/env node
// `kitchen` entry point (PLAN §4). Runs in the repo it is started in (or --repo <dir>).
//   kitchen ticket "<text>"
//   kitchen run [--once] [--detach] [<job>]
//   kitchen status
//   kitchen resume <id|n> · feedback <id> [--to <stage>] ["<text>"] · reject <id>
//   kitchen steer <id> "<text>" · pause <id> · stop <id>       talk to a running job, park it (src/engine/control.ts, ADR 0009)
//   kitchen report [--bench]
//   kitchen bench smoke|full|tuned|heldout [--tool claude|codex] [--runs n] [--only a,b] [--concurrency n] [--max-usd x] [--out dir] [--no-skills]   (src/bench/run.ts)
//   kitchen skills                                               which role skills are found for the agent tool (src/skills/, ADR 0014)
//   kitchen init [--tool claude|codex] [--toolkit] [--yes] [--start-over] · kitchen toolkit build [--answers <file>] [--yes] [--start-over] [--detach] [--status] [--verbose] · toolkit check [--feature x] [--src dir] · toolkit up · toolkit down --id <id>   (src/cli/toolkit-commands.ts)
//   kitchen drive <job> <C> [--repro] [--arg k=v]… [--role r]   one criterion's proof (src/proof/prove.ts)
//   kitchen drive <job> --view "<view>" [--role reviewer-ux]     one extra view for a UX/UI lens (src/engine/views.ts)
//   kitchen dismiss <job> [<finding-id>] [--reason "<why>"]      list a job's findings, or say one was not useful (ledger, per lens)
//   kitchen dashboard [--port 7357]                              the jobs, on 127.0.0.1; steer, answer, pause from it (src/dashboard/server.ts)
//   kitchen migrate [--dry-run]                                  kitchen.yaml schema + Toolkit template files (src/migrate/migrate.ts)
//   kitchen retro [status | unmute <lens>/<category> | approve <n>]   mutes and lesson drafts (src/retro/retro.ts)
//   kitchen toolkit maintain [--force]                           pstack's maintain pass (src/toolkit/maintain.ts)
//   kitchen mcp --job <id> --role <role> [--repo <dir>]   the engine bridge (src/bridge/mcp.ts)
import fs from "node:fs";
import path from "node:path";
import { serveBridge } from "./bridge/mcp.ts";
import * as cmd from "./cli/commands.ts";
import { quietOnEpipe } from "./cli/epipe.ts";

const USAGE =
  'usage: kitchen ticket "<text>" | run [--once] [--detach] [<job>] | status | resume <id|n> | feedback <id> [--to <stage>] ["<text>"] | reject <id> | steer <id> "<text>" | pause <id> | stop <id> | report [--bench] [--json] | retro [status | unmute <lens>/<category> | approve <n>] | migrate [--dry-run] | dashboard [--port n] | bench smoke|full|tuned|heldout […] | skills | init [--tool claude|codex] [--toolkit] [--yes] [--start-over] | toolkit build [--answers <file>] [--yes] [--start-over] [--detach] [--verbose] | toolkit build --status [--wait <s>] | toolkit check [--feature x] [--src dir] | toolkit up | toolkit down --id <id> | drive <job> <C> [--repro] [--arg k=v]… | drive <job> --view "<view>" | dismiss <job> <finding> [--reason "<why>"] | toolkit maintain [--force] | mcp …';

const HELP = `kitchen: turns tickets into proven, reviewed pull requests (Claude Code or Codex)

Setup
  kitchen init [--tool claude|codex]      seconds: checks node, git and your agent first, then kitchen.yaml with your checks, the /kitchen skill, .gitignore; runs the checks once
  kitchen init --yes                      every recommended answer (for CI); Enter takes it in a terminal
  kitchen init --start-over               begin again (a re-run otherwise continues where the last one stopped)
  kitchen init --skill                    only the /kitchen skill (then: /kitchen set up Kitchen in Claude Code or Codex)
  kitchen toolkit build [--detach]        3-15 min: an agent teaches Kitchen to start and drive your app (a proven Toolkit on kitchen/setup)
  kitchen toolkit build --answers <file>  resume the build with answers to its questions (.kitchen/setup-questions.json)
  kitchen toolkit build --status [--wait <s>]   how a detached build is doing
  kitchen init --toolkit                  both: quick init, then the Toolkit build
  kitchen toolkit check                   prove the Toolkit end to end (up, drives, reset, down)
  kitchen skills                          which role skills (skills/registry.json) are installed for the agent tool, and where

Work
  kitchen ticket "<what you want>"        a ticket from a prompt (or label a GitHub issue: source.kind github)
  kitchen run [--detach] [--once] [<job>] work the queue (--detach: in the background, log in .kitchen/run.log)
  kitchen status [--json]                 one row per job (--json: one JSON array)
  kitchen dashboard [--port 7357]         the jobs in a browser, on 127.0.0.1: watch them, message them, pause them
  kitchen feedback <id> ["<text>"] [--to <stage>]   answer a job that needs you, or send a done one back
  kitchen steer <id> "<text>"              message a running job: its agent reads it at its next step
  kitchen pause <id> · stop <id> · resume <id>   park a job after its step, or now; wake it
  kitchen reject <id>
  kitchen dismiss <job> [<finding>] [--reason "<why>"]  list its findings, or say one was not useful

Learning
  kitchen report [--bench] [--json]       the measures from the ledger
  kitchen retro [status | unmute <lens>/<category> | approve <n>]

Maintenance
  kitchen migrate [--dry-run]             kitchen.yaml schema + the Toolkit's template files
  kitchen toolkit maintain | up | down --id <id>
  kitchen drive <job> <C> [--repro] [--arg k=v]…   run one criterion's proof by hand

kitchen --version · kitchen <command> --help · docs: README.md in the package`;

/** `kitchen <command> --help`: the command's usage, then what it does. */
const COMMAND_HELP: Record<string, string> = {
  ticket: 'kitchen ticket "<what you want>"\n\nFiles a ticket from a prompt; kitchen run takes it in. With source.kind github, label an issue instead.',
  run: "kitchen run [--once] [--detach] [<job>]\n\nWorks the queue until nothing is left to do.\n  --once     one pass over the queue, then stop\n  --detach   in the background; the log is .kitchen/run.log\n  <job>      only this job",
  status:
    "kitchen status [--json]\n\nOne row per job: id, title, stage, round, when it last moved, PR, report.\n  --json   the jobs as one JSON array, nothing else",
  resume:
    "kitchen resume <id|n>\n\nWakes a paused job: it goes back to the stage it paused in and reads the messages sent while it was paused. On a job still running, it cancels a pause or stop not made yet. A job that needs you takes kitchen feedback instead.\nA job paused no-toolkit takes the Toolkit once it is on your base branch (kitchen toolkit build, then merge kitchen/setup); without one it goes on with checks and tests only, unless it is high risk or checks can't prove it.",
  steer:
    'kitchen steer <id> "<text>"\n\nA message for a job while it runs: add context, redirect it, ask what it is doing. A running Claude agent reads it after the tool call it is in, without stopping. Otherwise (Codex, a step with no agent, a paused job) the next agent role reads it, quoted as operator notes. The thread is .kitchen/jobs/<id>/messages.jsonl.',
  pause: "kitchen pause <id>\n\nLets the current step finish, then parks the job (paused, by-you) until kitchen resume.",
  stop: "kitchen stop <id>\n\nKills the job's running agent (and the checks it started) now and parks the job (paused, by-you). kitchen resume runs the stage again.",
  feedback:
    'kitchen feedback <id> ["<text>"] [--to <stage>]\n\nAnswers a job that needs you, or sends a done job back to build with your text.\n  --to <stage>   for a needs-human job: where it goes, at or before the stage it stopped in (intake ... verify)',
  reject: "kitchen reject <id>\n\nCloses a job without a PR.",
  report:
    "kitchen report [--bench] [--json]\n\nEvery measure from the ledger (merge-ready rate, rounds, escalations, time and cost...).\n  --bench   the benchmark runs instead\n  --json    machine-readable",
  retro:
    "kitchen retro [status | unmute <lens>/<category> | approve <n>]\n\nWith no argument, runs the retro now: mutes review categories people keep dismissing, proposes lesson tickets as drafts.\n  status                     the mutes and drafts\n  unmute <lens>/<category>   that category blocks again\n  approve <n>                turn draft n into a ticket",
  migrate:
    "kitchen migrate [--dry-run]\n\nBrings kitchen.yaml's schema and the Toolkit's template files up to this Kitchen; prints each change as a diff.\n  --dry-run   print, change nothing; exit 1 when there is something to change (for CI), 0 when not",
  dashboard:
    "kitchen dashboard [--port 7357]\n\nThe jobs in a browser, on 127.0.0.1 only: a list or a board, each job's live activity, checks and changes, and the Setup run. From it you answer, steer, pause, resume, stop, reject and follow up: the same engine code as the CLI verbs. Ctrl-C stops it.",
  bench:
    "kitchen bench smoke|full|tuned|heldout [--tool claude|codex] [--runs n] [--only a,b] [--concurrency n] [--max-usd x] [--out dir] [--no-skills]\n\nThe benchmark (from a clone of Kitchen only).\n  --no-skills   every role on its prompt alone (skills.enabled: false in each bench repo), to compare with a run with skills",
  skills:
    "kitchen skills\n\nEvery skill in Kitchen's role registry (skills/registry.json): found or not for the repo's agent tool (kitchen.yaml agent.tool), where it comes from, and how to install a missing one. Changes nothing.",
  init: "kitchen init [--tool claude|codex] [--toolkit] [--yes] [--start-over] | init --skill\n\nFirst it checks what Kitchen needs (node 20.11+, git and a commit, claude or codex signed in, gh optional): one line each, ✓ or ✗, with the command that fixes each ✗ on this OS; it installs nothing itself, and a missing one stops it (exit 2). Then quick init, in seconds: writes kitchen.yaml with the checks it finds (package.json, Makefile, pyproject.toml, go.mod, Cargo.toml; one short agent call only when none are obvious), installs the /kitchen skill, adds Kitchen's .gitignore entries, and runs the checks once. No Toolkit, no app start, no Docker.\n  --tool      claude or codex (default: the one that is ready; asked when both are)\n  --yes       take every recommended answer (never checks an agent proposed)\n  --start-over   begin again; the old answers and record go to .bak\n  --skill     only the /kitchen skill\n  --toolkit   then build the Toolkit too (kitchen toolkit build; its flags --answers, --detach, --verbose… pass through)",
  toolkit:
    "kitchen toolkit build [--answers <file>] [--yes] [--start-over] [--detach] [--status [--wait <s>]] [--verbose] [--tool claude|codex] | check [--feature x] [--src dir] | up | down --id <id> | maintain [--force]\n\n  build      an agent surveys the repo (at most 3 questions), writes the Toolkit and Kitchen proves it, on the branch kitchen/setup; 3-15 min, resumable (a re-run continues where it stopped; --start-over begins again). Questions: Enter takes the recommended answer, --yes takes them all. One line per phase and a live heartbeat; every detail in .kitchen/init/init.log (--verbose: on the terminal too)\n  check      prove the Toolkit end to end (up, drives, reset, down), every step shown\n  up/down    start or stop an instance of the app\n  maintain   the maintain pass: re-prove the Toolkit on the base and fix what broke",
  drive:
    'kitchen drive <job> <C> [--repro] [--arg k=v]... [--role r] | drive <job> --view "<view>"\n\nRuns one criterion\'s proof by hand (or one extra view for a review lens) and stamps the evidence.',
  dismiss:
    "kitchen dismiss <job> [<finding>] [--reason \"<why>\"]\n\nWithout a finding id, lists the job's review findings. With one, it records that the finding was not useful: the builder ignores it and the lens won't block on it again. A security finding needs --reason.",
  mcp: "kitchen mcp --job <id> --role <role> [--repo <dir>]\n\nThe engine bridge agents drive the app through (started by Kitchen, not by hand).",
};

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    // Bare `kitchen`: first, where this folder stands (ADR 0011), so the list never reads as "set up".
    if (name === undefined) console.log(`${(await import("./cli/here.ts")).hereLine(process.cwd())}\n`);
    console.log(HELP);
    return name === undefined ? 2 : 0;
  }
  if (name === "--version" || name === "-v") {
    console.log((JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version);
    return 0;
  }
  // `kitchen <cmd> --help` prints that command's usage and runs nothing.
  if (rest.includes("--help") || rest.includes("-h")) {
    const h = COMMAND_HELP[name];
    if (!h) {
      console.error(`kitchen: unknown command ${name}\n\nkitchen --help for the list`);
      return 2;
    }
    console.log(`usage: ${h}`);
    return 0;
  }
  if (name === "toolkit" || name === "init" || name === "setup-mcp") return (await import("./cli/toolkit-commands.ts")).w2(name, rest);
  if (name === "bench") return bench(rest);
  if (name === "skills") {
    const i = rest.indexOf("--repo");
    const repo = path.resolve(i >= 0 ? (rest[i + 1] ?? ".") : process.cwd());
    const r = (await import("./init/skills-report.ts")).skillsReport(repo);
    for (const l of [`role skills: ${r.summary}`, ...r.lines]) console.log(l);
    return 0;
  }
  if (name === "dashboard") {
    const i = rest.indexOf("--repo");
    const p = rest.indexOf("--port");
    const repo = path.resolve(i >= 0 ? (rest[i + 1] ?? ".") : process.cwd());
    await (await import("./dashboard/server.ts")).serveDashboard(repo, p >= 0 ? Number(rest[p + 1]) : 7357, (l) => console.log(l));
    return await new Promise<number>(() => {});
  }
  if (name === "retro") {
    const i = rest.indexOf("--repo");
    const repo = path.resolve(i >= 0 ? (rest[i + 1] ?? ".") : process.cwd());
    return (await import("./cli/retro-commands.ts")).retro(repo, i >= 0 ? rest.filter((_, j) => j !== i && j !== i + 1) : rest, (l) => console.log(l));
  }
  if (name === "mcp") {
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i]?.replace(/^--/, "");
      if (!k || rest[i + 1] === undefined || k in flags) throw new Error("usage: kitchen mcp --job <id> --role <role> [--repo <dir>]");
      flags[k] = rest[i + 1];
    }
    if (!flags.job || !flags.role) throw new Error("kitchen mcp needs --job and --role");
    await serveBridge({ job: flags.job, role: flags.role, repo: flags.repo ?? process.cwd() });
    return 0;
  }
  let repo = process.cwd();
  let to: string | undefined;
  const driveArgs: Record<string, string> = {};
  let role = "operator";
  let viewArg: string | undefined;
  let reason: string | undefined;
  const pos: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--repo") repo = rest[++i] ?? repo;
    else if (rest[i] === "--to" && name === "feedback") to = rest[++i];
    else if (rest[i] === "--arg" && name === "drive") {
      const kv = rest[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq < 1) throw new Error(`--arg takes name=value, got ${kv}`);
      driveArgs[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (rest[i] === "--role" && name === "drive") role = rest[++i] ?? role;
    else if (rest[i] === "--view" && name === "drive") viewArg = rest[++i];
    else if (rest[i] === "--reason" && name === "dismiss") reason = rest[++i];
    else if (rest[i].startsWith("--")) flags.add(rest[i]);
    else pos.push(rest[i]);
  }
  repo = path.resolve(repo);
  const out = (l: string) => console.log(l);
  const need = (what: string) => {
    if (!pos[0]) throw new Error(`kitchen ${name} needs ${what}`);
    return pos[0];
  };
  switch (name) {
    case "ticket":
      return cmd.ticket(repo, need('"<text>"'), out);
    case "run":
      for (const f of flags) if (f !== "--once" && f !== "--detach") throw new Error(`kitchen run: unknown flag ${f}`);
      return cmd.run(repo, { once: flags.has("--once"), detach: flags.has("--detach"), job: pos[0], cli: import.meta.filename, argv }, out);
    case "status":
      return cmd.status(repo, out, { json: flags.has("--json") });
    case "resume":
      return cmd.resume(repo, need("<id|n>"), out);
    case "feedback":
      return cmd.feedback(repo, need("<id>"), pos.slice(1).join(" "), out, { to });
    case "reject":
      return cmd.reject(repo, need("<id>"), out);
    case "steer":
      return (await cmd.steer(repo, need("<id>"), pos.slice(1).join(" "), out)).code;
    case "pause":
      return cmd.pause(repo, need("<id>"), out);
    case "stop":
      return cmd.stop(repo, need("<id>"), out);
    case "report":
      if (flags.has("--bench")) {
        for (const l of (await import("./bench/run.ts")).benchReport(repo)) out(l);
        return 0;
      }
      return cmd.report(repo, out, { json: flags.has("--json") });
    case "migrate":
      for (const f of flags) if (f !== "--dry-run") throw new Error(`kitchen migrate: unknown flag ${f}`);
      return (await import("./cli/migrate-command.ts")).migrate(repo, { dryRun: flags.has("--dry-run") }, out);
    case "dismiss":
      return cmd.dismiss(repo, need("<job>"), pos[1], reason, out);
    case "drive":
      if (viewArg !== undefined) {
        if (!viewArg.trim()) throw new Error('kitchen drive --view needs a view: "/path [--as user]", a feature drive, or toolkit segments');
        return cmd.view(repo, need("<job>"), viewArg, role === "operator" ? "reviewer-operator" : role, out);
      }
      for (const f of flags) if (f !== "--repro") throw new Error(`kitchen drive: unknown flag ${f}`);
      if (!pos[1]) throw new Error("kitchen drive needs <job> <criterion>");
      return cmd.drive(repo, need("<job>"), pos[1], { repro: flags.has("--repro"), args: driveArgs, role }, out);
    default:
      console.error(`kitchen: unknown command ${name}\n\n${USAGE}\n\nkitchen --help for the list`);
      return 2;
  }
}

async function bench(argv: string[]): Promise<number> {
  const noSkills = argv.includes("--no-skills");
  const rest = argv.filter((a) => a !== "--no-skills");
  const tier = rest[0];
  if (!["smoke", "full", "tuned", "heldout"].includes(tier ?? ""))
    throw new Error(
      "usage: kitchen bench smoke|full|tuned|heldout [--tool claude|codex] [--runs n] [--only a,b] [--concurrency n] [--max-usd x] [--out dir] [--no-skills]",
    );
  const f: Record<string, string> = {};
  for (let i = 1; i < rest.length; i += 2) {
    const k = rest[i]?.replace(/^--/, "");
    if (!k || rest[i + 1] === undefined || !["tool", "runs", "only", "concurrency", "max-usd", "out"].includes(k))
      throw new Error(`kitchen bench: bad flag ${rest[i]}`);
    f[k] = rest[i + 1];
  }
  const tool = (f.tool ?? "claude") as "claude" | "codex";
  if (tool !== "claude" && tool !== "codex") throw new Error("--tool is claude or codex");
  const { runBench } = await import("./bench/run.ts");
  const kitchenRoot = path.resolve(import.meta.dirname, "..");
  if (!fs.existsSync(path.join(kitchenRoot, "bench", "set.yaml")) || !fs.existsSync(path.join(kitchenRoot, "src", "cli.ts")))
    throw new Error("kitchen bench runs from a clone of the Kitchen repository (it needs bench/ and the fixtures), not from the npm package");
  const r = await runBench({
    kitchenRoot,
    tier: tier as "smoke" | "full" | "tuned" | "heldout",
    tool,
    runs: Number(f.runs ?? (tier === "smoke" ? 1 : 3)),
    only: f.only?.split(",").filter(Boolean),
    concurrency: Number(f.concurrency ?? 2),
    maxUsd: Number(f["max-usd"] ?? 25),
    out: path.resolve(
      f.out ?? path.join(kitchenRoot, "bench", ".work", `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${tier}${noSkills ? "-noskills" : ""}`),
    ),
    ledgerRepo: process.cwd(),
    print: (l) => console.log(l),
    skills: !noSkills,
  });
  return r.results.every((x) => x.correct) ? 0 : 1;
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
