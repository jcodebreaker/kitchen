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
