# Negative control: a wait whose text is empty after substitution

`"".includes("")` is true, so an empty wait would pass on anything. Must FAIL at the wait.

```drive
drive: negative.empty-wait
steps:
  - open: { path: /login }
  - type: { target: "[data-testid=login-username]", text: "" }
    save: empty
  - wait: { until: { text: $empty }, timeout: 1s }
```
