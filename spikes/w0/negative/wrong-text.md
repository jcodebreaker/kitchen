# Negative control: a wait that can never be met, with a retry

Must FAIL at the wait after the retry (two stamped attempts), not hang and not pass.

```drive
drive: negative.wrong-text
steps:
  - login: { as: alice }
  - press: { target: "[data-testid=nav-settings]" }
  - wait:  { until: { text: "Purple mode" }, timeout: 1s }
  - retry: { times: 1, on: fail }
  - screenshot: { name: never-reached }
```
