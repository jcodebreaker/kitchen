---
name: kitchen
description: "Drive Kitchen, the software factory in this repo: set it up (init), file tickets, run the queue as its orchestrator (/kitchen run: waves of intake, build, QA and review agents, merging passing jobs into staging), check status, answer jobs, refine an unclear ticket with the user (/kitchen refine), approve intake's criteria, steer, pause or stop a job, sweep or maintain its verify map. Use when the user mentions Kitchen or /kitchen, asks to turn a request into a reviewed change, to queue or run work, or to see job status."
---

# /kitchen

Kitchen turns tickets into reviewed changes merged into a `staging` branch. You map what the user says onto
`kitchen` commands, run them, and relay their one-line outputs. When the user says **run** (or `/kitchen run`),
you become the orchestrator: see Running the queue.

This skill comes from the Kitchen plugin, for devkitchen 0.1.0. The plugin has no pinned package yet, so
never run Kitchen through `npx`. Find how to run it once per session, from the repo root:

1. `kitchen --version`: if it prints a version, use `kitchen` from PATH, and say
   which version it is if it isn't 0.1.0.
2. If it doesn't, tell the user Kitchen isn't installed and how to get it:
   `npm install -g devkitchen@0.1.0`. Don't install it yourself unless
   they say so.

Run every command below from the repo root. (This plugin's skill is `/kitchen:kitchen` in Claude Code and
`kitchen:kitchen` in Codex: plugin skills are namespaced; where this page says `/kitchen`, that is this skill.)

| the user says | run |
|---|---|
| set up Kitchen, first use | `kitchen init` (seconds; see Setup) |
| "do X", "fix Y", "add Z" (a request for work) | `kitchen ticket "<the request>"` (see Tickets), then offer to run the queue |
| `run`, start, "go", work the queue, or your prompt is `/kitchen run` | be the orchestrator yourself: Running the queue, below. Never call `kitchen run` for this: it starts another session, and inside one `kitchen run` started it refuses |
| what's happening, status, progress | `kitchen status`; when a job shows `needs-info(refine: …)`, offer to refine it with them (see Refining a ticket) |
| "refine 004", "let's clarify 004", or your prompt is `/kitchen refine 004` | Refining a ticket, below |
| "approve 004", "the criteria are fine" | `kitchen approve <id>` (only a job shown `needs-info(confirm: …)`) |
| tell a job something: "tell 005 to keep the diff small" | `kitchen steer <id> "<their words>"` |
| "hold 005", "pause it after this step" | `kitchen pause <id>` |
| "stop 005 now" | `kitchen stop <id>` |
| continue a paused or stopped job | `kitchen resume <id>` |
| answer a job's question, "try again with …", follow up on a ready or merged job | `kitchen feedback <id> "<their answer>"` |
| drop a job | `kitchen reject <id>` |
| "show me the jobs", "open the dashboard" | `kitchen dashboard` as a background command, then give the user the address it prints (http://127.0.0.1:7357/#<repo>; when a dashboard already runs it adds this repo, prints `already open: …` and exits) |
| run the queue headless, in the background | `kitchen run --detach` (a separate Claude Code session runs this skill) |
| how is Kitchen doing | `kitchen report` |
| "sweep", check every feature before a release, "is staging good to ship" | a verify run: see The verify map, below (`kitchen verify sweep`) |
| "maintain the map", tidy or audit the verify skill, the map looks stale | a verify run: `kitchen verify maintain` |

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

You run the queue in this session. You **never** do product work yourself and you **never** edit
`.kitchen/jobs/`, `job.json`, the job branches or `staging` by hand: you start one agent per lane and move jobs
only through `kitchen job` verbs, which refuse any illegal move. The Agent tool is how you start a lane agent.

**Loop** (repeat until the plan says `drained`):

1. `kitchen job next --json` (the **first** call of a run: add `--restart-stranded`, which hands back lanes an
   earlier session left open). It returns `start` (lanes to open now: every job in intake, then downstream first;
   a lane is intake, build, qa, review or **regress**, the short pass that drives the features a job touches on
   staging with the job merged, before Kitchen merges it), `running`, `held` (each
   with why: a job it names on its `AFTER:` line, or no room; jobs touching the same files run side by side) and
   `you` (jobs waiting on the person). Tell the user the wave in one line.
2. For **every** entry in `start`, in parallel:
   - `kitchen job start <id> <lane> --json` (`--restart` when the entry says `restart`). It prepares the job's
     worktree and brief, hands over the person's unread messages, and returns `{ prompt, model, cwd, brief }`, or
     `refused` / `parked` (say why and skip it).
   - Spawn one Agent with exactly that `prompt`, and `model` set to the returned model, in the foreground (never
     `run_in_background`): parallel lanes are several Agent calls in one message. Never end your turn while a lane
     agent is still running: a headless session that ends its turn stops the run. Use one agent per lane per
     job: never reuse one, never give one two jobs, never do a lane yourself.
3. When an agent returns, run `kitchen job finish <id> --json` for its job, at once. Kitchen reads the files the
   lane left (intake.md, the commits, the QA verdict, evidence and map updates, review.json, the regress verdict),
   runs the checks itself, merges into staging when review passes and the features the merge touches still work
   (or opens a regress lane to drive them first), and moves the job, or refuses and says why (the lane runs again in the next wave;
   three refusals go to a person). Relay its `line`. Never argue with a refusal and never write the lane's files
   yourself.
4. Between waves, read nothing else: steering reaches the next agent through `kitchen job start`. Then go to 1.

When the plan is `drained`, report: what merged into staging (with the short shas), what stopped at Ready and
why, and what needs the user (`kitchen status`). Then stop. Never merge `staging` into the base branch or main,
never push either: that is the user's.

If `kitchen job start` or `finish` fails with an error (not a refusal), show its last line and stop the run.
If the user asks you to stop the run, finish the agents in flight (`kitchen job finish` each) and stop.

## The verify map

Kitchen keeps a verify skill in the repo (`.claude/skills/verify-<app>/`): how to start and drive the app, and a
feature map (`features/`), one file per user-facing feature with its recipe and the files behind it. QA follows
and updates it in every job; Kitchen drives the touched features before each merge. Two runs use it outside jobs,
each one agent you start like a lane agent:

1. `kitchen verify sweep --json` (a release check: every feature against staging, changes nothing) or
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
   `kitchen feedback <id> "<the refined ticket>"`. For a ticket too big, the brief says how the later slices
   become their own tickets.
5. Offer to run the queue.

A job shown `needs-info(confirm: …)` waits for the user to approve intake's criteria (`intake.confirm` in
`kitchen.yaml`): show the user its `criteria` and `leftOut` from `kitchen job show <id> --json`, then on their
word `kitchen approve <id>`, or `kitchen feedback <id> "<what to change>"`.

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
