# Trust what a run reports

**Status.** Accepted, 2026-11-24, by the user ("yes go ahead"). Each gap was confirmed in the code. Builds on ADR 0016 (QA evidence), 0025 (checks show progress), 0028 (check tickets, BLOCKED).

## Why

1. **Intake can lose a criterion without anyone knowing.** `parseCriteria` (`src/engine/lanes.ts`) only matches one lowercase word in the brackets. `- C3 (page + http): …`, `(page, http)`, `(UI)` and a criterion with no kind at all match nothing, and they are dropped. Intake is accepted on the criteria that are left. Build and QA never see the dropped ones, and the Report says "N of N pass" on a smaller N. A repeated id is dropped the same way.
2. **A broken environment reads as a broken product.** Only a check may say `BLOCKED` (`readQa`, `o.check`). On a job, QA has two choices, PASS or FAIL. Bad seed data, an app that won't start or a missing fixture therefore becomes a FAIL. That costs a Build round, and the builder then "fixes" code that was fine.
3. **"Waiting" doesn't say for what.** The wave planner knows why a job waits, for room (`parallel`) or for a job on its `AFTER:` line (`plan.held[].why`). The dashboard drops that and says "Waiting for a free lane", or "Waiting for its lane to start" in the panel.
4. **Setup time looks like a hang.** `kitchen qa up` can run `npm install` (up to 30 min), a reset and a health wait, and Playwright's Chromium is never installed ahead of time. The first `kitchen qa page` downloads it, or fails with Playwright's own error. None of this shows on the dashboard. ADR 0025's progress line covers checks only.

## Decision

1. **A malformed criterion refuses the intake.** Every line that looks like a criterion (`- C<n>` …) must parse. If one doesn't, `parseIntake` refuses with the exact line and the fix, and the intake lane runs again with that reason (as today for any refusal). Examples:
   - `C3 (page + http): one kind per criterion: split it into C3 (page) and C4 (http)`
   - `C5 has no kind: write - C5 (page|http|test|cmd): …`
   - `C2 is listed twice`

   Kinds are matched case-insensitively. Nothing is guessed or merged, so a criterion is never changed silently.
2. **QA on a job may say BLOCKED.** A job's QA may now return `{ verdict: "BLOCKED", blocked: "<why>", evidence: [...] }`, the same shape as a check's. The QA brief says when: the app won't start, the seed data is wrong or missing, or a service the app needs is down. Anything the job's change caused is a FAIL.
   - **First BLOCKED in a round:** Kitchen runs `kitchen qa reset` (fresh seed) and QA again. No Build round is counted.
   - **Second BLOCKED:** the job goes to **Needs you** with "QA couldn't test it: <why>", the evidence, and Resume (QA again) once you've fixed the environment.

   The Report never counts a BLOCKED as a fail.
3. **Waiting says why.** The dashboard runs the same `planWave` it already reads the jobs for, and shows the held reason:
   - `Waiting for a free lane · 009 and 010 are using both (parallel: 2)`. With more than three running, it gives the count instead: `· 4 jobs are using all 4`.
   - `Waiting for 007 to merge first (named on its AFTER: line)`
   - `Waiting for the orchestrator (kitchen run)`, unchanged when none runs.

   The card and the panel share the line, and the panel's "Waiting for its lane to start" goes away.
4. **Setup shows progress, and the browser is ready before QA needs it.**
   - `kitchen qa up` records the step it is on in the job's `checking` field (ADR 0025): `Preparing · npm install`, `Resetting data`, `Starting the app`, `Waiting for /health · 40s of 120s`. The card shows it with the log's last line, the same way it shows checks. The field clears when the app is up or the step fails.
   - `kitchen init` and `kitchen run`'s preflight check that Playwright's Chromium is installed. If it isn't, they install it once, saying so ("Installing the browser QA uses, once (~150 MB)…"). If the install fails, the run is refused with the command to run by hand. `kitchen qa page` turns Playwright's missing-browser error into the same one line.

5. **A finished ticket leaves nothing running.** (Added 2026-11-24, by the user: "when the ticket is done or totally failed" the agent is still up and holds memory.)
   - **The job's app stops on every way out of a lane.** That means done (merged, verified, checked), rejected, needs-human, and paused or stopped. Today only a lane that finishes normally and `kitchen remove` stop it. The other verbs leave the app, its dev server or its compose stack running.
   - **The orchestrator sweeps on drain.** When a wave plan says `drained`, and when `kitchen run` starts, Kitchen stops every app whose job is not in a running lane, using each job's `app.json`.
   - **The session exits, and takes its children with it.** This covers every agent session Kitchen starts: the `kitchen run` orchestrator, collect's triage, and `kitchen models check` (sweeps and verify runs are driven by the orchestrator's session, so its group covers them). Each runs in its own process group (one shared helper, `src/agents/session.ts`). Once its stream sends the final line (Claude's `result`; `codex exec`'s last turn event, else the process closing), Kitchen waits 10 s, then ends the group: SIGTERM, then SIGKILL 3 s later. On close, whatever is left of the group ends too, and so it does when Kitchen itself is stopped (SIGTERM, SIGINT). That also covers a stopped run and a crashed one. Anything a lane agent started by hand (`npm run dev &`, a browser) goes with the group. Apps that `kitchen qa up` started have their own groups and are stopped through `app.json`, as above. A Codex `/kitchen run` inside the person's own Codex session is theirs: Kitchen doesn't kill it, and the skill tells it to stop when the queue is drained.

## Not chosen

- **Splitting `(page + http)` into two criteria automatically:** Kitchen would be making up wording for a criterion. Intake rewriting it keeps the person's criteria in intake's words.
- **Letting QA mark a single row BLOCKED:** half-tested rounds then pass on the rows that ran. A round is tested or it isn't.
- **Retrying BLOCKED forever:** a wrong seed doesn't fix itself, so the second one asks a person.
