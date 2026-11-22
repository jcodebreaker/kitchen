# Kitchen

Kitchen is an open-source pipeline that turns requests for work into proven, reviewed pull requests, using a coding agent (Claude Code or Codex) for the judgment and deterministic code for everything else.

## Language

### Work

**Ticket**:
One request for work, from a GitHub issue or typed by a developer as a prompt.
_Avoid_: Issue (that is only one source), task, request

**Job**:
One run of Kitchen on one Ticket, from intake to a merged or handed-over pull request. Named by a number and a short slug, with the Ticket's title beside it.
_Avoid_: Run, build, pipeline run

**Stage**:
One step of a Job: Intake, Spec, Build, Gate, Verify, Review, Ready, Report.
_Avoid_: Phase, step

**Risk**:
Intake's rating of a Ticket (low, medium, high) that decides how many Stages and Review lenses a Job gets and whether a human must look.
_Avoid_: Priority, severity

**Verification contract**:
The Spec's list of acceptance criteria, each naming how it will be proven; the builder may only tick criteria off, never change them.
_Avoid_: Spec document, PRD, plan

**Round**:
One pass of Build, Gate, Verify and Review; a Job has a limited number before a human is asked.
_Avoid_: Iteration, attempt

### Proving behaviour

**Toolkit**:
The project-owned kit that starts, drives and observes the developer's app, and the only way any part of Kitchen touches the running app.
_Avoid_: Kitchen (that is the product), harness, verify skill, dev CLI

**Toolkit gap**:
Something the Toolkit cannot do that a Job needs in order to prove a behaviour; a missing capability, not a broken app.
_Avoid_: Kitchen gap, harness gap

**Primitive**:
A Toolkit command every Job can use (start, reset, sign in, press, screenshot…); changes only through the Toolkit smith and is proven on main.
_Avoid_: Helper, tool

**Feature drive**:
A declarative list of Primitive calls that reaches and exercises one feature; it holds no code and ships inside the Job's pull request.
_Avoid_: Drive script, test script

**Toolkit smith**:
The role that builds a missing Primitive on its own branch and proves it against main, never the Job's builder.
_Avoid_: Kitchen agent, toolkit builder

**Verdict**:
The outcome of driving the app through the Toolkit against a Job's acceptance criteria: PASS, FAIL, TOOLKIT-GAP or INCONCLUSIVE (which counts as FAIL).
_Avoid_: Review result, score

**Evidence**:
The files a Job produces as proof (screenshots, logs, command output, Verdicts), each with an id the Report cites.
_Avoid_: Artifacts, proof files

**Report**:
The HTML page a Job ends with, explaining what was done and showing its Evidence.
_Avoid_: Summary, PR description

### Learning

**Ledger**:
The record every Stage of every Job appends to: Verdicts, Rounds, cost, time, escalation reasons.
_Avoid_: Log, metrics store

**Retro**:
The step after each Job that turns repeated lessons into muted review categories or proposed Tickets.
_Avoid_: Postmortem, learning agent
