---
name: verify-fixture-d-api
description: "Start, drive and observe fixture-d-api, a small orders HTTP API (create/read/cancel orders, Stripe PaymentIntents and webhooks, email receipts), through its Kitchen Toolkit bin/dev with a local Stripe mock and SMTP catcher. Use whenever a Job needs to prove behaviour in this app: launch a slot, check it, run a feature drive, capture evidence, tear it down."
---

# Toolkit: fixture-d-api

`bin/dev` is the only way to touch the running app. Every command prints exactly
one JSON line on stdout and logs to stderr. Kitchen runs it from its own clean
checkout of the base, always with `--src <worktree>`. State per id lives in
`$KITCHEN_TOOLKIT_STATE` (default `$TMPDIR/kitchen-toolkit-fixture-d-api/<id>/`), so
`down --id` needs no `--src`. Project specifics are in `app.mjs`; `bin/dev` and
`lib/` are Kitchen's generic contract code. Surface: **api** (no UI, no CLI).

## Launch

```sh
bin/dev prepare --src <worktree>
bin/dev up --id <id> --src <worktree> --ports <app>,<stripe>,<smtp>
```

`prepare` runs `npm ci` in the app (npm's shared cache, a few seconds warm) and
builds a seed snapshot (an empty orders DB with the 4-SKU catalog, from
`db/schema.sql`) in the state root. `up` starts, on the three ports in order:
`app` = `node server.js`; `stripe` = the Stripe mock (`mock.mjs`, also serves
`/__kitchen/*` inspection); `smtp` = the mail catcher (same process). The app
gets a per-id SQLite copy of the snapshot and points `STRIPE_API_BASE`/`SMTP_*`
at the mocks. Ready means `/healthz` reports `db: true` and the catalog has 4 rows.
Secrets: only `.env.kitchen` (fake values). Never the developer's `.env`.
Node 22.5+ is required (`node:sqlite`).

## Doctor

`bin/dev doctor --id <id>` — read-only: app and mock processes alive, healthz
reports db, catalog has 4 SKUs, the Stripe mock answers and isn't in failure
mode, a seed API key is accepted. Run it first whenever anything looks off.

## Drive

Primitives (each `bin/dev <name> --id=<id> --src=<worktree> --out=<dir> [--flag=value]…`, prints `{"ok","out","files"}`).
Kitchen sets `--id`, `--src` and `--out` itself; a flag given twice is refused.
Seed users are the API key names in `.env.kitchen` (`dev-key-1`, `dev-key-2`); `as`
sends that key as `X-Api-Key`, no `as` sends none.

| primitive | flags | does |
|---|---|---|
| `http` | `method`, `path`, `body` (raw JSON), `as`, `expect_status` | one request to the app (same origin only); ok on a response, or when the status matches `expect_status` |
| `order` | `order_id`, `as`, `expect_status` | `GET /orders/<id>` |
| `cancel` | `order_id`, `as`, `expect_status` | `POST /orders/<id>/cancel` |
| `read` | `target` (`status`, `body`, `body.<path>`), `equals` | reads the last response; missing is ok:false |
| `webhook` | `type`, `payment_intent`, `bad_signature`, `expect_status` | Stripe-signed event to `/webhooks/stripe` |
| `mail` | `to`, `subject`, `contains`, `count` | mails the SMTP catcher received |
| `payments` | `path`, `contains`, `count` | calls the Stripe mock received (path, auth, idempotency key, form) |
| `stripe_fail` | `on` | make the Stripe mock answer 500 (cleared by `reset`) |
| `db_order` | `order_id`, `status` | the stored order row, straight from SQLite |

Feature drives live in `features/<x>.md` as fenced `drive` blocks; Kitchen
interprets them (they call primitives, nothing else). See `features/README.md`.
`bin/dev describe [--src <worktree>]` prints the capability list; it is
generated, never hand-edited.

## Evidence

- Kitchen passes `--out <evidence>/e<N>/` on every primitive call; files are
  written there and listed in `files` (a file anywhere else fails the step).
  Kitchen stamps each call in its manifest. Nothing in the Toolkit writes it.
- Proof standard: go through the real public API (HTTP with the API key, a
  Stripe-signed webhook), capture the response, and verify side effects from a
  second view: the stored row (`db_order`), a listing/GET, the mail the catcher
  received, the calls the Stripe mock received.
- Logs: `<state>/<id>/app.log`, `mock.log`.

## Cleanup

```sh
bin/dev reset --id <id>   # stops the app, restores the seed snapshot DB, clears the mock's mails/calls/failure mode, restarts the app
bin/dev down --id <id>    # stops only what this id started (recorded pids)
```

`down` keeps logs and never touches evidence. Instances are independent
(own ports, data dir, mock), so several can run at once.

## Stand-ins

Stripe and SMTP are mocks: the real Stripe validation, 3-D Secure and real mail
delivery are not exercised. The webhook is signed by the Toolkit with a fake secret.
