# New project wizard

A signed-in user creates a project in two steps (name and description, then a unique slug), sees it provisioning, then ready, and finds it in the projects list.

## Sub-features

- `create`: two-step form, slug validation and uniqueness
- `provisioning`: new project shows "Provisioning…" for ~1.5s, then "Ready"
- `list`: `/projects` lists the user's projects; `/projects/<slug>` is the detail page

## How to get to it (user POV)

- "New project" in the header nav (`/projects/new`)
- "Projects" in the header nav, then a project link

## Driving it with bin/dev

Seed state: `alice` owns one project, `onboarding`. The slug arg must not be `onboarding`.

```drive
drive: projects.create
args: [user, slug]
steps:
  - login: { as: $user }
  - press: { target: "[data-testid=nav-new-project]" }
  - type: { target: "[data-testid=project-name]", text: "Kitchen demo" }
  - type: { target: "[data-testid=project-description]", text: "Made by a drive" }
  - press: { target: "[data-testid=wizard-next]" }
  - type: { target: "[data-testid=project-slug]", text: $slug }
  - press: { target: "[data-testid=wizard-create]" }
  - wait: { until: { text: "Ready" }, timeout: 10s }
  - open: { path: "/projects" }
  - read: { target: "[data-testid=project-list]" }
  - sql: { query: "select name, slug from projects order by id" }
```

## Kitchen

```kitchen
paths: ["server.js", "db/**"]
check: { drive: projects.create, args: { user: alice, slug: kitchen-demo } }
```

## Gotchas

- Slugs are 3-30 lowercase letters, digits or dashes and globally unique; `reset` deletes created projects, so the same slug works again.
- Status flips from "Provisioning…" to "Ready" by client-side polling: `wait`, don't read once.
