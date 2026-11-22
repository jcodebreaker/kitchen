# Settings: dark mode

A signed-in user flips a dark-mode switch at `/settings`; the choice is saved per user and applied to every page.

## Sub-features

- `dark-mode`: toggle, saved confirmation, persisted in the database

## How to get to it (user POV)

- "Settings" in the header nav, then the "Dark mode" switch

## Driving it with bin/dev

Seed state: `alice` has theme `light`.

```drive
drive: settings.dark-mode
args: [user]
steps:
  - login: { as: $user }
  - press: { target: "[data-testid=nav-settings]" }
  - read: { target: "[data-testid=theme-state]" }
  - press: { target: "[data-testid=dark-mode-toggle]" }
  - wait: { until: { text: "Saved" }, timeout: 5s }
  - reload: {}
  - read: { target: "[data-testid=theme-state]" }
  - http: { method: GET, path: "/api/me" }
  - sql: { query: "select theme from users where username = 'alice'" }
```

## Kitchen

```kitchen
paths: ["server.js"]
check: { drive: settings.dark-mode, args: { user: alice } }
```

## Gotchas

- The "Saved" confirmation appears ~400ms after the click: use `wait`.
- The drive hardcodes `alice` in the SQL check; run it with `user: alice`.
- `reset` sets every theme back to `light`.
