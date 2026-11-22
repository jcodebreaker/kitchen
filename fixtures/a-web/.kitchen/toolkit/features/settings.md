# Settings: appearance

A signed-in user can switch the app to dark mode on /settings. The choice is
saved per user and survives a reload or a new session.

## Sub-features

- Appearance section with a "Dark mode" switch (`role=switch`, `aria-label="Dark mode"`).
- Save confirmation in `[data-testid=theme-status]` ("Saving…", then "Saved" after ~0.4 s).
- The theme is server-rendered on every page as `body.theme-dark` / `body.theme-light`.
- `GET /api/me` returns `{ username, admin, theme }`.

## How to get to it (user POV)

Sign in → **Settings** in the top bar → **Appearance**.

## Driving it with bin/dev

Starts from seed state (alice is on the light theme). Pressing **Settings** again
is a full server render, so it proves the theme was stored, not just painted.

```drive
drive: settings.toggle-dark
args: [user]
steps:
  - login: { as: $user }
  - press: { target: "[data-testid=nav-settings]" }
  - wait:  { until: { text: "Appearance" }, timeout: 10s }
  - retry: { times: 2, on: fail }
  - read:  { target: "[aria-label='Dark mode']", attr: aria-checked }
    save: before
  - press: { target: "[aria-label='Dark mode']" }
  - wait:  { until: { text: "Saved", target: "[data-testid=theme-status]" }, timeout: 5s }
  - press: { target: "[data-testid=nav-settings]" }   # full reload from the server
  - wait:  { until: { text: "theme-dark", target: body, attr: class }, timeout: 5s }
  - read:  { target: "[data-testid=theme-state]" }
    save: theme
  - http:  { method: GET, path: /api/me }
    save: me
  - screenshot: { name: settings-dark }
```

Proof for a spec criterion: `$theme` is `Dark`, `$me` contains `"theme":"dark"`,
and `$before` was `false`.

## Gotchas

- Toggling is a flip, not a set: run it from seed state (`reset`) or the second
  run turns dark mode off again.
- "Saved" appears ~0.4 s after the click on purpose; read it without a `wait` and you get "Saving…".
