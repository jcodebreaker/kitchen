# Invites: admin generates, newcomer joins

An admin generates a one-time invite code on /admin; someone signed out enters
it on /join. Codes are random (`INV-` + 8 hex), so a drive must read the code and
reuse it.

## Sub-features

- `/admin` (admins only): **Generate invite** (`generate-invite`), new code in `[data-testid=invite-code]`.
- `/join` (public, linked from sign-in as "Have an invite code?", `join-link`):
  `invite-input`, **Join** (`invite-submit`), outcome in `[data-testid=invite-result]`.
- A code works once; a second use says "not found or already used".

## How to get to it (user POV)

Sign in as an admin → **Admin**. To join: sign out → **Have an invite code?**

## Driving it with bin/dev

```drive
drive: invites.generate-and-join
args: [admin]
steps:
  - login: { as: $admin }
  - press: { target: "[data-testid=nav-admin]" }
  - press: { target: "[data-testid=generate-invite]" }
  - wait:  { until: { text: "INV-", target: "[data-testid=invite-code]" }, timeout: 5s }
  - read:  { target: "[data-testid=invite-code]" }
    save: invite
  - press: { target: "[data-testid=sign-out]" }
  - press: { target: "[data-testid=join-link]" }
  - type:  { target: "[data-testid=invite-input]", text: $invite }
  - press: { target: "[data-testid=invite-submit]" }
  - wait:  { until: { text: "Invite accepted: $invite", target: "[data-testid=invite-result]" }, timeout: 5s }
  - screenshot: { name: invite-accepted }
```

## Gotchas

- Seed admin is `bob-admin`; `alice` gets "Admins only".
