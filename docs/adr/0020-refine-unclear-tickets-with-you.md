# Refine unclear tickets with you

**Status.** Accepted, 2026-11-23, by the user ("sometimes it's not about speed, it's about accuracy and how well defined the ticket is"). Amends the intake role and its decisions (ADR 0016 and its intake amendments). The routing follows super-board's `lint` verb (v3.3.0, MIT; credited in NOTICE).

## Why

Intake takes the smallest reading of a ticket and writes the criteria itself. It asks one question only when it can't tell what done looks like. That is fast, but nobody checks the reading before Build: what intake left out shows up in the Report afterwards. A ticket with two readings is built on the one intake picked.

super-board puts refinement before the run, where a person is present. `super-board lint` flags vague tickets and sends each to a skill: `grilling` for a ticket with several readings or one that needs rethinking, `/to-tickets` for one too big, `diagnosing-bugs` for a bug with no repro steps, `domain-modeling` / `codebase-design` for unclear terms or design. Its workers never grill: an unattended agent can't ask, so it stalls or answers itself (super-build's decision policy says so).

## Decision

### 1. Intake can send a ticket to be refined
A fourth decision, `REFINE`, for when a short answer won't do:
- **readings**: the ticket has two or more reasonable readings that change what gets built (intake lists them);
- **too big**: it is more than one job of `staging.max_lines` (intake sketches the slices);
- **no repro**: a bug with no way to see it;
- **terms**: it uses words the code or the glossary means differently.

`REFINE` writes `REASON: readings | too-big | no-repro | terms` and the readings, slices or gaps, in plain words. `NEEDS-INFO` stays for one missing fact a one-line answer settles.

The job goes to `needs-info` marked "refine with you" with the reason. The dashboard shows it under Needs you, says why, and shows the command for Claude Code.

### 2. You refine it in Claude Code (or Codex)
`/kitchen refine <id>`, or the `/kitchen` session offers it when a job is waiting for refinement:
- `kitchen refine <id>` writes a brief: the ticket, intake's reason and readings, earlier answers, the verify map's features and sub-features, and the repo's `GLOSSARY.md` and ADRs when present. It prints the brief's path.
- The session runs `grill-with-docs` (`grilling` + `domain-modeling`) with you, one question at a time, against the code and the map. Without it, the brief's own steps do the same: one question per turn, a recommended answer each, until nothing is left open. Glossary terms and decisions settled on the way are written as the skill says.
- It ends with the refined ticket: the problem, what's in, what's out, the criteria you agreed and, for a ticket too big, the slices (each becomes its own ticket with `AFTER:` order). You confirm it, then `kitchen feedback <id> "<refined ticket>"` sends the job back to intake, which reads it as the author's own words.

### 3. An optional gate after intake
`intake: { confirm: true }` in `kitchen.yaml` stops every accepted job after intake, under Needs you, with its criteria and `LEFT OUT:`. `kitchen approve <id>` (or Approve on the dashboard) sends it to Build. Edits go through `kitchen feedback`, back to intake. Off by default.

### 4. Lane agents never grill
The interactive skills stay off the lanes' list. Refinement happens only in a session with you in it.

## Not chosen
- **Intake grilling you itself:** it runs unattended, in parallel, and can't wait on a conversation.
- **A separate lint pass over the queue before each run** (super-board's shape): Kitchen's intake already reads every ticket. It flags the unclear ones, and the clear ones aren't held.
- **Refining every ticket:** most are clear, and a conversation per ticket is what makes a queue slow. The confirm gate is there for teams who want every reading checked.

## Consequences
- Unclear tickets wait for you, and get built on the reading you chose.
- Clear tickets go straight through, as before.
- Needs you gets a new reason, refine, next to answer and approve.
- `grill-with-docs` is used only in your own session. A machine without it still refines, by the brief's steps.
