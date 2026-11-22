# Import / export

Export tasks as CSV or JSON and import a CSV.

## Sub-features

- export: csv/json to stdout
- import: csv file

## How to get to it (user POV)

`tasks export --format csv`, `tasks import <file>`.

## Driving it with bin/dev

Precondition: seed state (`seed/demo.csv` imported; every drive begins with the `seed` primitive, which restores it: ids 1-4 open, 5-6 done; id 4 "Renew domain" is overdue).

```drive
drive: transfer.roundtrip
args: []
steps:
  - seed: {}
  - cli: { argv: [import, seed/demo.csv] }
  - cli: { argv: [export, --format, csv] }
  - read: { target: stdout }
  - cli: { argv: [stats] }
  - wait: { until: { text: "12 tasks" }, timeout: 5s }
```

## Kitchen

```kitchen
paths: [tasks/cli.py, tasks/store.py]
check: { drive: transfer.roundtrip, args: {} }
```

## Gotchas

- Importing the demo file onto the seeded DB duplicates it (6 -> 12); reset restores 6. Import paths are relative to the repo root (cwd = --src).
