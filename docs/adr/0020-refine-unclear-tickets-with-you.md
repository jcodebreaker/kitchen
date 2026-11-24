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

## Amendment, 2026-11-23: how it is built

- **intake.md.** `DECISION: REFINE`, `REASON:` starting with `readings`, `too-big` (or `too big`), `no-repro` or `terms`, and a `## Refine` section of `- ` lines (the readings, slices or gaps). `parseIntake` refuses REFINE without one of the four reasons or without a line. The role file says when to refine and keeps "the smallest reading" for clear tickets.
- **The marker.** The job goes to `needs-info` with `waits: { for: "refine", reason, at }` on job.json and `pausedReason: "refine: <reason>"`, so `kitchen status` shows `needs-info(refine: readings)` with no new code. The question (intake's readings and the `/kitchen refine <id>` line) is recorded as a clarification round and in question.md, like a NEEDS-INFO question. Any move out of needs-info clears `waits` (machine.ts).
- **Feedback.** Unchanged path: the answer lands in the clarifications as the author's words and the job goes back to intake. On a refine job it also appends `{ reason, at }` to `refined`.
- **No second refinement for the same reason.** When `refined` already holds intake's reason, Kitchen refuses the lane ("decide on it now"); three refusals go to a person, as for any lane. Refinements count toward the two-question rule: after two, a third question or refinement goes to needs-human.
- **`kitchen refine <id>`** (src/engine/refine.ts) writes `.kitchen/jobs/<id>/refine/brief.md`: the ticket with its answered clarifications, intake's REASON line and list, the verify map's index (the same section intake's brief uses), pointers to GLOSSARY.md, GLOSSARY-MAP.md and docs/adr/ when present, and the steps (grill-with-docs, else grilling + domain-modeling, else one question per turn with a recommended answer; the refined ticket as Problem / In / Out / Criteria / Slices; confirm, then `kitchen feedback`). It refuses a job not waiting for refinement.
- **Too big, one rule.** The job is rescoped to slice 1 through the feedback; each later slice is filed with `kitchen ticket`, in order, naming the job it comes after ("Comes after job 005"), which intake turns into `AFTER:`. The job is never rejected for being too big. (Kitchen files the later slices itself now: see the amendment below.)
- **The confirm gate.** `intake: { confirm: true }`: an ACCEPT applies intake's fields, then the job goes to `needs-info` with `waits: { for: "confirm" }` and its criteria and LEFT OUT as the question (a round keyed `…/confirm`, which the two-question rule doesn't count). `kitchen approve <id>` (needs-info → build, a new move in the table) is only for such a job; it records "Approved as written." in the clarifications and `approved` on the job. `kitchen feedback` sends it back to intake, which asks for approval again on its new criteria.
- **Dashboard.** Data carries `waits` (reason and readings, or criteria and LEFT OUT). A refine job shows "Refine with you · <reason>", the readings, and `/kitchen refine <id>` with a copy button ("Run in Claude Code or Codex"); Reply still answers. A confirm job shows "Approve the criteria", the criteria, "Left out: …", Approve (POST /api/approve → `control.approve`) and Ask for changes. Approve wakes an orchestrator like an answer does.
- **Report.** "What you must check" says "Refined with you on <date> (<reason>)" and "Criteria approved by you on <date>".
- **Lanes.** The registry's interactive-skill exclusion is unchanged: no lane loads grill-with-docs, grilling or the like.

## Amendment, 2026-11-23: Kitchen files the later slices

Seen live: a ticket split in two on the dashboard's Reply ("yes for two") was accepted as its first part; intake wrote the second part on `LEFT OUT:` as "filed on its own", and nobody filed it. Only the `/kitchen refine` session filed slices. Now code does it, whichever way the author answered.

- **intake.md.** With `ACCEPT`, intake may write `## Later slices`: one `- ` line per later slice, each a ticket on its own in the author's words (what, for whom; the reading they picked, or that it still needs refining). Only when the author agreed the ticket is more than one job, or intake scopes a too-big ticket to its first slice. `LEFT OUT:` no longer carries those. `parseIntake` returns them as `slices` (empty when none).
- **Filing.** When `kitchen job finish` admits the ACCEPT (to Build, or to the confirm gate), Kitchen files each slice in order with the same function as `kitchen ticket`: "<slice>. Comes after job <n>.", the first after this job and each later one after the slice before it, so their intakes write `AFTER:`. Each filed slice is recorded on the job (`slices: [{ text, id }]`) as it is filed, so a retried finish files only what isn't yet. The finish line says "filed 007, 008".
- **Report.** "What you must check" says "Split with you: the rest is filed as 007 “…”, 008 “…”".
- **Refine brief.** The refined ticket lists every slice under Slices; the session no longer files them with `kitchen ticket` (that would file them twice). The Slices flow to intake, intake writes `## Later slices`, Kitchen files them.
