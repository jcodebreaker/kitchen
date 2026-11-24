# Use the project's own testing

**Status.** Accepted, 2026-11-24, by the user ("go ahead with all four, ADR first"). Amends ADR 0016 (checks, `app:`) and ADR 0017 (the verify skill, the sweep).

## Why

Kitchen brings its own checking: your unit-level checks after Build and on the merged result, and QA driving the running app with `kitchen qa page` / `http` from the verify map. A project that already has more doesn't get it used:

- **An end-to-end suite** (`test:e2e`, `playwright test`, `cypress run`) is never a check. `kitchen init` takes only `lint`, `typecheck`, `test` and `build`, and skips anything slow or container-bound. You can add it to `checks:` by hand, but then it runs after every Build round.
- **The suite's know-how** (page objects, fixtures, seed helpers, login helpers) is invisible to QA, which works out how to drive the app from zero.
- **A deployed test environment** (a staging URL the team shares) is never used. QA runs the job's code on your machine, rightly, since a shared server has whatever was deployed last, not this branch. But after a release cut nothing checks the deployed app either.
- **A multi-service app** (`docker compose`) works only as one shared stack, so two jobs' QA share one database.

## Decision

### 1. Init finds the e2e suite; it runs on the merged result only
- `kitchen init` looks for an end-to-end suite: a `test:e2e`, `e2e`, `test:integration` or `cy:run` script, a `playwright.config.*` (`npx playwright test`) or a `cypress.config.*` (`npx cypress run`), and the Makefile targets `e2e` / `integration`.
- It writes it as a check with `when: merge`: `checks: [{ name: e2e, run: "npm run test:e2e", when: merge, timeout_sec: 900 }]`. A check is `when: build` (default, as today: after Build and before the merge) or `when: merge` (only on the trial merge, before it lands).
- A `when: merge` check needs the app running when the suite expects one: `needs_app: true` makes Kitchen start the app (`app:`) in the trial-merge folder first and pass its URL as `$BASE_URL` (and `$PLAYWRIGHT_BASE_URL`, `$CYPRESS_BASE_URL`).
- Red `when: merge` checks send the job back like red checks do today: a round, unless the red comes only from staging having moved (ADR 0018).

### 2. QA uses the suite's know-how
- The verify skill's `SKILL.md` gets a **Your tests** section, written by init: where the suite is, its page objects / fixtures / helpers (the folders and files init finds), how a test logs in or seeds data, and the command to run one spec.
- QA's role: read that section before driving; reuse the suite's selectors and seed helpers; when a criterion matches an existing spec, run that spec as evidence (its output in the QA folder) instead of re-driving it by hand.
- QA never edits the suite. A new spec, when the ticket asks for one, is the builder's.

