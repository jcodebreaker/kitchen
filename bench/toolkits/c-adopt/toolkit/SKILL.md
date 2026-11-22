---
name: verify-fixture-c-adopt
description: "fixture-c-adopt is a small server-rendered web app (Node + Postgres) with username/password sign-in, a dark-mode setting, a two-step project wizard and admin invite codes. Start, drive and observe it through its Kitchen Toolkit bin/dev. Use whenever a Job needs to prove behaviour in this app: launch a slot, check it, run a feature drive, capture evidence, tear it down."
---

# Toolkit: fixture-c-adopt

`bin/dev` is the only way to touch the running app. Every command prints exactly
one JSON line on stdout and logs to stderr. Kitchen runs it from its own clean
checkout of the base, always with `--src <worktree>`. State per id lives in
`$KITCHEN_TOOLKIT_STATE` (default `$TMPDIR/kitchen-toolkit-fixture-c-adopt/<id>/`), so
`down --id` needs no `--src`. Project specifics are in `app.mjs`; `bin/dev` and
`lib/` are Kitchen's generic contract code.

## Launch

```sh
bin/dev prepare --src <worktree>
bin/dev up --id <id> --src <worktree> --ports <app>,<db>,<browser>
```

`prepare` installs the Toolkit's deps (Playwright 1.65.0 and its chromium shell,
cached per version), builds the app image and pulls `postgres:16-alpine`. Cold
takes minutes, warm seconds. `up` runs the repo's own `docker-compose.yml` as a
compose project per id (`APP_PORT`=first port, `DB_PORT`=second), so the schema
and seed (`db/001_schema.sql`, `db/002_seed.sql`) run on the fresh volume. It
then waits for `/healthz` to report `db: true`, checks seed users exist, and
starts the browser daemon on the third port. Returns `{ url }`. Secrets: only
`.env.kitchen` (fake values, same as the dev seed). Never the developer's `.env`.

## Doctor

`bin/dev doctor --id <id>` is read-only. Checks: `/healthz` reports the db, the
seed users `alice` and `bob-admin` exist, the browser session answers (plus
process liveness added by bin/dev). Run it first whenever anything looks off.

## Drive

Primitives (each `bin/dev <name> --id=<id> --src=<worktree> --out=<dir> [--flag=value]…`, prints `{"ok","out","files"}`).
Kitchen sets `--id`, `--src` and `--out` itself; a flag given twice is refused.

| primitive | flags | does |
|---|---|---|
| login | as | sign in through the real form (seed users: alice, bob-admin) |
| open | path | navigate to a path on the app (same origin only) |
| reload | | reload the current page |
| press | target | click the first match |
| type | target, text | replace a field's value |
| read | target, attr? | inner text or attribute; missing is `ok:false` |
| screenshot | name, width? | full-page PNG into `--out` |
| http | method, path, body? | same-origin request with the browser's cookies |
| sql | query | a single read-only SELECT in the instance's postgres |

Feature drives live in `features/<x>.md` as fenced `drive` blocks; Kitchen
interprets them (they call primitives, nothing else). See `features/README.md`.
`bin/dev describe [--src <worktree>]` prints the capability list; it is
generated, never hand-edited. Most elements carry `data-testid`.

## Evidence

- Kitchen passes `--out <evidence>/e<N>/` on every primitive call; files are
  written there and listed in `files` (a file anywhere else fails the step).
  Kitchen stamps each call in its manifest. Nothing in the Toolkit writes it.
- Proof standard: sign in through the real form, act through the UI, then
  observe the result from a second view: reload, `/api/me`, `/projects`, or a
  `sql` read of the stored row.
- Logs: `<state>/<id>/*.log`.

## Cleanup

```sh
bin/dev reset --id <id>   # truncates sessions, invites, projects; themes back to light; re-inserts the seeded "onboarding" project; fresh browser context
bin/dev down --id <id>    # stops only what this id started (its compose project incl. volume, browser daemon)
```

`down` keeps logs and never touches evidence. Two instances can run side by side
(separate compose projects and ports).
