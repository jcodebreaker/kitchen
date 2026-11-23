---
name: kitchen
description: "Drive Kitchen, the software factory in this repo: set it up (init), file tickets, run the queue as its orchestrator (/kitchen run: waves of intake, build, QA and review agents, merging passing jobs into staging), check status, answer jobs, steer, pause or stop a job. Use when the user mentions Kitchen or /kitchen, asks to turn a request into a reviewed change, to queue or run work, or to see job status."
---

# /kitchen

Kitchen turns tickets into reviewed changes merged into a `staging` branch. You map what the user says onto
`kitchen` commands, run them, and relay their one-line outputs. When the user says **run** (or `/kitchen run`),
you become the orchestrator: see Running the queue.

<!-- kitchen-run:start (the plugin's copy replaces this block: npm run plugin:sync) -->
Run commands from the repo root. If `kitchen` is not on PATH, use
`npx devkitchen` in its place.
<!-- kitchen-run:end -->

| the user says | run |
|---|---|
| set up Kitchen, first use | `kitchen init` (seconds; see Setup) |
| "do X", "fix Y", "add Z" (a request for work) | `kitchen ticket "<the request>"` (see Tickets), then offer to run the queue |
| `run`, start, "go", work the queue | be the orchestrator: Running the queue, below |
| what's happening, status, progress | `kitchen status` |
| tell a job something: "tell 005 to keep the diff small" | `kitchen steer <id> "<their words>"` |
| "hold 005", "pause it after this step" | `kitchen pause <id>` |
| "stop 005 now" | `kitchen stop <id>` |
| continue a paused or stopped job | `kitchen resume <id>` |
| answer a job's question, "try again with …", follow up on a ready or merged job | `kitchen feedback <id> "<their answer>"` |
| drop a job | `kitchen reject <id>` |
| "show me the jobs", "open the dashboard" | `kitchen dashboard` as a background command, then give the user http://127.0.0.1:7357 |
| run the queue headless, in the background | `kitchen run --detach` (a separate Claude Code session runs this skill) |
| how is Kitchen doing | `kitchen report` |

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

## Running the queue (you are the orchestrator)

You run the queue in this session. You **never** do product work yourself and you **never** edit
`.kitchen/jobs/`, `job.json`, the job branches or `staging` by hand: you start one agent per lane and move jobs
only through `kitchen job` verbs, which refuse any illegal move. The Agent tool is how you start a lane agent.

**Loop** (repeat until the plan says `drained`):

1. `kitchen job next --json` (the **first** call of a run: add `--restart-stranded`, which hands back lanes an
   earlier session left open). It returns `start` (lanes to open now, downstream first), `running`, `held` (each
   with why: a dependency on another job touching the same files, or no room) and `you` (jobs waiting on the
   person). Tell the user the wave in one line.
2. For **every** entry in `start`, in parallel:
   - `kitchen job start <id> <lane> --json` (`--restart` when the entry says `restart`). It prepares the job's
     worktree and brief, hands over the person's unread messages, and returns `{ prompt, model, cwd, brief }`, or
     `refused` / `parked` (say why and skip it).
   - Spawn one Agent with exactly that `prompt`, and `model` set to the returned model. Use one agent per lane per
     job: never reuse one, never give one two jobs, never do a lane yourself.
3. When an agent returns, run `kitchen job finish <id> --json` for its job, at once. Kitchen reads the files the
   lane left (intake.md, the commits, the QA verdict and evidence, review.json), runs the checks itself, merges into
   staging when review passes, and moves the job, or refuses and says why (the lane runs again in the next wave;
   three refusals go to a person). Relay its `line`. Never argue with a refusal and never write the lane's files
   yourself.
4. Between waves, read nothing else: steering reaches the next agent through `kitchen job start`. Then go to 1.

When the plan is `drained`, report: what merged into staging (with the short shas), what stopped at Ready and
why, and what needs the user (`kitchen status`). Then stop. Never merge `staging` into the base branch or main,
never push either: that is the user's.

If `kitchen job start` or `finish` fails with an error (not a refusal), show its last line and stop the run.
If the user asks you to stop the run, finish the agents in flight (`kitchen job finish` each) and stop.

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