### 3. The sweep can run against a deployed environment
- `kitchen verify sweep --url <url>` drives every feature in the map against that URL instead of starting the app from `staging`. It changes nothing, as today, and the report names the URL.
- Recipes that need a reset or seed (preconditions the deployed app can't do) are marked "not run: needs a fresh seed" in the report, not failed.
- The URL is never stored in a job and never used by a job's QA: jobs always test their own code.

### 4. Compose apps get a stack per job
- When `app.start` runs `docker compose` (or `docker-compose`), Kitchen gives each job its own project: `COMPOSE_PROJECT_NAME=kq<job>` in the app's environment, so containers, networks and volumes are per job. `kitchen qa down` runs `docker compose -p kq<job> down -v` (or `app.stop` when set).
- Ports: the app still gets `$PORT`; a compose file that publishes a fixed port must use `${PORT}` for the job's app to run beside another (init says so when it sees a fixed published port).
- `app.reset` runs inside the job's project too.

## Not chosen
- **Running the e2e suite after every Build round:** slow, and the round's QA already checks the job's criteria in the running app. Once per merge is the gate that matters.
- **QA writing specs into the suite:** a growing pile of tests is what ADR 0017 avoided; the builder adds a spec only when the ticket asks for one.
- **Jobs testing on the shared environment:** it doesn't run the job's branch.

## Consequences
- Projects with an e2e suite get it as a gate on every merge into staging, and QA drives the app the way the suite does.
- A merge gets slower by the suite's run time, once per merge.
- The release sweep can check what's actually deployed.
- Compose apps can run QA for parallel jobs without sharing data.

## Amendment, 2026-11-24: how it is built

**Checks.** `checks[]` takes `when: build | merge` (default `build`) and `needs_app: boolean` (default false). `needs_app` is refused on a `build` check and when `app.start` is empty. `checksFor(cfg, "build")` is what `job finish` runs after Build, what init runs once and what the brief lists; the trial merge runs `checksFor(cfg, "merge")` (all of them, in kitchen.yaml order). The brief names the merge-only ones separately.

**The app for a merge check.** `qa/app.ts` now has `startApp` / `stopApp`, shared by `kitchen qa up|down` and the merge gate: `app.reset`, `app.start` on a free port, the health wait (a start command that exits 0, like `docker compose up -d`, keeps waiting; one that fails stops the wait). `runChecks` takes an `app` hook; for a `needs_app` check it starts the app from the trial-merge worktree, runs the check with `BASE_URL`, `PLAYWRIGHT_BASE_URL` and `CYPRESS_BASE_URL` set to the app's URL, and stops the app in a `finally`. An app that doesn't come up fails the check ("the app did not start"). The merge log carries the app's output and the suite's.

**Red on the merge.** Back to Build like any red merge check, and a red `when: merge` check is always a **round**, never a catch-up: it never ran on the branch alone, so "green alone" (ADR 0018) isn't known, and counting it a catch-up would give a job that really breaks the suite three free tries whenever staging moved. The merge outcome says whether the failing check is merge-only, and `isCatchUp` takes it: a conflict is a catch-up; a red build check on the merge with the round's checks green alone and staging moved is a catch-up; a red merge-only check is a round. The red check's last 60 lines go into `merge.txt`, which the next builder's brief quotes, so a failing spec says what broke.

**Init.** `detectE2e`: the first of the scripts `test:e2e`, `e2e`, `test:integration`, `cy:run`; else `playwright.config.{ts,js,mjs,cjs}` (`npx playwright test`); else `cypress.config.*` (`npx cypress run`); else a Makefile `e2e` / `integration` target. Written after the unit-level checks as `{ name: e2e, run, when: merge, needs_app, timeout_sec: 900 }`, `needs_app` true when init found (or kitchen.yaml already had) an `app.start`, under a comment saying when it runs. The unsafe filter stays for build checks; for the e2e command `docker` / `compose` is allowed (it only ever runs in the throwaway trial-merge worktree, and many suites bring up their database that way), while `--fix`/`--write`, watch and serve still skip it. A kitchen.yaml that already names its checks isn't edited: init prints the line to add. Init doesn't run the suite.

**Your tests.** `verify/suite.ts` finds the suite (Playwright or Cypress by config or dependency, else the `when: merge` check), its folder (Playwright's `testDir`, else the usual folders), up to five spec names and the count, helper folders (`pages`, `page-objects`, `fixtures`, `helpers`, `support`, `utils`, `setup`) and files (`*.page.ts`, `*.po.ts`, `fixtures.ts`, `helpers.ts`, `commands.js`, `global-setup.ts`…), and login/seed helpers by name (exported functions, Playwright fixtures, `Cypress.Commands.add`) matching login, sign in, auth, seed, reset or session. The section gives the one-spec command with the URL env and with the run's artifacts sent to the evidence folder (`--output <evidence folder>/pw`, Cypress `screenshotsFolder`), so a spec run leaves the worktree clean. It sits between Launch and Drive; the whole-file marker rule is unchanged (a SKILL.md someone edited is kept, without the section).

**Sweep `--url`.** `kitchen verify sweep --url <url>` (refused for maintain): no app starts; the URL and the features whose recipe mentions `kitchen qa reset`, `app.reset` or seed data are kept in the run's `run.json` only. `kitchen qa page|http <run>` use the URL as their base and accept only its origin (besides loopback); `qa up` and `qa reset` refuse with a line saying why. The verdict may give those features `NOT_RUN` (no evidence needed), which `readFeatureVerdict` accepts only for them; a NOT_RUN row isn't a FAIL. The report and the finish line name the URL and the not-run count.

**Compose.** `composeProject(app, id)`: `kq<job number>` (`kq-<run id>` for a verify run) when `app.start` matches `docker compose` / `docker-compose`; the merge check's app uses `kq<job number>-merge`, so it never shares a stack with the job's QA. `COMPOSE_PROJECT_NAME` is set for `app.start`, `app.reset` and the stop command. New optional `app.stop`; without it a compose app stops with `docker compose -p <project> down -v`. The stop command and its env are saved in the app's state at start, so a later kitchen.yaml edit can't strand a stack. Init warns about fixed published host ports in `compose.yaml` / `docker-compose.yml` (short and long syntax; `${PORT}` and container-only ports are fine). Only the env and command construction is unit-tested; Kitchen's tests never run Docker.

**Known gap.** `kitchen qa up` decides the app is already up by its process being alive and healthy. A compose app started detached (`docker compose up -d`, whose process exits) passes the health wait, but a second `qa up` for the same job doesn't see it as running and starts it again (the same compose project, so the same containers; untested, since Kitchen's tests never run Docker). Start compose in the foreground (`docker compose up`) until this is fixed.

**Proof.** `src/engine/merge-checks.test.ts` drives two jobs through every lane with a stand-in suite (a node script reading `$BASE_URL`): skipped after Build, green on the merge against the reset app and stopped after, then a change that breaks the page, with staging moved meanwhile, goes back to Build as a round (not a catch-up) with the suite's output in the next brief. A real Playwright run was checked once by hand on a small shop app.
