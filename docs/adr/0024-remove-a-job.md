# Remove a job at any stage

**Status.** Accepted, 2026-11-24, by the user ("can I remove a ticket even if it's in build … I don't want it on the dashboard"). Built with ADR 0022 in PR #29; this records the decision after the fact.

## Why
`kitchen reject` moved a job to rejected but left its lane agent working, its worktree on disk, and the job on the dashboard as "Rejected". The person wants it gone.

## Decision
- `kitchen remove <id>` (and Remove on any job in the dashboard, with the 5-second Undo before it's sent): closes a running lane and stops its QA app, rejects an unfinished job, marks it `archived`, removes its worktree and trial merge. The branch and the job folder stay.
- Lane agents run inside the orchestrator session, so there is no process to kill: the guard hook refuses every tool call from an agent whose job was removed and tells it to stop.
- A merged job is only hidden; staging is never touched.
- Removed jobs are out of the dashboard, `kitchen status` (`--all` lists them "(removed)") and the wave plan; `job start` / `finish` refuse them; `kitchen report` still counts them. `kitchen restore <id>` shows it again as it was left.

## Not chosen
Deleting the branch and job folder: a mistaken remove would lose the work and its evidence; the branch is cheap.
