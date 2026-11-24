# Kitchen

Kitchen is an open-source pipeline that turns requests for work into reviewed changes merged into a staging branch: one Claude Code session orchestrates agents per lane, and deterministic code moves the jobs, runs the checks and merges.

## Language

### Work

**Ticket**:
One request for work, from a GitHub issue or typed by a developer as a prompt.
_Avoid_: Issue (that is only one source), task, request

**Job**:
One run of Kitchen on one Ticket, from intake to a change merged into Staging or held at Ready for a person. Named by a number and a short slug, with the Ticket's title beside it.
_Avoid_: Run, build, pipeline run

**Stage**:
Where a Job is: intake, build, QA, review, regress (the Lanes), ready (held for a person), done (merged into Staging), or waiting: needs-info, needs-human, paused, rejected.
_Avoid_: Phase, step

**Risk**:
Intake's rating of a Ticket (low, medium, high) that decides the review lenses and whether a Job may merge by itself (high never does).
_Avoid_: Priority, severity

**Criteria**:
Intake's list of what "done" means, each tagged with how QA checks it (page, http, test, cmd); fixed once written: the builder may not change them.
_Avoid_: Spec document, PRD, plan, verification contract

**Steer**:
A person's message to a Job (`kitchen steer`, the dashboard's composer): the Orchestrator hands it to the Job's next Lane agent, quoted as operator notes. Kept on the Job's thread, `messages.jsonl`.
_Avoid_: Chat, prompt, interrupt

**Round**:
One pass of Build, QA and Review; a Job has a limited number before a person is asked.
_Avoid_: Iteration, attempt

**Catch-up**:
A pass back through Build, QA, Review and the Merge check only because staging moved under the Job (its merge conflicted, or the checks went red on the merged result alone). It costs no Round; three in a row go to a person (ADR 0018).
_Avoid_: Rebase round, conflict round

### Running the queue

**Orchestrator**:
The Claude Code session that runs the queue (`/kitchen run`, or headless through `kitchen run`): it plans each Wave and starts one agent per Lane; it moves Jobs only through `kitchen job` verbs and does no product work itself.
_Avoid_: Runner (the removed plain-code loop), dispatcher

**Wave**:
The lanes the Orchestrator starts at once, from `kitchen job next`: downstream first, at most `parallel`, a Job held back only while one it names on its `AFTER:` line is unfinished (Jobs sharing files run side by side).
_Avoid_: Batch, tick

**Lane**:
A Stage an agent works in: intake, build, QA, review, regress. One fresh agent per Lane per Job, briefed by `kitchen job start`, its result read by `kitchen job finish`.
_Avoid_: Worker, step

**Role skill**:
An outside skill (a `SKILL.md`, such as test-first building or a security review) quoted into a Lane's brief as guidance, chosen from Kitchen's registry by the Ticket's kind, surfaces and Risk; it never decides a Verdict.
_Avoid_: Plugin, tool, the /kitchen skill (that one drives Kitchen from Claude Code)

**Guard hook**:
A Claude Code hook Kitchen installs that refuses a tool call before it runs: reading secrets, writing a key literal, pushing to the base branch or main, deleting outside the project, writing outside the Job's worktree.
_Avoid_: Sandbox (Kitchen has none now)

**Verdict**:
QA's result for a Job's criteria, checked against the running app: PASS only when every criterion passes, each citing its Evidence.
_Avoid_: Review result, score

**Evidence**:
The plain files QA leaves in the Job's folder (screenshots, HTTP transcripts, command output) that the Verdict and the Report cite by name.
_Avoid_: Artifacts, proof files

**Staging**:
The branch passing Jobs merge into, after Kitchen re-runs the checks on the merged result. Never the base branch or main: a person merges staging onward.
_Avoid_: Release branch, main

**Target**:
The branch a Job starts from and merges into: Staging, unless its Ticket named another (`kitchen ticket --into`). It must exist; with `merge: kitchen` never the base branch or main (ADR 0026).
_Avoid_: Destination, base

**PR open**:
A Job at Ready whose pull request into its Target waits for a person on GitHub (`staging.merge: pr`). Kitchen never merges it; merged there it is done, closed it is rejected (ADR 0026).
_Avoid_: Pending merge

