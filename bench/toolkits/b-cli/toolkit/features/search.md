# Search and filter

Find tasks by text and filter the list by tag.

## Sub-features

- search: substring search
- list --tag: tag filter

## How to get to it (user POV)

`tasks search <text>`, `tasks list --tag <tag>`.

## Driving it with bin/dev

Precondition: seed state (`seed/demo.csv` imported; every drive begins with the `seed` primitive, which restores it: ids 1-4 open, 5-6 done; id 4 "Renew domain" is overdue).

```drive
drive: search.find_and_filter
args: []
steps:
  - seed: {}
  - cli: { argv: [search, flaky, --json] }
  - read: { target: stdout }
  - cli: { argv: [list, --tag, ops, --json] }
  - read: { target: stdout }
  - cli: { argv: [list, --tag, nonexistent] }
  - wait: { until: { text: "No tasks." }, timeout: 5s }
```

## Kitchen

```kitchen
paths: [tasks/cli.py, tasks/store.py]
check: { drive: search.find_and_filter, args: {} }
```

## Gotchas

- `list --tag ops` hides done tasks, so only 'Renew domain' (id 4) shows.
