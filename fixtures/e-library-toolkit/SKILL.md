---
name: verify-library-demo
description: "Drive library-demo, a lending-library JSON API (browse books, borrow, return, my loans, librarian adds books), through its Kitchen Toolkit bin/dev. Use whenever a Job needs to prove behaviour in this app: launch a slot, check it, run a feature drive, capture evidence, tear it down."
---

# Toolkit: library-demo

`bin/dev` is the only way to touch the running app. Every command prints exactly
one JSON line on stdout and logs to stderr. Kitchen runs it from its own clean
checkout of the base, always with `--src <worktree>`. State per id lives in
`$KITCHEN_TOOLKIT_STATE` (default `$TMPDIR/kitchen-toolkit-library-demo/<id>/`), so
`down --id` needs no `--src`. Project specifics are in `app.mjs`; `bin/dev` and
`lib/` are Kitchen's generic contract code.

## Launch

```sh
bin/dev prepare --src <worktree>
bin/dev up --id <id> --src <worktree> --ports <p1,...>   # only the first port is used (app)
```

`prepare` only checks Node >= 20.11: the app has no dependencies, so it takes
under a second. `up` copies `seed.json` to `<state>/<id>/data/library.json`, starts
`node server.js` from the worktree with `PORT` and `DATA_DIR`, and is ready when
`/healthz` is ok with all seed books and a seed member can list `/books`. It returns
`{ url: http://127.0.0.1:<port> }`. No secrets: `.env.kitchen` holds only fake values.

## Doctor

`bin/dev doctor --id <id>` is read-only: the app process is alive, `/healthz` is ok,
a seed member gets 200 and an unknown one 401, and the data file parses. Run it
first whenever anything looks off.

## Drive

Primitives (each `bin/dev <name> --id=<id> --src=<worktree> --out=<dir> [--flag=value]...`, prints `{"ok","out","files"}`).
Kitchen sets `--id`, `--src` and `--out` itself; a flag given twice is refused.

| primitive | flags | does |
|---|---|---|
| `http` | `method`, `path`, `body` (JSON string), `as` (seed member sent as `X-Member`), `expect_status`, `expect_body` | same-origin request; `out` is `{status, body}`; ok unless an expectation differs |
| `read` | `target` = `status` or `body` | the last `http` response (use with `wait`) |
| `stored` | `table` (books, loans, members), `where` (`key=value`), `expect` | rows read from the data file, a second view that bypasses the API; ok only if rows match and contain `expect` |

Seed members: `ana`, `ben` (members) and `lena` (librarian). No passwords: identity is the `X-Member` header.

Feature drives live in `features/<x>.md` as fenced `drive` blocks; Kitchen
interprets them (they call primitives, nothing else). See `features/README.md`.
`bin/dev describe [--src <worktree>]` prints the capability list; it is
generated, never hand-edited.

## Evidence

- Kitchen passes `--out <evidence>/e<N>/` on every primitive call; files are
  written there and listed in `files` (a file anywhere else fails the step).
  Nothing in the Toolkit writes the manifest.
- This is an API, so the evidence is the response status and body in `out`. Prove a
  change through the real route (`POST /loans`), then observe the result from a
  second view: `GET /loans` or `/books/:id` as another member, and `stored`.
- Logs: `<state>/<id>/app.log`.

## Cleanup

```sh
bin/dev reset --id <id>   # stops the app, restores library.json from seed.json, restarts it on the same port
bin/dev down --id <id>    # stops only what this id started (recorded pid)
```

`reset` needs a restart because the app loads its data once at start. `down` keeps logs and never touches evidence.
