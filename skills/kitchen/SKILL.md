---
name: kitchen
description: "Drive Kitchen, the software factory in this repo: set it up (init), build the app's Toolkit, file tickets, run the queue, check status, answer jobs, steer, pause or stop a running job, prove the Toolkit. Use when the user mentions Kitchen or /kitchen, asks to turn a request into a proven pull request, to queue or run work, to see job status, or to set up, build or check the app's Toolkit."
---

# /kitchen

Kitchen turns tickets into proven pull requests. You don't do the work
yourself: you map what the user says onto `kitchen` commands, run them, and
relay their one-line outputs.

<!-- kitchen-run:start (the plugin's copy replaces this block: npm run plugin:sync) -->
Run commands from the repo root. If `kitchen` is not on PATH, use
`npx devkitchen` in its place.
<!-- kitchen-run:end -->

| the user says | run |
|---|---|
| set up Kitchen, first use | `kitchen init` (seconds; see Setup), then offer the Toolkit build |
| "make a Toolkit", "let Kitchen drive the app", a job paused `no-toolkit` | `kitchen toolkit build --status`, then `kitchen toolkit build --detach` and `kitchen toolkit build --status --wait 90` (see The Toolkit build) |
| "do X", "fix Y", "add Z" (a request for work) | `kitchen ticket "<the request>"` (see Tickets), then offer to start the queue |
| "use the Toolkit", "approve it", a job waits for a proven Toolkit | ask (see Approving the Toolkit), then `kitchen toolkit approve` |
| "stop using the Toolkit" | `kitchen toolkit revoke` |
| "share the Toolkit with my team", "commit the Toolkit" | `kitchen toolkit commit` (it asks the user itself in a terminal; from here, ask first, then `kitchen toolkit commit --yes`) |
| start, run, "go", work the queue | `kitchen run --detach` (see Running), then `kitchen status` |
| stop the queue, "stop the runner" | `kitchen run --stop` |
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

## Tickets

The ticket is the work the user wants done, in their words. Words addressed to
you about what to do **after** filing it are not part of the work: strip them
before calling `kitchen ticket`, and act on them yourself. For example:

- "add a renew endpoint for loans. Then start the queue." → `kitchen ticket
  "add a renew endpoint for loans."`, then `kitchen run --detach`.
- "fix the date bug and run it" → `kitchen ticket "fix the date bug"`, then
  `kitchen run --detach`.
- "file: dark mode doesn't persist, and show me the status" → `kitchen ticket
  "dark mode doesn't persist"`, then `kitchen status`.

Only trailing instructions to you ("then start the queue", "and run it", "then
show me the status", "and open the dashboard") come out; everything about the
work itself stays, verbatim.

## Running

A queue drain takes minutes to hours: never hold a tool call open for it.
Always start it detached, and **outside your sandbox**: a detached process
keeps the sandbox of the session that started it, and inside it Kitchen can't
write its job folders or reach the network.

- Claude Code: run `kitchen run --detach` as a normal Bash command (not in a
  sandboxed or restricted mode).
- Codex: run it with escalated permissions (`require_escalated` / "run outside
  the sandbox"); the user approves it once.

It prints `run detached: pid <n>, log <file>` (or `runner: already running`)
and returns. Then show `kitchen status`. Check back with `kitchen status` when
the user asks; don't poll in a loop.

The detached runner keeps going: when every job waits on the user it idles
and picks the work up by itself once there is some again (a new ticket, an
answer, a resume, an approval). So after `kitchen feedback`, `kitchen resume`
or a new ticket, don't start it again; `kitchen status` shows `runner: pid …`
while it is up. The dashboard starts one by itself when an action needs it.
Only if the status says `runner: not running` run `kitchen run --detach`.
`kitchen run --stop` ends it, when the user asks to stop the queue.

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
proves it with `kitchen toolkit check`. Jobs use it once the user approves it:
nothing is merged into their branch, committed or pushed. It takes 3–15 minutes and starts its
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
   - `toolkit build: done: proven, waiting for your approval …`: go to
     Approving the Toolkit.
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

### Approving the Toolkit

"Set up Kitchen" and "build the Toolkit" end here. A proven Toolkit runs
nothing for jobs until the user approves it. Ask with `AskUserQuestion`:

- question: "Kitchen proved the Toolkit for this app. Use it to run your app for every job?"
- options, in this order: "Use it (Recommended)" (Kitchen runs the app with
  it for every job; nothing is merged or committed), "Not now" (jobs that need
  the app keep waiting), "Let me review it first" (show `git log -p
  <base>..kitchen/setup`, then ask again).

On "Use it", run `kitchen toolkit approve` and relay its one line (it names
the jobs it woke). Never run `git merge`, `git commit` or `git push` for the
Toolkit yourself: approving is all a local run needs. If the user wants their
team to have it too, `kitchen toolkit commit` makes one Kitchen commit of only
the Toolkit files, after they confirm. A rebuilt or maintained Toolkit is a
new version: it needs the same question again, and jobs keep the one approved
before until then.

**A job paused `no-toolkit`** needs the running app for one of its criteria.
If `kitchen status` says a proven Toolkit is waiting for approval, ask as
above. Otherwise tell the user so and offer the build. If they would rather not,
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
- Never edit `.kitchen/jobs/`, Kitchen's records in `$KITCHEN_HOME`, `job.json` or
  evidence by hand: Kitchen owns them.
- If a command fails, show its last line and stop; don't retry in a loop.
