# A check ticket: test something without changing code

**Status.** Accepted, 2026-11-24, by the user ("yes go ahead"). Builds on ADR 0016 (lanes), 0017 (verify map, `kitchen qa`), 0022 (the inbox), 0027 (where the map lives).

## Why

Many tickets ask to test, confirm or explore ("check checkout still works", "go through the loan flow on staging"). Today intake rejects them ("asks Kitchen to do something other than change code") or accepts them as work, and the builder is pushed to change code nobody asked to change. Kitchen already has the parts: the verify map's recipes, `kitchen qa` to start and drive the app, sweeps on staging, triage that reproduces reports. Nothing routes a ticket to them.

## Decision

1. **Intake gets `KIND: check`** for a ticket that asks to test, confirm or explore without changing behaviour. Its criteria say what to check, in the usual forms (page, http, cmd). An exploring ticket ("try the loan flow and see what breaks") gets `EXPLORE: <minutes>` (default 20) instead of fixed criteria: QA drives freely for that long and reports findings. "Write tests for X" stays a `chore` (it changes code).
2. **A check job's path is Intake → QA → Done.** No branch, no Build, no Review, no merge check, no merge. QA runs against staging's tip (a `check-<id>` verify run, as sweeps use), with the app started from it.
3. **QA writes the Report as today** (each criterion with its evidence and screenshots) plus, for each failure or finding, a proposed bug: title, what was seen, repro steps, evidence.
4. **Outcome:**
   - all pass: Done, "Checked on staging · 4 of 4 pass";
   - failures or findings: Done, "Found 2 problems"; each becomes a proposal in the Inbox (source: Kitchen findings, linked back to the check job) for you to Run, Hold or set aside. Nothing is built without your click.
   - a check worth repeating: the recipes it used are added to the verify map (committed, or the local map, ADR 0027), so later merge checks and sweeps repeat it. A map write failure never fails the check (ADR 0027 §3).
5. **Repeat on a schedule:** `kitchen ticket --check --every day "…"` files the check again on each tick (the same launchd/systemd writer as `kitchen collect --install-schedule`); `kitchen ticket --check` alone forces the kind when intake would read it otherwise.
6. **Costs and rounds:** a check uses one QA lane (its round limit applies to a QA that couldn't run: app won't start, page unreachable); a check never goes back to Build.

## Amendment, 2026-11-24: test code that isn't kept

A ticket can ask for test code only to verify something now ("write a harness that proves the import handles 10k rows"), not to keep it. Intake decides and says so:

- **`KEEP: no`** (any kind that builds): the path is Intake → Build → checks → QA → Done, "Verified · not merged". No review, no merge check, no merge; the job branch is kept with its Report. `kitchen promote <id>` (and Promote in the panel) takes it up later: Review → merge check → merge into its target, or a PR when the target merges by PR (ADR 0026).
- **`KEEP: yes`** (the default): the normal flow, e.g. a regression test that stays, into the job's target; a PR where Kitchen never merges directly.
- A `check` (no code) has no KEEP: nothing is built.

## Not chosen

- Forcing a check through Build: makes changes nobody asked for.
- Filing failures straight into the queue: skips your choice and spends money before anyone looked.
- A separate "test runner" outside the queue: the queue already has the lanes, the Report and the dashboard.
