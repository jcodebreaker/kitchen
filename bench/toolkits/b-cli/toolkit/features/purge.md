# Purge

Delete all done tasks after a confirmation prompt.

## Sub-features

- purge: interactive y/N
- purge --yes: skip the question

## How to get to it (user POV)

`tasks purge` (prompts), `tasks purge --yes`.

## Driving it with bin/dev

Precondition: seed state (`seed/demo.csv` imported; every drive begins with the `seed` primitive, which restores it: ids 1-4 open, 5-6 done; id 4 "Renew domain" is overdue).

```drive
drive: purge.confirm_and_delete
args: []
steps:
  - seed: {}
  - cli: { argv: [purge], stdin: "n", expect_exit: 1 }
  - cli: { argv: [stats] }
  - wait: { until: { text: "6 tasks" }, timeout: 5s }
  - cli: { argv: [purge], stdin: "y" }
  - cli: { argv: [stats] }
  - wait: { until: { text: "4 tasks: 4 open, 0 done, 1 overdue" }, timeout: 5s }
```

## Kitchen

```kitchen
paths: [tasks/cli.py, tasks/store.py]
check: { drive: purge.confirm_and_delete, args: {} }
```

## Gotchas

- Declining exits 1 with `error: aborted` and leaves all 6 tasks. Needs the 2 done seed tasks.
