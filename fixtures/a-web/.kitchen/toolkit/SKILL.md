---
name: verify-fixture-a-web
description: "Start, drive and observe fixture A (Node web app + Postgres, local sign-in, settings with dark mode, two-step project form, admin invites) through its Kitchen Toolkit bin/dev. Use whenever a Job needs to prove behaviour in this app: launch a slot, check it, run a feature drive, capture evidence, tear it down."
---

# Toolkit: fixture A

`bin/dev` is the only way to touch the running app. Every command prints exactly
one JSON line on stdout and logs to stderr. Run it from anywhere; it finds its
own files. State per id lives in `$KITCHEN_TOOLKIT_STATE` (default
`$TMPDIR/kitchen-toolkit-a-web/<id>/`), so `down --id` needs no `--src`.

## Launch

```sh
bin/dev prepare --src <worktree>                       # npm ci (app + toolkit), Chromium headless shell, seed snapshot image
bin/dev up --id <id> --src <worktree> --ports <app>,<postgres>,<driver>[,…]
```

- `prepare` builds `kitchen-a-web-seed:<hash of db/*.sql + .env.kitchen>`: Postgres
  with migrations + seed baked in and an `app_seed` template database. Cached; a
  warm prepare is ~1 s, a cold snapshot build ~4–5 s.
- `up` uses the first 3 ports it is given: app, Postgres (127.0.0.1 only), browser
  driver. It starts the snapshot container `kitchen-a-web-<id>`, the app
  (`node server.js`), and a headless Chromium session daemon (`lib/driver.mjs`).
  Ready means `/healthz` reports `db: true` and the driver answers a ping.
  Prints `{"status":"ready","url":…}` in ~1–1.5 s.
- Secrets: only `.env.kitchen` (fake values). Never the developer's `.env`.

## Doctor

`bin/dev doctor --id <id>` — read-only. Checks: container running with our
`kitchen.id` label, seed users present, app pid alive, `/healthz` on our port,
browser driver alive. Run it first whenever anything looks off.

## Drive

Primitives (each `bin/dev <name> --id=<id> --src=<worktree> --out=<dir> [--flag=value]…`, prints `{"ok","out","files"}`).
Kitchen sets `--id`, `--src` and `--out` itself; a flag given twice is refused.

| primitive | flags | does |
|---|---|---|
| `login` | `--as <seed user>` | signs in through the real /login page (`alice`, `bob-admin`) |
| `press` | `--target <selector>` | clicks the first match, waits for any navigation to load |
| `type` | `--target <selector> --text <s>` | replaces the field's value |
| `read` | `--target <selector> [--attr <name>]` | inner text (default `body`) or an attribute; no match or no such attribute is `ok:false` |
| `screenshot` | `--name <stem>` | full-page PNG into `--out` (required) |
| `http` | `--method GET --path /api/… [--body json]` | request with the browser's cookies (as the signed-in user); another origin is refused |
| `open` | `--path /settings` | navigates to a path on the app; another origin is refused |
| `reload` | | reloads the current page from the server |

The browser session (cookies, open page) lasts until `reset` or `down`.
Selectors: prefer `[data-testid=…]` and `[aria-label='…']`; every interactive
element in the app has one. Waits are not a primitive: the Kitchen engine polls
`read` for `wait:` steps.

Feature drives live in `features/<x>.md` as fenced `drive` blocks; Kitchen's
`src/proof/drive.ts` interprets them. See `features/README.md`.

`bin/dev describe [--src <worktree>]` prints the primitives, the feature files
(`features/*.md` in `--src`; Kitchen parses the drives in them), `ports.needs`, seed users (parsed from `db/002_seed.sql`), externals (none) and
`parallel: true`. It is generated; don't hand-edit a capability list anywhere.

## Evidence

- Kitchen passes `--out <evidence>/e<N>/` on every primitive call; files
  (screenshots) are written there and listed in `files` (a file anywhere else
  fails the step). Kitchen stamps each call in `manifest.jsonl` with the files'
  hashes. Nothing in the Toolkit writes the manifest.
- Kitchen runs `bin/dev` with a scrubbed env plus `DOCKER_HOST`/`DOCKER_CONTEXT`
  (named in `KITCHEN_CONTROL_ENV`); `appEnv()` strips those before starting the
  app and the browser driver.
- Proof standard: go through the UI the way a user does (`login` uses the real
  form, `http` uses the browser's own session). Prove persistence with a full page
  load (press a nav link) or `http GET /api/me`, not by reading client state only.
- App and driver logs: `<state>/<id>/app.log`, `driver.log`.

## Cleanup

```sh
bin/dev reset --id <id>   # DROP DATABASE app WITH (FORCE); CREATE … TEMPLATE app_seed; fresh browser context (~0.6 s)
bin/dev down --id <id>    # kill the driver + app process groups we started, docker rm -f kitchen-a-web-<id>
```

`down` stops only what that id started (by recorded pid and container name,
never by process name), keeps logs, and never touches evidence. Check with
`docker ps --filter label=kitchen.toolkit=a-web`.
