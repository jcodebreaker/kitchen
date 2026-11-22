# Projects: two-step create form

A signed-in user creates a project in two steps: basics (name, description),
then an address (slug) that is validated on step 2. A new project shows
"Provisioning…" and turns "Ready" about 1.5 s later.

## Sub-features

- Step 1: `[data-testid=project-name]` (required), `[data-testid=project-description]`, **Next** (`wizard-next`).
- Step 2: `[data-testid=project-slug]`, **Create project** (`wizard-create`).
  Errors in `[data-testid=slug-error]`: bad format ("…lowercase…") or "That slug is already taken."
- Project page `/projects/<slug>`: `project-title`, `project-slug-value`, `project-status` (polls until Ready).
- List at **Projects** (`nav-projects`); seed has `onboarding` for alice.

## How to get to it (user POV)

Sign in → **New project** in the top bar.

## Driving it with bin/dev

```drive
drive: projects.create
args: [user, slug]
steps:
  - login: { as: $user }
  - press: { target: "[data-testid=nav-new-project]" }
  - wait:  { until: { text: "Step 1 of 2", target: "[data-testid=wizard-step]" }, timeout: 5s }
  - type:  { target: "[data-testid=project-name]", text: "Launch plan" }
  - type:  { target: "[data-testid=project-description]", text: "Made by a Kitchen drive" }
  - press: { target: "[data-testid=wizard-next]" }
  - wait:  { until: { text: "Step 2 of 2", target: "[data-testid=wizard-step]" }, timeout: 5s }
  - type:  { target: "[data-testid=project-slug]", text: "Not A Slug!" }
  - press: { target: "[data-testid=wizard-create]" }
  - wait:  { until: { text: "lowercase", target: "[data-testid=slug-error]" }, timeout: 5s }
  - type:  { target: "[data-testid=project-slug]", text: $slug }
  - press: { target: "[data-testid=wizard-create]" }
  - wait:  { until: { text: "Ready", target: "[data-testid=project-status]" }, timeout: 10s }
  - read:  { target: "[data-testid=project-slug-value]" }
    save: created
  - screenshot: { name: project-ready }
```

## Gotchas

- Slugs are unique across all users: a second run with the same `slug` stops at
  "That slug is already taken." unless the slot was `reset`.
- Step 2 re-renders on a validation error; the typed name survives in hidden fields.
