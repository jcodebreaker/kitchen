# Task lifecycle

Add a task with a due date and tags, mark it done, edit its title.

## Sub-features

- add: create a task
- done: mark complete
- edit: change title/due

## How to get to it (user POV)

`python3 -m tasks add|done|edit|list` in a terminal.

## Driving it with bin/dev

Precondition: seed state (`seed/demo.csv` imported; every drive begins with the `seed` primitive, which restores it: ids 1-4 open, 5-6 done; id 4 "Renew domain" is overdue).

```drive
drive: lifecycle.add_done_edit
args: []
steps:
  - seed: {}
  - cli: { argv: [add, "Write the report", --due, "2030-06-01", --tag, work, --json] }
  - read: { target: stdout }
  - cli: { argv: [done, "7"] }
  - cli: { argv: [edit, "7", --title, "Write the Q2 report"] }
  - cli: { argv: [list, --all, --json] }
  - wait: { until: { text: "Write the Q2 report" }, timeout: 5s }
```

## Kitchen

```kitchen
paths: [tasks/cli.py, tasks/store.py, tasks/db.py, tasks/migrations/**]
check: { drive: lifecycle.add_done_edit, args: {} }
```

## Gotchas

- The new task is id 7 only from seed state; reset first on a used instance.
- The final `list` is a second view: the edit and done flag must show there.
