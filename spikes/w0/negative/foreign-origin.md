# Negative control: requests that would leave the app

W0 review: `${BASE}${p}` turned `@evil.example/x` into `http://127.0.0.1:31000@evil.example/x`,
a request to evil.example. The driver now resolves every path with `new URL(p, BASE)` and
refuses any other origin.

`@evil.example/x` now stays on the app (it is just the path `/@evil.example/x`, a 404):

```drive
drive: negative.foreign-at
steps:
  - login: { as: alice }
  - http: { method: GET, path: "@evil.example/x" }
```

An absolute URL or a protocol-relative path is refused before any request:

```drive
drive: negative.foreign-abs
steps:
  - http: { method: GET, path: "http://evil.example/x" }
```

```drive
drive: negative.foreign-open
steps:
  - open: { path: "//evil.example/x" }
```
