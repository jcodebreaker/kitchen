# Close four gaps in a run

**Status.** Accepted, 2026-11-24, by the user ("yes go ahead"). Each gap was confirmed in the code.

## Why

1. **Intake reads the wrong tree.** The intake agent is told `cd <repo>` (the person's checkout, whatever branch it is on), while its brief's map is read from the staging tip (`src/engine/jobs.ts:380,417`). When the checkout has code the base doesn't, intake can accept a ticket the base can't support.
2. **A ticket from the terminal can wait forever.** Only the dashboard wakes Kitchen after a ticket (`WAKES` in `src/dashboard/actions.ts`). `kitchen ticket` files it and stops; if the orchestrator drained a moment before, the ticket sits until someone starts a run.
3. **An old `claude` fails mid-run.** Nothing checks the version before a run; a missing `agent.command` binary has no error handler on the spawn (`src/run/orchestrator.ts`).
4. **Checks look stuck.** A check's output is buffered and written to `checks.log` only when the command ends (`src/checks/run-checks.ts`); the dashboard shows nothing during a long check step.

## Decision

1. **Intake reads the job's base.** Before the intake lane starts, Kitchen makes a detached, read-only checkout of the base build would use (the staging tip, else `staging.base`, else HEAD) under `.kitchen/` and gives intake that as its `cwd`, so the map and the tree agree. It is removed when intake finishes (and on remove/restart). The person's checkout is never read by a lane.
2. **Every verb that gives the queue work wakes Kitchen, wherever it is called.** The wake moves out of the dashboard into the shared verbs: `kitchen ticket`, `approve`, `feedback`/answer, `follow-up`, `resume`, `inbox run` start `kitchen run --detach` when no orchestrator works the queue, and say so ("→ intake · Kitchen started"). `--no-run` files without starting. Inside an orchestrator session (`KITCHEN_ORCHESTRATOR`) nothing is started (the running one picks it up).
3. **A run checks its tool first.** `kitchen run` runs `<agent.command or claude> --version` and refuses below `MIN_CLAUDE` (one constant, the oldest version Kitchen is tested with) with "Claude Code X is older than Kitchen needs (Y). Update it: claude update", and refuses a binary that isn't there ("agent.command … not found"). The spawn gets an `error` handler. `kitchen doctor`-style output is not added; the refusal is the message. An in-session `/kitchen run` is already running on the `claude` the person opened, so it is not checked.
4. **Checks show progress.** `runShell` appends output to `checks.log` as it arrives (the `$ cmd` header first, `[exit …]` at the end, same file format). While checks run, the job records `checking: { cmd, at }`; the dashboard card and panel say "Checks · `npm test` · 3m 12s" with the log's last line, and clear it when the step ends.

## Not chosen

- Intake in the build worktree: build's branch doesn't exist yet and intake must not commit.
- A daemon that watches for tickets: one wake in the verbs covers it without a process that lives forever.
- Warning (not refusing) on an old `claude`: the failure shows up mid-run, after money is spent.
