#!/usr/bin/env node
// `kitchen` entry point (ADR 0016). Runs in the repo it is started in (or --repo <dir>); started inside one of its
// job worktrees (.worktrees/<job>), in the main checkout that owns them.
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
  kitchen ticket "<what you want>" [--into <branch>] [--no-run]   a ticket; intake writes its criteria. Kitchen
                                         starts (kitchen run --detach) when nothing works the queue, as after approve,
                                         feedback, resume and inbox run; --no-run files it only; --into: the branch it
                                         starts from and goes into (default staging; it must exist)
  kitchen ticket --check "<what to check>"   a check (ADR 0028): QA tests staging as it is, nothing is built; "Checked
                                         on staging · 4 of 4 pass", or each problem proposed in the inbox
  kitchen ticket --check --every day|hour|2h… "<text>"   file that check on a timer (launchd / systemd);
                                         --every off "<same text>" removes it; kitchen schedules lists them
  kitchen schedules                      this repo's timers (checks, collect), each with how to remove it
  kitchen promote <id>                   a job intake read as KEEP: no (verified, not merged): review, the merge
                                         check, then the merge into its target (or its PR)
  kitchen run [--detach] [--max-usd n]   a headless orchestrator session works the queue (or /kitchen run in Claude Code)
  kitchen run --stop | --print           end it | print the exact command it runs
  kitchen status [--json] [--all]        one row per job (--all: the removed ones too)
  kitchen dashboard                      every repo's jobs in one browser page, on 127.0.0.1:7357: lanes, live activity,
                                         steering; run it in another repo to add that one (--forget removes it)
  kitchen dashboard --private [--port n] this repo alone, on its own server, not added to the list
  kitchen feedback <id> ["<text>"] [--to <stage>]   answer a job that needs you, or send a ready/done one back
  kitchen refine <id>                    a job intake sent to be refined with you: the brief for Claude Code or Codex
                                         (/kitchen refine <id>), which grills the ticket with you, then sends it back
  kitchen approve <id>                   a job held for your approval after intake (intake.confirm) → build
  kitchen merge <id>                     a job held at Ready (ready(held)) into its target: the same checks as an
                                         auto-merge, never main. With staging.merge: pr a person merges its PR on
                                         GitHub instead (ready(PR open)); Kitchen sees it merged or closed
  kitchen steer <id> "<text>"            a message the job's next agent reads
  kitchen pause <id> · stop <id> · resume <id> · reject <id>
  kitchen remove <id> · restore <id>     off the dashboard, any stage (a working lane is stopped, an unfinished job
                                         rejected, its worktree removed; a merged one only hidden) · back in view
  kitchen report [--json]                what the queue did
  kitchen models [--json] [--tool claude|codex]   each lane's model and the choices the tool has (ADR 0023)
  kitchen models set <lane> <model|tier> [--tool t]   intake, build, qa or review; written to kitchen.yaml
  kitchen models check                   one tiny request per chosen model, through the tool (costs a fraction of a cent)

