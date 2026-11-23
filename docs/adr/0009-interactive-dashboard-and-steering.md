# The dashboard becomes interactive: steer, answer, pause and stop jobs from the browser

**Decision.** `kitchen dashboard` serves the approved v4 design (`docs/mockups/dashboard-v4.html`): a List view (default) and a Board view of the same jobs, a docked job panel (stage track; Activity, Checks and Changes tabs), the Setup run, and one message composer per job. The composer covers every way a person talks to a job:

- **Answer** a job that needs you. This is the same as `kitchen feedback <id> "…"`.
- **Steer** a running job: add context, redirect, or ask what it is doing.
- **Pause / Resume / Stop** a job.
- **Follow up** on a done job.
- **Reject** a job that needs you. This is the same as `kitchen reject`.

The server stops being read-only. It gains a small set of POST actions, each mapped to the same engine code the CLI verbs use, so the browser can do nothing the CLI cannot.

## The five behaviours (chosen 2026-11-22, mock-up approved by the user)

1. **A steering message reaches a running agent at its next step, without stopping it.** This is how Devin and Cursor behave.
   - Claude roles run with `--input-format stream-json` / `--output-format stream-json`. The engine writes the person's message to the agent's stdin as a user message while it works, and the agent takes it after its current tool call.
   - If a role's adapter cannot take input mid-run, the message is queued. Codex (`codex exec`) is one such adapter today, and so is a role that ends before the message is read. A queued message is delivered at the start of the job's next agent role, quoted as operator notes.
   - Either way the job's activity shows the message as **sent**, then **read by <role>** once delivered.
2. **Pause is a real job state.** The existing `paused` stage is reused, with a reason `by-you`.
   - **Pause** lets the current agent step finish, then parks the job.
   - **Stop** kills the running agent now, through its process group as `src/procs.ts` already does, and parks the job.
   - **Resume** is `kitchen resume` and returns the job to the stage it paused in.
   - Messages sent while paused queue and are delivered on resume.
3. **Messaging a step with no agent (Gate, Verify's engine part, Report)** queues the note for the next agent role. The composer says so.
4. **Following up on a done job** reopens it as a new Build round, which is what `kitchen feedback` on a done job already does (ADR 0007). Kitchen never merges, so a done job's branch is still open.
5. **The default view is List.** The chosen view is remembered per browser.

## Security

The page can now change state, so the server must refuse requests that do not come from the page it served.

- **Local only.** It binds to 127.0.0.1. Every request still passes the Host check, which refuses DNS rebinding.
- **A per-launch secret.** The server makes a random 32-byte token when it starts and embeds it in the page it serves. Every POST must carry it in an `x-kitchen-token` header and have `content-type: application/json`. A token missing or wrong gets a 403. A header plus a JSON body is something a cross-site form or a simple request cannot send, and the token is unguessable. A POST whose `Origin` is present and is not the server's own origin is also refused.
- **Message text is operator input.** It has the same trust as `kitchen feedback`: it comes from the person at this machine. It is stored in the job's engine-owned folder and quoted to agents as operator notes, never followed as instructions to the engine. Size is capped.
- The CSP stays strict: no third-party script. The v4 mock-up loads Geist from Google Fonts; the shipped page bundles or drops it, so nothing loads from elsewhere.

## Data the page needs, all read from `.kitchen/`

- **Live activity.** The agent's own session transcript (`transcriptPath`, already recorded per run), read incrementally: tool calls, short reasoning lines, file edits with +/− counts.
- **The steering thread.** `.kitchen/jobs/<id>/messages.jsonl`, written only by the engine. Each line records who, text, time, and status (`sent` or `read by <role>`).
- Checks, changes and stage history come from what `data.ts` already reads.
- Setup comes from `.kitchen/init/` and `.kitchen/setup-questions.json`, and its questions can be answered from the page, which is the same as `kitchen init --answers`.

The page polls; no WebSocket. Jobs run in `kitchen run`, a separate process, so the dashboard server writes requests into the job folder, through the same functions the CLI uses, and the runner acts on them. The runner watches for them between steps, and for steering, while an agent runs.

## Same verbs everywhere

Every dashboard action is also a CLI verb, and both call one engine function:

| Dashboard | CLI |
|---|---|
| Answer | `kitchen feedback <id> "…"` |
| Reject | `kitchen reject <id>` |
| Steer | `kitchen steer <id> "…"` (new) |
| Pause | `kitchen pause <id>` (new) |
| Stop | `kitchen stop <id>` (new) |
| Resume | `kitchen resume <id>` |
| Setup answers | `kitchen init --answers <file>` |

The `/kitchen` skill uses the same verbs, so "tell 005 to keep the diff small" works from Claude Code or Codex too. Only the engine writes job state.

**How the reference does it (zazencodes factory v2, checked 2026-11-22).** Its dashboard is a read-only static page polling job files every 2 s. A person talks to the factory in natural language with `/factory <anything>` in the orchestrating Claude Code session, which routes it as a question, feedback, reject, an answer or a new issue, always through `factory/bin/job`, the single writer of job state. Feedback reaches a job only once it is waiting on a person (`feedback-<k>.md`, a new round). It has no mid-run steering, no pause and no stop. We keep its single-writer rule, and its "talk to it from the agent" path through `/kitchen`. We go further on mid-run steering and pause/stop, which the user asked for.

## Alternatives

- **Interrupt immediately on every message.** Rejected as the default: it throws away the agent's in-flight call and makes every question costly. Stop covers "interrupt now".
- **Messages only between stages.** Simpler, but loses the main thing the user asked for: talking to an agent while it works.
- **A WebSocket channel.** More moving parts than polling at this scale, with one person on one machine.
- **Keep the dashboard read-only and print CLI commands.** Rejected by the user: the dashboard is where they want to act.

## Residual risks

- Another local process running as the same user can read the token from the served page by requesting it. That user can already run `kitchen` directly, so the token guards only against other websites, not other local processes.
- Mid-run delivery depends on Claude Code's stream-json input. If a future version changes it, messages fall back to the queue (behaviour 1), which stays correct, only slower.
