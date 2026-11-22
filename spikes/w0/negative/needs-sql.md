# Negative control: a drive that names a primitive the Toolkit lacks

Must end as a TOOLKIT-GAP naming `sql`, before any step runs.

```drive
drive: negative.needs-sql
steps:
  - login: { as: alice }
  - sql: { query: "SELECT theme FROM users WHERE username = 'alice'" }
```