**Report**:
The HTML page a Job ends with: what a person must check (every Changed earlier check among it), then each criterion with its Evidence, the Features driven before the merge, the review and the diff.
_Avoid_: Summary, PR description

### The verify map

**Verify skill**:
The skill in the person's repo that says how to check their app: `.claude/skills/verify-<app>/` (and the same for Codex under `.agents/skills/`), with a `SKILL.md` (Launch, Doctor, Drive, Evidence, Cleanup) and the Feature map. `kitchen init` writes its skeleton; QA keeps its map.
_Avoid_: Toolkit (the removed up-front build), test suite

**Feature map**:
The Verify skill's `features/` folder: a README index (baseline preconditions, driving conventions, the sweep order) and one Feature file per user-facing feature. It grows with features, not tickets.
_Avoid_: Test plan, spec

**Feature file**:
One user-facing feature in the Feature map: a title and paragraph, then `Sub-features`, `How to get to it (user POV)`, `Driving it with kitchen qa` (the Recipe) and `Gotchas`, ending with a `Code:` line naming the files behind it.
_Avoid_: Test case, spec file

**Recipe**:
A Feature file's steps: each a bold label, the action a person takes, the exact `kitchen qa` command and the result anyone can see. Prose an agent drives, never a saved script. Never weakened: fix how to reach something, never what is expected.
_Avoid_: Test script, e2e test

**Touched feature**:
A Feature whose `Code:` line covers a file a change touches. Kitchen's code decides which features are touched; an agent drives them.
_Avoid_: Affected test

**Regress**:
The Lane between review and the merge into Staging: one agent drives the Touched features' Recipes on the trial merge (Staging as it is, with the Job merged). Red sends the Job back to Build with the Evidence; green lands that merge. The dashboard calls it the merge check.
_Avoid_: Regression suite, smoke test

**CHANGES**:
Intake's line naming the sub-features (`<feature>/<sub-feature>`) a Ticket changes on purpose. Only those may lose a sub-feature, a step or an expected result; Kitchen refuses any other weakening. The Report shows each one as a **Changed earlier check: was …, now …**.
_Avoid_: Breaking change, waiver

**Sweep**:
`kitchen verify sweep`: one agent drives every Feature in the README's order against Staging before a person merges it onward, and writes a sweep report. It changes nothing.
_Avoid_: Release test, full regression

**Map upkeep**:
`kitchen verify maintain`: one agent keeps the Feature map honest (prune, merge duplicates, fix drift from each `Code:`, drive every Feature) on a branch of Staging; a product regression becomes a new Ticket, never a weaker map.
_Avoid_: Healing, test maintenance

### The outer loop (ADR 0022)

**Inner loop**:
The queue Kitchen works: intake, build, QA, review, merge check, Staging. Your own Tickets (`kitchen ticket`, New ticket) go straight in.
_Avoid_: Pipeline, factory floor

**Outer loop**:
What might be built: Items from Sources, triaged into Proposals a person chooses from. Nothing reaches the Inner loop without their click.
_Avoid_: Backlog, intake

**Source**:
Where Kitchen's code reads reports from (`.kitchen/sources/<name>.json`): GitHub issues with a label, a Slack channel's threads marked with an emoji, and the built-in Kitchen findings. Each keeps a watermark; one that can't be read is unavailable, never empty.
_Avoid_: Integration, connector, feed

**Item**:
One report as a Source gave it, keyed `source:native_id`, in the inbox (`.kitchen/inbox/<id>/`). The same report edited is a new sighting.
_Avoid_: Issue, message, ticket

**Collect**:
`kitchen collect`: read every Source, add what is new, then one triage session reads the new Items together and writes a verdict for each.
_Avoid_: Sync, import, fetch

**Proposal**:
Triage's verdict on one or more Items with the same cause: proposed (a Ticket with a priority, P1–P3, and how it was reproduced), unclear, or set aside (duplicate, fixed, not ours). Run makes a proposed one a Job, which keeps where it came from.
_Avoid_: Suggestion, candidate, draft ticket

### Learning

**Ledger**:
The record every move of every Job appends to (`.kitchen/ledger.jsonl`): moves, lanes, checks, the orchestrator's spend.
_Avoid_: Log, metrics store
