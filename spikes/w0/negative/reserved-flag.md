# Negative control: a step that tries to set an engine flag

W0 review: `login: {as: bob-admin, id: p2}` drove slot p2 while the manifest stamped p1.
Must be refused when the drive is parsed, before anything runs.

```drive
drive: negative.reserved-flag
steps:
  - login: { as: bob-admin, id: p2 }
```
