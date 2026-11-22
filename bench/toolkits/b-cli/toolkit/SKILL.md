---
name: verify-tasks
description: "tasks is a terminal task tracker (Python CLI over SQLite): add, list, done, edit, search, stats, purge, import/export. Drive it as a user types commands. Start, drive and observe it through its Kitchen Toolkit bin/dev. Use whenever a Job needs to prove behaviour in this app: launch a slot, check it, run a feature drive, capture evidence, tear it down."
---

# Toolkit: tasks

`bin/dev` is the only way to touch the running app. Every command prints exactly
one JSON line on stdout and logs to stderr. Kitchen runs it from its own clean
checkout of the base, always with `--src <worktree>`. State per id lives in
`$KITCHEN_TOOLKIT_STATE` (default `$TMPDIR/kitchen-toolkit-tasks/<id>/`), so
`down --id` needs no `--src`. Project specifics are in `app.mjs`; `bin/dev` and
`lib/` are Kitchen's generic contract code.

## Launch

```sh
bin/dev prepare --src <worktree>
bin/dev up --id <id> --src <worktree> --ports <any one port; unused>
```

`prepare` checks python3 >= 3.11 and builds a seeded DB snapshot (`seed/demo.csv` imported), cached in `$TMPDIR/kitchen-toolkit-tasks-cache` by content hash; nothing to install (seconds). `up` copies the snapshot to `<state>/data/tasks.db` and runs `list` to confirm 6 tasks; that is "ready". There is no server; the port is unused. Every `cli` call runs `python3 -m tasks` in the worktree with `TASKS_DB` pointing at that instance's DB. Secrets: none (`.env.kitchen` is fake).

## Doctor

`bin/dev doctor --id <id>` — read-only. Checks: DB file exists, the CLI opens it, it holds tasks. Run it first
whenever anything looks off.

## Drive

Primitives (each `bin/dev <name> --id=<id> --src=<worktree> --out=<dir> [--flag=value]…`, prints `{"ok","out","files"}`).
Kitchen sets `--id`, `--src` and `--out` itself; a flag given twice is refused.

| primitive | flags | does |
|---|---|---|
| cli | argv (list), stdin?, expect_exit? | run one `tasks` command; out is {exit, stdout, stderr}; ok whatever the exit code unless expect_exit pins one |
| seed | | restore the DB to the seed snapshot (drives start with it) |
| read | target: stdout/stderr/exit | the last cli call's output (what `wait` polls) |

Feature drives live in `features/<x>.md` as fenced `drive` blocks; Kitchen
interprets them (they call primitives, nothing else). See `features/README.md`.
`bin/dev describe [--src <worktree>]` prints the capability list; it is
generated, never hand-edited.

## Evidence

- Kitchen passes `--out <evidence>/e<N>/` on every primitive call; files are
  written there and listed in `files` (a file anywhere else fails the step).
  Kitchen stamps each call in its manifest. Nothing in the Toolkit writes it.
- Proof standard: go through the real user path (the real `tasks` command, never SQL), capture the action and the resulting state,
  and verify side effects (rows, files, mails, calls to externals) alongside
  what's visible.
- Logs: `<state>/<id>/*.log`.

## Cleanup

```sh
bin/dev reset --id <id>   # re-copies the seed snapshot over the DB
bin/dev down --id <id>    # stops only what this id started (recorded pids, labelled containers, its compose project)
```

`down` keeps logs and never touches evidence.
