# Sign in / sign out

A user signs in with a username and password, lands on Home showing who they are, and can sign out; signed-out visitors are sent to the sign-in page.

## Sub-features

- `sign-in`: username + password form, session cookie
- `sign-out`: Sign out button ends the session
- `guard`: protected pages redirect to `/login`

## How to get to it (user POV)

- `/login` (also where any protected page redirects when signed out)
- "Sign out" button in the header of every signed-in page

## Driving it with bin/dev

Seed state: users `alice` and `bob-admin` (passwords in `.env.kitchen`).

```drive
drive: auth.sign-in
args: [user]
steps:
  - login: { as: $user }
  - read: { target: "[data-testid=signed-in-as]" }
    save: who
  - reload: {}
  - read: { target: "[data-testid=signed-in-as]" }
  - http: { method: GET, path: "/api/me" }
  - press: { target: "[data-testid=sign-out]" }
  - wait: { until: { text: "Sign in" }, timeout: 5s }
  - open: { path: "/home" }
  - read: { target: "[data-testid=login-submit]" }
  - sql: { query: "select count(*) from sessions" }
```

## Kitchen

```kitchen
paths: ["server.js", "db/**"]
check: { drive: auth.sign-in, args: { user: alice } }
```

## Gotchas

- `login` clears cookies first, so it is safe to call repeatedly.
- Sessions live in the `sessions` table; `reset` truncates it.
