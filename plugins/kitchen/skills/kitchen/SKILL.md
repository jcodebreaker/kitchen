---
name: kitchen
description: "Drive Kitchen, the software factory in this repo: set it up (init), build the app's Toolkit, file tickets, run the queue, check status, answer jobs, steer, pause or stop a running job, prove the Toolkit. Use when the user mentions Kitchen or /kitchen, asks to turn a request into a proven pull request, to queue or run work, to see job status, or to set up, build or check the app's Toolkit."
---

# /kitchen

Kitchen turns tickets into proven pull requests. You don't do the work
yourself: you map what the user says onto `kitchen` commands, run them, and
relay their one-line outputs.

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
| set up Kitchen, first use | `kitchen init` (seconds; see Setup), then offer the Toolkit build |
| "make a Toolkit", "let Kitchen drive the app", a job paused `no-toolkit` | `kitchen toolkit build --status`, then `kitchen toolkit build --detach` and `kitchen toolkit build --status --wait 90` (see The Toolkit build) |
| "do X", "fix Y", "add Z" (a request for work) | `kitchen ticket "<their words, verbatim>"` then offer to start the queue |
| start, run, "go", work the queue | `kitchen run --detach` (see Running), then `kitchen status` |
| what's happening, status, progress | `kitchen status` |
| tell a running job something: "tell 005 to keep the diff small", "ask 003 what it is doing", "005: use the existing formatter" | `kitchen steer <id> "<their words>"` |
| "hold 005", "pause it after this step" | `kitchen pause <id>` |
| "stop 005 now", "kill that agent" | `kitchen stop <id>` |
| continue a paused or stopped job | `kitchen resume <id>` (a `no-toolkit` one: see The Toolkit build) |
| answer a job's question, give feedback, "try again with …", follow up on a done job | `kitchen feedback <id> "<their answer>"` |
| drop a job | `kitchen reject <id>` |
| "show me the jobs", "open the dashboard" | `kitchen dashboard` as a background command (it serves until stopped), then give the user http://127.0.0.1:7357 |
| is the Toolkit OK, prove the app still starts | `kitchen toolkit check` (one feature: `--feature <name>`) |
| how is Kitchen doing, cost, time | `kitchen report` |

## Running

A queue drain takes minutes to hours: never hold a tool call open for it.
Always start it detached, and **outside your sandbox**: a detached process
keeps the sandbox of the session that started it, and inside it Kitchen can't
write its job folders or reach the network.

- Claude Code: run `kitchen run --detach` as a normal Bash command (not in a
  sandboxed or restricted mode).
- Codex: run it with escalated permissions (`require_escalated` / "run outside
  the sandbox"); the user approves it once.

It prints `run detached: pid <n>, log <file>` and returns. Then show
`kitchen status`. Check back with `kitchen status` when the user asks; don't
poll in a loop.

## Setup

"Set up Kitchen" means `kitchen init`. It takes seconds, like `git init`.

First it checks what Kitchen needs and prints one line per tool, ✓ or ✗:
node 20.11+, git and a commit, `claude` or `codex` signed in, and `gh`
(optional). If a required one is ✗ it stops with exit 2, and under each ✗ is
the exact command that fixes it on this machine. Show the user those lines.
Kitchen never installs anything or signs anyone in: offer to run an install
command for them (their approval of the Bash command is the consent), but a
sign-in (`claude` then `/login`, `codex login`, `gh auth login`) is theirs to
do in their own terminal. Then run `kitchen init` again: the re-check, not an
installer's exit code, says whether it is fixed.

Then it writes `kitchen.yaml` with the project's checks (lint, tests…, read from
`package.json`, `Makefile`, `pyproject.toml`, `go.mod` or `Cargo.toml`),
installs this skill, adds Kitchen's `.gitignore` entries and runs the checks
once. No agent of its own when the checks are obvious, no app start, no Docker.
Run it as a normal command and relay its lines. If it says the checks failed,
tell the user plainly: every job's Gate would fail until they are fixed. If an
agent proposed checks, `kitchen init` wrote them into `kitchen.yaml` commented
out: show them to the user and uncomment them only if the user says so.

