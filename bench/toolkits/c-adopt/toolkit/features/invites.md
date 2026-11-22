# Admin invites

An admin generates single-use invite codes at `/admin`; anyone can redeem a code at `/join`, and a used code is rejected.

## Sub-features

- `generate`: admin-only button creates an `INV-XXXXXXXX` code
- `redeem`: `/join` accepts an unused code once

## How to get to it (user POV)

- "Admin" in the header nav (admins only), then "Generate invite"
- `/join` ("Have an invite code?" on the sign-in page)

## Driving it with bin/dev

Seed state: `bob-admin` is the admin; no invites exist.

```drive
drive: invites.generate-and-redeem
args: [user]
steps:
  - login: { as: $user }
  - press: { target: "[data-testid=nav-admin]" }
  - press: { target: "[data-testid=generate-invite]" }
  - read: { target: "[data-testid=invite-code]" }
    save: code
  - open: { path: "/join" }
  - type: { target: "[data-testid=invite-input]", text: $code }
  - press: { target: "[data-testid=invite-submit]" }
  - read: { target: "[data-testid=invite-result]" }
  - sql: { query: "select code, accepted_at is not null from invites" }
```

## Kitchen

```kitchen
paths: ["server.js", "db/**"]
check: { drive: invites.generate-and-redeem, args: { user: bob-admin } }
```

## Gotchas

- Only `bob-admin` sees the Admin link; `alice` gets 403 at `/admin`.
- Codes are random; always `save` the one shown rather than guessing.
