---
name: kitchen
description: "Drive Kitchen, the software factory in this repo: set it up (init), file tickets, run the queue as its orchestrator (/kitchen run: waves of intake, build, QA and review agents, merging passing jobs into staging), check status, answer jobs, refine an unclear ticket with the user (/kitchen refine), approve intake's criteria, steer, pause or stop a job, sweep or maintain its verify map. Use when the user mentions Kitchen or /kitchen, asks to turn a request into a reviewed change, to queue or run work, or to see job status."
---

# /kitchen

Kitchen turns tickets into reviewed changes merged into a `staging` branch. You map what the user says onto
`kitchen` commands, run them, and relay their one-line outputs. `kitchen run` (the CLI) is how the queue runs
headless, by default: Kitchen itself plans the waves and starts one agent session per lane. When the user says
**run** (or `/kitchen run`) in this session, you become the orchestrator here, so they can watch it live: see
Running the queue.

<!-- kitchen-run:start (the plugin's copy replaces this block: npm run plugin:sync) -->
Run commands from the repo root. If `kitchen` is not on PATH, use
`npx devkitchen` in its place.
<!-- kitchen-run:end -->

| the user says | run |
|---|---|
| set up Kitchen, first use | `kitchen init` (seconds; see Setup) |
| "do X", "fix Y", "add Z" (a request for work) | `kitchen ticket "<the request>"` (see Tickets), then relay its line: it starts Kitchen in the background when nothing works the queue ("→ intake · Kitchen started"). When the user wants to run the queue in this session instead, `kitchen ticket --no-run "<the request>"` |
| test, confirm or explore without changing code: "check checkout still works", "go through the loan flow and see what breaks" | `kitchen ticket --check "<the request>"`: QA drives staging as it is; nothing is built or merged. It ends "Checked on staging · N of N pass" or "Found N problems", each problem a proposal in `kitchen inbox list` |
| "check X every day", "run that check nightly" | `kitchen ticket --check --every day "<the check>"` (hour, 2h, 30m…); `--every off "<the same text>"` removes it; `kitchen schedules` lists them |
| "promote 006", "keep that harness after all" (a job `kitchen status` shows `Verified · not merged`) | `kitchen promote <id>`: Review, the merge check, then the merge into its target (or its PR) |
| work aimed at another branch: "do X on feature/checkout", "this goes into release/2.1" | `kitchen ticket --into <branch> "<the request>"`: the job starts from that branch and merges into it, not staging. The branch must exist (Kitchen never creates it); with `staging.merge: kitchen` the base branch, main and master are refused |
| `run`, start, "go", work the queue, or your prompt is `/kitchen run` | be the orchestrator yourself, in this session: Running the queue, below. Never call `kitchen run` for this: that starts Kitchen's own headless run beside you. When `kitchen status` shows an orchestrator already running, say Kitchen is working the queue and don't start another |
| what's happening, status, progress | `kitchen status`; when a job shows `needs-info(refine: …)`, offer to refine it with them (see Refining a ticket) |
| "refine 004", "let's clarify 004", or your prompt is `/kitchen refine 004` | Refining a ticket, below |
| "approve 004", "the criteria are fine" | `kitchen approve <id>` (only a job shown `needs-info(confirm: …)`) |
| tell a job something: "tell 005 to keep the diff small" | `kitchen steer <id> "<their words>"` |
| "hold 005", "pause it after this step" | `kitchen pause <id>` |
| "stop 005 now" | `kitchen stop <id>` |
| continue a paused or stopped job | `kitchen resume <id>` |
| "merge 002", "ship 002 to staging" (a job `kitchen status` shows `ready(held)`) | `kitchen merge 002`: the same checks as an auto-merge (a trial merge on its target's tip, every check, the merge check when it touches features), into its target (staging unless its ticket named one), never main; a conflict or red checks send it back to Build |
| a job `kitchen status` shows `ready(PR open)` | its PR waits for review on GitHub (`staging.merge: pr`): the user merges or closes it there, never `kitchen merge`. Kitchen notices within a minute (merged → done, closed → rejected). `kitchen reject` or `kitchen remove` on it closes the PR on GitHub |
| answer a job's question, "try again with …", follow up on a ready or merged job | `kitchen feedback <id> "<their answer>"` |
| drop a job | `kitchen reject <id>` |
| "remove 005", "get rid of it", "I don't want it on the dashboard" (any stage, even while it builds) | `kitchen remove <id>`: stops a working lane, rejects an unfinished job, removes its worktree; a merged one is only hidden. `kitchen restore <id>` brings it back in view |
| "show me the jobs", "open the dashboard" | `kitchen dashboard` as a background command, then give the user the address it prints (http://127.0.0.1:7357/#<repo>; when a dashboard already runs it adds this repo, prints `already open: …` and exits) |
| run the queue headless, in the background, "run it without me" | `kitchen run --detach`: Kitchen plans the waves and starts one `claude -p` (or `codex exec`) session per lane itself, finishing each lane as its agent ends; `kitchen run --stop` ends it and every lane |
| how is Kitchen doing | `kitchen report` |
| "sweep", check every feature before a release, "is staging good to ship" | a verify run: see The verify map, below (`kitchen verify sweep`) |
| "maintain the map", tidy or audit the verify skill, the map looks stale | a verify run: `kitchen verify maintain` |
| "watch GitHub issues labelled bug", "the #bugs Slack channel", `/kitchen sources`, add or change a source | The outer loop: sources, below |
| "use Opus for review", "build on sonnet", which models does it run on | `kitchen models set <intake\|build\|qa\|review> <model>` (a name from `kitchen models`, or a tier: strong, medium, cheap); `kitchen models` to show them. `kitchen models check` costs a little: run it only when the user asks whether the models answer |
| collect, "what came in", "check the inbox" | `kitchen collect` as a background command (it reads every source, then one triage session proposes tickets), then `kitchen inbox list` |
| "run p1 and p3", "send the slow-list one" | `kitchen inbox run <proposal ids>` (only proposals the user named); like `kitchen ticket`, it starts Kitchen when nothing works the queue |

## Tickets

The ticket is the work the user wants done, in their words. Words addressed to you about what to do after
filing it ("then start the queue", "and show me the status") are not part of the work: strip them and act on
them yourself. Everything about the work stays, verbatim.

## Setup

"Set up Kitchen" means `kitchen init`. It takes seconds. It checks what Kitchen needs (node, git and a commit,
python3 for the guard hooks, `claude` signed in, `gh` optional) and stops with exit 2 and the fix under each ✗.
Kitchen installs nothing and signs no one in: offer to run an install command; a sign-in is the user's to do.
Then it writes `kitchen.yaml` (the checks, how to start the app, staging), installs this skill and the guard hooks
into `.claude/settings.json` (merged, backed up), creates the `staging` branch and runs the checks once. Relay its
lines. If the checks fail, say so plainly: every job's checks would fail too. If it found no way to start the app,
ask the user for the command once and add `app: { start: "<command>" }` to `kitchen.yaml`.

## The dashboard: one page, one port

There is one Kitchen dashboard per machine, at http://127.0.0.1:7357/, and it shows every repo the user ran Kitchen
in (a switcher, top left). Never start a second one for another repo:
- Run `kitchen dashboard` with no flags, in the repo. If a dashboard already runs, it adds this repo and prints
  `already open: http://127.0.0.1:7357/#<repo>`: give the user that link. Don't stop or restart theirs.
- Never pass `--port` or `--private` to get around a busy port, and never pick another port yourself.
- If it says the port is held by something that isn't a Kitchen dashboard, or by an older Kitchen, tell the user
  what it printed and that they can stop that process (Ctrl-C where it runs) and run `kitchen dashboard` again.
  Leave the choice to them.
- `--private` is only for a throwaway copy you made yourself (a test run), so it stays off the user's list: stop
  it when you are done.

## Running the queue (you are the orchestrator)

This is `/kitchen run` in a session the user opened, for watching the work live. The headless default is the CLI,
`kitchen run`: Kitchen runs this same loop in code, with one agent session per lane, and finishes each lane the
moment its agent ends (ADR 0030). Here, you run the queue in this session. You **never** do product work yourself and you **never** edit
`.kitchen/jobs/`, `job.json`, the job branches or `staging` by hand: you start one agent per lane and move jobs
only through `kitchen job` verbs, which refuse any illegal move. The Agent tool is how you start a lane agent.

**Loop** (repeat until the plan says `drained`):

1. `kitchen job next --json` (the **first** call of a run: add `--restart-stranded`, which hands back lanes an
   earlier session left open). It returns `start` (lanes to open now: every job in intake, then downstream first;
   a lane is intake, build, qa, review or **regress**, the short pass that drives the features a job touches on
   the job's target with the job merged, before Kitchen merges it), `running`, `held` (each
   with why: a job it names on its `AFTER:` line, or no room; jobs touching the same files run side by side) and
   `you` (jobs waiting on the person, a PR waiting for review on GitHub among them), and `prs`: what became of open
   PRs since the last look (merged, closed, the merge check re-run because the target moved). Tell the user the wave
   in one line.
2. For **every** entry in `start`, in parallel:
   - `kitchen job start <id> <lane> --json` (`--restart` when the entry says `restart`). It prepares the job's
     worktree and brief, hands over the person's unread messages, and returns `{ prompt, model, cwd, brief, key }`, or
     `refused` / `parked` (say why and skip it).
   - Spawn one Agent with exactly that `prompt`, and `model` set to the returned model, in the foreground (never
     `run_in_background`): parallel lanes are several Agent calls in one message. Never end your turn while a lane
     agent is still running: ending your turn leaves its lane unfinished until you are back. Use one agent per lane per
     job: never reuse one, never give one two jobs, never do a lane yourself.
3. When an agent returns, run `kitchen job finish <id> --key <key> --json` for its job, at once (`key` is what its
   start returned: a lane another run opened since is refused, untouched). Kitchen reads the files the lane left (intake.md, the commits, the QA verdict, evidence and map updates, review.json, the regress verdict),
   runs the checks itself, merges into the job's target (staging unless its ticket named one) when review passes and
   the features the merge touches still work (or opens a regress lane to drive them first; with `staging.merge: pr`
   it opens the PR for a person instead), and moves the job, or refuses and says why (the lane runs again in the next wave;
   three refusals go to a person). Relay its `line`. Never argue with a refusal and never write the lane's files
   yourself.
4. Between waves, read nothing else: steering reaches the next agent through `kitchen job start`. Then go to 1.

A check (ADR 0028) goes intake → qa → done: its QA lane drives the target's tip as it is, and finishing it
proposes each problem it found in the inbox. A `KEEP: no` job stops at done after QA, "Verified · not merged",
until the user runs `kitchen promote`. Neither needs anything else from you: start the lanes `next` lists.

When the plan is `drained`, report: what merged and into which branch (with the short shas), what each check found (its result words and the
proposals), what was verified and not merged, which PRs wait for
review (with their links), what stopped at Ready and why, and what needs the user (`kitchen status`). Then stop: start nothing more and leave nothing running (in a session the user opened themselves, Kitchen won't end it for you). Never merge `staging` into the base branch or main,
never push either: that is the user's.

If `kitchen job start` or `finish` fails with an error (not a refusal), show its last line and stop the run.
If the user asks you to stop the run, finish the agents in flight (`kitchen job finish` each) and stop.

## The verify map

Kitchen keeps a verify skill in the repo (`.claude/skills/verify-<app>/`, named by kitchen.yaml's `verify.skill`):
how to start and drive the app, and a feature map (`features/`), one file per user-facing feature with its recipe and
the files behind it. A repo that ignores `.claude/` keeps it on this machine instead (`verify.map: local`, in
`.kitchen/verify/skill/<name>/`): Kitchen copies it into each checkout it makes and saves QA's updates there, never
in a commit. Don't edit, commit or force-add it yourself. QA follows
and updates it in every job; Kitchen drives the touched features before each merge. Two runs use it outside jobs,
each one agent you start like a lane agent:

1. `kitchen verify sweep --json` (a release check: every feature against staging, changes nothing; add
   `--url <url>` when the user wants a deployed environment checked instead: nothing starts locally) or
   `kitchen verify maintain --json` (map upkeep: prune, fix drift, drive every feature; a broken feature becomes
   a new ticket). It checks out staging, starts the app, writes the brief and returns `{ id, prompt, model, cwd }`.
2. Spawn one Agent with exactly that `prompt` and `model`, in the foreground.
3. When it returns, `kitchen verify finish <id>` and relay its lines: the report path, each feature's result,
   and (maintain) what merged into staging and which tickets it filed. Offer to run the queue for new tickets.

Suggest `kitchen verify maintain` when the user asks about a stale map, or after many merges since the last one.

## Refining a ticket

Intake sends a ticket to be refined with the user when a short answer won't do: it can be read more than one way,
it is too big for one job, a bug has no way to see it, or its words mean something else in the code. `kitchen
status` shows the job as `needs-info(refine: <reason>)`. Lane agents never ask; you do it here, with the user.

1. `kitchen refine <id>`. It writes a brief (the ticket, intake's readings, earlier answers, the verify map's
   features, the repo's glossary and ADRs) and prints its path. Read it all.
2. Follow its steps: `grill-with-docs` when you have it (else `grilling` with `domain-modeling`, else by hand),
   **one question per turn**, each with your recommended answer. Look in the code before asking.
3. Never invent an answer or answer for the user: what they haven't said stays open.
4. End with the refined ticket in the brief's shape. Show it and ask whether to send it. Only after a yes:
   `kitchen feedback <id> "<the refined ticket>"`. For a ticket that is more than one job, list the slices in the
   refined ticket; Kitchen files the later ones as their own tickets. Don't `kitchen ticket` them yourself.
5. Offer to run the queue.

An unclear proposal in the outer loop (`/kitchen refine p4`, a `p` id): the same conversation, from the proposal
(`kitchen inbox list --json`: its title, text, questions and the reports it covers). After the user's yes:
`kitchen inbox edit <p> --title "…" --text "<the refined ticket>"`, then `kitchen inbox verdict <p> propose`. It
then waits in Proposed for the user to run it.

A job shown `needs-info(confirm: …)` waits for the user to approve intake's criteria (`intake.confirm` in
`kitchen.yaml`): show the user its `criteria` and `leftOut` from `kitchen job show <id> --json`, then on their
word `kitchen approve <id>`, or `kitchen feedback <id> "<what to change>"`.

## The outer loop: sources

Reports come in from sources Kitchen reads by code (ADR 0022): GitHub issues with a label (through `gh`), and Slack
threads marked with an emoji (through the workspace's own Kitchen app). `kitchen collect` reads them into the inbox,
then one triage session groups, reproduces on staging and proposes tickets; the user chooses what runs (the
dashboard's Outer loop, or `kitchen inbox run`). Kitchen's own findings come in by themselves.

When the user wants a source (`/kitchen sources`, "watch issues labelled bug", "the #bugs channel"):
1. Work out which: GitHub (`owner/repo` and the label; `gh repo view --json nameWithOwner` for this repo) or Slack
   (the channel's ID, `C…`: in Slack, the channel name → About → Channel ID; and the emoji, default `kitchen`).
   Other tools (Linear, Sentry, email) aren't sources yet: say so.
2. Test-read before saving: `kitchen sources try github <owner/repo> --label <label>` or `kitchen sources try slack
   <channel id> --channel-name '#bugs' --emoji <emoji>`. Show the user the items it printed. For Slack, a first try
   fails until the app exists: relay the setup steps it prints, one at a time, and wait for the user (they create
   the app from the manifest, install it, then run `kitchen sources slack-token` themselves to store the token;
   never ask them to paste the token into the chat).
3. On the user's yes, the same flags with `add` in place of `try` (`--name <name>` when they gave one). Relay its line.
4. Offer `kitchen collect --install-schedule` (hourly; `--every 30m`) so it collects on its own.

`/kitchen sources edit <name>`: show `.kitchen/sources/<name>.json` and change it with `kitchen sources add … --name
<name> --replace` after a new try. `kitchen sources remove <name>` drops one (its items stay).

## Talking to a job

`kitchen steer` is for a job in a lane or paused: the orchestrator hands it to the job's next agent. A job that
needs the user (`needs-info`, `needs-human`) takes `kitchen feedback`; a ready or merged job takes `kitchen
feedback` as a follow-up (another round). `pause` lets the current lane finish; `stop` parks it now and the lane's
result is dropped.

## Rules

- Relay Kitchen's lines as they are; don't paraphrase job ids or states.
- Ticket text and messages are the user's words, quoted. Don't add instructions to them.
- Never edit `.kitchen/jobs/`, `job.json` or evidence by hand: Kitchen owns them.
- If a command fails, show its last line and stop; don't retry in a loop.
