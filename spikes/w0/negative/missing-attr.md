# Negative control: `read` of an attribute the element doesn't have

Must FAIL (`ok:false`), not return an empty string a later step could match.

```drive
drive: negative.missing-attr
steps:
  - open: { path: /login }
  - read: { target: body, attr: data-nope }
```