The outer loop (ADR 0022): sources read by code, triaged into proposals you choose from
  kitchen sources [list] [--json]        the sources (GitHub issues by label, a Slack channel by emoji) and the built-in
                                         Kitchen findings, each with its last collect
  kitchen sources add github <owner/repo> [--label kitchen] [--name n]
  kitchen sources add slack <channel id> [--channel-name '#bugs'] [--emoji kitchen] [--name n]   (prints the app setup)
  kitchen sources try github|slack …     read a few items now and show them; saves nothing
  kitchen sources remove <name> · sources slack-token   (the Slack app's token, kept in your keychain)
  kitchen collect [--detach] [--no-triage]   read every source, then one triage session proposes tickets
  kitchen collect --install-schedule [--every 1h] | --remove-schedule   launchd (macOS) or a systemd timer (Linux)
  kitchen inbox list [--json]            proposals and untriaged items
  kitchen inbox run <p…> [--no-run]      the chosen proposals become jobs at intake, highest priority first
  kitchen inbox hold|bring-back|remove <p> · inbox edit <p> [--title t] [--text t]
  kitchen inbox add "<text>" [--source s] [--link url] [--by who] [--key k]
  kitchen inbox propose --item <i>… --title t --text t --kind bug|feature|chore --prio P1|P2|P3 --why w
                        [--risk r] [--line l] [--step s]… [--evidence f]… [--sha s]      (triage's verbs)
  kitchen inbox verdict <i…> duplicate|fixed|not-ours --reason r [--of id] · verdict <i…> unclear --question q…
  kitchen inbox verdict <p> propose      a set-aside one back to Proposed ("Propose anyway")

The orchestrator's verbs (the only way a job moves)
  kitchen job next [--json] [--restart-stranded]   the next wave: lanes to start, what waits and why
  kitchen job start <id> <lane> [--json] [--restart]   open a lane: worktree, brief, the agent's prompt and model
  kitchen job finish <id> [--json]       read the lane's files, run the checks / the merge, move the job (or refuse)
  kitchen job show <id> [--json]

QA's tools (evidence lands in the job's QA folder)
  kitchen qa up <id> · qa down <id>      start / stop the app from the job's worktree
  kitchen qa reset <id>                  down, app.reset, up: the app again on fresh seed data
  kitchen qa page <id> <path> --name <n> [--script f.mjs]   Playwright: screenshot + page text
  kitchen qa http <id> <METHOD> <path> --name <n> [--header 'K: v']… [--data '<json>']   an HTTP transcript

The verify map (the verify skill's features/: how to check each feature; QA keeps it). It lives in the repo
(.claude/skills/<verify.skill>/, committed with each change), or on this machine (.kitchen/verify/skill/) when the
repo ignores .claude/ (kitchen.yaml verify.map: repo|local; init and kitchen run decide it from git)
  kitchen verify sweep [--url <url>] [--json]   before a release: staging checked out, the app up, a brief to drive
                                         every feature in the README's order; changes nothing. --url: drive that
                                         deployed environment instead (nothing starts locally)
  kitchen verify maintain [--json]       map upkeep on a branch of staging: prune, fix drift, drive every feature;
                                         a broken feature becomes a ticket, never a weaker map
  kitchen verify finish <run>            read the run's result, write its report (maintain: land its map fixes)

kitchen --version · kitchen <command> --help · docs: README.md in the package`;

const COMMAND_HELP: Record<string, string> = {
  ticket:
    'kitchen ticket "<what you want>" [--into <branch>] [--no-run] [--check] | ticket --check --every <when|off> "<text>"\n\nFiles a ticket for intake. When no orchestrator works the queue, Kitchen starts one (kitchen run --detach) and says so: "→ intake · Kitchen started"; when one does, it picks the ticket up ("· Kitchen is already working the queue"). approve, feedback, resume and inbox run do the same.\n  --no-run   file it only; kitchen run works the queue later\n  --into <branch>   the job\'s target (ADR 0026): its Build starts from that branch\'s tip and it merges into it, not staging. The branch must exist (on origin with forge github, else locally); Kitchen never creates it. With staging.merge: kitchen, the base branch, main and master are refused; with merge: pr any branch is fine, since a person merges the PR.\n  --check   a check (ADR 0028): intake is told the kind (KIND: check); QA tests the target\'s tip as it is (a check-<id> verify run), nothing is built or merged. Done says "Checked on staging · N of N pass", or "Found N problems" with each problem proposed in the inbox (kitchen inbox list; run one to file the fix).\n  --every <day|hour|2h|30m|…>   with --check: a launchd agent (macOS) or systemd user timer (Linux) files the same check on each tick (the log is .kitchen/checks.log). --every off with the same text removes it; kitchen schedules lists this repo\'s timers.',
  promote:
    'kitchen promote <id>\n\nA job intake read as KEEP: no (code built only to verify something now) ends at Done, "Verified · not merged", its branch kept. promote takes it the rest of the way: Review, the merge check when it touches mapped features, then the merge into its target, or a PR with staging.merge: pr (ADR 0026).',
  schedules:
    "kitchen schedules\n\nThis repo's timers (.kitchen/schedules.json): each check filed with kitchen ticket --check --every, and collect's, with the command that removes it.",
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
  remove:
    "kitchen remove <id>\n\nTakes a job off the dashboard, kitchen status and the queue, whatever its stage. A lane working on it is stopped (its agent is refused from its next tool call, its result dropped); a job not merged is rejected and its worktree removed (the branch and the job folder stay); a merged job is only hidden, staging untouched. kitchen status --all lists it; kitchen restore <id> shows it again.",
  restore: "kitchen restore <id>\n\nA removed job back in view, as it was left (rejected or merged).",
  refine:
    "kitchen refine <id>\n\nFor a job intake sent to be refined with you (needs-info, refine): writes .kitchen/jobs/<id>/refine/brief.md (the ticket, intake's reason and readings, your earlier answers, the verify map's features, the repo's glossary and ADRs) and prints its path. A Claude Code or Codex session follows it with you (/kitchen refine <id>): one question at a time, then kitchen feedback <id> \"<the refined ticket>\" sends it back to intake.",
  merge:
    "kitchen merge <id>\n\nFor a job held at Ready for you (kitchen status shows ready(held)): merges it into its target (staging, or the branch its ticket named with --into) through the same gate as an auto-merge, without the hold. The reviewed head is merged onto the target's tip in a scratch worktree, every check runs there (the when: merge ones too), and when the merge touches features on the verify map the job goes to Merge check first (the orchestrator drives them, then it lands). A conflict or red checks send it back to Build; the target checked out or the branch moved leave it at Ready. On GitHub it goes through its PR into the target. Never into main or the base branch.\n\nWith staging.merge: pr (kitchen init sets it when origin is on GitHub), Kitchen never merges: after the merge check passes it pushes the job branch and opens (or updates) a PR into the target with the Report as its body, and the job waits at Ready as ready(PR open). kitchen job next and the dashboard ask GitHub about it at most once a minute: merged → done (merged on GitHub), closed → rejected; when the target moves under an open PR the merge check re-runs (a conflict or a red the target caused is a catch-up, no round; its own red goes back to Build) and the PR is updated. kitchen merge refuses such a job: merge the PR on GitHub. A PR merged or closed while its job is back in a lane (a catch-up) ends the job too, and the lane's agent is stopped. kitchen reject or kitchen remove on a job whose PR is open closes the PR on GitHub with a comment; kitchen restore doesn't reopen it.",
  approve:
    'kitchen approve <id>\n\nFor a job held after intake for your approval (intake: { confirm: true } in kitchen.yaml): sends it to Build on intake\'s criteria. To change them instead: kitchen feedback <id> "<what to change>".',
  report: "kitchen report [--json]\n\nWhat the queue did: merged, ready, sent back, rounds, time.",
  dashboard:
    "kitchen dashboard | dashboard --forget | dashboard --private [--port n]\n\nThe jobs in a browser, on 127.0.0.1 only: a list or a board by lane, each job's live activity, criteria and changes. From it you answer, steer, pause, resume, stop, reject, follow up and start the orchestrator.\nOne page, http://127.0.0.1:7357/, for every repo on ~/.kitchen/repos.json (kitchen init and kitchen dashboard add the repo they run in; the repo name top-left switches). When the dashboard already runs, it adds this repo and prints its address.\n  --forget   take this repo off the list\n  --private  this repo alone, on its own server, not added to the list (--port implies it; default port 7357)",
  skills: "kitchen skills\n\nEvery skill in Kitchen's role registry (skills/registry.json): found or not for the agent tool, and how to install a missing one.",
  init: "kitchen init [--tool claude|codex] [--yes] | init --skill\n\nChecks what Kitchen needs (node, git and a commit, python3 for the hooks, claude or codex signed in, gh optional), then writes kitchen.yaml with the checks and how to start the app it finds (one question at most when none is obvious; --yes asks nothing), installs the /kitchen skill and the guard hooks (merged into .claude/settings.json, with a backup), adds .gitignore entries, creates the staging branch from your branch, and runs the checks once.",
  job: "kitchen job next|start|finish|show …\n\nThe orchestrator's verbs: the single writer of job state. See kitchen --help.",
  verify:
    "kitchen verify sweep [--url <url>]|maintain [--json] | verify finish <run>\n\nThe verify skill's feature map (ADR 0017).\n  sweep      checks out staging, starts the app and writes a brief that drives every feature in features/README.md order; prints the agent's prompt. Changes nothing.\n             --url <url>: drive that deployed environment instead of starting the app (ADR 0021); recipes that need a reset or seed are reported not run. The URL stays in the run, never in a job.\n  maintain   the same on a branch of staging, with a brief to keep the map honest: prune, merge duplicates, fix drift from each feature's Code:, drive every feature; product regressions become tickets.\n  finish     reads the agent's verdict.json (sweep) or report.json (maintain), writes report.html in .kitchen/verify/<run>/, stops the app; maintain's map fixes (verify skill files only) merge into staging, or (verify.map: local) are copied back to .kitchen/verify/skill/.\nkitchen qa … <run> drives the run's app, like a job's.",
  models:
    "kitchen models [--json] [--tool claude|codex] | models set <lane> <model|tier> [--tool t] | models check\n\nEach lane's model for the tool (ADR 0023) and what you can choose: Claude Code's aliases (fable, opus, sonnet, haiku) and, with ANTHROPIC_API_KEY set, every model Anthropic's models API lists; Codex's providers from ~/.codex/config.toml and their GET /models. set writes models.<tool>.<lane> in kitchen.yaml; it applies from the next lane a job starts. check sends one tiny request per chosen model through the tool itself and says which answer: the only Kitchen command that spends money outside a run.",
  inbox:
    "kitchen inbox list|add|propose|verdict|hold|bring-back|remove|edit|run …\n\nThe outer loop's inbox (ADR 0022): items read from your sources and Kitchen's own findings, the proposals triage made from them, and what you sent to the inner loop. Only these verbs write it; the dashboard calls the same ones. See kitchen --help.",
  collect:
    "kitchen collect [--detach] [--no-triage] | collect --install-schedule [--every 1h] | collect --remove-schedule\n\nReads every source by code (GitHub through gh, Slack through your workspace's Kitchen app), adds what is new to the inbox, then starts one headless Claude Code session that triages the new items together (groups, reproduces on staging, proposes or sets aside). It never builds, merges or posts. One collect at a time per repo: a busy one exits 4 without writing. A source that can't be read is reported unavailable and keeps its watermark.\n  --detach            in the background; the log is .kitchen/collect.log\n  --no-triage         read only; the items wait for the next collect\n  --install-schedule  a launchd agent (macOS) or systemd user timer (Linux) that runs it every --every (default 1h)",
  sources:
    "kitchen sources [list] | add github <owner/repo> [--label kitchen] | add slack <channel id> [--channel-name '#bugs'] [--emoji kitchen] | try … | remove <name> | slack-token\n\nWhere the outer loop reads reports from (.kitchen/sources/<name>.json). In Claude Code, /kitchen sources sets one up by talking: it tries a read, shows you a few items and saves the source on your yes.",
  qa: "kitchen qa up|down|reset|page|http <id> …\n\nThe QA lane's tools: the app from the job's worktree (reset: down, app.reset, up, for fresh seed data), Playwright screenshots, HTTP transcripts. See kitchen --help.",
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
    if (name === undefined) {
      const here = await import("./cli/here.ts");
      console.log(`${here.hereLine(here.kitchenRepo(process.cwd()))}\n`);
    }
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
  const { INBOX_FLAGS } = await import("./inbox/cli.ts");
  const f = parse(rest, ["repo", "to", "into", "port", "tool", "max-usd", "name", "script", "header", "data", "url", ...INBOX_FLAGS]);
  // Inside a job's worktree (.worktrees/<job>), the main checkout: that is where the jobs live.
  const repo = f.vals.repo?.[0] ? path.resolve(f.vals.repo[0]) : (await import("./cli/here.ts")).kitchenRepo(process.cwd());
  const v = (k: string) => f.vals[k]?.[0];
  const need = (i: number, what: string) => {
    if (!f.pos[i]) throw new Error(`kitchen ${name} needs ${what}`);
    return f.pos[i];
  };
  const json = f.flags.has("--json");
  /** ADR 0025 §2: a verb that gives the queue work wakes Kitchen (run/wake.ts) unless --no-run; its line says so. */
  const waking = async (verb: (o: (l: string) => void) => Promise<number> | number): Promise<number> => {
    const lines: string[] = [];
    try {
      const code = await verb((l) => lines.push(l));
      const said: string[] = json ? [] : lines;
      if (code === 0) await (await import("./run/wake.ts")).wake(repo, said, { noRun: f.flags.has("--no-run"), cli: import.meta.filename });
      if (json) for (const l of said) console.error(l);
      return code;
    } finally {
      for (const l of lines) out(l);
    }
  };
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
      const code = await (await import("./init/quick.ts")).init({ repo, tool: tool as "claude" | "codex" | undefined, ask }, out);
      // On the dashboard's list (ADR 0019): needs .kitchen/, which init doesn't always make.
      if (code === 0) {
        fs.mkdirSync(path.join(repo, ".kitchen"), { recursive: true });
        (await import("./dashboard/repos.ts")).addRepo(repo);
      }
      return code;
    }
    case "skills": {
      const r = (await import("./init/skills-report.ts")).skillsReport(repo);
      for (const l of [`role skills: ${r.summary}`, ...r.lines]) out(l);
      return 0;
    }
    case "dashboard": {
      if (f.flags.has("--forget")) {
        const gone = (await import("./dashboard/repos.ts")).forgetRepo(repo);
        out(gone ? `${path.basename(repo)} is off the dashboard's list` : `${path.basename(repo)} wasn't on the dashboard's list`);
        return 0;
      }
      const p = v("port");
      const priv = f.flags.has("--private") || p !== undefined;
      // KITCHEN_DASHBOARD_PORT moves the shared dashboard (a second one, for trying Kitchen out beside your own).
      const port = Number(p ?? process.env.KITCHEN_DASHBOARD_PORT ?? 7357);
      const s = await (await import("./dashboard/server.ts")).serveDashboard(repo, port, out, { private: priv });
      return s ? await new Promise<number>(() => {}) : 0;
    }
    case "ticket": {
      const check = f.flags.has("--check");
      // ADR 0028 §5: a check filed on a timer (or, with off, no longer).
      if (v("every") !== undefined) {
        if (!check) throw new Error('--every files a check on a timer: kitchen ticket --check --every day "<what to check>"');
        const { scheduleCheck } = await import("./inbox/schedule.ts");
        for (const l of scheduleCheck(repo, import.meta.filename, f.pos.join(" "), v("every") as string, {}, v("into"))) out(l);
        return 0;
      }
      return waking((o) => control.ticket(repo, f.pos.join(" ") || need(0, '"<text>"'), o, { into: v("into"), check }));
    }
    case "schedules":
      for (const l of (await import("./inbox/schedule.ts")).schedulesLines(repo)) out(l);
      return 0;
    case "promote":
      return waking((o) => control.promote(repo, need(0, "<id>"), o));
    case "run": {
      // `kitchen run` starts a paid session: a flag it doesn't know (a typo, `--status`) stops it instead.
      const odd = [...[...f.flags].filter((x) => !["--detach", "--stop", "--print", "--json"].includes(x)), ...f.pos];
      if (odd.length) {
        console.error(
          `kitchen run: unknown ${odd.join(", ")} (it takes --detach, --stop, --print, --max-usd <n>). Nothing started.${odd.includes("--status") ? " For the queue's state: kitchen status" : ""}`,
        );
        return 2;
      }
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
    }
    case "status":
      return cmd.status(repo, out, { json, all: f.flags.has("--all") });
    case "report":
      return cmd.report(repo, out, { json });
    case "resume":
      return waking((o) => control.resume(repo, need(0, "<id>"), o));
    case "feedback":
      return waking((o) => control.feedback(repo, need(0, "<id>"), f.pos.slice(1).join(" "), o, { to: v("to") }));
    case "reject":
      return control.reject(repo, need(0, "<id>"), out);
    case "remove":
      return control.remove(repo, need(0, "<id>"), out);
    case "restore":
      return control.restore(repo, need(0, "<id>"), out);
    case "approve":
      return waking((o) => control.approve(repo, need(0, "<id>"), o));
    case "merge": {
      const r = await (await import("./engine/jobs.ts")).mergeHeld(repo, need(0, "<id>"));
      out("refused" in r ? r.refused : r.to === "regress" ? `${r.line}; the orchestrator drives them (kitchen run), then it lands` : r.line);
      return "refused" in r ? 1 : 0;
    }
    case "refine":
      return (await import("./engine/refine.ts")).refine(repo, need(0, "<id>"), out);
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
    case "verify":
      return verifyVerb(repo, f, json, out);
    case "models":
      return modelsVerb(repo, f, json, out);
    case "inbox":
      return f.pos[0] === "run"
        ? waking(async (o) => (await import("./inbox/cli.ts")).inboxVerb(repo, f, json, o))
        : (await import("./inbox/cli.ts")).inboxVerb(repo, f, json, out);
    case "collect":
      return (await import("./inbox/cli.ts")).collectVerb(repo, f, import.meta.filename, out);
    case "sources":
      return (await import("./inbox/cli.ts")).sourcesVerb(repo, f, json, out);
    default:
      console.error(`kitchen: unknown command ${name}\n\nkitchen --help for the list`);
      return 2;
  }
}

