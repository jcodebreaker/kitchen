---
name: verify-fixture-e-library
description: "Start, drive and observe fixture-e-library, a small lending library HTTP API (books, members, loans: borrow and return with due dates), through its Kitchen Toolkit bin/dev. Use whenever a Job needs to prove behaviour in this app: launch a slot, check it, run a feature drive, capture evidence, tear it down."
---

# Toolkit: fixture-e-library

`bin/dev` is the only way to touch the running app. Every command prints exactly
one JSON line on stdout and logs to stderr. Kitchen runs it from its own clean
checkout of the base, always with `--src <worktree>`. State per id lives in
`$KITCHEN_TOOLKIT_STATE` (default `$TMPDIR/kitchen-toolkit-fixture-e-library/<id>/`), so
`down --id` needs no `--src`. Project specifics are in `app.mjs`; `bin/dev` and
`lib/` are Kitchen's generic contract code. Surface: **api** (no UI, no CLI).

## Launch

```sh
bin/dev prepare --src <worktree>
bin/dev up --id <id> --src <worktree> --ports <app>
```

`prepare` has nothing to install (the app has no dependencies). `up` starts
`node server.js` on the one port with `DATA_DIR` set to a fresh folder in the
instance's state dir; the app creates `library.json` there from the worktree's
`seed.json` on start. Ready means `/healthz` reports `store: true` and the store
holds the seed's books and loans. No secrets: `.env.kitchen` is only a marker.
Node 20.11+.

## Doctor

`bin/dev doctor --id <id>` — read-only: the app process is alive, healthz
reports the store, `library.json` parses, a seed member is accepted. Run it
first whenever anything looks off.

## Drive

Primitives (each `bin/dev <name> --id=<id> --src=<worktree> --out=<dir> [--flag=value]…`, prints `{"ok","out","files"}`).
Kitchen sets `--id`, `--src` and `--out` itself; a flag given twice is refused.
Seed users are the members in `seed.json` (`ana`, `ben`, and the librarian `lena`);
`as` sends that id as `X-Member`, no `as` sends none.

| primitive | flags | does |
|---|---|---|
| `http` | `method`, `path`, `body` (raw JSON), `as`, `expect_status` | one request to the app (same origin only); its output is `{status, body}`; ok on a response, or when the status matches `expect_status` |
| `read` | `target` (`status`, `body`, `body.<path>` or `<path>`), `equals` | reads the last response; missing is ok:false |
| `stored` | `collection` (`books`, `loans`, `members`), `record` (its id), `field`, `equals` | one record straight from `library.json` |

Feature drives live in `features/<x>.md` as fenced `drive` blocks; Kitchen
interprets them (they call primitives, nothing else). See `features/README.md`.
`bin/dev describe [--src <worktree>]` prints the capability list; it is
generated, never hand-edited.

## Evidence

- Kitchen passes `--out <evidence>/e<N>/` on every primitive call; files are
  written there and listed in `files` (a file anywhere else fails the step).
  Kitchen stamps each call in its manifest. Nothing in the Toolkit writes it.
- Proof standard: go through the real public API (HTTP with `X-Member`),
  capture the response, and verify side effects from a second view: the stored
  record (`stored`), or a listing/GET of the same thing.
- Logs: `<state>/<id>/app.log`.

## Cleanup

```sh
bin/dev reset --id <id>   # stops the app, wipes its data dir, restarts it (re-seeded from seed.json)
bin/dev down --id <id>    # stops only what this id started (recorded pids)
```

`down` keeps logs and never touches evidence. Instances are independent
(own port and data dir), so several can run at once.

## Stand-ins

None: the app has no external services. The clock is the real one (UTC), so
due dates depend on the day the drive runs; the seed's loans have fixed 2025 dates.
