---
name: verify-TODO-app
description: "TODO: one sentence naming the app, its surface (web UI, CLI, API) and its main features, then: Start, drive and observe it through its Kitchen Toolkit bin/dev. Use whenever a Job needs to prove behaviour in this app: launch a slot, check it, run a feature drive, capture evidence, tear it down."
---

# Toolkit: TODO-app

`bin/dev` is the only way to touch the running app. Every command prints exactly
one JSON line on stdout and logs to stderr. Kitchen runs it from its own clean
checkout of the base, always with `--src <worktree>`. State per id lives in
`$KITCHEN_TOOLKIT_STATE` (default `$TMPDIR/kitchen-toolkit-TODO-app/<id>/`), so
`down --id` needs no `--src`. Project specifics are in `app.mjs`; `bin/dev` and
`lib/` are Kitchen's generic contract code.

## Launch

```sh
bin/dev prepare --src <worktree>
bin/dev up --id <id> --src <worktree> --ports <TODO: the ports in order>
```

TODO: what prepare installs and caches (and how long a cold and a warm prepare
take), what `up` starts on which port, and what "ready" means (usable, not just
listening). Secrets: only `.env.kitchen` (fake values). Never the developer's `.env`.

## Doctor

`bin/dev doctor --id <id>` — read-only. TODO: list its checks. Run it first
whenever anything looks off.

## Drive

Primitives (each `bin/dev <name> --id=<id> --src=<worktree> --out=<dir> [--flag=value]…`, prints `{"ok","out","files"}`).
Kitchen sets `--id`, `--src` and `--out` itself; a flag given twice is refused.

| primitive | flags | does |
|---|---|---|
| TODO | | |

Feature drives live in `features/<x>.md` as fenced `drive` blocks; Kitchen
interprets them (they call primitives, nothing else). See `features/README.md`.
`bin/dev describe [--src <worktree>]` prints the capability list; it is
generated, never hand-edited.

## Evidence

- Kitchen passes `--out <evidence>/e<N>/` on every primitive call; files are
  written there and listed in `files` (a file anywhere else fails the step).
  Kitchen stamps each call in its manifest. Nothing in the Toolkit writes it.
- Proof standard: go through the real user path (TODO: the sign-in form, the
  real command, the public API), capture the action and the resulting state,
  and verify side effects (rows, files, mails, calls to externals) alongside
  what's visible.
- Logs: `<state>/<id>/*.log`.

## Cleanup

```sh
bin/dev reset --id <id>   # TODO: what reset restores, and how
bin/dev down --id <id>    # stops only what this id started (recorded pids, labelled containers, its compose project)
```

`down` keeps logs and never touches evidence.