async function jobVerb(repo: string, f: Flags, json: boolean, out: (l: string) => void): Promise<number> {
  const jobs = await import("./engine/jobs.ts");
  const [verb, id, lane] = f.pos;
  if (verb === "next") {
    const p = await jobs.next(repo, { restartStranded: f.flags.has("--restart-stranded") });
    if (json) out(JSON.stringify(p, null, 2));
    else {
      for (const l of p.prs) out(`pr     ${l}`);
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

async function modelsVerb(repo: string, f: Flags, json: boolean, out: (l: string) => void): Promise<number> {
  const m = await import("./models/models.ts");
  const [verb, lane, value] = f.pos;
  const tool = f.vals.tool?.[0];
  if (tool && tool !== "claude" && tool !== "codex") throw new Error("--tool is claude or codex");
  if (verb === "set") {
    const role = lane ? m.roleOf(lane) : null;
    if (!role || !value) throw new Error("kitchen models set <intake|build|qa|review> <model or tier>");
    const r = m.setModel(repo, role, value, tool as "claude" | "codex" | undefined);
    out(`${m.TOOL_NAMES[r.tool]} · ${m.LANE_NAMES[r.role]} runs on ${r.model} from the next lane a job starts (kitchen.yaml models.${r.tool}.${r.role})`);
    return 0;
  }
  if (verb === "check") {
    const rs = await m.checkModels(repo);
    if (json) out(JSON.stringify(rs, null, 2));
    else for (const r of rs) out(`${r.ok ? "ok  " : "FAIL"}  ${r.model} (${r.lanes.join(", ")})${r.ok ? "" : `: ${r.why}`}`);
    return rs.every((r) => r.ok) ? 0 : 1;
  }
  if (verb !== undefined) throw new Error(`kitchen models: set or check, or nothing to list (got ${verb})`);
  const l = await m.listModels(repo, { tool: tool as "claude" | "codex" | undefined });
  if (json) {
    out(JSON.stringify(l, null, 2));
    return 0;
  }
  out(`${m.TOOL_NAMES[l.tool]}: ${l.lanes.map((x) => `${x.lane} ${x.model}${x.want !== x.model ? ` (${x.want})` : ""}`).join(" · ")}`);
  out(`choices: ${l.choices.map((c) => c.id).join(", ")}; tiers: ${l.tiers.join(", ")}`);
  for (const n of l.notes) out(`note: ${n}`);
  return 0;
}

async function verifyVerb(repo: string, f: Flags, json: boolean, out: (l: string) => void): Promise<number> {
  const v = await import("./verify/run.ts");
  const [verb, id] = f.pos;
  if (verb === "sweep" || verb === "maintain") {
    const url = f.vals.url?.[0];
    const r = await v.prepare(repo, verb, json ? () => {} : out, new Date(), url !== undefined ? { url } : {});
    if (json) out(JSON.stringify(r, null, 2));
    else for (const l of [`run: ${r.id}`, `model: ${r.model}`, `cwd: ${r.cwd}`, `brief: ${r.brief}`, `prompt: ${r.prompt}`]) out(l);
    return 0;
  }
  if (verb === "finish") {
    if (!id) throw new Error("kitchen verify finish needs <run> (kitchen verify sweep printed it)");
    return v.finishRun(repo, id, out);
  }
  throw new Error(`kitchen verify: sweep, maintain or finish (got ${verb ?? "nothing"})`);
}

async function qaVerb(repo: string, f: Flags, out: (l: string) => void): Promise<number> {
  const qa = await import("./qa/app.ts");
  const [verb, id, a, b] = f.pos;
  if (!id) throw new Error(`kitchen qa ${verb ?? ""} needs <id>`);
  const name = f.vals.name?.[0];
  if (verb === "up") return qa.appUp(repo, id, out);
  if (verb === "down") return qa.appDown(repo, id, out);
  if (verb === "reset") return qa.appReset(repo, id, out);
  if (verb === "page") {
    if (!a || !name) throw new Error("kitchen qa page <id> <path> --name <name> [--script f.mjs]");
    return qa.page(repo, id, a, { name, script: f.vals.script?.[0] }, out);
  }
  if (verb === "http") {
    if (!a || !b || !name) throw new Error("kitchen qa http <id> <METHOD> <path> --name <name> [--header 'K: v']… [--data '<json>']");
    return qa.http(repo, id, a, b, { name, headers: f.vals.header ?? [], data: f.vals.data?.[0] }, out);
  }
  throw new Error(`kitchen qa: up, down, reset, page or http (got ${verb ?? "nothing"})`);
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
