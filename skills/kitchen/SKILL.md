---
name: kitchen
description: "Drive Kitchen, the software factory in this repo: set it up (init), file tickets, run the queue, check status, answer jobs, steer, pause or stop a running job, prove the Toolkit. Use when the user mentions Kitchen or /kitchen, asks to turn a request into a proven pull request, to queue or run work, to see job status, or to set up or check the app's Toolkit."
---

# /kitchen

Kitchen turns tickets into proven pull requests. You don't do the work
yourself: you map what the user says onto `kitchen` commands, run them, and
relay their one-line outputs. Run commands from the repo root. If `kitchen` is
not on PATH, use `npx devkitchen` in its place.

| the user says | run |
|---|---|
| set up Kitchen, "make a Toolkit", first use | `kitchen init --status`, then `kitchen init --detach` and `kitchen init --status --wait 90` (see Setup) |
| "do X", "fix Y", "add Z" (a request for work) | `kitchen ticket "<their words, verbatim>"` then offer to start the queue |
| start, run, "go", work the queue | `kitchen run --detach` (see Running), then `kitchen status` |
| what's happening, status, progress | `kitchen status` |
| tell a running job something: "tell 005 to keep the diff small", "ask 003 what it is doing", "005: use the existing formatter" | `kitchen steer <id> "<their words>"` |
| "hold 005", "pause it after this step" | `kitchen pause <id>` |
| "stop 005 now", "kill that agent" | `kitchen stop <id>` |
| continue a paused or stopped job | `kitchen resume <id>` |
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

`kitchen init` writes `kitchen.yaml`, installs this skill, generates the
Toolkit with Kitchen's setup agent on a branch (`kitchen/setup`) and proves it
with `kitchen toolkit check`. It takes 5–15 minutes and starts its own agent,
Docker containers and network calls, so, like a queue drain:

0. First run `kitchen init --status`. If it says `running`, go to step 2; if
   `questions`, go to Questions; if `done`, relay it. Otherwise start it:
1. Start it **detached and outside your sandbox**: `kitchen init --detach`.
   - Claude Code: a normal Bash command (if Bash runs sandboxed, run this one
     with the sandbox off). The user approves `kitchen init` once.
   - Codex: run it with escalated permissions (`require_escalated`, "run
     outside the sandbox"); the user approves it once. Inside the sandbox it
     can't write `.git`, reach Docker or start the setup agent.
   It prints `init detached: pid <n>, log <file>` and returns at once.
2. **Poll** with `kitchen init --status --wait 90` (read-only: no escalation
   needed). It returns as soon as init stops running, or after 90 seconds with
   the latest lines; don't use `sleep` (agent tools may refuse it), and never
   one call that waits for the whole setup. Keep polling until it ends, in this
   same turn: setup is what the user asked for. Relay a short progress line
   now and then, not every poll. It ends in one of:
   - `init: done`: relay the last lines (the next steps).
   - `init: questions`: see Questions.
   - `init: failed …`: show its lines and stop. Don't retry in a loop;
     `kitchen init --detach` again resumes where it stopped, if the user wants.
   - `init: running …`: poll again.

**Questions.** `init` can't ask the user itself. On `init: questions` it has
written `.kitchen/setup-questions.json`:

```json
{ "questions": [{ "id": "q1", "question": "…", "why": "…", "default": "…" }] }
```

Ask the user each question (show `why` and the default) and wait for their
answers: never answer for them. Write the answers to
`.kitchen/setup-answers.json` as `{ "answers": { "q1": "…" } }` (an empty
answer means "use the default"), then start `kitchen init --answers
.kitchen/setup-answers.json --detach` the same way as step 1 and poll again.
`init` resumes where it stopped; every step it finished is kept.

When it ends it prints the next steps: review and merge the `kitchen/setup`
branch, commit `kitchen.yaml` and the skill folders.

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
