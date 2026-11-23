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
Where a Job is: intake, build, QA, review (the Lanes), ready (held for a person), done (merged into Staging), or waiting: needs-info, needs-human, paused, rejected.
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

### Running the queue

**Orchestrator**:
The Claude Code session that runs the queue (`/kitchen run`, or headless through `kitchen run`): it plans each Wave and starts one agent per Lane; it moves Jobs only through `kitchen job` verbs and does no product work itself.
_Avoid_: Runner (the removed plain-code loop), dispatcher

**Wave**:
The lanes the Orchestrator starts at once, from `kitchen job next`: downstream first, at most `parallel`, a Job that shares a file with an unfinished earlier one held back.
_Avoid_: Batch, tick

**Lane**:
A Stage an agent works in: intake, build, QA, review. One fresh agent per Lane per Job, briefed by `kitchen job start`, its result read by `kitchen job finish`.
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

**Report**:
The HTML page a Job ends with: what a person must check, then each criterion with its Evidence, the review and the diff.
_Avoid_: Summary, PR description

### Learning

**Ledger**:
The record every move of every Job appends to (`.kitchen/ledger.jsonl`): moves, lanes, checks, the orchestrator's spend.
_Avoid_: Log, metrics store