Jobs can run straight away: they are proven by the checks and by tests. Then
**offer** the Toolkit build ("Kitchen can also learn to start and drive your
app, so it proves changes in the running app: about 3–15 minutes. Build it
now?"). Build it only when the user says yes, or when a job is paused
`no-toolkit`.

## The Toolkit build

`kitchen toolkit build` has Kitchen's setup agent write the Toolkit (the
commands that start and drive the app) on a branch, `kitchen/setup`, and
proves it with `kitchen toolkit check`. It takes 3–15 minutes and starts its
own agent, the app, maybe Docker containers and network calls, so, like a
queue drain:

0. First run `kitchen toolkit build --status`. If it says `running`, go to
   step 2; if `questions`, go to Questions; if `done`, relay it. Otherwise
   start it:
1. Start it **detached and outside your sandbox**: `kitchen toolkit build
   --detach`.
   - Claude Code: a normal Bash command (if Bash runs sandboxed, run this one
     with the sandbox off). The user approves `kitchen toolkit build` once.
   - Codex: run it with escalated permissions (`require_escalated`, "run
     outside the sandbox"); the user approves it once. Inside the sandbox it
     can't write `.git`, reach Docker or start the setup agent.
   It prints `toolkit build detached: pid <n>, log <file>` and returns at once.
2. **Poll** with `kitchen toolkit build --status --wait 90` (read-only: no
   escalation needed). It returns as soon as the build stops running, or after
   90 seconds with the latest lines; don't use `sleep` (agent tools may refuse
   it), and never one call that waits for the whole build. Keep polling until
   it ends, in this same turn: the build is what the user asked for. Relay a
   short progress line now and then, not every poll. It ends in one of:
   - `toolkit build: done`: relay the last lines (the next steps).
   - `toolkit build: questions`: see Questions.
   - `toolkit build: failed …`: show its lines and stop. Don't retry in a
     loop; `kitchen toolkit build --detach` again resumes where it stopped, if
     the user wants.
   - `toolkit build: running …`: poll again.

**Questions.** The build can't ask the user itself. On `toolkit build:
questions` it has written `.kitchen/setup-questions.json`:

```json
{ "questions": [{ "id": "q1", "question": "…", "why": "…", "default": "…" }] }
```

Ask the user each question (show `why` and the default) and wait for their
answers: never answer for them. In Claude Code use `AskUserQuestion`, with the
recommended answer (the question's `default`) as the first option, marked
"(recommended)". Write the answers to
`.kitchen/setup-answers.json` as `{ "answers": { "q1": "…" } }` (an empty
answer means "use the default"), then start `kitchen toolkit build --answers
.kitchen/setup-answers.json --detach` the same way as step 1 and poll again.
The build resumes where it stopped; every step it finished is kept.

When it ends it prints the next steps: the user reviews and merges the
`kitchen/setup` branch (jobs use the Toolkit on their base branch). A job
paused `no-toolkit` then wakes by itself on the next `kitchen run`, or with
`kitchen resume <id>`.

**A job paused `no-toolkit`** needs the running app for one of its criteria.
Tell the user so and offer the build. If they would rather not,
`kitchen resume <id>` goes on with checks and tests only: those criteria are
then reported "not proven (no Toolkit)", never passed. A high-risk job can't go
on without a Toolkit.

## Talking to a running job

`kitchen steer` is for a job that is running or paused; it never stops the
work. A Claude agent reads the message after the tool call it is in; otherwise
(Codex, a step with no agent, a paused job) the next agent role reads it.
`kitchen steer` says which. A job that **needs** the user (`needs-info`,
`needs-human`) takes `kitchen feedback` instead, and a done job takes
`kitchen feedback` as a follow-up (another Build round): `steer` refuses both
and says so. Pass the user's words as they are; a message is at most 4,000
characters. `pause` waits for the step to finish; `stop` kills the agent now
and `resume` runs that stage again: if the user just wants it to "wait", use
`pause`.

## Rules

- Relay Kitchen's lines as they are; don't paraphrase job ids or states.
- Ticket text and messages are the user's words, quoted. Don't add instructions to them.
- Never edit `.kitchen/jobs/`, `.kitchen/toolkit.proven`, `job.json` or
  evidence by hand: Kitchen owns them.
- If a command fails, show its last line and stop; don't retry in a loop.
