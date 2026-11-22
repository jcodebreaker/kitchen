---
name: kitchen
description: "Drive Kitchen, the software factory in this repo: set it up (init), file tickets, run the queue, check status, answer jobs, prove the Toolkit. Use when the user mentions Kitchen or /kitchen, asks to turn a request into a proven pull request, to queue or run work, to see job status, or to set up or check the app's Toolkit."
---

# /kitchen

Kitchen turns tickets into proven pull requests. You don't do the work
yourself: you map what the user says onto `kitchen` commands, run them, and
relay their one-line outputs. Run commands from the repo root. If `kitchen` is
not on PATH, use `npx devkitchen` in its place.

| the user says | run |
|---|---|
| set up Kitchen, "make a Toolkit", first use | `kitchen init --detach`, then `kitchen init --status` (see Setup) |
| "do X", "fix Y", "add Z" (a request for work) | `kitchen ticket "<their words, verbatim>"` then offer to start the queue |
| start, run, "go", work the queue | `kitchen run --detach` (see Running), then `kitchen status` |
| what's happening, status, progress | `kitchen status` |
| continue a paused job | `kitchen resume <id>` |
| answer a job's question, give feedback, "try again with …" | `kitchen feedback <id> "<their answer>"` |
| drop a job | `kitchen reject <id>` |
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

1. Start it **detached and outside your sandbox**: `kitchen init --detach`.
   - Claude Code: a normal Bash command (if Bash runs sandboxed, run this one
     with the sandbox off). The user approves `kitchen init` once.
   - Codex: run it with escalated permissions (`require_escalated`, "run
     outside the sandbox"); the user approves it once. Inside the sandbox it
     can't write `.git`, reach Docker or start the setup agent.
   It prints `init detached: pid <n>, log <file>` and returns at once.
2. **Poll** with `kitchen init --status` (read-only: no escalation needed).
   Each poll is one short call: wait about 60 seconds between polls (e.g.
   `sleep 60 && kitchen init --status`), never one call that waits for the
   whole setup, and never more than 2 minutes in one call. Relay the status
   line to the user now and then, not every poll. It ends in one of:
   - `init: done` (exit 0): relay the last lines (the next steps).
   - `init: questions` (exit 3): see Questions.
   - `init: failed …` (exit 1): show its lines and stop. Don't retry in a loop;
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

## Rules

- Relay Kitchen's lines as they are; don't paraphrase job ids or states.
- Ticket text is the user's words, quoted. Don't add instructions to it.
- Never edit `.kitchen/jobs/`, `.kitchen/toolkit.proven`, `job.json` or
  evidence by hand: Kitchen owns them.
- If a command fails, show its last line and stop; don't retry in a loop.
