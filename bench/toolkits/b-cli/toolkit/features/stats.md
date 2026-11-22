# Stats

Show total, open, done and overdue counts.

## Sub-features

- stats: counts

## How to get to it (user POV)

`tasks stats`.

## Driving it with bin/dev

Precondition: seed state (`seed/demo.csv` imported; every drive begins with the `seed` primitive, which restores it: ids 1-4 open, 5-6 done; id 4 "Renew domain" is overdue).

```drive
drive: stats.counts
args: []
steps:
  - seed: {}
  - cli: { argv: [stats] }
  - wait: { until: { text: "6 tasks: 4 open, 2 done, 1 overdue" }, timeout: 5s }
  - cli: { argv: [stats, --json] }
  - read: { target: stdout }
```

## Kitchen

```kitchen
paths: [tasks/cli.py, tasks/store.py]
check: { drive: stats.counts, args: {} }
```

## Gotchas

- Overdue depends on today's date: id 4 is due 2020-03-01 so stays overdue; other due dates are 2029-2030.
